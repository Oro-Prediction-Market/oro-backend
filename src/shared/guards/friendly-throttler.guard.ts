import {
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from "@nestjs/common";
import { ThrottlerGuard, type ThrottlerLimitDetail } from "@nestjs/throttler";

/**
 * Turn a number of seconds into something to put in front of a user.
 *
 * Always rounds up: telling someone to wait 44 seconds when the window clears
 * in 44.6 earns them a second rejection.
 */
export function describeWait(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "a moment";
  if (seconds < 60) {
    const whole = Math.ceil(seconds);
    return `${whole} second${whole === 1 ? "" : "s"}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * The rate limiter, answering in a sentence instead of a class name.
 *
 * Two things were wrong with the stock guard here, and the second one hid the
 * first:
 *
 * 1. Its message is "ThrottlerException: Too Many Requests" — the name of an
 *    exception class, which is not something to show anyone.
 *
 * 2. `ThrottlerException` is constructed as `super(message, status)`, the
 *    string overload, so `getResponse()` returns a bare string rather than the
 *    `{ statusCode, message }` object every other error in this API returns.
 *    Our global HttpExceptionFilter serialises `getResponse()` as-is, so a 429
 *    body was the JSON string `"ThrottlerException: Too Many Requests"`. The
 *    frontends read `err.message`, which on a string is undefined, so all three
 *    fell through to their `HTTP ${status}` fallback and showed "HTTP 429".
 *
 * Throwing a plain HttpException with an object body fixes both at once, for
 * every throttled route and all three clients, with no frontend change.
 *
 * `retryAfter` is included in the body as well as the `Retry-After` header the
 * base guard already sets, because a client reading the body does not
 * necessarily have the headers to hand.
 */
@Injectable()
export class FriendlyThrottlerGuard extends ThrottlerGuard {
  protected async throwThrottlingException(
    _context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    // The same figure the base guard puts in Retry-After, in seconds.
    const seconds = Math.max(0, Math.ceil(detail.timeToBlockExpire));
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: "Too Many Requests",
        message: `You're doing that too quickly. Try again in ${describeWait(
          detail.timeToBlockExpire,
        )}.`,
        retryAfter: seconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
