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

/**
 * Regression guard for the defect that silently confirmed every rejected
 * payout: `success` used to fall back to
 * `response_message.toUpperCase().includes("SUCCESS")`, and
 * `"UNSUCCESSFUL".includes("SUCCESS")` is true. Every DK rejection whose
 * message contained that word was reported as SUCCESS — the user's debit
 * stood, the refund branch was skipped, and no money ever reached the bank.
 */
describe("DKGatewayService.transferToAccount — message must not override the code", () => {
  it.each([
    "Transaction Unsuccessful",
    "TRANSACTION UNSUCCESSFUL",
    "Payment was not successful",
  ])("does not read %p as a success", async (message) => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({ response_code: "3001", response_message: message });
    const res = await transfer(dkPost, gateway);
    expect(res.status).not.toBe("SUCCESS");
    expect(res.status).toBe("FAILED");
  });

  it("does not read a success message on an indeterminate code as SUCCESS", async () => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({
      response_code: "2002",
      response_message: "Transaction unsuccessful - timed out",
    });
    const res = await transfer(dkPost, gateway);
    expect(res.status).toBe("AMBIGUOUS");
  });

  // Deliberately still SUCCESS: DK's payout response shape has never been
  // captured, so refusing an unreferenced 0000 would park every payout in
  // PROCESSING if the real field name is not one of the four checked below.
  it("keeps 0000 with no reference as SUCCESS, with a null id", async () => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({ response_code: "0000", response_data: {} });
    const res = await transfer(dkPost, gateway);
    expect(res.status).toBe("SUCCESS");
    expect(res.txnId).toBeNull();
  });

  // DK does not always send `transaction_id`: the pull-payment flow returns
  // `txn_status_id` and batch mode returns only `bfs_txn_id`. Demanding
  // `transaction_id` specifically would park every good payout in PROCESSING.
  it.each([
    ["txn_status_id", { txn_status_id: "S1" }, "S1"],
    ["inquiry_id", { inquiry_id: "Q1" }, "Q1"],
    ["bfs_txn_id", { bfs_txn_id: "B1" }, "B1"],
  ])("accepts 0000 carrying only %s", async (_label, data, expected) => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({ response_code: "0000", response_data: data });
    const res = await transfer(dkPost, gateway);
    expect(res.status).toBe("SUCCESS");
    expect(res.txnId).toBe(expected);
  });

  it("accepts 0000 carrying txn_id as well as transaction_id", async () => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({
      response_code: "0000",
      response_data: { txn_id: "T2" },
    });
    const res = await transfer(dkPost, gateway);
    expect(res.status).toBe("SUCCESS");
    expect(res.txnId).toBe("T2");
  });
});
