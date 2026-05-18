import { Controller, Sse, Query, UnauthorizedException } from "@nestjs/common";
import { Observable, map } from "rxjs";
import { SseService } from "./sse.service";
import { JwtService } from "@nestjs/jwt";
import { RedisService } from "../redis/redis.service";

interface MessageEvent {
  data: string | object;
  type?: string;
  id?: string;
  retry?: number;
}

@Controller("sse")
export class SseController {
  constructor(
    private readonly sseService: SseService,
    private readonly jwtService: JwtService,
    private readonly redis: RedisService,
  ) {}

  /**
   * SSE stream endpoint.
   * Since EventSource cannot send Authorization headers, we accept
   * the JWT as a query parameter: GET /sse/stream?token=<jwt>
   *
   * The token is verified and checked against the revocation blacklist so
   * that a logged-out token cannot keep an SSE stream alive.
   */
  @Sse("stream")
  async stream(@Query("token") token: string): Promise<Observable<MessageEvent>> {
    if (!token) throw new UnauthorizedException("Missing token");
    let payload: any;
    try {
      payload = this.jwtService.verify(token);
    } catch {
      throw new UnauthorizedException("Invalid token");
    }

    // Enforce revocation: tokens logged out via /auth/logout are blacklisted by jti.
    // Without this check, a revoked token can still receive SSE events indefinitely.
    if (payload.jti) {
      const revoked = await this.redis.get(`jwt:blacklist:${payload.jti}`);
      if (revoked) throw new UnauthorizedException("Token has been revoked");
    }

    const userId: string = payload.sub || payload.userId;

    return this.sseService.forUser(userId).pipe(
      map((event) => ({
        type: event.type,
        data: JSON.stringify(event.data ?? {}),
      })),
    );
  }
}
