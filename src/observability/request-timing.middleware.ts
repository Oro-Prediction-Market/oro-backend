import { Injectable, NestMiddleware } from "@nestjs/common";
import { PerfRecorderService } from "./perf-recorder.service";

/**
 * Times every HTTP request and hands it to PerfRecorderService.
 *
 * A middleware rather than an interceptor so the time includes the guards
 * (JWT, session checks, rate limiting) and requests they reject. It records on
 * the response's `finish`, by which point Express has matched the route, so
 * the key is the route template ("GET /api/markets/:id"), never the concrete
 * URL — the number of keys stays bounded by the number of routes.
 *
 * Server-sent event streams are skipped: they stay open for hours and would
 * swamp the numbers. A request whose client hangs up early never finishes and
 * is not counted.
 */
@Injectable()
export class RequestTimingMiddleware implements NestMiddleware {
  constructor(private readonly perf: PerfRecorderService) {}

  use(req: any, res: any, next: () => void) {
    if (!this.perf.enabled) return next();
    const start = process.hrtime.bigint();
    res.once("finish", () => {
      const type = String(res.getHeader?.("content-type") ?? "");
      if (type.includes("text/event-stream")) return;
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      this.perf.record(routeKey(req), ms, res.statusCode ?? 0);
    });
    next();
  }
}

export function routeKey(req: {
  method?: string;
  route?: { path?: string };
  baseUrl?: string;
}): string {
  const path = req.route?.path;
  const template = path ? `${req.baseUrl ?? ""}${path}` : "(unmatched)";
  return `${req.method ?? "?"} ${template}`;
}
