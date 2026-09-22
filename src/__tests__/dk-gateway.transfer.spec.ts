/**
 * DKGatewayService.transferToAccount — response-code classification.
 *
 * The withdrawal money-safety flow depends on this mapping. FAILED refunds the
 * user, so it is stated as an allowlist: a code reaches it only by being a
 * rejection DK documents as final, where the request was turned down and no
 * money moved. Everything else — a timeout, an internal error, the new core's
 * pending `0001`, or a code DK has never sent us before — is AMBIGUOUS, which
 * parks the withdrawal in PROCESSING with the debit intact for the reconciler
 * to resolve against /v1/intra-transaction/status.
 *
 * The allowlist is the whole design. An inverted list, where anything
 * unrecognised falls through to FAILED, is what refunded four withdrawals DK
 * had accepted: `0001` was in neither list. An unknown code is not a rejection,
 * it is the absence of an answer, and the safe reading of no answer is "wait".
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
    ["0001", "accepted by the new core, still validating"],
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

  // 2011 carries its real reason in response_data — invalid OTP, account
  // closed, insufficient funds — so the code alone does not establish that no
  // money moved. It stays off the allowlist until one of us has read one.
  it("maps 2011 (third-party rejection) to AMBIGUOUS, not FAILED", async () => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({ response_code: "2011" });
    const res = await transfer(dkPost, gateway);
    expect(res.status).toBe("AMBIGUOUS");
  });

  // The regression the allowlist exists to prevent: 0001 was in neither list
  // and fell through to FAILED, refunding transfers DK went on to settle.
  it.each([
    ["9999", "a code DK has never sent us"],
    ["4008", "permission denied"],
    ["0002", "a plausible future new-core code"],
  ])("maps unrecognised code %s (%s) to AMBIGUOUS, never FAILED", async (code) => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({ response_code: code });
    const res = await transfer(dkPost, gateway);
    expect(res.status).toBe("AMBIGUOUS");
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

/**
 * DK's new core system (source accounts starting with 8) answers an initiate
 * call with `0001` and a different response_data shape: `payment_number` is the
 * handle its status API wants, and `external_id` echoes the request id. Neither
 * is `transaction_id`, so without capturing them a pending payout reaches the
 * reconciler with no reference at all and needs a human holding DK's statement.
 */
describe("DKGatewayService.transferToAccount — new-core pending handles", () => {
  it("captures payment_number from a 0001 response", async () => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({
      response_code: "0001",
      response_data: { payment_number: "PN-123", external_id: "REQ-9" },
    });
    const res = await transfer(dkPost, gateway);
    expect(res.paymentNumber).toBe("PN-123");
  });

  it("captures external_id as the request id from a 0001 response", async () => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({
      response_code: "0001",
      response_data: { payment_number: "PN-123", external_id: "REQ-9" },
    });
    const res = await transfer(dkPost, gateway);
    expect(res.requestId).toBe("REQ-9");
  });

  it("uses payment_number as the reconcilable handle when it is the only one", async () => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({
      response_code: "0001",
      response_data: { payment_number: "PN-123" },
    });
    const res = await transfer(dkPost, gateway);
    expect(res.txnId).toBe("PN-123");
  });

  it("falls back to external_id when DK sends no payment_number", async () => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({
      response_code: "0001",
      response_data: { external_id: "REQ-9" },
    });
    const res = await transfer(dkPost, gateway);
    expect(res.txnId).toBe("REQ-9");
  });

  it("leaves the pending handles null on a settled response", async () => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({
      response_code: "0000",
      response_data: { transaction_id: "T1" },
    });
    const res = await transfer(dkPost, gateway);
    expect(res.paymentNumber).toBeNull();
    expect(res.requestId).toBeNull();
  });
});
