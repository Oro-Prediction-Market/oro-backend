import * as crypto from "node:crypto";
import { UnauthorizedException } from "@nestjs/common";
import { CryptoWebhookService } from "../payment/crypto-webhook.service";
import { Pay21WebhookGuard } from "../payment/guards/pay21-webhook.guard";
import { TwentyOnePayClient } from "../payment/services/twentyone-pay/twentyone-pay.client";

const TID = "11111111-2222-3333-4444-555555555555";
const SUBJ = (action: string, net = "tron") =>
  `payment.tenants.${TID}.deposits.${net}.${action}`;

function build(existing: any = null) {
  const saved: any[] = [];
  const repo: any = {
    findOne: jest.fn().mockResolvedValue(existing),
    create: jest.fn().mockImplementation((d: any) => ({ id: "ev-1", ...d })),
    save: jest.fn().mockImplementation((d: any) => {
      saved.push(d);
      return Promise.resolve(d);
    }),
    update: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn(),
  };
  return { service: new CryptoWebhookService(repo), saved, repo };
}

describe("CryptoWebhookService.parseSubject", () => {
  it("parses the full NATS subject, not the short label from the docs", () => {
    // X-T1Pay-Event carries e.g.
    // payment.tenants.<tid>.deposits.tron.confirmed — 21Pay's docs show
    // "deposit.confirmed", which the engine never sends.
    const { service } = build();
    expect(service.parseSubject(SUBJ("confirmed"))).toEqual({
      family: "deposits",
      network: "tron",
      action: "confirmed",
    });
    expect(
      service.parseSubject(`payment.tenants.${TID}.payouts.base.failed`),
    ).toEqual({ family: "payouts", network: "base", action: "failed" });
  });

  it("returns nulls for a subject it cannot read", () => {
    const { service } = build();
    expect(service.parseSubject("")).toEqual({
      family: null,
      network: null,
      action: null,
    });
  });
});

describe("CryptoWebhookService.record", () => {
  const payload = {
    intent_id: "int-1",
    tx_hash: "0xabc",
    amount: "10000000",
    currency: "USDT",
    network: "tron",
  };

  it("records every deposit action the engine actually publishes", async () => {
    for (const action of [
      "detected",
      "accepted",
      "confirmed",
      "confirmed_partial",
      "confirmed_overpaid",
      "completed_via_topup",
      "expired",
      "unexpected",
    ]) {
      const { service, saved } = build();
      const res = await service.record(SUBJ(action), payload);
      expect({ action, recorded: !!res.event }).toEqual({
        action,
        recorded: true,
      });
      expect(saved[0].eventAction).toBe(action);
    }
  });

  it("keeps the amount as the string it arrived as", async () => {
    // Converting at write time and again at credit time is two chances to be
    // wrong about decimals.
    const { service, saved } = build();
    await service.record(SUBJ("confirmed"), payload);
    expect(saved[0].amount).toBe("10000000");
    expect(typeof saved[0].amount).toBe("string");
  });

  it("drops subjects we have no handler for rather than failing", async () => {
    // We subscribe with a wildcard because enumerating subjects is
    // unmaintainable; the cost is silently ignoring the rest.
    const { service, saved } = build();
    for (const s of [
      `payment.tenants.${TID}.sweeps.tron.requested`,
      `payment.tenants.${TID}.freeze.tron.added`,
      `payment.tenants.${TID}.deposits.tron.invented`,
      `payment.reorg.deposits.tron.reorged`,
    ]) {
      const res = await service.record(s, payload);
      expect({ s, event: res.event }).toEqual({ s, event: null });
    }
    expect(saved).toHaveLength(0);
  });

  it("recognises a delivery it has already seen", async () => {
    // There is no delivery-id header, so the key is built from the payload:
    // (action, intent_id, tx_hash) — the same triple the publisher's own
    // idempotency key uses.
    const { service, saved, repo } = build({ id: "ev-existing" });
    const res = await service.record(SUBJ("confirmed"), payload);

    expect(res.duplicate).toBe(true);
    expect(saved).toHaveLength(0);
    expect(repo.findOne).toHaveBeenCalledWith({
      where: {
        eventAction: "confirmed",
        pay21IntentId: "int-1",
        txHash: "0xabc",
      },
    });
  });

  it("still records an event that has no natural key", async () => {
    // An expiry carries no tx_hash, so the partial unique index does not cover
    // it. It must not be silently dropped for lacking a key.
    const { service, saved } = build();
    const res = await service.record(SUBJ("expired"), { intent_id: "int-1" });
    expect(res.event).not.toBeNull();
    expect(saved[0].txHash).toBeNull();
  });
});

