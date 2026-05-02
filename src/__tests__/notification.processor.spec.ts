/**
 * Tests for NotificationProcessor — verifies each job type calls the correct
 * TelegramSimpleService method with the right message shape.
 */
import { NotificationProcessor } from "../jobs/notification.processor";
import { JobName } from "../jobs/notification.queue";

function makeJob(name: string, data: object) {
  return { name, data } as any;
}

describe("NotificationProcessor", () => {
  let processor: NotificationProcessor;
  let mockTelegram: { sendMessage: jest.Mock; postToChannel: jest.Mock };

  beforeEach(() => {
    mockTelegram = {
      sendMessage: jest.fn().mockResolvedValue(undefined),
      postToChannel: jest.fn().mockResolvedValue(undefined),
    };
    processor = new NotificationProcessor(mockTelegram as any);
  });

  it("PAYMENT_SUCCESS: sends a DM to the user", async () => {
    await processor.process(
      makeJob(JobName.PAYMENT_SUCCESS, {
        userId: "123",
        paymentId: "p1",
        amount: 500,
        currency: "BTN",
      }),
    );
    expect(mockTelegram.sendMessage).toHaveBeenCalledWith(
      123,
      expect.stringContaining("500"),
    );
  });

  it("MARKET_SETTLED: posts to channel", async () => {
    await processor.process(
      makeJob(JobName.MARKET_SETTLED, {
        marketId: "m1",
        marketTitle: "Will BTC hit 100k?",
        winningOutcomeLabel: "Yes",
      }),
    );
    expect(mockTelegram.postToChannel).toHaveBeenCalledWith(
      expect.stringContaining("Will BTC hit 100k?"),
    );
    expect(mockTelegram.postToChannel).toHaveBeenCalledWith(
      expect.stringContaining("Yes"),
    );
  });

  it("BET_RESULT WON: sends win DM with payout", async () => {
    await processor.process(
      makeJob(JobName.BET_RESULT, {
        userId: "456",
        positionId: "pos1",
        marketTitle: "Champions League",
        outcomeLabel: "Real Madrid",
        status: "WON",
        payout: 350,
      }),
    );
    expect(mockTelegram.sendMessage).toHaveBeenCalledWith(
      456,
      expect.stringContaining("350"),
    );
  });

  it("BET_RESULT LOST: sends loss DM", async () => {
    await processor.process(
      makeJob(JobName.BET_RESULT, {
        userId: "456",
        positionId: "pos2",
        marketTitle: "Champions League",
        outcomeLabel: "Barcelona",
        status: "LOST",
      }),
    );
    expect(mockTelegram.sendMessage).toHaveBeenCalledWith(
      456,
      expect.stringContaining("Champions League"),
    );
  });

  it("STREAK_MILESTONE day-7 boost: sends boost message", async () => {
    await processor.process(
      makeJob(JobName.STREAK_MILESTONE, {
        userId: "u1",
        telegramId: "789",
        streakCount: 7,
        dayInCycle: 7,
        boostActive: true,
      }),
    );
    expect(mockTelegram.sendMessage).toHaveBeenCalledWith(
      789,
      expect.stringContaining("1.2x"),
    );
  });

  it("STREAK_MILESTONE day-3: sends milestone nudge", async () => {
    await processor.process(
      makeJob(JobName.STREAK_MILESTONE, {
        userId: "u1",
        telegramId: "789",
        streakCount: 3,
        dayInCycle: 3,
        boostActive: false,
      }),
    );
    expect(mockTelegram.sendMessage).toHaveBeenCalledWith(
      789,
      expect.stringContaining("3-day"),
    );
  });

  it("DAILY_CREDIT: sends credit notification", async () => {
    await processor.process(
      makeJob(JobName.DAILY_CREDIT, {
        userId: "u1",
        telegramId: "999",
        creditAmount: 20,
      }),
    );
    expect(mockTelegram.sendMessage).toHaveBeenCalledWith(
      999,
      expect.stringContaining("20"),
    );
  });

  it("unknown job: does not throw", async () => {
    await expect(
      processor.process(makeJob("unknown.job", {})),
    ).resolves.toBeUndefined();
  });
});
