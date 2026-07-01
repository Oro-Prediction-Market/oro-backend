import { UsersController } from "../users/users.controller";
import { ParimutuelEngine } from "../markets/parimutuel.engine";

/**
 * Verifies GET /users/me/referral returns a DIRECT Mini App deep link
 * (t.me/<bot>?startapp=ref_<telegramId>) so the referral code lands in
 * start_param on first launch — instead of the old bot-chat ?start= link that
 * required the invitee to also tap the bot's "Open Oro" button.
 */
describe("UsersController.getReferral link format", () => {
  function buildController(telegramId: string | null, botUsername = "OroPredictBot") {
    const userRepo = {
      findOne: jest.fn().mockResolvedValue(
        telegramId === null ? null : { id: "user-uuid", telegramId },
      ),
      count: jest.fn().mockResolvedValue(0),
    };
    const transactionRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ total: "0" }),
      }),
    };
    const config = { get: jest.fn().mockReturnValue(botUsername) };

    // Only userRepo, transactionRepo and config are used by getReferral.
    const controller = new UsersController(
      userRepo as any,
      {} as any, // paymentRepo
      transactionRepo as any,
      {} as any, // betRepo
      {} as any, // redis
      {} as any, // streakService
      config as any,
      {} as any, // seasonService
      {} as any, // onboardService
      {} as any, // dkGateway
    );
    return controller;
  }

  it("returns a direct ?startapp=ref_<telegramId> deep link", async () => {
    const controller = buildController("12345");
    const res = await controller.getReferral({ user: { userId: "user-uuid" } });

    expect(res.referralLink).toBe(
      "https://t.me/OroPredictBot?startapp=ref_12345",
    );
  });

  it("does NOT use the old bot-chat ?start= format", async () => {
    const controller = buildController("12345");
    const res = await controller.getReferral({ user: { userId: "user-uuid" } });

    expect(res.referralLink).not.toContain("?start=");
    expect(res.referralLink).toContain("?startapp=");
  });

  it("honours the configured bot username", async () => {
    const controller = buildController("999", "SomeOtherBot");
    const res = await controller.getReferral({ user: { userId: "user-uuid" } });

    expect(res.referralLink).toBe(
      "https://t.me/SomeOtherBot?startapp=ref_999",
    );
  });

  it("exposes the reward constants used to display terms", async () => {
    const controller = buildController("12345");
    const res = await controller.getReferral({ user: { userId: "user-uuid" } });

    expect(res.flatBonus).toBe(ParimutuelEngine.REFERRAL_FLAT_BONUS);
    expect(res.betPct).toBe(ParimutuelEngine.REFERRAL_BET_PCT * 100);
    expect(res.cap).toBe(ParimutuelEngine.REFERRAL_CAP);
  });
});
