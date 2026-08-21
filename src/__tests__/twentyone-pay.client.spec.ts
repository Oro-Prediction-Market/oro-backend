import { TwentyOnePayClient } from "../payment/services/twentyone-pay/twentyone-pay.client";
import { CryptoNetwork } from "../payment/services/twentyone-pay/twentyone-pay.types";

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
    const calls: { method: string; url: string }[] = [];
    let i = 0;
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({ method: init?.method ?? "GET", url: String(url) });
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
