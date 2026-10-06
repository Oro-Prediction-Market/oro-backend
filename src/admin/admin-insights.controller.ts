import { Controller, Get, Optional, Query, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { JwtAuthGuard, AdminGuard } from "../auth/guards";
import {
  SEASON_MIN_QUALIFIERS,
  SEASON_PRIZES,
} from "../users/season.service";
import { DEFAULT_HOUSE_EDGE_PCT } from "../markets/fee.constants";
import { CryptoIntentStatus } from "../entities/crypto-payment-intent.entity";
import { RedisService } from "../redis/redis.service";
import { readWebhookRejections } from "../payment/guards/pay21-webhook-health";
import { JobHealthService } from "../job-health/job-health.service";

const MEDALS = ["🥇", "🥈", "🥉"];

/** The label season.service writes into prize notes and notification metadata. */
function monthLabel(month: number, year: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "Week of 29 Sep 2026" or "September 2026", from a YYYY-MM-DD bucket start. */
function bucketLabel(start: string, period: "week" | "month"): string {
  const [y, m, d] = start.split("-").map(Number);
  if (period === "month") return monthLabel(m, y);
  const date = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return `Week of ${date}`;
}

const clampLimit = (raw: unknown, fallback: number, max: number) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback;
};

/**
 * Read-only views over tables the dashboard had no window onto.
 *
 * Every one of these was a question that, before this existed, could only be
 * answered by somebody with a database client. They live here rather than in
 * `admin.controller.ts`, which is past 3,800 lines, and they are all reads: no
 * endpoint in this file moves money or changes state.
 */
@ApiTags("admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller("admin/insights")
export class AdminInsightsController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly redis?: RedisService,
    @Optional() private readonly jobHealth?: JobHealthService,
  ) {}

  /**
   * Each monthly season, its podium, and whether each prize actually landed.
   *
   * Crediting runs fire-and-forget after the season closes, and each prize is
   * its own transaction — so it can partially succeed, and a failure only ever
   * reached the logs. "Were September's winners paid?" needed three queries.
   *
   * A prize counts as paid when the `season_prize` transaction with the exact
   * note season.service writes exists for that user. Matching on the note is
   * what the service itself uses as its idempotency key, so this cannot
   * disagree with what the service believes it did.
   *
   * Each place also carries whether the in-app prize notification was created
   * and whether the winner has opened it (`seenAt`).
   */
  @Get("seasons")
  async seasons(@Query("limit") limit?: string) {
    const take = clampLimit(limit, 12, 36);

    const seasons: Array<{
      id: string;
      month: number;
      year: number;
      startsAt: Date;
      endsAt: Date;
      status: string;
      winnersSnapshot: Array<Record<string, any>> | null;
    }> = await this.dataSource.query(
      `SELECT id, "weekNumber" AS month, year, "startsAt", "endsAt", status,
              "winnersSnapshot"
         FROM seasons
        ORDER BY year DESC, "weekNumber" DESC
        LIMIT $1`,
      [take],
    );
    if (seasons.length === 0) return { prizes: SEASON_PRIZES, seasons: [] };

    // Every prize note in one query, keyed by note.
    const labels = seasons.map((s) => monthLabel(s.month, s.year));
    const prizeRows: Array<{
      userId: string;
      amount: string;
      note: string;
      createdAt: Date;
    }> = await this.dataSource.query(
      `SELECT "userId", amount, note, "createdAt"
         FROM transactions
        WHERE type = 'season_prize'
          AND note LIKE ANY($1)`,
      [labels.map((l) => `%Season prize — ${l} #%`)],
    );
    const prizeByNoteAndUser = new Map(
      prizeRows.map((r) => [`${r.note}|${r.userId}`, r]),
    );

    // The in-app popup each winner gets, and whether they opened it. Keyed by
    // the month label season.service stores in the notification's metadata.
    // `seenAt` stays null until the popup is shown — the only read receipt
    // there is. (The Telegram DM has none; Telegram does not report reads.)
    const noticeRows: Array<{
      userId: string;
      month: string;
      createdAt: Date;
      seenAt: Date | null;
    }> = await this.dataSource.query(
      `SELECT "userId", metadata->>'month' AS month, "createdAt", "seenAt"
         FROM user_notifications
        WHERE type = 'season_prize'
          AND metadata->>'month' = ANY($1)`,
      [labels],
    );
    const noticeByMonthAndUser = new Map(
      noticeRows.map((r) => [`${r.month}|${r.userId}`, r]),
    );

    return {
      prizes: SEASON_PRIZES,
      minQualifiers: SEASON_MIN_QUALIFIERS,
      seasons: seasons.map((s) => {
        const label = monthLabel(s.month, s.year);
        const snapshot = Array.isArray(s.winnersSnapshot) ? s.winnersSnapshot : [];
        // Mirrors the service's own guard: fewer than the minimum qualifiers
        // closes the season with a snapshot and pays nobody, by design.
        const paysOut =
          s.status === "closed" && snapshot.length >= SEASON_MIN_QUALIFIERS;

        const podium = snapshot
          .filter((w) => Number(w.rank) >= 1 && Number(w.rank) <= 3)
          .sort((a, b) => Number(a.rank) - Number(b.rank))
          .map((w) => {
            const rank = Number(w.rank);
            const note = `${MEDALS[rank - 1]} Season prize — ${label} #${rank}`;
            const paid = prizeByNoteAndUser.get(`${note}|${w.userId}`);
            const notice = noticeByMonthAndUser.get(`${label}|${w.userId}`);
            return {
              rank,
              userId: w.userId as string,
              name: (w.username as string) || (w.firstName as string) || null,
              winRate: Number(w.winRate ?? 0),
              volume: Number(w.volume ?? 0),
              prize: SEASON_PRIZES[rank] ?? 0,
              paid: !!paid,
              paidAmount: paid ? Number(paid.amount) : null,
              paidAt: paid?.createdAt ?? null,
              // Notification is only sent on a fresh credit, so a paid place
              // with no notification row means the send failed after the
              // money moved — worth seeing, not just "unseen".
              notified: !!notice,
              notifiedAt: notice?.createdAt ?? null,
              seenAt: notice?.seenAt ?? null,
            };
          });

        return {
          id: s.id,
          label,
          month: s.month,
          year: s.year,
          status: s.status,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          qualifiers: snapshot.length,
          paysOut,
          podium,
        };
      }),
    };
  }

  /**
   * Markets whose house edge is not the standard one.
   *
   * fee.constants.ts standardised every market on one flat edge because it had
   * drifted across 5%, 8% and 10% and made disclosure and reconciliation
   * inconsistent. But any admin can still set a per-market edge from 0 to 50%,
   * and nothing listed where that had happened — a market settled at 15% in
   * production and was only found by hand-written SQL.
   *
   * Settlement reads the edge from the BOOK (`book.houseEdgePct`), not the
   * market row, so both are checked. A market whose row says standard while a
   * book says otherwise is flagged as a mismatch: it is the one case where the
   * edge the admin sees is not the edge bettors are charged.
   */
  @Get("edge-exceptions")
  async edgeExceptions() {
    const rows: Array<{
      id: string;
      title: string;
      status: string;
      subcategory: string | null;
      marketEdge: string;
      createdAt: Date;
      currency: string | null;
      bookEdge: string | null;
      bookPool: string | null;
    }> = await this.dataSource.query(
      `SELECT m.id, m.title, m.status, m.subcategory,
              m."houseEdgePct" AS "marketEdge", m."createdAt",
              b.currency, b."houseEdgePct" AS "bookEdge", b."totalPool" AS "bookPool"
         FROM markets m
         LEFT JOIN market_books b ON b."marketId" = m.id
        WHERE m."houseEdgePct" <> $1
           OR b."houseEdgePct" <> $1
        ORDER BY m."createdAt" DESC
        LIMIT 500`,
      [DEFAULT_HOUSE_EDGE_PCT],
    );

    const byMarket = new Map<
      string,
      {
        id: string;
        title: string;
        status: string;
        subcategory: string | null;
        marketEdge: number;
        createdAt: Date;
        books: { currency: string; edge: number; pool: number }[];
      }
    >();
    for (const r of rows) {
      let m = byMarket.get(r.id);
      if (!m) {
        m = {
          id: r.id,
          title: r.title,
          status: r.status,
          subcategory: r.subcategory,
          marketEdge: Number(r.marketEdge),
          createdAt: r.createdAt,
          books: [],
        };
        byMarket.set(r.id, m);
      }
      if (r.currency != null && r.bookEdge != null) {
        m.books.push({
          currency: r.currency,
          edge: Number(r.bookEdge),
          pool: Number(r.bookPool ?? 0),
        });
      }
    }

    return {
      standard: DEFAULT_HOUSE_EDGE_PCT,
      markets: [...byMarket.values()].map((m) => ({
        ...m,
        // What a bettor is actually charged differs from what the market row
        // shows. The row is what an admin reads; the book is what settles.
        mismatch: m.books.some((b) => b.edge !== m.marketEdge),
      })),
    };
  }

  /**
   * USDT deposit intents — the deposit side of the USDT rail.
   *
   * Withdrawals had a page; deposits had none. The figure that matters most is
   * `uncredited`: intents the chain says CONFIRMED that have no credit yet,
   * past a short grace. That is money a user sent which is not in their
   * balance — the thing a broken webhook plus a stalled poller would produce.
   */
  @Get("usdt-deposits")
  async usdtDeposits(
    @Query("limit") limit?: string,
    @Query("status") status?: string,
  ) {
    const take = clampLimit(limit, 50, 200);
    const valid = Object.values(CryptoIntentStatus) as string[];
    const filter = status && valid.includes(status) ? status : null;

    const rows = await this.dataSource.query(
      `SELECT i.id, i."userId", u.username, u."firstName", i.network,
              i."amountUsdt", i."detectedAmountUsdt", i.status, i."txHash",
              i."failureReason", i."createdAt", i."creditedAt", i."expiresAt"
         FROM crypto_payment_intents i
         LEFT JOIN users u ON u.id = i."userId"
        WHERE ($2::text IS NULL OR i.status::text = $2)
        ORDER BY i."createdAt" DESC
        LIMIT $1`,
      [take, filter],
    );

    const byStatus = await this.dataSource.query(
      `SELECT status::text AS status, COUNT(*)::int AS count
         FROM crypto_payment_intents
        WHERE "createdAt" > now() - interval '7 days'
        GROUP BY status`,
    );
    const [uncredited] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM(COALESCE("detectedAmountUsdt", "amountUsdt")), 0) AS amount
         FROM crypto_payment_intents
        WHERE status::text = ANY($1)
          AND "creditedAt" IS NULL
          AND "updatedAt" < now() - interval '10 minutes'`,
      [
        [
          CryptoIntentStatus.CONFIRMED,
          CryptoIntentStatus.CONFIRMED_PARTIAL,
          CryptoIntentStatus.CONFIRMED_OVERPAID,
        ],
      ],
    );

    return {
      statuses: valid,
      last7DaysByStatus: byStatus as Array<{ status: string; count: number }>,
      uncredited: {
        count: Number(uncredited?.count ?? 0),
        amountUsdt: Number(uncredited?.amount ?? 0),
      },
      deposits: (rows as any[]).map((r) => ({
        ...r,
        amountUsdt: Number(r.amountUsdt),
        detectedAmountUsdt:
          r.detectedAmountUsdt == null ? null : Number(r.detectedAmountUsdt),
      })),
    };
  }

  /**
   * 21Pay webhook deliveries, and whether they are being turned away.
   *
   * `crypto_webhook_events` only ever holds ACCEPTED deliveries — a delivery
   * that fails verification is rejected before anything records it. So this
   * also reports the rejection counter the webhook guard keeps, and whether
   * the verification secret is configured at all (as a yes/no only — never
   * its value). Without those two, a misnamed secret leaves this table looking
   * quietly healthy while every delivery bounces.
   *
   * `rawPayload` is deliberately not returned.
   */
  @Get("pay21-webhooks")
  async pay21Webhooks(@Query("limit") limit?: string) {
    const take = clampLimit(limit, 50, 200);

    const [events, [agg], rejections] = await Promise.all([
      this.dataSource.query(
        `SELECT id, subject, "eventAction", network, "txHash", amount, currency,
                "receivedAt", "processedAt", "processError"
           FROM crypto_webhook_events
          ORDER BY "receivedAt" DESC
          LIMIT $1`,
        [take],
      ),
      this.dataSource.query(
        `SELECT MAX("receivedAt") AS "lastReceivedAt",
                COUNT(*) FILTER (WHERE "receivedAt" > now() - interval '7 days')::int AS "received7d",
                COUNT(*) FILTER (WHERE "processError" IS NOT NULL
                                   AND "receivedAt" > now() - interval '7 days')::int AS "failed7d",
                COUNT(*) FILTER (WHERE "processedAt" IS NULL
                                   AND "processError" IS NULL
                                   AND "receivedAt" < now() - interval '5 minutes')::int AS "unprocessed"
           FROM crypto_webhook_events`,
      ),
      readWebhookRejections(this.redis),
    ]);

    return {
      health: {
        usdtEnabled: this.config?.get<string>("USDT_ENABLED") === "true",
        // The name the code actually reads. Presence only.
        secretConfigured: !!this.config?.get<string>("TWENTYONE_PAY_WEBHOOK_SECRET"),
        lastReceivedAt: agg?.lastReceivedAt ?? null,
        received7d: Number(agg?.received7d ?? 0),
        failed7d: Number(agg?.failed7d ?? 0),
        unprocessed: Number(agg?.unprocessed ?? 0),
        rejectedToday: rejections.today,
        rejected7d: rejections.last7Days,
        lastRejectedAt: rejections.lastRejectedAt,
      },
      events,
    };
  }

  /**
   * Whether the jobs that move money are still running.
   *
   * KeeperDashboard covers the keeper only. Nothing showed whether the season
   * rollover, revenue booking, withdrawal reconcilers or USDT pollers had run,
   * so "did September roll over?" had no answer short of the logs.
   *
   * The monthly rollover gets a second, database-derived check: is the active
   * season the current month's? A monthly job's own record is empty for weeks
   * after this was first deployed, and this answers the actual question
   * immediately.
   */
  @Get("jobs")
  async jobs() {
    const jobs = this.jobHealth ? await this.jobHealth.snapshot() : [];

    // The month in Bhutan, which is the clock the rollover runs on.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Thimphu",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(new Date());
    const part = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const month = part("month");
    const year = part("year");
    // The rollover fires at 00:05 on the 1st; allow it the first hours.
    const withinGrace = part("day") === 1 && part("hour") < 3;

    const [active] = await this.dataSource.query(
      `SELECT "weekNumber" AS month, year FROM seasons
        WHERE status = 'active'
        ORDER BY year DESC, "weekNumber" DESC
        LIMIT 1`,
    );
    const onCurrent =
      !!active && Number(active.month) === month && Number(active.year) === year;

    return {
      jobs,
      seasonRollover: {
        expected: monthLabel(month, year),
        active: active ? monthLabel(Number(active.month), Number(active.year)) : null,
        status: onCurrent ? "ok" : withinGrace ? "pending" : "behind",
      },
    };
  }

  /**
   * Everything that is waiting on a human, in one place.
   *
   * The home dashboard showed four totals and nothing actionable. Each of these
   * queues already lives on its own page; the problem was knowing to go and
   * look. Every item names the admin page that deals with it.
   *
   * Thresholds are deliberately past the point where the system would have
   * handled it on its own — a market closed three hours without a proposed
   * result, a DK withdrawal still processing after thirty minutes, a market
   * whose objection window ended fifteen minutes ago and has not settled — so
   * a non-zero count means something is actually stuck, not merely in flight.
   */
  @Get("attention")
  async attention() {
    // Midnight in Bhutan, the business day the "today" figures mean.
    const DAY_START = `(date_trunc('day', now() AT TIME ZONE 'Asia/Thimphu') AT TIME ZONE 'Asia/Thimphu')`;
    const NOT_SELF_RESOLVING = `COALESCE("externalSource", '') NOT IN ('ter', 'btc')`;

    const [r] = await this.dataSource.query(`
      SELECT
        (SELECT COUNT(*) FROM crypto_withdrawals
          WHERE "approvalStatus" = 'pending_approval')::int AS "usdtWithdrawals",
        (SELECT COUNT(*) FROM payments
          WHERE type = 'withdrawal' AND method = 'dkbank' AND status = 'processing'
            AND "createdAt" < now() - interval '30 minutes')::int AS "dkStuck",
        (SELECT COUNT(*) FROM disputes WHERE "bondStatus" = 'locked')::int AS "disputes",
        (SELECT COUNT(*) FROM markets
          WHERE status = 'closed' AND ${NOT_SELF_RESOLVING}
            AND "closesAt" < now() - interval '3 hours')::int AS "awaitingResult",
        (SELECT COUNT(*) FROM markets
          WHERE status = 'resolving' AND ${NOT_SELF_RESOLVING}
            AND "disputeDeadlineAt" < now() - interval '15 minutes')::int AS "stuckSettling",
        (SELECT COUNT(*) FROM revenue_distributions WHERE status = 'pending')::int AS "revenueCount",
        (SELECT COALESCE(SUM(amount), 0) FROM revenue_distributions
          WHERE status = 'pending' AND currency = 'BTN') AS "revenueBtn",
        (SELECT COUNT(*) FROM user_kyc_documents WHERE status = 'pending')::int AS "kyc",
        (SELECT COUNT(*) FROM crypto_payment_intents
          WHERE status::text IN ('confirmed', 'confirmed_partial', 'confirmed_overpaid')
            AND "creditedAt" IS NULL
            AND "updatedAt" < now() - interval '10 minutes')::int AS "usdtUncredited",
        (SELECT COUNT(*) FROM transactions
          WHERE type = 'deposit' AND currency = 'BTN' AND "createdAt" >= ${DAY_START})::int AS "depCount",
        (SELECT COALESCE(SUM(ABS(amount)), 0) FROM transactions
          WHERE type = 'deposit' AND currency = 'BTN' AND "createdAt" >= ${DAY_START}) AS "depSum",
        (SELECT COUNT(*) FROM transactions
          WHERE type = 'withdrawal' AND currency = 'BTN' AND "createdAt" >= ${DAY_START})::int AS "wdCount",
        (SELECT COALESCE(SUM(ABS(amount)), 0) FROM transactions
          WHERE type = 'withdrawal' AND currency = 'BTN' AND "createdAt" >= ${DAY_START}) AS "wdSum"
    `);

    const jobs = this.jobHealth ? await this.jobHealth.snapshot() : [];
    const jobProblems = jobs.filter(
      (j) => j.status === "failing" || j.status === "stale",
    ).length;

    const n = (v: unknown) => Number(v ?? 0);
    // `urgent` = someone's money is stuck or a payout is at risk. The rest are
    // ordinary queues that still need working.
    const items = [
      { key: "usdtUncredited", label: "USDT deposits confirmed but not credited", count: n(r?.usdtUncredited), page: "usdt-deposits", urgent: true },
      { key: "dkStuck", label: "DK withdrawals stuck processing (> 30 min)", count: n(r?.dkStuck), page: "payments", urgent: true },
      { key: "stuckSettling", label: "Markets past their objection window, not settled", count: n(r?.stuckSettling), page: "markets", urgent: true },
      { key: "jobProblems", label: "Scheduled jobs failing or stopped", count: jobProblems, page: "keeper", urgent: true },
      { key: "usdtWithdrawals", label: "USDT withdrawals awaiting approval", count: n(r?.usdtWithdrawals), page: "usdt-withdrawals", urgent: false },
      { key: "awaitingResult", label: "Markets closed 3h+ with no result proposed", count: n(r?.awaitingResult), page: "markets", urgent: false },
      { key: "disputes", label: "Open disputes", count: n(r?.disputes), page: "reporting", urgent: false },
      { key: "kyc", label: "Identity documents to review", count: n(r?.kyc), page: "kyc", urgent: false },
      { key: "revenue", label: "Revenue distributions not yet transferred", count: n(r?.revenueCount), amountBtn: n(r?.revenueBtn), page: "revenue", urgent: false },
    ];

    return {
      items,
      today: {
        deposits: { count: n(r?.depCount), sumBtn: n(r?.depSum) },
        withdrawals: { count: n(r?.wdCount), sumBtn: n(r?.wdSum) },
      },
    };
  }

  /**
   * Signups per week or per month, on the Bhutan calendar.
   *
   * `user-growth` only buckets by day over a fixed window, which answers "what
   * happened this week" but not "how does this month compare to the last six".
   *
   * `users."createdAt"` is a zoneless timestamp holding UTC, so it takes the
   * double cast `userGrowth` documents to reach Bhutan wall-clock; `now()` is
   * already timestamptz and takes one. Weeks are ISO, Monday-start.
   *
   * The provider split uses the weekly report's rule — a user's EARLIEST auth
   * method — so the two never disagree about where someone came from. Users
   * with no auth method still count toward the total, under "unknown".
   *
   * Bucket starts come back as YYYY-MM-DD text, not timestamps: node-postgres
   * parses a zoneless timestamp in the process's own zone, which would shift a
   * Monday into a Sunday anywhere that is not Bhutan.
   */
  @Get("signups")
  async signups(
    @Query("period") periodRaw?: string,
    @Query("count") countRaw?: string,
  ) {
    const period = periodRaw === "month" ? "month" : "week";
    const count = clampLimit(countRaw, 12, period === "month" ? 24 : 52);

    const rows: Array<{ start: string; provider: string | null; count: number }> =
      await this.dataSource.query(
        `WITH buckets AS (
           SELECT generate_series(
                    date_trunc($1::text, now() AT TIME ZONE 'Asia/Thimphu')
                      - ($2::int - 1) * ('1 ' || $1::text)::interval,
                    date_trunc($1::text, now() AT TIME ZONE 'Asia/Thimphu'),
                    ('1 ' || $1::text)::interval
                  ) AS bucket
         ),
         first_provider AS (
           SELECT DISTINCT ON (u.id)
                  u.id,
                  date_trunc($1::text,
                    u."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Thimphu') AS bucket,
                  am.provider
             FROM users u
             LEFT JOIN auth_methods am ON am."userId" = u.id
            WHERE u."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Thimphu'
                    >= (SELECT MIN(bucket) FROM buckets)
            ORDER BY u.id, am."createdAt" ASC
         )
         SELECT to_char(b.bucket, 'YYYY-MM-DD') AS start,
                fp.provider,
                COUNT(fp.id)::int AS count
           FROM buckets b
           LEFT JOIN first_provider fp ON fp.bucket = b.bucket
          GROUP BY b.bucket, fp.provider
          ORDER BY b.bucket`,
        [period, count],
      );

    // Fold provider rows into one entry per bucket, keeping empty buckets.
    const byStart = new Map<string, { signups: number; byProvider: Record<string, number> }>();
    for (const r of rows) {
      const b = byStart.get(r.start) ?? { signups: 0, byProvider: {} };
      const n = Number(r.count);
      // An empty bucket comes back as one row with a null provider and 0.
      if (n > 0) {
        b.signups += n;
        const key = r.provider ?? "unknown";
        b.byProvider[key] = (b.byProvider[key] ?? 0) + n;
      }
      byStart.set(r.start, b);
    }

    const starts = [...byStart.keys()].sort();
    const buckets = starts.map((start, i) => ({
      start,
      label: bucketLabel(start, period),
      // The newest bucket is the one still in progress.
      partial: i === starts.length - 1,
      ...byStart.get(start)!,
    }));

    return {
      period,
      buckets,
      total: buckets.reduce((sum, b) => sum + b.signups, 0),
    };
  }

  /**
   * Pool money and house edge per category and subcategory.
   *
   * Nothing broke revenue down this way; the only category grouping elsewhere
   * is 30-day bet volume, with no pool and no edge.
   *
   * Settled figures come from `settlements`, dated by `settledAt` — the same
   * basis as the Revenue page and the weekly report, so all three agree.
   * `from`/`to` are Bhutan calendar days, both inclusive; `settledAt` is a
   * zoneless UTC timestamp, so it takes the same double cast as signups.
   *
   * House edge is `houseAmount − houseForfeit`: pool money only. Forfeited
   * dispute bonds are reported beside it as `bonds`, never inside it. Rows
   * settled before that column existed have it at 0, so for them any bond is
   * still counted as edge — the page says so.
   *
   * `livePool` is what is staked right now on markets not yet settled, from
   * the market books. One currency per request: BTN and USDT are never summed.
   */
  @Get("category-revenue")
  async categoryRevenue(
    @Query("from") fromRaw?: string,
    @Query("to") toRaw?: string,
    @Query("currency") currencyRaw?: string,
  ) {
    const currency = currencyRaw === "USDT" ? "USDT" : "BTN";
    const day = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    const from = day(fromRaw);
    const to = day(toRaw);

    const LOCAL = `(s."settledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Thimphu')`;
    const settled: Array<Record<string, string>> = await this.dataSource.query(
      `SELECT m.category::text AS category,
              COALESCE(NULLIF(m.subcategory, ''), '(none)') AS subcategory,
              COUNT(*) FILTER (WHERE s."cancelReason" IS NULL)::int     AS settled,
              COUNT(*) FILTER (WHERE s."cancelReason" IS NOT NULL)::int AS refunded,
              COALESCE(SUM(s."totalPool")    FILTER (WHERE s."cancelReason" IS NULL), 0)     AS pool,
              COALESCE(SUM(s."totalPool")    FILTER (WHERE s."cancelReason" IS NOT NULL), 0) AS "refundedPool",
              COALESCE(SUM(s."houseAmount" - s."houseForfeit")
                                              FILTER (WHERE s."cancelReason" IS NULL), 0)     AS edge,
              COALESCE(SUM(s."houseForfeit") FILTER (WHERE s."cancelReason" IS NULL), 0)     AS bonds,
              COALESCE(SUM(s."totalPaidOut") FILTER (WHERE s."cancelReason" IS NULL), 0)     AS "paidOut"
         FROM settlements s
         JOIN markets m ON m.id = s."marketId"
        WHERE s.currency = $1
          AND ($2::date IS NULL OR ${LOCAL} >= $2::date)
          AND ($3::date IS NULL OR ${LOCAL} < $3::date + 1)
        GROUP BY 1, 2`,
      [currency, from, to],
    );

    const live: Array<Record<string, string>> = await this.dataSource.query(
      `SELECT m.category::text AS category,
              COALESCE(NULLIF(m.subcategory, ''), '(none)') AS subcategory,
              COUNT(DISTINCT m.id)::int AS markets,
              COALESCE(SUM(b."totalPool"), 0) AS pool
         FROM market_books b
         JOIN markets m ON m.id = b."marketId"
        WHERE b.currency = $1
          AND m.status IN ('upcoming', 'open', 'closed', 'resolving')
        GROUP BY 1, 2`,
      [currency],
    );

    type Figures = {
      settled: number; refunded: number; pool: number; refundedPool: number;
      edge: number; bonds: number; paidOut: number;
      liveMarkets: number; livePool: number;
    };
    const zero = (): Figures => ({
      settled: 0, refunded: 0, pool: 0, refundedPool: 0,
      edge: 0, bonds: 0, paidOut: 0, liveMarkets: 0, livePool: 0,
    });
    const add = (a: Figures, b: Figures) => {
      for (const k of Object.keys(a) as (keyof Figures)[]) a[k] += b[k];
    };

    const cats = new Map<string, { totals: Figures; subs: Map<string, Figures> }>();
    const slot = (category: string, subcategory: string) => {
      let c = cats.get(category);
      if (!c) cats.set(category, (c = { totals: zero(), subs: new Map() }));
      let sub = c.subs.get(subcategory);
      if (!sub) c.subs.set(subcategory, (sub = zero()));
      return sub;
    };

    for (const r of settled) {
      const f = slot(r.category, r.subcategory);
      f.settled += Number(r.settled);
      f.refunded += Number(r.refunded);
      f.pool += Number(r.pool);
      f.refundedPool += Number(r.refundedPool);
      f.edge += Number(r.edge);
      f.bonds += Number(r.bonds);
      f.paidOut += Number(r.paidOut);
    }
    for (const r of live) {
      const f = slot(r.category, r.subcategory);
      f.liveMarkets += Number(r.markets);
      f.livePool += Number(r.pool);
    }

    // Effective edge on pool money only, so it reads ~10% when the edge is
    // being applied as configured.
    const withPct = (f: Figures) => ({
      ...f,
      edgePct: f.pool > 0 ? Math.round((f.edge / f.pool) * 10000) / 100 : null,
    });

    const grand = zero();
    const categories = [...cats.entries()]
      .map(([category, c]) => {
        for (const f of c.subs.values()) add(c.totals, f);
        add(grand, c.totals);
        return {
          category,
          ...withPct(c.totals),
          subcategories: [...c.subs.entries()]
            .map(([subcategory, f]) => ({ subcategory, ...withPct(f) }))
            .sort((a, b) => b.pool - a.pool || b.livePool - a.livePool),
        };
      })
      .sort((a, b) => b.pool - a.pool || b.livePool - a.livePool);

    return { currency, from, to, totals: withPct(grand), categories };
  }
}
