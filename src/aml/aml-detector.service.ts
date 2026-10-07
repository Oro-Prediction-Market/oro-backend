import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { AmlAlertType, AmlRiskLevel } from "./entities/aml-alert.entity";

export interface AlertCandidate {
  userId: string;
  cid: string | null;
  alertType: AmlAlertType;
  riskLevel: AmlRiskLevel;
  description: string;
  totalAmount: number | null;
  transactionCount: number | null;
  metadata: Record<string, any>;
}

export interface AmlLedger {
  currency: "BTN" | "USDT";
  /** Smallest single deposit the rapid deposit→withdrawal check looks at. */
  rapidMinDeposit: number;
  /** Total deposits in the window above which a low wagering ratio alerts. */
  lowRatioMinDeposits: number;
  /** A day's deposits at or above this count as "near the limit". */
  nearLimitDaily: number;
}

/** Formats an amount the way an analyst reads it: "Nu 3,000" / "35 USDT". */
function money(amount: number, currency: string): string {
  const n = Number(amount).toLocaleString();
  return currency === "BTN" ? `Nu ${n}` : `${n} ${currency}`;
}

@Injectable()
export class AmlDetectorService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly config: ConfigService,
  ) {}
  ledgers(): AmlLedger[] {
    const num = (key: string, fallback: number) => {
      const v = Number(this.config.get(key));
      return Number.isFinite(v) && v > 0 ? v : fallback;
    };
    return [
      {
        currency: "BTN",
        rapidMinDeposit: 3000,
        lowRatioMinDeposits: 20000,
        nearLimitDaily: 14000,
      },
      {
        currency: "USDT",
        rapidMinDeposit: num("AML_USDT_RAPID_MIN_DEPOSIT", 35),
        lowRatioMinDeposits: num("AML_USDT_LOW_RATIO_MIN_DEPOSITS", 235),
        nearLimitDaily: num(
          "AML_USDT_NEAR_LIMIT_DAILY",
          0.9 * num("USDT_MAX_DEPOSIT", 1000),
        ),
      },
    ];
  }

  async runScan(from: Date, to: Date): Promise<AlertCandidate[]> {
    const perLedger = await Promise.all(
      this.ledgers().map((l) =>
        Promise.all([
          this.detectRapidDepositWithdrawal(from, to, l),
          this.detectLowGamblingRatio(from, to, l),
          this.detectNearLimitDeposits(from, to, l),
        ]),
      ),
    );
    // Frequency counts transactions, not amounts, so one pass covers both
    // ledgers; it groups by currency so the two are never added together.
    const htf = await this.detectHighFrequency(from, to);
    return [...perLedger.flat(2), ...htf];
  }

  /** HIGH RISK — Deposited then withdrew ≥50% within 2 hours with no bets in between. */
  private async detectRapidDepositWithdrawal(
    from: Date,
    to: Date,
    l: AmlLedger,
  ): Promise<AlertCandidate[]> {
    const rows = await this.ds.query<any[]>(
      `
      WITH deposits AS (
        SELECT t.id, t."userId", t.amount::numeric AS amt, t."createdAt" AS dt
        FROM transactions t
        WHERE t.currency = $3
          AND t.type = 'deposit'
          AND t."createdAt" BETWEEN $1 AND $2
          AND t.amount::numeric >= $4
      ),
      suspicious AS (
        -- Withdrawals are stored as NEGATIVE ledger debits; ABS() converts them
        -- to a positive magnitude so the ">= 50% of deposit" comparison works.
        -- Without ABS the sum is negative and this alert would never fire.
        SELECT
          d."userId",
          d.id                         AS deposit_id,
          d.amt                        AS deposit_amount,
          d.dt                         AS deposit_time,
          SUM(ABS(w.amount::numeric))  AS wd_total,
          MIN(w."createdAt")           AS wd_time
        FROM deposits d
        JOIN transactions w
          ON  w."userId"    = d."userId"
          AND w.currency    = $3
          AND w.type        = 'withdrawal'
          AND w."createdAt" BETWEEN d.dt AND d.dt + INTERVAL '2 hours'
        GROUP BY d."userId", d.id, d.amt, d.dt
        HAVING SUM(ABS(w.amount::numeric)) >= d.amt * 0.5
      )
      SELECT
        s."userId",
        u."dkCid",
        s.deposit_id,
        s.deposit_amount,
        s.deposit_time,
        s.wd_total,
        s.wd_time,
        EXTRACT(EPOCH FROM (s.wd_time - s.deposit_time)) / 60 AS gap_min
      FROM suspicious s
      JOIN users u ON u.id = s."userId"
      WHERE NOT EXISTS (
        SELECT 1 FROM transactions b
        WHERE b."userId"    = s."userId"
          AND b.currency    = $3
          AND b.type        = 'bet_placed'
          AND b."createdAt" BETWEEN s.deposit_time AND s.wd_time
      )
      `,
      [from, to, l.currency, l.rapidMinDeposit],
    );

    return rows.map((r) => {
      const pct = Math.round(
        (Number(r.wd_total) / Number(r.deposit_amount)) * 100,
      );
      const mins = Math.round(Number(r.gap_min));
      return {
        userId: r.userId,
        cid: r.dkCid,
        alertType: AmlAlertType.RAPID_DEPOSIT_WITHDRAWAL,
        riskLevel: AmlRiskLevel.HIGH,
        description: `Deposited ${money(r.deposit_amount, l.currency)} then withdrew ${money(r.wd_total, l.currency)} (${pct}%) within ${mins} minute(s) with no bets placed`,
        totalAmount: Number(r.deposit_amount),
        transactionCount: 2,
        metadata: {
          currency: l.currency,
          depositId: r.deposit_id,
          depositAmount: Number(r.deposit_amount),
          depositTime: r.deposit_time,
          withdrawalAmount: Number(r.wd_total),
          withdrawalTime: r.wd_time,
          gapMinutes: mins,
        },
      };
    });
  }

  /** MEDIUM RISK — Deposited >Nu 20,000 total but wagered <15% of that amount. */
  private async detectLowGamblingRatio(
    from: Date,
    to: Date,
    l: AmlLedger,
  ): Promise<AlertCandidate[]> {
    const rows = await this.ds.query<any[]>(
      `
      WITH user_deposits AS (
        SELECT "userId", SUM(amount::numeric) AS total_deposited
        FROM transactions
        WHERE currency = $3
          AND type = 'deposit' AND "createdAt" BETWEEN $1 AND $2
        GROUP BY "userId"
        HAVING SUM(amount::numeric) > $4
      ),
      user_bets AS (
        -- Bets are stored as NEGATIVE ledger debits; ABS() gives the positive
        -- amount wagered. Without it total_bet is negative, so every high
        -- depositor would falsely trip the "<15% wagered" ratio.
        SELECT "userId", SUM(ABS(amount::numeric)) AS total_bet
        FROM transactions
        WHERE currency = $3
          AND type = 'bet_placed' AND "createdAt" BETWEEN $1 AND $2
        GROUP BY "userId"
      )
      SELECT
        d."userId",
        u."dkCid",
        d.total_deposited,
        COALESCE(b.total_bet, 0) AS total_bet,
        ROUND(COALESCE(b.total_bet, 0) / NULLIF(d.total_deposited, 0) * 100, 1) AS bet_ratio
      FROM user_deposits d
      LEFT JOIN user_bets b ON b."userId" = d."userId"
      JOIN users u ON u.id = d."userId"
      WHERE COALESCE(b.total_bet, 0) < d.total_deposited * 0.15
      `,
      [from, to, l.currency, l.lowRatioMinDeposits],
    );

    return rows.map((r) => ({
      userId: r.userId,
      cid: r.dkCid,
      alertType: AmlAlertType.LOW_GAMBLING_RATIO,
      riskLevel: AmlRiskLevel.MEDIUM,
      description: `Deposited ${money(r.total_deposited, l.currency)} but only wagered ${money(r.total_bet, l.currency)} (${r.bet_ratio}%) — low engagement relative to deposit volume`,
      totalAmount: Number(r.total_deposited),
      transactionCount: null,
      metadata: {
        currency: l.currency,
        totalDeposited: Number(r.total_deposited),
        totalBet: Number(r.total_bet),
        betRatioPercent: Number(r.bet_ratio),
      },
    }));
  }

  /** MEDIUM RISK — >15 deposit/withdrawal transactions in any single calendar week. */
  private async detectHighFrequency(
    from: Date,
    to: Date,
  ): Promise<AlertCandidate[]> {
    const rows = await this.ds.query<any[]>(
      `
      SELECT
        t."userId",
        u."dkCid",
        t.currency,
        COUNT(*)::int                     AS tx_count,
        DATE_TRUNC('week', t."createdAt") AS week_start
      FROM transactions t
      JOIN users u ON u.id = t."userId"
      WHERE t.type IN ('deposit', 'withdrawal')
        AND t."createdAt" BETWEEN $1 AND $2
      GROUP BY t."userId", u."dkCid", t.currency, DATE_TRUNC('week', t."createdAt")
      HAVING COUNT(*) > 15
      `,
      [from, to],
    );

    return rows.map((r) => ({
      userId: r.userId,
      cid: r.dkCid,
      alertType: AmlAlertType.HIGH_TRANSACTION_FREQUENCY,
      riskLevel: AmlRiskLevel.MEDIUM,
      description: `${r.tx_count} ${r.currency} deposit/withdrawal transactions in the week starting ${new Date(r.week_start).toLocaleDateString("en-BT", { timeZone: "Asia/Thimphu" })}`,
      totalAmount: null,
      transactionCount: Number(r.tx_count),
      metadata: {
        currency: r.currency,
        weekStart: r.week_start,
        transactionCount: Number(r.tx_count),
      },
    }));
  }

  /** LOW RISK — Deposited ≥Nu 14,000 (near daily maximum) on ≥3 separate days. */
  private async detectNearLimitDeposits(
    from: Date,
    to: Date,
    l: AmlLedger,
  ): Promise<AlertCandidate[]> {
    const rows = await this.ds.query<any[]>(
      `
      WITH daily AS (
        SELECT
          "userId",
          DATE_TRUNC('day', "createdAt" AT TIME ZONE 'Asia/Thimphu') AS deposit_day,
          SUM(amount::numeric) AS daily_total
        FROM transactions
        WHERE currency = $3
          AND type = 'deposit' AND "createdAt" BETWEEN $1 AND $2
        GROUP BY "userId", DATE_TRUNC('day', "createdAt" AT TIME ZONE 'Asia/Thimphu')
        HAVING SUM(amount::numeric) >= $4
      )
      SELECT
        d."userId",
        u."dkCid",
        COUNT(*)::int      AS near_limit_days,
        SUM(d.daily_total) AS cumulative_total
      FROM daily d
      JOIN users u ON u.id = d."userId"
      GROUP BY d."userId", u."dkCid"
      HAVING COUNT(*) >= 3
      `,
      [from, to, l.currency, l.nearLimitDaily],
    );

    return rows.map((r) => ({
      userId: r.userId,
      cid: r.dkCid,
      alertType: AmlAlertType.NEAR_LIMIT_DEPOSITS,
      riskLevel: AmlRiskLevel.LOW,
      description: `Deposited at or near the daily maximum (≥${money(l.nearLimitDaily, l.currency)}) on ${r.near_limit_days} separate days — cumulative total ${money(r.cumulative_total, l.currency)}`,
      totalAmount: Number(r.cumulative_total),
      transactionCount: Number(r.near_limit_days),
      metadata: {
        currency: l.currency,
        nearLimitDays: Number(r.near_limit_days),
        cumulativeTotal: Number(r.cumulative_total),
      },
    }));
  }
}
