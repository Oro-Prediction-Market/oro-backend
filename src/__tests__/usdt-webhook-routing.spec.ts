import { PaymentController } from "../payment/payment.controller";
import { CryptoWebhookService } from "../payment/crypto-webhook.service";

/**
 * Which service a verified 21 Pay delivery reaches.
 *
 * The rule from 21 Pay's HD contract: `credited` with `end_user_id` is the only
 * deposit event that credits a permanent address; every other HD deposit
 * event is ignored; invoice payments (no `end_user_id`) behave as before, and
 * their own `credited` must not credit a second time.
 */
const TENANT = "payment.tenants.da890606-5622-4c3d-93a0-e4d84bd4442d";

function build() {
  const webhookRepo: any = {
    findOne: async () => null,
    create: (e: any) => e,
    save: async (e: any) => ({ id: "evt-1", ...e }),
    update: jest.fn(async () => undefined),
  };
  const cryptoWebhook = new CryptoWebhookService(webhookRepo);
  const cryptoHd = {
    credit: jest.fn(async (_e: any) => ({ handled: true, credited: true })),
    // Only the permanent address below is ours.
    isPermanentAddress: jest.fn(
      async (_n: string, a?: string | null) => a === "TA42skAP",
    ),
  };
  const cryptoSettlement = {
    settle: jest.fn(async () => ({ handled: true, credited: true })),
  };
  const cryptoWithdrawal = {
    handleWebhook: jest.fn(async (_p: any) => ({ handled: true })),
  };

  const controller = Object.create(PaymentController.prototype);
  Object.assign(controller, {
    cryptoWebhook,
    cryptoHd,
    cryptoSettlement,
    cryptoWithdrawal,
  });
  return { controller, cryptoHd, cryptoSettlement, cryptoWithdrawal, webhookRepo };
}

const hdBody = {
  intent_id: "8f716410-9844-4ce9-a41c-c5aec7996cf0",
  end_user_id: "11111111-1111-4111-8111-111111111111",
  network: "tron",
  amount: "1000000",
  tx_hash: "aefacc37",
  deposit_address: "TA42skAP",
};

