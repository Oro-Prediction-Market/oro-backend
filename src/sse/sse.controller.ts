import {
  Controller,
  Sse,
  Post,
  Query,
  Request,
  UseGuards,
  UnauthorizedException,
} from "@nestjs/common";
import { randomBytes } from "crypto";
import { Observable, map } from "rxjs";
import { SseService } from "./sse.service";
import { JwtService } from "@nestjs/jwt";
import { RedisService } from "../redis/redis.service";
import { JwtAuthGuard } from "../auth/guards";

interface MessageEvent {
  data: string | object;
  type?: string;
  id?: string;
  retry?: number;
}

const SSE_TICKET_PREFIX = "sse:ticket:";
const SSE_TICKET_TTL_SECONDS = 60;

@Controller("sse")
export class SseController {
  constructor(
    private readonly sseService: SseService,
    private readonly jwtService: JwtService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Issue a short-lived, single-use ticket for opening an SSE stream.
   *
   * EventSource cannot send Authorization headers, so historically the JWT was
   * passed in the query string — but query strings leak into proxy/access logs
   * and browser history, exposing live session tokens. Instead, the client
   * authenticates here with its Bearer token (over the normal header) and
   * receives an opaque ticket. The ticket is random, expires in 60s, is bound
   * to the user, and is consumed on first use, so even if it appears in a log
   * it is worthless: it cannot be replayed and cannot be used as an API token.
   */
  @Post("ticket")
  @UseGuards(JwtAuthGuard)
  async issueTicket(@Request() req: any): Promise<{ ticket: string }> {
    const userId: string = req.user?.userId;
    if (!userId) throw new UnauthorizedException("Authentication required");
    const ticket = randomBytes(32).toString("hex");
    await this.redis.setEx(
      `${SSE_TICKET_PREFIX}${ticket}`,
      SSE_TICKET_TTL_SECONDS,
      userId,
    );
    return { ticket };
  }

  /**
   * SSE stream endpoint.
   *
   * Preferred auth: a single-use `ticket` obtained from POST /sse/ticket.
   * Legacy fallback: a raw JWT in `token` — DEPRECATED, kept only so that
   * clients running an older bundle keep working during rollout. New clients
   * must use the ticket flow; the token path can be removed once all clients
   * have updated.
   */
  @Sse("stream")
  async stream(
    @Query("ticket") ticket?: string,
    @Query("token") token?: string,
  ): Promise<Observable<MessageEvent>> {
    let userId: string | undefined;

    if (ticket) {
      // Single-use: read then immediately delete so the ticket can't be replayed.
      const key = `${SSE_TICKET_PREFIX}${ticket}`;
      const ticketUserId = await this.redis.get(key);
      await this.redis.del(key);
      if (!ticketUserId) {
        throw new UnauthorizedException("Invalid or expired ticket");
      }
      userId = ticketUserId;
    } else if (token) {
      // Deprecated legacy path — verify the JWT and enforce revocation.
      let payload: any;
      try {
        payload = this.jwtService.verify(token);
      } catch {
        throw new UnauthorizedException("Invalid token");
      }
      if (payload.jti) {
        const revoked = await this.redis.get(`jwt:blacklist:${payload.jti}`);
        if (revoked) throw new UnauthorizedException("Token has been revoked");
      }
      userId = payload.sub || payload.userId;
    } else {
      throw new UnauthorizedException("Missing ticket");
    }

    return this.sseService.forUser(userId!).pipe(
      map((event) => ({
        type: event.type,
        data: JSON.stringify(event.data ?? {}),
      })),
    );
  }
}
