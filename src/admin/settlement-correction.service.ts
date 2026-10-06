import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { createHash } from "crypto";
import { DataSource, EntityManager } from "typeorm";
import { computeWinnerPayouts } from "../markets/winner-payouts";
import { roundMoney } from "../shared/utils/money.util";
import { rebuildRunningBalances } from "../shared/utils/ledger.util";
import {
  CorrectionMode,
  SettlementCorrection,
} from "../entities/settlement-correction.entity";
import { RedisService } from "../redis/redis.service";
import { SseService } from "../sse/sse.service";

/** Two figures this close are the same amount of money. */
const EPS = 0.005;

interface Pos {
  id: string;
  userId: string;
  outcomeId: string;
  amount: number;
  payout: number;
  status: string;
  currency: string;
  isBonusFunded: boolean;
  streakBoostArmed: boolean;
}

export interface BookPlan {
  currency: string;
  settlementId: string;
  settledAt: string;
  totalPool: number;
  edgePct: number;
  payoutPool: number;
  oldPaidOut: number;
  oldHouse: number;
  paidOut: Record<CorrectionMode, number>;
  house: Record<CorrectionMode, number>;
  wrongWinners: { positionId: string; userId: string; stake: number; payout: number }[];
  newWinners: { positionId: string; userId: string; stake: number; payout: number }[];
  distribution: {
    id: string;
    status: string;
    amount: number;
    pendingTransferRef: string | null;
  } | null;
}

export interface UserLine {
  userId: string;
  username: string | null;
  firstName: string | null;
  currency: string;
  /** What the wrong result paid them, which clawback takes back. */
  wrongPayout: number;
  /** What the right result pays them. */
  newPayout: number;
  balanceNow: number;
  after: Record<CorrectionMode, number>;
}

export interface CorrectionPlan {
  market: { id: string; title: string; status: string };
  from: { id: string; label: string } | null;
  to: { id: string; label: string } | null;
  outcomes: { id: string; label: string }[];
  /** Any entry here means the correction cannot be applied by this tool. */
  blocks: string[];
  warnings: string[];
  books: BookPlan[];
  users: UserLine[];
  /** Users clawback would overdraw. Non-empty means only `keep` is possible. */
  clawbackWouldOverdraw: string[];
  /** Cost to the house per currency, for each mode. */
  houseCost: { currency: string; clawback: number; keep: number }[];
  fingerprint: string;
}

/**
 * Re-settle a market whose result was wrong, after it has paid out.
 *
 * The procedure is the one September's two wrong results were fixed with by
 * hand: take the payouts back from the wrong side (or let them keep it and
 * have the house pay), pay the right side exactly what the engine would have,
 * restate the settlement, move the winner flags, and rebuild the running
 * balances of every wallet touched. The payout rows are dated to the original
 * settlement, so a user's history reads as if it had settled correctly.
 *
 * It refuses anything it cannot reverse exactly, rather than guess: disputes
 * and duels on the market (their outcomes followed the old result), bonus-
 * funded or streak-boosted bets (their accounting is not a plain payout), a
 * refunded book, a result nobody backed, and a revenue transfer that is at the
 * bank right now.
 *
 * Every rewritten row is snapshotted into settlement_corrections first.
 */
