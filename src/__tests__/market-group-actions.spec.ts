import { ForbiddenException } from "@nestjs/common";
import { MarketsService } from "../markets/markets.service";
import { MarketStatus } from "../entities/market.entity";
import { buildMarketAnnouncement } from "../telegram/market-announcement";

/**
 * Whole-group actions: a group is one Yes/No market per option, and closing,
 * cancelling, deleting or pinning "the market" has to reach every option,
 * through the same single-market path each option would take on its own.
 */
describe("MarketsService group actions", () => {
  const member = (name: string, status: MarketStatus, totalPool = 0) => ({
    id: `m-${name}`,
    title: `NBA MVP — ${name}`,
    groupTitle: "NBA MVP",
    groupId: "g1",
    status,
    totalPool,
    metadata: null,
  });

  function build(members: ReturnType<typeof member>[]) {
    const svc = Object.create(MarketsService.prototype) as any;
    svc.findGroup = jest.fn().mockResolvedValue(members);
    svc.transition = jest.fn().mockResolvedValue(undefined);
    svc.cancel = jest.fn().mockResolvedValue(undefined);
    svc.delete = jest.fn().mockResolvedValue(undefined);
    svc.invalidateMarketCache = jest.fn().mockResolvedValue(undefined);
    svc.marketRepo = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    svc.telegram = { postToChannel: jest.fn().mockResolvedValue(undefined) };
    return svc;
  }

  it("names an option by the title after the dash", () => {
    expect(
      MarketsService.optionName({
        title: "NBA MVP — Nikola Jokic",
        metadata: null,
      } as any),
    ).toBe("Nikola Jokic");
    expect(
      MarketsService.optionName({
        title: "x",
        metadata: { candidate: "Sonam" },
      } as any),
    ).toBe("Sonam");
  });

  it("closes only the options still open", async () => {
    const svc = build([
      member("A", MarketStatus.OPEN),
      member("B", MarketStatus.OPEN),
      member("C", MarketStatus.RESOLVING),
    ]);
    const r = await svc.closeGroup("g1");
    expect(svc.transition).toHaveBeenCalledTimes(2);
    expect(svc.transition).toHaveBeenCalledWith("m-A", MarketStatus.CLOSED);
    expect(r).toEqual({ closed: 2, skipped: 1, failed: [] });
  });

  it("reports an option that fails to close and carries on", async () => {
    const svc = build([
      member("A", MarketStatus.OPEN),
      member("B", MarketStatus.OPEN),
    ]);
    svc.transition.mockRejectedValueOnce(new Error("boom"));
    const r = await svc.closeGroup("g1");
    expect(r.closed).toBe(1);
    expect(r.failed).toEqual(["A: boom"]);
  });

  it("cancels unfinished options, never a paid-out one, and posts once", async () => {
    const svc = build([
      member("Open", MarketStatus.OPEN, 500),
      member("Closed", MarketStatus.CLOSED, 200),
      member("Settled", MarketStatus.SETTLED, 900),
      member("Gone", MarketStatus.CANCELLED),
    ]);
    const r = await svc.cancelGroup("g1");
    expect(svc.cancel.mock.calls.map((c: any[]) => c[0])).toEqual([
      "m-Open",
      "m-Closed",
    ]);
    // Per-option channel posts are off; the group posts one.
    for (const call of svc.cancel.mock.calls)
      expect(call[1]).toEqual({ channelPost: false });
    expect(svc.telegram.postToChannel).toHaveBeenCalledTimes(1);
    expect(svc.telegram.postToChannel.mock.calls[0][0]).toContain("NBA MVP");
    expect(r).toEqual({ cancelled: 2, skipped: 2, failed: [] });
  });

  it("posts nothing when there was nothing to cancel", async () => {
    const svc = build([member("Settled", MarketStatus.SETTLED, 900)]);
    await svc.cancelGroup("g1");
    expect(svc.cancel).not.toHaveBeenCalled();
    expect(svc.telegram.postToChannel).not.toHaveBeenCalled();
  });

  it("deletes the whole group, or nothing when any option has bets", async () => {
    const svc = build([
      member("Empty", MarketStatus.OPEN, 0),
      member("Bet on", MarketStatus.OPEN, 300),
    ]);
    await expect(svc.deleteGroup("g1")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(svc.delete).not.toHaveBeenCalled();

    const ok = build([
      member("Empty", MarketStatus.OPEN, 0),
      member("Refunded", MarketStatus.CANCELLED, 300),
      member("Not open", MarketStatus.UPCOMING, 0),
    ]);
    expect(await ok.deleteGroup("g1")).toEqual({ deleted: 3 });
    expect(ok.delete).toHaveBeenCalledTimes(3);
  });

  it("pins every option together", async () => {
    const svc = build([
      member("A", MarketStatus.OPEN),
      member("B", MarketStatus.OPEN),
    ]);
    expect(await svc.setGroupFeatured("g1", true)).toBe(2);
    expect(svc.marketRepo.update).toHaveBeenCalledWith(
      { groupId: "g1" },
      { isFeatured: true },
    );
    expect(svc.invalidateMarketCache).toHaveBeenCalledTimes(2);
  });
});

describe("group announcement text", () => {
  it("lists the options under their own heading", () => {
    const text = buildMarketAnnouncement(
      {
        title: "NBA MVP",
        outcomes: ["Nikola Jokic", "Luka Doncic"],
        outcomesHeading: "Options",
        closesAt: "Apr 10, 2027",
        link: "https://t.me/bot?startapp=g_1",
      },
      4096,
    );
    expect(text).toContain("<b>Options:</b>");
    expect(text).toContain("• Nikola Jokic");
    expect(text).toContain("startapp=g_1");
  });

  it("still says Outcomes for a single market", () => {
    const text = buildMarketAnnouncement(
      { title: "x", outcomes: ["Yes", "No"], closesAt: "TBD", link: "l" },
      4096,
    );
    expect(text).toContain("<b>Outcomes:</b>");
  });
});
