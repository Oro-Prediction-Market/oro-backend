import { TwentyOnePayClient } from "../payment/services/twentyone-pay/twentyone-pay.client";
import { CryptoNetwork } from "../payment/services/twentyone-pay/twentyone-pay.types";
import * as crypto from "node:crypto";

/**
 * The duplicate-destination recovery.
 *
 * 21 Pay answers a re-submitted address with 409 ("idempotency key already
 * used"). The two sides drift easily — an earlier attempt whose local write
 * failed, or an address added straight in their console — and before this,
 * that left the user permanently unable to withdraw to their own address.
 */
describe("TwentyOnePayClient.createWithdrawalDestination", () => {
  const TRON_ADDR = "TPB9fSJQx7eKM1pSKdNbJjxDJLff47saE1";
  const EVM_ADDR = "0x0f5CbE2Cd1A325D85C8cB5A0e8954fdaD8b589F2";

  function build(responses: { status: number; body: unknown }[]) {
    // `init` is captured too: the signing tests below assert over the exact
    // headers and body that went out, which is the only way to prove the
    // signed bytes and the sent bytes are the same bytes.
    const calls: { method: string; url: string; init: any }[] = [];
    let i = 0;
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({ method: init?.method ?? "GET", url: String(url), init });
      const r = responses[Math.min(i++, responses.length - 1)];
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        text: async () => JSON.stringify(r.body),
      } as any;
    }) as any;

    const config = {
      get: (k: string) =>
        ({
          TWENTYONE_PAY_BASE_URL: "https://pay.example/v1",
          TWENTYONE_PAY_NETWORKS: "tron,arbitrum,ethereum",
          TWENTY_ONE_PAY_API: "tk_test",
        })[k],
    };
    return { client: new TwentyOnePayClient(config as any), calls };
  }

  it("signs every request as HMAC-SHA256(apiKey, timestamp + body), hex", async () => {
    // The production engine answers 401 `hmac: auth: missing X-T1Pay-Timestamp
    // header` to an unsigned call, and `signature does not match` to a wrongly
    // signed one. Staging enforced neither, so nothing caught this until a
    // base-URL change pointed the same code at production.
    const { client, calls } = build([
      { status: 200, body: { networks: [] } },
    ]);

    await client.listNetworks();

    const headers = calls[0].init.headers as Record<string, string>;
    const ts = headers["X-T1Pay-Timestamp"];
    expect(ts).toMatch(/^\d+$/);
    // Whole seconds, not milliseconds — a millisecond value is ~1000x outside
    // any sane clock tolerance and reads as an expired request.
    expect(Number(ts)).toBeCloseTo(Math.floor(Date.now() / 1000), -1);

    const expected = crypto
      .createHmac("sha256", "tk_test")
      .update(ts + "")
      .digest("hex");
    expect(headers["X-T1Pay-Signature"]).toBe(expected);
    expect(headers.Authorization).toBe("Bearer tk_test");
  });

  it("signs the exact bytes it sends on a request with a body", async () => {
    // Signing a separately-stringified copy would pass this suite and fail in
    // production the moment key order or spacing differed between the two.
    const { client, calls } = build([
      {
        status: 200,
        body: { id: "pi_1", status: "awaiting_deposit", deposit_address: "T1" },
      },
    ]);

    await client.createPaymentIntent({
      idempotencyKey: "pay-1",
      network: "tron" as any,
      amountBaseUnits: "1000000",
      expiresAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const { init } = calls[0];
    const headers = init.headers as Record<string, string>;
    const expected = crypto
      .createHmac("sha256", "tk_test")
      .update(headers["X-T1Pay-Timestamp"] + String(init.body))
      .digest("hex");
    expect(headers["X-T1Pay-Signature"]).toBe(expected);
  });

  it("adopts the existing entry when 21 Pay says it already has one", async () => {
    const { client, calls } = build([
      { status: 409, body: { error: { message: "idempotency key already used" } } },
      {
        status: 200,
        body: {
          items: [
            {
              id: "remote-1",
              network: "tron",
              address: TRON_ADDR,
              status: "active",
              active_at: "2026-08-21T09:49:14Z",
            },
          ],
        },
      },
    ]);

    const res = await client.createWithdrawalDestination({
      network: CryptoNetwork.TRON,
      address: TRON_ADDR,
    });

    expect(res.id).toBe("remote-1");
    // The cooldown comes across too, so approval is not attempted before
    // 21 Pay will honour the payout.
    expect(res.active_at).toBe("2026-08-21T09:49:14Z");
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET"]);
  });

  it("reads the paginated shape, not a bare array", async () => {
    // The API returns `{ items: [...] }`. Treating it as an array yielded an
    // object with no `.find`, which would have broken the recovery above.
    const { client } = build([
      { status: 409, body: {} },
      { status: 200, body: { items: [{ id: "r2", network: "tron", address: TRON_ADDR, status: "active" }] } },
    ]);
    await expect(
      client.createWithdrawalDestination({
        network: CryptoNetwork.TRON,
        address: TRON_ADDR,
      }),
    ).resolves.toMatchObject({ id: "r2" });
  });

  it("matches an EVM address regardless of case", async () => {
    // EIP-55 casing is a checksum, not part of the address. A byte comparison
    // would miss the duplicate 21 Pay is objecting to.
    const { client } = build([
      { status: 409, body: {} },
      {
        status: 200,
        body: {
          items: [
            { id: "r3", network: "arbitrum", address: EVM_ADDR.toLowerCase(), status: "active" },
          ],
        },
      },
    ]);
    await expect(
      client.createWithdrawalDestination({
        network: CryptoNetwork.ARBITRUM,
        address: EVM_ADDR,
      }),
    ).resolves.toMatchObject({ id: "r3" });
  });

  it("does not fold case on Tron, where base58 is case-sensitive", async () => {
    // Two different Tron addresses can differ only in case; treating them as
    // one would adopt the wrong destination and send money elsewhere.
    const { client } = build([
      { status: 409, body: {} },
      {
        status: 200,
        body: {
          items: [
            { id: "r4", network: "tron", address: TRON_ADDR.toLowerCase(), status: "active" },
          ],
        },
      },
    ]);
    await expect(
      client.createWithdrawalDestination({
        network: CryptoNetwork.TRON,
        address: TRON_ADDR,
      }),
    ).rejects.toThrow(/409/);
  });

  it("still fails when the conflict is not about our address", async () => {
    const { client } = build([
      { status: 409, body: {} },
      { status: 200, body: { items: [] } },
    ]);
    await expect(
      client.createWithdrawalDestination({
        network: CryptoNetwork.TRON,
        address: TRON_ADDR,
      }),
    ).rejects.toThrow(/409/);
  });

  it("does not swallow other failures", async () => {
    const { client } = build([{ status: 500, body: {} }]);
    await expect(
      client.createWithdrawalDestination({
        network: CryptoNetwork.TRON,
        address: TRON_ADDR,
      }),
    ).rejects.toThrow(/500/);
  });
});
