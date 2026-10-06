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

const MEDALS = ["🥇", "🥈", "🥉"];

/** The label season.service writes into prize notes and notification metadata. */
function monthLabel(month: number, year: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
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
}
