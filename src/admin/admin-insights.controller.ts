import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { JwtAuthGuard, AdminGuard } from "../auth/guards";
import {
  SEASON_MIN_QUALIFIERS,
  SEASON_PRIZES,
} from "../users/season.service";

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
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

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
}
