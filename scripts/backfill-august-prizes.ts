// One-off back-fill: pay the August 2026 season top-3 prizes that were withheld
// by the (then 5-) qualifier floor. Reuses the PRODUCTION crediter
// (SeasonService.creditSeasonPrizes) so each winner gets the credit AND the
// normal notifications — in-app popup, Telegram DM, and BhutanApp push — exactly
// like a real rollover. Idempotent: guards on the SEASON_PRIZE note per
// user/rank, so re-running never double-credits or re-notifies. Run against PROD.
//
//   preview (no writes, no DMs):
//     npx ts-node -r tsconfig-paths/register scripts/backfill-august-prizes.ts
//   actually credit + notify:
//     npx ts-node -r tsconfig-paths/register scripts/backfill-august-prizes.ts --commit
import { NestFactory } from "@nestjs/core";
import { DataSource } from "typeorm";
import { AppModule } from "../src/app.module";
import { SeasonService } from "../src/users/season.service";
import { Season } from "../src/entities/season.entity";
import { User } from "../src/entities/user.entity";

const PRIZES: Record<number, number> = { 1: 700, 2: 500, 3: 350 };
const COMMIT = process.argv.includes("--commit");

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn", "log"],
  });
  try {
    const ds = app.get(DataSource);
    const seasonService = app.get(SeasonService);

    const season = await ds
      .getRepository(Season)
      .findOne({ where: { year: 2026, weekNumber: 8 } });
    if (!season) {
      console.error("[backfill] August 2026 season not found — aborting.");
      return;
    }

    const top3 = ((season.winnersSnapshot as any[]) ?? [])
      .filter((w) => w.rank >= 1 && w.rank <= 3)
      .sort((a, b) => a.rank - b.rank);
    if (top3.length === 0) {
      console.error("[backfill] snapshot has no top-3 — aborting.");
      return;
    }

    // Load the User entities in rank order — creditSeasonPrizes assigns the prize
    // by array position (index 0 = #1, etc.).
    const userRepo = ds.getRepository(User);
    const winners: User[] = [];
    for (const w of top3) {
      const u = await userRepo.findOne({ where: { id: w.userId } });
      if (!u) {
        console.error(`[backfill] user ${w.userId} (#${w.rank}) not found — aborting.`);
        return;
      }
      winners.push(u);
      console.log(
        `[backfill] #${w.rank}  Nu ${PRIZES[w.rank]}  → ${w.username ?? w.firstName ?? w.userId}`,
      );
    }

    if (!COMMIT) {
      console.log(
        "[backfill] preview only — nothing credited, no notifications sent. Re-run with --commit to pay + notify.",
      );
      return;
    }

    // Reuses the production path: credits each winner AND sends the in-app popup,
    // Telegram DM and BhutanApp push. Idempotent per note.
    await (seasonService as any).creditSeasonPrizes(winners, season);
    console.log("[backfill] done — credited + notified (idempotent).");
  } finally {
    await app.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[backfill] failed:", e);
    process.exit(1);
  });
