import { Controller, Sse, Query, UnauthorizedException } from "@nestjs/common";
import { Observable, map } from "rxjs";
import { SseService } from "./sse.service";
import { JwtService } from "@nestjs/jwt";

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
  ) {}

  /**
   * SSE stream endpoint.
   * Since EventSource cannot send Authorization headers, we accept
   * the JWT as a query parameter: GET /sse/stream?token=<jwt>
   */
  @Sse("stream")
  stream(@Query("token") token: string): Observable<MessageEvent> {
    if (!token) throw new UnauthorizedException("Missing token");
    let payload: any;
    try {
      payload = this.jwtService.verify(token);
    } catch {
      throw new UnauthorizedException("Invalid token");
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