describe("usdtWebhook routing", () => {
  it("HD credited → HD credit, not invoice settlement", async () => {
    const { controller, cryptoHd, cryptoSettlement } = build();
    const res = await controller.usdtWebhook(
      hdBody,
      `${TENANT}.deposits.tron.credited`,
    );
    expect(cryptoHd.credit).toHaveBeenCalledTimes(1);
    expect(cryptoHd.credit.mock.calls[0][0]).toMatchObject({
      intentId: hdBody.intent_id,
      endUserId: hdBody.end_user_id,
      amountBaseUnits: "1000000",
    });
    expect(cryptoSettlement.settle).not.toHaveBeenCalled();
    expect(res.credited).toBe(true);
  });

  it.each(["detected", "confirmed", "accepted"])(
    "HD %s → recorded, nothing credited",
    async (action) => {
      const { controller, cryptoHd, cryptoSettlement, webhookRepo } = build();
      const res = await controller.usdtWebhook(
        hdBody,
        `${TENANT}.deposits.tron.${action}`,
      );
      expect(cryptoHd.credit).not.toHaveBeenCalled();
      expect(cryptoSettlement.settle).not.toHaveBeenCalled();
      expect(res.credited).toBe(false);
      // Marked processed with no error: ignoring it is the correct outcome.
      expect(webhookRepo.update).toHaveBeenCalledWith(
        { id: "evt-1" },
        expect.objectContaining({ processError: null }),
      );
    },
  );

  it("invoice credited (no end_user_id) → neither path credits", async () => {
    const { controller, cryptoHd, cryptoSettlement } = build();
    const { end_user_id, ...invoiceBody } = hdBody;
    const res = await controller.usdtWebhook(
      invoiceBody,
      `${TENANT}.deposits.tron.credited`,
    );
    expect(cryptoHd.credit).not.toHaveBeenCalled();
    expect(cryptoSettlement.settle).not.toHaveBeenCalled();
    expect(res.credited).toBe(false);
  });

  it("invoice confirmed → invoice settlement, as before", async () => {
    const { controller, cryptoHd, cryptoSettlement } = build();
    // An invoice pays to its own per-intent address, never a permanent one.
    const { end_user_id, deposit_address, ...rest } = hdBody;
    const invoiceBody = { ...rest, to: "TInvoiceAddr" };
    await controller.usdtWebhook(
      invoiceBody,
      `${TENANT}.deposits.tron.confirmed`,
    );
    expect(cryptoSettlement.settle).toHaveBeenCalledTimes(1);
    expect(cryptoHd.credit).not.toHaveBeenCalled();
  });

  it.each(["detected", "accepted", "confirmed"])(
    "HD %s without end_user_id (only `to`) → ignored, not sent to invoice settlement",
    async (action) => {
      const { controller, cryptoHd, cryptoSettlement, webhookRepo } = build();
      const res = await controller.usdtWebhook(
        {
          intent_id: hdBody.intent_id,
          network: "tron",
          tx_hash: "3b50",
          to: "TA42skAP",
          amount: "1000000",
        },
        `${TENANT}.deposits.tron.${action}`,
      );
      expect(cryptoSettlement.settle).not.toHaveBeenCalled();
      expect(cryptoHd.credit).not.toHaveBeenCalled();
      expect(res.credited).toBe(false);
      expect(webhookRepo.update).toHaveBeenCalledWith(
        { id: "evt-1" },
        expect.objectContaining({ processError: null }),
      );
    },
  );

  it("an invoice confirmed to an address that is not ours still settles", async () => {
    const { controller, cryptoSettlement } = build();
    await controller.usdtWebhook(
      { intent_id: "inv-1", network: "tron", tx_hash: "ab", to: "TInvoiceAddr", amount: "5000000" },
      `${TENANT}.deposits.tron.confirmed`,
    );
    expect(cryptoSettlement.settle).toHaveBeenCalledTimes(1);
  });

  it.each(["broadcasting", "completed", "failed", "rejected"])(
    "withdrawals.tron.%s → withdrawal handler, never deposit settlement",
    async (status) => {
      const { controller, cryptoWithdrawal, cryptoSettlement, cryptoHd } = build();
      const body = {
        id: "99ae0e68-0000-4000-8000-000000000000",
        status,
        idempotency_key: "wd:u1:r1",
        end_user_id: "11111111-1111-4111-8111-111111111111",
        amount: "25000000",
        tx_hash: "aa99",
      };
      await controller.usdtWebhook(body, `${TENANT}.withdrawals.tron.${status}`);
      expect(cryptoWithdrawal.handleWebhook).toHaveBeenCalledWith(body);
      expect(cryptoSettlement.settle).not.toHaveBeenCalled();
      expect(cryptoHd.credit).not.toHaveBeenCalled();
    },
  );

  it("a withdrawal handler failure surfaces, so 21 Pay retries", async () => {
    const { controller, cryptoWithdrawal } = build();
    cryptoWithdrawal.handleWebhook.mockRejectedValue(new Error("21 Pay read failed"));
    await expect(
      controller.usdtWebhook(
        { id: "p1", status: "completed", idempotency_key: "k", tx_hash: "t1" },
        `${TENANT}.withdrawals.tron.completed`,
      ),
    ).rejects.toThrow("21 Pay read failed");
  });

  it("payouts.* (21 Pay's own sweeps) are recorded and ignored", async () => {
    const { controller, cryptoWithdrawal, cryptoSettlement, webhookRepo } = build();
    await controller.usdtWebhook(
      { id: "sweep-1", tx_hash: "5d38", network: "tron" },
      `${TENANT}.payouts.tron.confirmed`,
    );
    expect(cryptoSettlement.settle).not.toHaveBeenCalled();
    expect(cryptoWithdrawal.handleWebhook).not.toHaveBeenCalled();
    expect(webhookRepo.update).toHaveBeenCalledWith(
      { id: "evt-1" },
      expect.objectContaining({ processError: null }),
    );
  });

  it("an unrecognised subject is acknowledged and ignored", async () => {
    const { controller, cryptoHd, cryptoSettlement } = build();
    const res = await controller.usdtWebhook(
      hdBody,
      `${TENANT}.deposits.tron.sender_flagged`,
    );
    expect(res).toEqual({ received: true, duplicate: false });
    expect(cryptoHd.credit).not.toHaveBeenCalled();
    expect(cryptoSettlement.settle).not.toHaveBeenCalled();
  });
});
