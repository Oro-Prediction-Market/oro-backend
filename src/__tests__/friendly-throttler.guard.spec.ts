import { HttpException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { ThrottlerLimitDetail } from "@nestjs/throttler";
import {
  describeWait,
  FriendlyThrottlerGuard,
} from "../shared/guards/friendly-throttler.guard";

describe("describeWait", () => {
  it("reads as seconds under a minute", () => {
    expect(describeWait(1)).toBe("1 second");
    expect(describeWait(45)).toBe("45 seconds");
    expect(describeWait(59)).toBe("59 seconds");
  });

  it("reads as minutes at a minute and over", () => {
    expect(describeWait(60)).toBe("1 minute");
    expect(describeWait(61)).toBe("2 minutes");
    expect(describeWait(600)).toBe("10 minutes");
  });

  // Rounding down would send someone back a second early, straight into a
  // second rejection.
  it("rounds up", () => {
    expect(describeWait(44.2)).toBe("45 seconds");
    expect(describeWait(90)).toBe("2 minutes");
  });

  it("degrades to a phrase rather than a wrong number", () => {
    expect(describeWait(0)).toBe("a moment");
    expect(describeWait(-5)).toBe("a moment");
    expect(describeWait(NaN)).toBe("a moment");
  });
});

describe("FriendlyThrottlerGuard", () => {
  /**
   * Reach the protected hook the base guard calls on a blocked request. It is
   * `async`, so it rejects rather than throwing synchronously — awaiting the
   * rejection is what makes the assertion, and a plain try/catch around the
   * call would let it escape as an unhandled rejection.
   */
  async function throwFor(seconds: number): Promise<HttpException> {
    const guard = Object.create(
      FriendlyThrottlerGuard.prototype,
    ) as FriendlyThrottlerGuard;
    const detail = {
      limit: 5,
      ttl: 60_000,
      key: "k",
      tracker: "1.2.3.4",
      totalHits: 6,
      timeToExpire: seconds,
      isBlocked: true,
      timeToBlockExpire: seconds,
    } as ThrottlerLimitDetail;

    const caught = await (
      guard as unknown as {
        throwThrottlingException(
          c: ExecutionContext,
          d: ThrottlerLimitDetail,
        ): Promise<void>;
      }
    )
      .throwThrottlingException({} as ExecutionContext, detail)
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(caught).not.toBeNull();
    return caught as HttpException;
  }

  it("answers 429 with a sentence, not a class name", async () => {
    const err = await throwFor(45);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(429);
    expect(err.message).not.toContain("ThrottlerException");
    const body = err.getResponse() as Record<string, unknown>;
    expect(body.message).toBe(
      "You're doing that too quickly. Try again in 45 seconds.",
    );
    expect(body.retryAfter).toBe(45);
  });

  // The bug this guard exists for: ThrottlerException is built from the string
  // overload, so getResponse() returned a bare string. Our global filter
  // serialises getResponse() as-is, and the frontends read `err.message` off
  // the parsed body — undefined on a string, so they showed "HTTP 429".
  it("returns an object body so a client can read .message", async () => {
    const body = (await throwFor(90)).getResponse();
    expect(typeof body).toBe("object");
    expect(body).toMatchObject({
      statusCode: 429,
      error: "Too Many Requests",
      message: "You're doing that too quickly. Try again in 2 minutes.",
      retryAfter: 90,
    });
  });
});
