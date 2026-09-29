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
  };
  const cryptoSettlement = {
    settle: jest.fn(async () => ({ handled: true, credited: true })),
  };

  const controller = Object.create(PaymentController.prototype);
  Object.assign(controller, { cryptoWebhook, cryptoHd, cryptoSettlement });
  return { controller, cryptoHd, cryptoSettlement, webhookRepo };
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
    const { end_user_id, ...invoiceBody } = hdBody;
    await controller.usdtWebhook(
      invoiceBody,
      `${TENANT}.deposits.tron.confirmed`,
    );
    expect(cryptoSettlement.settle).toHaveBeenCalledTimes(1);
    expect(cryptoHd.credit).not.toHaveBeenCalled();
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
