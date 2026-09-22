/**
 * DKGatewayService.checkTransferStatus — DK's new-core status endpoint.
 *
 * This is the only call in the withdrawal path allowed to authorise a refund,
 * so its failure verdict has to be earned rather than assumed. A lookup that
 * cannot answer — the reference is not indexed yet, our query was malformed,
 * our key lacks the scope, DK sent a code we have never seen — is `pending`,
 * never `failed`. "I cannot tell you" is not "it was refused", and reading it
 * as one refunds a transfer that is still on its way to the user's bank.
 */
import { DKGatewayService } from "../payment/services/dk-gateway/dk-gateway.service";

function makeGateway() {
  const configService: any = { get: () => "", getOrThrow: () => "x" };
  const gateway = new DKGatewayService(configService, {} as any);
  const dkPost = jest.fn();
  (gateway as any).dkPost = dkPost;
  return { gateway, dkPost };
}

async function status(gateway: DKGatewayService) {
  return gateway.checkTransferStatus({
    referenceNo: "PN-123",
    beneAccountNumber: "110000000001",
  });
}

describe("DKGatewayService.checkTransferStatus — request", () => {
  it("asks the new-core endpoint, scoped to the beneficiary account", async () => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({ response_code: "0001", response_data: { status: "validating" } });
    await status(gateway);
    expect(dkPost).toHaveBeenCalledWith(
      "/v1/intra-transaction/status",
      { reference_no: "PN-123", bene_account_number: "110000000001" },
      true,
    );
  });
});

describe("DKGatewayService.checkTransferStatus — settled", () => {
  it("reads settled_at as settled", async () => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({
      response_code: "0000",
      response_data: { status: "settled", settled_at: "2026-09-22T10:00:00Z" },
    });
    expect((await status(gateway)).verdict).toBe("success");
  });

  it("reads 0000 with a settled status word as settled", async () => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({ response_code: "0000", response_data: { status: "settled" } });
    expect((await status(gateway)).verdict).toBe("success");
  });

  it("reads 0000 with no status word as settled", async () => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({ response_code: "0000", response_data: {} });
    expect((await status(gateway)).verdict).toBe("success");
  });

  // Money in the user's account is the fact; DK's wording is a description of
  // it. A settlement timestamp on a row DK also calls rejected is the one
  // combination where refunding would definitely double-pay.
  it("lets settled_at override a rejection word", async () => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({
      response_code: "0000",
      response_data: { status: "rejected", settled_at: "2026-09-22T10:00:00Z" },
    });
    expect((await status(gateway)).verdict).toBe("success");
  });

  it("returns the settlement timestamp", async () => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({
      response_code: "0000",
      response_data: { status: "settled", settled_at: "2026-09-22T10:00:00Z" },
    });
    expect((await status(gateway)).settledAt).toBe("2026-09-22T10:00:00Z");
  });
});

describe("DKGatewayService.checkTransferStatus — refused", () => {
  it.each(["rejected", "failed", "REVERSED", "Transaction Unsuccessful", "cancelled"])(
    "reads %p with no settlement timestamp as refused",
    async (word) => {
      const { gateway, dkPost } = makeGateway();
      dkPost.mockResolvedValue({ response_code: "0000", response_data: { status: word } });
      expect((await status(gateway)).verdict).toBe("failed");
    },
  );
});

describe("DKGatewayService.checkTransferStatus — cannot tell yet", () => {
  it.each([
    ["validating", "still in flight"],
    ["initiated", "not yet approved"],
    ["approved", "approved but not settled"],
  ])("reads status %p (%s) as pending", async (word) => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({ response_code: "0001", response_data: { status: word } });
    expect((await status(gateway)).verdict).toBe("pending");
  });

  // Each of these is a fact about the lookup, not about the transfer. LuckyPem
  // classifies them as failures, which is why a bare 3001 there refunds a live
  // transfer; 4008 would refund every pending withdrawal at once.
  it.each([
    ["3001", "reference not indexed yet"],
    ["4002", "our query was malformed"],
    ["4008", "our key lacks the status scope"],
    ["2012", "DK gateway exception, transient"],
    ["5002", "DK database error"],
    ["9999", "a code DK has never sent us"],
  ])("reads response code %s (%s) as pending, never refused", async (code) => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({ response_code: code });
    expect((await status(gateway)).verdict).toBe("pending");
  });

  // Kept ambiguous deliberately. DK's 20 Sep notice calls 2001 final on the new
  // core, but Oro saw 2001 carrying "Fail due to rejection" on transfers that
  // could not be safely refunded, so it keeps polling instead.
  it("reads 2001 as pending rather than a final refusal", async () => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({ response_code: "2001" });
    expect((await status(gateway)).verdict).toBe("pending");
  });

  // A settled word is matched whole. Substring matching reads the "settled" in
  // "not settled" as a settlement, and the money-moved verdict is the one that
  // must never be reached by accident.
  it.each(["not settled", "settlement pending", "awaiting posting"])(
    "does not read %p as settled",
    async (word) => {
      const { gateway, dkPost } = makeGateway();
      dkPost.mockResolvedValue({ response_code: "0000", response_data: { status: word } });
      expect((await status(gateway)).verdict).toBe("pending");
    },
  );

  it("reads an empty response as pending", async () => {
    const { gateway, dkPost } = makeGateway();
    dkPost.mockResolvedValue({});
    expect((await status(gateway)).verdict).toBe("pending");
  });
});