describe("Pay21WebhookGuard", () => {
  const SECRET = "whsec_test_secret";
  const client = new TwentyOnePayClient({
    get: (k: string) =>
      k === "TWENTYONE_PAY_WEBHOOK_SECRET" ? SECRET : undefined,
  } as any);
  const guard = new Pay21WebhookGuard(client);

  const ctx = (headers: any, rawBody?: Buffer) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ headers, rawBody }) }) }) as any;

  const sign = (ts: string, body: string, secret = SECRET) =>
    crypto.createHmac("sha256", secret).update(`t=${ts}.${body}`).digest("hex");

  it("accepts a correctly signed delivery", () => {
    const body = '{"intent_id": "int-1"}';
    const ts = String(Math.floor(Date.now() / 1000));
    expect(
      guard.canActivate(
        ctx(
          { "x-t1pay-timestamp": ts, "x-t1pay-signature": sign(ts, body) },
          Buffer.from(body),
        ),
      ),
    ).toBe(true);
  });

  it("rejects a body that was parsed and re-serialised", () => {
    // The failure this guards against is our own middleware, not an attacker.
    // Nest's parser runs first and body-parser skips an already-consumed
    // request, so a second parser's `verify` never fires and rawBody is
    // quietly undefined — every real delivery then fails.
    const onTheWire = '{"intent_id": "int-1", "amount": "10000000"}';
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = {
      "x-t1pay-timestamp": ts,
      "x-t1pay-signature": sign(ts, onTheWire),
    };

    expect(guard.canActivate(ctx(headers, Buffer.from(onTheWire)))).toBe(true);

    const reserialised = Buffer.from(JSON.stringify(JSON.parse(onTheWire)));
    expect(reserialised.equals(Buffer.from(onTheWire))).toBe(false);
    expect(() => guard.canActivate(ctx(headers, reserialised))).toThrow(
      UnauthorizedException,
    );
  });

  it("rejects a missing raw body, a stale delivery and a bad signature alike", () => {
    const body = '{"a":1}';
    const now = String(Math.floor(Date.now() / 1000));
    const stale = String(Math.floor(Date.now() / 1000) - 400);

    // One message for all three. The engine checks freshness before the HMAC,
    // making stale and forged indistinguishable to a caller; we match that so
    // the route cannot be used to probe which signatures are well-formed.
    const cases = [
      ctx({ "x-t1pay-timestamp": now, "x-t1pay-signature": sign(now, body) }),
      ctx(
        { "x-t1pay-timestamp": stale, "x-t1pay-signature": sign(stale, body) },
        Buffer.from(body),
      ),
      ctx(
        { "x-t1pay-timestamp": now, "x-t1pay-signature": sign(now, body, "wrong") },
        Buffer.from(body),
      ),
      ctx({}, Buffer.from(body)),
    ];
    const messages = cases.map((c) => {
      try {
        guard.canActivate(c);
        return "ACCEPTED";
      } catch (e: any) {
        return e.message;
      }
    });
    expect(messages).toEqual([
      "Invalid signature",
      "Invalid signature",
      "Invalid signature",
      "Invalid signature",
    ]);
  });
});
