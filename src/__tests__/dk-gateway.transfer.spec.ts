/**
 * DKGatewayService.transferToAccount — response-code classification.
 *
 * The withdrawal money-safety flow depends on this mapping: only a DEFINITE
 * rejection (no money moved) may be reported as FAILED (→ caller refunds).
 * An INDETERMINATE outcome (timeout / no-response / internal error — the money
 * may have moved) must be reported as AMBIGUOUS (→ caller leaves PROCESSING,
 * never refunds), so a settled transfer can never be double-paid by a refund.
 */
import { DKGatewayService } from "../payment/services/dk-gateway/dk-gateway.service";

function makeGateway() {
  const configService: any = {
    get: () => "",
    getOrThrow: () => "x",
  };
  const gateway = new DKGatewayService(configService, {} as any);
  // Stub the private HTTP call so we control DK's raw response_code.
  const dkPost = jest.fn();
  (gateway as any).dkPost = dkPost;
  return { gateway, dkPost };
}

async function transfer(dkPost: jest.Mock, gateway: DKGatewayService) {
  return gateway.transferToAccount({
    accountNumber: "110000000001",
    accountName: "Test User",
    amount: 100,
    reference: "pay-1",
  });
}

describe("DKGatewayService.transferToAccount — status classification", () => {
  it("maps 0000 to SUCCESS", async () => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({
      response_code: "0000",
      response_data: { transaction_id: "T1" },
    });
    const res = await transfer(dkPost, gateway);
    expect(res.status).toBe("SUCCESS");
  });

  it.each([
    ["2002", "timeout"],
    ["2001", "no-response"],
    ["2004", "internal failure"],
    ["5001", "exception"],
    ["5002", "db error"],
  ])("maps indeterminate code %s (%s) to AMBIGUOUS (never refundable)", async (code) => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({ response_code: code });
    const res = await transfer(dkPost, gateway);
    expect(res.status).toBe("AMBIGUOUS");
  });

  it.each([
    ["3001", "account not found"],
    ["4002", "invalid params"],
    ["2008", "restriction"],
  ])("maps definite-rejection code %s (%s) to FAILED (safe to refund)", async (code) => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({ response_code: code });
    const res = await transfer(dkPost, gateway);
    expect(res.status).toBe("FAILED");
  });

  it("still throws (transport error) when the HTTP call itself fails", async () => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockRejectedValue(new Error("socket hang up"));
    await expect(transfer(dkPost, gateway)).rejects.toThrow("DK Bank transfer failed");
  });
});
