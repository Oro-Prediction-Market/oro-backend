import {
  STUCK_DUEL,
  DUEL_PLATFORM_FEE_PCT,
  isStuck,
  toDuelRow,
} from "../admin/duel-view";
import {
  Challenge,
  ChallengeStatus,
  CardType,
} from "../entities/challenge.entity";
import { MarketStatus } from "../entities/market.entity";

function makeDuel(over: Partial<Challenge> = {}): Challenge {
  return {
    id: "duel-1",
    status: ChallengeStatus.ACTIVE,
    // TypeORM hands a decimal column back as a STRING. Every fixture here
    // keeps that shape on purpose — it is the trap this module exists to
    // absorb, and a number fixture would hide a regression.
    wagerAmount: "25" as unknown as number,
    currency: "BTN",
    equippedCard: null,
    participantCount: 1,
    winnerId: null,
    settledAt: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    expiresAt: new Date("2026-09-02T00:00:00Z"),
    creatorId: "u-creator",
    joinerId: "u-joiner",
    marketId: "m-1",
    outcomeId: "o-1",
    creator: { id: "u-creator", username: "alice", firstName: "Alice" },
    joiner: { id: "u-joiner", username: null, firstName: "Bob" },
    market: { id: "m-1", title: "Will X happen?", status: MarketStatus.OPEN },
    outcome: { id: "o-1", label: "Yes" },
    ...over,
  } as unknown as Challenge;
}

describe("toDuelRow", () => {
  it("returns the wager as a number, not the decimal string", () => {
    const row = toDuelRow(makeDuel());
    expect(row.wagerAmount).toBe(25);
    // The trap: "25" * 2 works, but "25" + "25" is "2525".
    expect(row.pot).toBe(50);
    expect(typeof row.wagerAmount).toBe("number");
  });

  it("takes the platform cut off the whole pot, not one wager", () => {
    const row = toDuelRow(makeDuel());
    expect(row.platformFee).toBeCloseTo(50 * DUEL_PLATFORM_FEE_PCT, 9);
    expect(row.feeWaived).toBe(false);
  });

  it("waives the fee for a Double Down duel", () => {
    const row = toDuelRow(makeDuel({ equippedCard: CardType.DOUBLE_DOWN }));
    expect(row.feeWaived).toBe(true);
    expect(row.platformFee).toBe(0);
    // The pot itself is unchanged — the winner simply keeps all of it.
    expect(row.pot).toBe(50);
  });

  it("does not waive the fee for a Ghost duel", () => {
    const row = toDuelRow(makeDuel({ equippedCard: CardType.GHOST }));
    expect(row.feeWaived).toBe(false);
    expect(row.platformFee).toBeGreaterThan(0);
  });

  it("renders an unjoined duel without inventing an opponent", () => {
    const row = toDuelRow(
      makeDuel({ status: ChallengeStatus.OPEN, joiner: null, joinerId: null }),
    );
    expect(row.joiner).toBeNull();
    expect(row.winnerId).toBeNull();
    expect(row.creator?.username).toBe("alice");
  });

  // joinerId is ON DELETE SET NULL, so a deleted account leaves an ACTIVE duel
  // with no joiner. The row still has to render.
  it("survives a joiner whose account was deleted", () => {
    const row = toDuelRow(makeDuel({ joiner: null }));
    expect(row.joiner).toBeNull();
    expect(row.status).toBe(ChallengeStatus.ACTIVE);
  });

  it("carries a username-less player through by first name", () => {
    expect(toDuelRow(makeDuel()).joiner).toEqual({
      id: "u-joiner",
      username: null,
      firstName: "Bob",
    });
  });

  it("treats a zero-wager bragging-rights duel as free", () => {
    const row = toDuelRow(makeDuel({ wagerAmount: "0" as unknown as number }));
    expect(row.wagerAmount).toBe(0);
    expect(row.pot).toBe(0);
    expect(row.platformFee).toBe(0);
  });
});

describe("isStuck", () => {
  // The bug the page exists to surface: cancelMarket() refunds positions but
  // never calls settleByMarket(), so these never resolve or refund.
  it("flags open and active duels on a cancelled market", () => {
    expect(isStuck(ChallengeStatus.OPEN, MarketStatus.CANCELLED)).toBe(true);
    expect(isStuck(ChallengeStatus.ACTIVE, MarketStatus.CANCELLED)).toBe(true);
  });

  it("does not flag a duel that already reached a terminal state", () => {
    for (const s of [
      ChallengeStatus.SETTLED,
      ChallengeStatus.EXPIRED,
      ChallengeStatus.VOID,
    ]) {
      expect(isStuck(s, MarketStatus.CANCELLED)).toBe(false);
    }
  });

  it("does not flag a live duel on a healthy market", () => {
    expect(isStuck(ChallengeStatus.ACTIVE, MarketStatus.OPEN)).toBe(false);
    expect(isStuck(ChallengeStatus.ACTIVE, MarketStatus.RESOLVED)).toBe(false);
    expect(isStuck(ChallengeStatus.ACTIVE, null)).toBe(false);
  });

  it("agrees with the SQL predicate the list and summary share", () => {
    // Both halves of the endpoint filter on this one string; if it drifts from
    // isStuck(), the count in the header stops matching the rows below it.
    expect(STUCK_DUEL).toContain("c.status IN ('open','active')");
    expect(STUCK_DUEL).toContain(`m.status = '${MarketStatus.CANCELLED}'`);
  });
});
