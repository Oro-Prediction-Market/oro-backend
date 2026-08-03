import { Injectable } from "@nestjs/common";
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

@Injectable()
export class AmlDetectorService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async runScan(from: Date, to: Date): Promise<AlertCandidate[]> {
    const [rdw, lgr, htf, nld] = await Promise.all([
      this.detectRapidDepositWithdrawal(from, to),
      this.detectLowGamblingRatio(from, to),
      this.detectHighFrequency(from, to),
      this.detectNearLimitDeposits(from, to),
    ]);
    return [...rdw, ...lgr, ...htf, ...nld];
  }

  /** HIGH RISK — Deposited then withdrew ≥50% within 2 hours with no bets in between. */
  private async detectRapidDepositWithdrawal(from: Date, to: Date): Promise<AlertCandidate[]> {
    const rows = await this.ds.query<any[]>(
      `
      WITH deposits AS (
        SELECT t.id, t."userId", t.amount::numeric AS amt, t."createdAt" AS dt
        FROM transactions t
        WHERE t.type = 'deposit'
          AND t."createdAt" BETWEEN $1 AND $2
          AND t.amount::numeric >= 3000
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
          AND b.type        = 'bet_placed'
          AND b."createdAt" BETWEEN s.deposit_time AND s.wd_time
      )
      `,
      [from, to],
    );

    return rows.map((r) => {
      const pct = Math.round((Number(r.wd_total) / Number(r.deposit_amount)) * 100);
      const mins = Math.round(Number(r.gap_min));
      return {
        userId: r.userId,
        cid: r.dkCid,
        alertType: AmlAlertType.RAPID_DEPOSIT_WITHDRAWAL,
        riskLevel: AmlRiskLevel.HIGH,
        description: `Deposited Nu ${Number(r.deposit_amount).toLocaleString()} then withdrew Nu ${Number(r.wd_total).toLocaleString()} (${pct}%) within ${mins} minute(s) with no bets placed`,
        totalAmount: Number(r.deposit_amount),
        transactionCount: 2,
        metadata: {
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
  private async detectLowGamblingRatio(from: Date, to: Date): Promise<AlertCandidate[]> {
    const rows = await this.ds.query<any[]>(
      `
      WITH user_deposits AS (
        SELECT "userId", SUM(amount::numeric) AS total_deposited
        FROM transactions
        WHERE type = 'deposit' AND "createdAt" BETWEEN $1 AND $2
        GROUP BY "userId"
        HAVING SUM(amount::numeric) > 20000
      ),
      user_bets AS (
        -- Bets are stored as NEGATIVE ledger debits; ABS() gives the positive
        -- amount wagered. Without it total_bet is negative, so every high
        -- depositor would falsely trip the "<15% wagered" ratio.
        SELECT "userId", SUM(ABS(amount::numeric)) AS total_bet
        FROM transactions
        WHERE type = 'bet_placed' AND "createdAt" BETWEEN $1 AND $2
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
      [from, to],
    );

    return rows.map((r) => ({
      userId: r.userId,
      cid: r.dkCid,
      alertType: AmlAlertType.LOW_GAMBLING_RATIO,
      riskLevel: AmlRiskLevel.MEDIUM,
      description: `Deposited Nu ${Number(r.total_deposited).toLocaleString()} but only wagered Nu ${Number(r.total_bet).toLocaleString()} (${r.bet_ratio}%) — low engagement relative to deposit volume`,
      totalAmount: Number(r.total_deposited),
      transactionCount: null,
      metadata: {
        totalDeposited: Number(r.total_deposited),
        totalBet: Number(r.total_bet),
        betRatioPercent: Number(r.bet_ratio),
      },
    }));
  }

  /** MEDIUM RISK — >15 deposit/withdrawal transactions in any single calendar week. */
  private async detectHighFrequency(from: Date, to: Date): Promise<AlertCandidate[]> {
    const rows = await this.ds.query<any[]>(
      `
      SELECT
        t."userId",
        u."dkCid",
        COUNT(*)::int                     AS tx_count,
        DATE_TRUNC('week', t."createdAt") AS week_start
      FROM transactions t
      JOIN users u ON u.id = t."userId"
      WHERE t.type IN ('deposit', 'withdrawal')
        AND t."createdAt" BETWEEN $1 AND $2
      GROUP BY t."userId", u."dkCid", DATE_TRUNC('week', t."createdAt")
      HAVING COUNT(*) > 15
      `,
      [from, to],
    );

    return rows.map((r) => ({
      userId: r.userId,
      cid: r.dkCid,
      alertType: AmlAlertType.HIGH_TRANSACTION_FREQUENCY,
      riskLevel: AmlRiskLevel.MEDIUM,
      description: `${r.tx_count} deposit/withdrawal transactions in the week starting ${new Date(r.week_start).toLocaleDateString("en-BT", { timeZone: "Asia/Thimphu" })}`,
      totalAmount: null,
      transactionCount: Number(r.tx_count),
      metadata: { weekStart: r.week_start, transactionCount: Number(r.tx_count) },
    }));
  }

  /** LOW RISK — Deposited ≥Nu 14,000 (near daily maximum) on ≥3 separate days. */
  private async detectNearLimitDeposits(from: Date, to: Date): Promise<AlertCandidate[]> {
    const rows = await this.ds.query<any[]>(
      `
      WITH daily AS (
        SELECT
          "userId",
          DATE_TRUNC('day', "createdAt" AT TIME ZONE 'Asia/Thimphu') AS deposit_day,
          SUM(amount::numeric) AS daily_total
        FROM transactions
        WHERE type = 'deposit' AND "createdAt" BETWEEN $1 AND $2
        GROUP BY "userId", DATE_TRUNC('day', "createdAt" AT TIME ZONE 'Asia/Thimphu')
        HAVING SUM(amount::numeric) >= 14000
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
      [from, to],
    );

    return rows.map((r) => ({
      userId: r.userId,
      cid: r.dkCid,
      alertType: AmlAlertType.NEAR_LIMIT_DEPOSITS,
      riskLevel: AmlRiskLevel.LOW,
      description: `Deposited at or near the daily maximum (≥Nu 14,000) on ${r.near_limit_days} separate days — cumulative total Nu ${Number(r.cumulative_total).toLocaleString()}`,
      totalAmount: Number(r.cumulative_total),
      transactionCount: Number(r.near_limit_days),
      metadata: {
        nearLimitDays: Number(r.near_limit_days),
        cumulativeTotal: Number(r.cumulative_total),
      },
    }));
  }
}
