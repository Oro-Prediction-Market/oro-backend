import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { TwentyOnePayClient } from "../services/twentyone-pay/twentyone-pay.client";

/**
 * Verifies a 21Pay webhook before the controller sees it.
 *
 * The endpoint is unauthenticated by necessity — 21Pay has no session with us —
 * so the HMAC *is* the authentication.
 *
 * The engine checks freshness **before** the HMAC, which makes "stale" and
 * "wrong signature" indistinguishable to a caller. We match that: one generic
 * rejection, so the route cannot be used to probe which signatures are
 * structurally valid.
 *
 * Note each retry is signed with a **fresh** timestamp, so a delivery arriving
 * 24 hours after the event is still inside the 300-second window. The timestamp
 * bounds the delivery, not the event — an old event is not suspicious.
 *
 * See docs/usdt-oro/21PAY-ANSWERS.md §3.1–3.2.
 */
@Injectable()
export class Pay21WebhookGuard implements CanActivate {
  private readonly logger = new Logger(Pay21WebhookGuard.name);

  constructor(private readonly client: TwentyOnePayClient) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();

    // Raw bytes, not the parsed body. A parse-and-reserialise round trip
    // changes whitespace and key order and breaks the signature, which is why
    // main.ts captures rawBody on this route specifically.
    const rawBody: Buffer | undefined = req.rawBody;

    if (!this.client.verifyWebhook(req.headers ?? {}, rawBody)) {
      // Deliberately vague to the caller. The detail is in the log, which is
      // also where the rejection counter for the alert comes from — a spike
      // means a misconfigured secret or somebody probing.
      this.logger.warn(
        "[21pay] webhook rejected: signature, freshness or raw body invalid",
      );
      throw new UnauthorizedException("Invalid signature");
    }

    return true;
  }
}