@Injectable()
export class SettlementCorrectionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional() private readonly redis?: RedisService,
    @Optional() private readonly sse?: SseService,
  ) {}

  preview(marketId: string, toOutcomeId: string): Promise<CorrectionPlan> {
    return this.plan(this.dataSource.manager, marketId, toOutcomeId);
  }

  async apply(
    input: {
      marketId: string;
      toOutcomeId: string;
      mode: CorrectionMode;
      note: string;
      fingerprint: string;
    },
    adminId: string,
  ): Promise<{ correctionId: string; plan: CorrectionPlan }> {
    const { marketId, toOutcomeId, mode } = input;

    const result = await this.dataSource.transaction(async (em) => {
      // Market first, then every bettor in id order: a fixed order, so two
      // corrections, or a correction and a settlement, cannot deadlock.
      const locked = await em.query(
        `SELECT id FROM markets WHERE id = $1 FOR UPDATE`,
        [marketId],
      );
      if (!locked.length) throw new NotFoundException("Market not found");
      await em.query(
        `SELECT id FROM users
          WHERE id IN (SELECT DISTINCT "userId" FROM positions WHERE "marketId" = $1)
          ORDER BY id FOR UPDATE`,
        [marketId],
      );

      // Re-derived under the locks. The preview the admin approved and the
      // state being written must be the same state.
      const plan = await this.plan(em, marketId, toOutcomeId);
      if (plan.blocks.length) {
        throw new BadRequestException(plan.blocks.join(" "));
      }
      if (plan.fingerprint !== input.fingerprint) {
        throw new ConflictException(
          "The market changed since you previewed it. Preview it again.",
        );
      }
      if (mode === "clawback" && plan.clawbackWouldOverdraw.length) {
        throw new BadRequestException(
          `Taking the payout back would overdraw ${plan.clawbackWouldOverdraw.join(", ")}. ` +
            `Choose "let them keep it" instead.`,
        );
      }

      const snapshot = await this.snapshot(em, marketId);

      for (const book of plan.books) {
        if (mode === "clawback" && book.wrongWinners.length) {
          const ids = book.wrongWinners.map((w) => w.positionId);
          await em.query(
            `DELETE FROM transactions
              WHERE type = 'bet_payout' AND "positionId" = ANY($1::uuid[])`,
            [ids],
          );
          await em.query(
            `UPDATE positions SET status = 'lost', payout = 0
              WHERE id = ANY($1::uuid[])`,
            [ids],
          );
        }

        for (const w of book.newWinners) {
          await em.query(
            `UPDATE positions SET status = 'won', payout = $2 WHERE id = $1`,
            [w.positionId, w.payout],
          );
          // Dated to the original settlement, copied inside SQL: both columns
          // are zoneless, and a round trip through a JS Date would shift it by
          // the process's UTC offset.
          await em.query(
            `INSERT INTO transactions
               (type, amount, currency, "balanceBefore", "balanceAfter",
                "positionId", "userId", note, "isBonus", "stakeAmount", "createdAt")
             SELECT 'bet_payout', $1, $2, 0, 0, $3, $4, $5, false, $6, s."settledAt"
               FROM settlements s WHERE s.id = $7`,
            [
              w.payout,
              book.currency,
              w.positionId,
              w.userId,
              `Payout for winning prediction on: ${plan.to!.label}`,
              w.stake,
              book.settlementId,
            ],
          );
        }

        const paidOut = book.paidOut[mode];
        const house = book.house[mode];
        const winners =
          book.newWinners.length + (mode === "keep" ? book.wrongWinners.length : 0);
        await em.query(
          `UPDATE settlements
              SET "winningOutcomeId" = $2, "winningBets" = $3,
                  "totalPaidOut" = $4, "houseAmount" = $5
            WHERE id = $1`,
          [book.settlementId, toOutcomeId, winners, paidOut, house],
        );

        const dist = book.distribution;
        if (dist && dist.status !== "completed") {
          if (house > 0) {
            await em.query(
              `UPDATE revenue_distributions
                  SET amount = $2, "houseEdgePct" = $3
                WHERE id = $1`,
              [
                dist.id,
                house,
                book.totalPool > 0
                  ? Math.round((house / book.totalPool) * 10_000) / 100
                  : 0,
              ],
            );
          } else {
            // No revenue left to transfer. The row is in the snapshot, and the
            // missing-distribution job only books houseAmount > 0, so it does
            // not come back.
            await em.query(`DELETE FROM revenue_distributions WHERE id = $1`, [
              dist.id,
            ]);
          }
        }
      }

      await em.query(
        `UPDATE outcomes SET "isWinner" = (id = $2) WHERE "marketId" = $1`,
        [marketId, toOutcomeId],
      );
      await em.query(
        `UPDATE markets SET "resolvedOutcomeId" = $2, "proposedOutcomeId" = $2
          WHERE id = $1`,
        [marketId, toOutcomeId],
      );

      const touched = plan.users.filter(
        (u) => u.newPayout > 0 || (mode === "clawback" && u.wrongPayout > 0),
      );
      for (const u of touched) {
        await rebuildRunningBalances(em, u.userId, u.currency);
      }

      const record = await em.save(
        SettlementCorrection,
        em.create(SettlementCorrection, {
          marketId,
          fromOutcomeId: plan.from!.id,
          toOutcomeId,
          mode,
          note: input.note,
          adminId,
          summary: summarise(plan, mode) as any,
          snapshot,
        }),
      );
      return { correctionId: record.id, plan };
    });

    // Caches and open apps, after commit: nothing to undo if these fail.
    const userIds = [...new Set(result.plan.users.map((u) => u.userId))];
    await this.redis
      ?.del(
        "oro:cache:markets:all",
        "oro:cache:markets:all:live",
        `oro:cache:market:${marketId}`,
        ...userIds.map((id) => `oro:cache:balance:${id}`),
      )
      .catch(() => undefined);
    for (const id of userIds) {
      this.sse?.emit(id, "balance:updated", { marketId });
    }

    return result;
  }

  /** Everything the correction rewrites or deletes, as it is now. */
  private async snapshot(em: EntityManager, marketId: string) {
    const [market] = await em.query(
      `SELECT id, title, status, "resolvedOutcomeId", "proposedOutcomeId", "resolvedAt"
         FROM markets WHERE id = $1`,
      [marketId],
    );
    return {
      takenAt: new Date().toISOString(),
      market,
      outcomes: await em.query(
        `SELECT id, label, "isWinner" FROM outcomes WHERE "marketId" = $1`,
        [marketId],
      ),
      positions: await em.query(`SELECT * FROM positions WHERE "marketId" = $1`, [
        marketId,
      ]),
      payoutTransactions: await em.query(
        `SELECT t.* FROM transactions t
          WHERE t.type = 'bet_payout'
            AND t."positionId" IN (SELECT id FROM positions WHERE "marketId" = $1)`,
        [marketId],
      ),
      settlements: await em.query(`SELECT * FROM settlements WHERE "marketId" = $1`, [
        marketId,
      ]),
      revenueDistributions: await em.query(
        `SELECT * FROM revenue_distributions WHERE "marketId" = $1`,
        [marketId],
      ),
    };
  }

  /**
   * Work out what a correction would do, and whether it can be done at all.
   * Read-only; `apply` runs it again under locks before writing anything.
   */
  async plan(
    em: EntityManager,
    marketId: string,
    toOutcomeId: string,
  ): Promise<CorrectionPlan> {
    const [market] = await em.query(
      `SELECT id, title, status, "resolvedOutcomeId" FROM markets WHERE id = $1`,
      [marketId],
    );
    if (!market) throw new NotFoundException("Market not found");

    const outcomes: { id: string; label: string }[] = await em.query(
      `SELECT id, label FROM outcomes WHERE "marketId" = $1 ORDER BY "sortOrder", label`,
      [marketId],
    );
    const label = (id: string) => outcomes.find((o) => o.id === id)?.label ?? id;
    const from = market.resolvedOutcomeId
      ? { id: market.resolvedOutcomeId, label: label(market.resolvedOutcomeId) }
      : null;
    const toRow = outcomes.find((o) => o.id === toOutcomeId);
    const to = toRow ? { id: toRow.id, label: toRow.label } : null;

    const blocks: string[] = [];
    const warnings: string[] = [];
    const empty = (): CorrectionPlan => ({
      market: { id: market.id, title: market.title, status: market.status },
      from,
      to,
      outcomes,
      blocks,
      warnings,
      books: [],
      users: [],
      clawbackWouldOverdraw: [],
      houseCost: [],
      fingerprint: "",
    });

    if (market.status !== "settled") {
      blocks.push(`The market is ${market.status}, not settled.`);
    }
    if (!to) blocks.push("That outcome is not on this market.");
    else if (to.id === market.resolvedOutcomeId) {
      blocks.push(`The market already settled as ${to.label}.`);
    }
    if (blocks.length) return empty();

    const settlements: any[] = await em.query(
      `SELECT s.id, s.currency, s."winningOutcomeId", s."totalPool", s."totalPaidOut",
              s."houseAmount", s."houseForfeit", s."cancelReason", s."settledAt",
              mb."houseEdgePct"
         FROM settlements s
         LEFT JOIN market_books mb
           ON mb."marketId" = s."marketId" AND mb.currency = s.currency
        WHERE s."marketId" = $1
        ORDER BY s.currency`,
      [marketId],
    );
    if (!settlements.length) blocks.push("The market has no settlement record.");
    for (const s of settlements) {
      if (s.cancelReason) {
        blocks.push(`The ${s.currency} book was refunded (${s.cancelReason}), not paid out.`);
      } else if (s.winningOutcomeId !== market.resolvedOutcomeId) {
        blocks.push(
          `The ${s.currency} settlement says ${label(s.winningOutcomeId)} but the market says ${label(market.resolvedOutcomeId)}.`,
        );
      }
      if (Number(s.houseForfeit) > 0) {
        blocks.push(`The ${s.currency} book includes forfeited dispute bonds.`);
      }
      if (s.houseEdgePct === null) {
        blocks.push(`The ${s.currency} book has no edge on record.`);
      }
    }

    const [{ disputes }] = await em.query(
      `SELECT COUNT(*)::int AS disputes FROM disputes WHERE "marketId" = $1`,
      [marketId],
    );
    if (disputes > 0) {
      blocks.push(
        `It has ${disputes} dispute(s); their bonds and rewards followed the old result and need handling by hand.`,
      );
    }
    const [{ duels }] = await em.query(
      `SELECT COUNT(*)::int AS duels FROM challenges WHERE "marketId" = $1`,
      [marketId],
    );
    if (duels > 0) {
      blocks.push(`It has ${duels} duel(s), which were settled on the old result.`);
    }

    const positions: Pos[] = (
      await em.query(
        `SELECT id, "userId", "outcomeId", amount, payout, status, currency,
                "isBonusFunded", "streakBoostArmed"
           FROM positions WHERE "marketId" = $1 ORDER BY id`,
        [marketId],
      )
    ).map((p: any) => ({
      ...p,
      amount: Number(p.amount),
      payout: Number(p.payout ?? 0),
    }));

    const odd = positions.filter((p) => p.status !== "won" && p.status !== "lost");
    if (odd.length) blocks.push(`${odd.length} bet(s) are neither won nor lost.`);
    if (positions.some((p) => p.isBonusFunded)) {
      blocks.push("Some bets were placed with bonus credit, whose payouts are capped differently.");
    }
    const strayWinners = positions.filter(
      (p) => p.status === "won" && p.outcomeId !== market.resolvedOutcomeId,
    );
    if (strayWinners.length) {
      blocks.push(
        `${strayWinners.length} bet(s) on other outcomes are marked won — this market looks already corrected once.`,
      );
    }

    // What the ledger actually paid each position.
    const paid = new Map<string, number>();
    const streakRows = new Set<string>();
    for (const r of await em.query(
      `SELECT t."positionId", t.type, t.currency, SUM(t.amount) AS amount
         FROM transactions t
        WHERE t."positionId" IN (SELECT id FROM positions WHERE "marketId" = $1)
          AND t.type IN ('bet_payout', 'streak_bonus')
        GROUP BY t."positionId", t.type, t.currency`,
      [marketId],
    )) {
      if (r.type === "streak_bonus") streakRows.add(r.positionId);
      else paid.set(r.positionId, Number(r.amount));
    }

    const books: BookPlan[] = [];
    for (const s of settlements) {
      const currency: string = s.currency;
      const bets = positions.filter((p) => p.currency === currency);
      const wrong = bets.filter((p) => p.status === "won");
      const right = bets.filter((p) => p.outcomeId === toOutcomeId);

      for (const p of [...wrong, ...right]) {
        if (p.streakBoostArmed || streakRows.has(p.id)) {
          blocks.push("A winning bet on either side carries a day-7 streak boost.");
          break;
        }
      }
      for (const p of wrong) {
        if (Math.abs((paid.get(p.id) ?? 0) - p.payout) > EPS) {
          blocks.push(
            `A ${currency} bet's recorded payout (${p.payout}) differs from what the ledger paid (${paid.get(p.id) ?? 0}).`,
          );
          break;
        }
      }
      if (bets.some((p) => p.status === "lost" && (paid.get(p.id) ?? 0) !== 0)) {
        blocks.push(`A losing ${currency} bet has a payout in the ledger.`);
      }
      if (!right.length) {
        blocks.push(
          `Nobody backed ${to!.label} in ${currency}: settling on it would refund the book, which this tool does not do.`,
        );
        continue;
      }
      if (right.length === bets.length) {
        blocks.push(`Everyone in ${currency} backed ${to!.label}: that book would be refunded.`);
        continue;
      }

      const totalPool = Number(s.totalPool);
      const edgePct = Number(s.houseEdgePct);
      const payoutPool = totalPool - totalPool * (edgePct / 100);
      const { payouts } = computeWinnerPayouts({
        stakes: right.map((p) => p.amount),
        payoutPool,
        totalPool,
        currency,
      });
      const newSum = roundMoney(payouts.reduce((a, b) => a + b, 0), currency);
      const oldPaid = roundMoney(
        wrong.reduce((a, p) => a + p.payout, 0),
        currency,
      );
      const paidOut = {
        clawback: newSum,
        keep: roundMoney(oldPaid + newSum, currency),
      };

      const [dist] = await em.query(
        `SELECT id, status, amount, "pendingTransferRef"
           FROM revenue_distributions WHERE "settlementId" = $1`,
        [s.id],
      );
      if (dist?.pendingTransferRef) {
        blocks.push(
          `The ${currency} revenue transfer for this market is at the bank right now; wait for it to finish.`,
        );
      }
      if (dist?.status === "completed") {
        warnings.push(
          `${roundMoney(Number(dist.amount), currency)} ${currency} of house revenue was already transferred out for this market. ` +
            `The settlement will be restated; that transfer is not reversed.`,
        );
      }

      books.push({
        currency,
        settlementId: s.id,
        settledAt: new Date(s.settledAt).toISOString(),
        totalPool,
        edgePct,
        payoutPool: roundMoney(payoutPool, currency),
        oldPaidOut: Number(s.totalPaidOut),
        oldHouse: Number(s.houseAmount),
        paidOut,
        house: {
          clawback: roundMoney(totalPool - paidOut.clawback, currency),
          keep: roundMoney(totalPool - paidOut.keep, currency),
        },
        wrongWinners: wrong.map((p) => ({
          positionId: p.id,
          userId: p.userId,
          stake: p.amount,
          payout: p.payout,
        })),
        newWinners: right.map((p, i) => ({
          positionId: p.id,
          userId: p.userId,
          stake: p.amount,
          payout: payouts[i],
        })),
        distribution: dist
          ? {
              id: dist.id,
              status: dist.status,
              amount: Number(dist.amount),
              pendingTransferRef: dist.pendingTransferRef ?? null,
            }
          : null,
      });
    }

    // Per wallet: what each side gains or loses, against its balance now.
    const lines = new Map<string, UserLine>();
    const line = (userId: string, currency: string) => {
      const key = `${userId}|${currency}`;
      if (!lines.has(key)) {
        lines.set(key, {
          userId,
          username: null,
          firstName: null,
          currency,
          wrongPayout: 0,
          newPayout: 0,
          balanceNow: 0,
          after: { clawback: 0, keep: 0 },
        });
      }
      return lines.get(key)!;
    };
    for (const b of books) {
      for (const w of b.wrongWinners) line(w.userId, b.currency).wrongPayout += w.payout;
      for (const w of b.newWinners) line(w.userId, b.currency).newPayout += w.payout;
    }
    const users = [...lines.values()];
    if (users.length) {
      const ids = [...new Set(users.map((u) => u.userId))];
      const bal = new Map<string, number>();
      for (const r of await em.query(
        `SELECT "userId", currency, SUM(amount) AS balance
           FROM transactions WHERE "userId" = ANY($1::uuid[])
          GROUP BY "userId", currency`,
        [ids],
      )) {
        bal.set(`${r.userId}|${r.currency}`, Number(r.balance));
      }
      const names = new Map<string, any>();
      for (const r of await em.query(
        `SELECT id, username, "firstName" FROM users WHERE id = ANY($1::uuid[])`,
        [ids],
      )) {
        names.set(r.id, r);
      }
      for (const u of users) {
        u.wrongPayout = roundMoney(u.wrongPayout, u.currency);
        u.newPayout = roundMoney(u.newPayout, u.currency);
        u.balanceNow = bal.get(`${u.userId}|${u.currency}`) ?? 0;
        u.after = {
          clawback: roundMoney(u.balanceNow - u.wrongPayout + u.newPayout, u.currency),
          keep: roundMoney(u.balanceNow + u.newPayout, u.currency),
        };
        u.username = names.get(u.userId)?.username ?? null;
        u.firstName = names.get(u.userId)?.firstName ?? null;
      }
    }
    const clawbackWouldOverdraw = users
      .filter((u) => u.after.clawback < 0)
      .map((u) => (u.username ? `@${u.username}` : (u.firstName ?? u.userId.slice(0, 8))));

    warnings.push(
      "Reputation, prediction stats and leaderboard points are not recalculated.",
      "No one is messaged. Payouts to the right side are dated to the original settlement.",
    );

    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          market: [market.id, market.resolvedOutcomeId, toOutcomeId],
          positions: positions.map((p) => [p.id, p.status, p.payout, p.outcomeId, p.amount]),
          settlements: settlements.map((s) => [s.id, String(s.totalPaidOut), String(s.houseAmount)]),
          paid: [...paid.entries()].sort(),
        }),
      )
      .digest("hex");

    return {
      market: { id: market.id, title: market.title, status: market.status },
      from,
      to,
      outcomes,
      blocks: [...new Set(blocks)],
      warnings,
      books,
      users: users.sort((a, b) => b.newPayout - a.newPayout || b.wrongPayout - a.wrongPayout),
      clawbackWouldOverdraw,
      houseCost: books.map((b) => ({
        currency: b.currency,
        clawback: roundMoney(b.oldHouse - b.house.clawback, b.currency),
        keep: roundMoney(b.oldHouse - b.house.keep, b.currency),
      })),
      fingerprint,
    };
  }
}

function summarise(plan: CorrectionPlan, mode: CorrectionMode) {
  return {
    from: plan.from,
    to: plan.to,
    mode,
    books: plan.books.map((b) => ({
      currency: b.currency,
      totalPool: b.totalPool,
      paidOut: { before: b.oldPaidOut, after: b.paidOut[mode] },
      house: { before: b.oldHouse, after: b.house[mode] },
    })),
    users: plan.users.map((u) => ({
      userId: u.userId,
      currency: u.currency,
      delta: roundMoney(
        u.newPayout - (mode === "clawback" ? u.wrongPayout : 0),
        u.currency,
      ),
      balanceBefore: u.balanceNow,
      balanceAfter: u.after[mode],
    })),
  };
}
