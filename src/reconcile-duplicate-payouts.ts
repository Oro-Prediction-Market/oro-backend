/**
 * One-off reconciliation script — reverses duplicate POSITION_PAYOUT and
 * FREE_CREDIT transactions caused by the TER scheduler race (fixed in
 * TerMarketService.closeAndResolve + ParimutuelEngine.resolveMarket atomic
 * claim). Adds equal-and-opposite reversal transactions so balances are
 * corrected without deleting any historical rows (full audit trail preserved).
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/reconcile-duplicate-payouts.ts            # dry-run
 *   npx ts-node -r tsconfig-paths/register src/reconcile-duplicate-payouts.ts --execute  # commit
 *
 * Idempotent: re-running after --execute finds no duplicates because each
 * reversal carries a unique note tag that the detection step filters out.
 */
import { AppDataSource } from "./data-source";
import {
  Transaction,
  TransactionType,
} from "./entities/transaction.entity";
import { User } from "./entities/user.entity";
import { Settlement } from "./entities/settlement.entity";

const RECONCILIATION_NOTE_PREFIX = "RECONCILIATION: reversing duplicate of txn";

interface DupGroupRow {
  positionId: string;
  type: TransactionType;
  userId: string;
  count: string;
}

async function main(): Promise<void> {
  const isDryRun = !process.argv.includes("--execute");
  const banner = isDryRun ? "[DRY-RUN]" : "[EXECUTE]";

  await AppDataSource.initialize();
  console.log(`${banner} Connected to database\n`);

  const txnRepo = AppDataSource.getRepository(Transaction);
  const userRepo = AppDataSource.getRepository(User);
  const settlementRepo = AppDataSource.getRepository(Settlement);

  // ── Step 0: Surface duplicate Settlement rows (FYI only — not modified) ────
  const dupSettlements: Array<{ marketId: string; count: string }> =
    await settlementRepo.query(`
      SELECT "marketId", COUNT(*) AS count
      FROM settlements
      GROUP BY "marketId"
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
    `);
  if (dupSettlements.length > 0) {
    console.log(
      `Note: ${dupSettlements.length} market(s) have duplicate Settlement rows ` +
        `(audit-only, not affecting balances):`,
    );
    for (const s of dupSettlements) {
      console.log(`  market ${s.marketId}: ${s.count} settlement rows`);
    }
    console.log("");
  }

  // ── Step 1: Find duplicate payout / free-credit groups ─────────────────────
  // A bet (positionId) should produce AT MOST ONE POSITION_PAYOUT and AT MOST
  // ONE FREE_CREDIT per resolution. count > 1 = duplicate.
  const dupGroups: DupGroupRow[] = await txnRepo.query(`
    SELECT "positionId", type, "userId", COUNT(*)::text AS count
    FROM transactions
    WHERE "positionId" IS NOT NULL
      AND type IN ('bet_payout', 'free_credit')
      AND COALESCE(note, '') NOT LIKE 'RECONCILIATION:%'
    GROUP BY "positionId", type, "userId"
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
  `);

  if (dupGroups.length === 0) {
    console.log(`${banner} No duplicates found. Nothing to do.`);
    await AppDataSource.destroy();
    return;
  }

  console.log(
    `Found ${dupGroups.length} duplicate (positionId, type, userId) group(s)\n`,
  );

  let totalCashReversed = 0;
  let totalBonusReversed = 0;
  let reversalCount = 0;
  let skippedAlreadyReversed = 0;
  const userBonusOverPaid = new Map<string, number>();
  const affectedUserIds = new Set<string>();

  for (const grp of dupGroups) {
    // Fetch all real (non-reversal) txns in this group, oldest first
    const all = await txnRepo.find({
      where: {
        positionId: grp.positionId,
        type: grp.type,
        userId: grp.userId,
      },
      order: { createdAt: "ASC" },
    });
    const reals = all.filter(
      (t) => !t.note?.startsWith(RECONCILIATION_NOTE_PREFIX),
    );
    if (reals.length <= 1) continue;

    const keep = reals[0];
    const toReverse = reals.slice(1);

    console.log(
      `\nGroup: position=${grp.positionId.slice(0, 8)}… type=${grp.type} user=${grp.userId.slice(0, 8)}… realCount=${reals.length}`,
    );
    console.log(
      `  KEEP    ${keep.id.slice(0, 8)}… amount=${keep.amount} createdAt=${keep.createdAt.toISOString()}`,
    );

    for (const dup of toReverse) {
      const reversalNote = `${RECONCILIATION_NOTE_PREFIX} ${dup.id}`;
      const existing = await txnRepo.findOneBy({
        userId: dup.userId,
        note: reversalNote,
      });
      if (existing) {
        skippedAlreadyReversed++;
        console.log(
          `  SKIP    ${dup.id.slice(0, 8)}… (already reversed by ${existing.id.slice(0, 8)}…)`,
        );
        continue;
      }

      console.log(
        `  REVERSE ${dup.id.slice(0, 8)}… amount=${dup.amount} createdAt=${dup.createdAt.toISOString()}`,
      );

      if (!isDryRun) {
        const row = await txnRepo
          .createQueryBuilder("t")
          .select("COALESCE(SUM(t.amount), 0)", "sum")
          .where("t.userId = :userId", { userId: dup.userId })
          .getRawOne();
        const currentBalance = Number(row.sum);
        const reversalAmount = -Number(dup.amount);

        await txnRepo.save(
          txnRepo.create({
            type: dup.type,
            amount: reversalAmount,
            balanceBefore: currentBalance,
            balanceAfter: currentBalance + reversalAmount,
            positionId: dup.positionId,
            userId: dup.userId,
            isBonus: dup.isBonus,
            note: reversalNote,
          }),
        );
      }

      reversalCount++;
      affectedUserIds.add(dup.userId);

      if (dup.type === TransactionType.POSITION_PAYOUT) {
        totalCashReversed += Number(dup.amount);
      } else if (dup.type === TransactionType.FREE_CREDIT) {
        totalBonusReversed += Number(dup.amount);
        // Duplicate FREE_CREDIT means User.bonusBalance was double-credited
        // via the relative SQL expression `bonusBalance + ${playPayout}` in
        // parimutuel.engine.ts. Track per-user over-credit to roll back.
        userBonusOverPaid.set(
          dup.userId,
          (userBonusOverPaid.get(dup.userId) ?? 0) + Number(dup.amount),
        );
      }
    }
  }

  // ── Step 2: Correct User.bonusBalance for duplicate FREE_CREDIT ────────────
  if (userBonusOverPaid.size > 0) {
    console.log(`\n── Bonus balance corrections ──`);
    for (const [userId, overCredit] of userBonusOverPaid) {
      console.log(
        `  user ${userId.slice(0, 8)}…  -${overCredit.toFixed(2)} from bonusBalance (floor 0)`,
      );
      if (!isDryRun) {
        await userRepo
          .createQueryBuilder()
          .update(User)
          .set({
            bonusBalance: () =>
              `GREATEST(0, "bonusBalance" - ${overCredit.toFixed(2)})`,
          })
          .where("id = :id", { id: userId })
          .execute();
      }
    }
  }

  console.log(`\n── Summary ──`);
  console.log(`Duplicate groups inspected:  ${dupGroups.length}`);
  console.log(`Reversals ${isDryRun ? "to create" : "created"}:        ${reversalCount}`);
  console.log(`Already-reversed (skipped):  ${skippedAlreadyReversed}`);
  console.log(`Affected users:              ${affectedUserIds.size}`);
  console.log(`Cash reversed:               Nu ${totalCashReversed.toFixed(2)}`);
  console.log(`Bonus credits reversed:      Nu ${totalBonusReversed.toFixed(2)}`);
  console.log("");

  if (isDryRun) {
    console.log(
      `${banner} No changes written. Re-run with --execute to commit.`,
    );
  } else {
    console.log(`${banner} Committed. Affected user IDs:`);
    for (const uid of affectedUserIds) console.log(`  ${uid}`);
    console.log(
      `\nIMPORTANT: bust Redis balance cache for these users (oro:cache:balance:<userId>) ` +
        `or restart the backend so balances reflect immediately.`,
    );
  }

  await AppDataSource.destroy();
}

main().catch((err: Error) => {
  console.error("\nReconciliation FAILED:", err.message);
  console.error(err.stack);
  process.exit(1);
});
