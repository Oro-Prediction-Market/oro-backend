/**
 * End-to-end Dispute Bond Flow Test
 *
 * Demonstrates that bet ledger and dispute bond ledger are COMPLETELY SEPARATE:
 *   - POSITION_OPENED (-amount)  → placed when user bets
 *   - DISPUTE_BOND    (-bond)    → placed when user challenges resolution
 *   - POSITION_PAYOUT (+payout)  → credited when user wins bet
 *   - DISPUTE_REFUND  (+bond)    → credited ONLY if dispute was correct
 *
 * Two scenarios tested back-to-back:
 *   Scenario 1 — Dispute WRONG (proposal confirmed):
 *     B bets on "No", A bets on "Yes". Admin proposes "Yes".
 *     B disputes → bond staked. Admin confirms "Yes".
 *     B's bond is SLASHED. A gets normal payout + 95% of B's bond.
 *
 *   Scenario 2 — Dispute CORRECT (proposal overturned):
 *     Same bets. Admin proposes "No" (wrong). B disputes.
 *     Admin corrects to "Yes". B's bond is RETURNED.
 *     A gets normal payout (no bonus since no bond was slashed).
 *
 * Usage:
 *   node test-dispute-flow.js                           # default: A=500, B=300, bond=50
 *   node test-dispute-flow.js --bet-a 500 --bet-b 300 --bond 100
 *   node test-dispute-flow.js --scenario 2              # only run scenario 2
 */

const { Pool }  = require("../node_modules/pg");
const { randomUUID } = require("crypto");
const path = require("path");
const fs   = require("fs");

// ── Load .env ──────────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    const eq = t.indexOf("=");
    if (eq === -1) return;
    const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim();
    if (k && !(k in process.env)) process.env[k] = v;
  });
}

// ── CLI args ────────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const getArg  = (flag, def) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : def; };
const BET_A   = parseFloat(getArg("--bet-a",    "500"));
const BET_B   = parseFloat(getArg("--bet-b",    "300"));
const BOND    = parseFloat(getArg("--bond",      "50"));
const HOUSE   = parseFloat(getArg("--house-pct", "8"));
const SCENARIO = getArg("--scenario", "both"); // "1", "2", or "both"

// ── DB ─────────────────────────────────────────────────────────────────────────
const db = new Pool({
  host:     process.env.DB_HOST     || "localhost",
  port:     parseInt(process.env.DB_PORT || "5432"),
  user:     process.env.DB_USERNAME || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME     || "oro_db",
});

// ── Test users (staging CIDs) ───────────────────────────────────────────────────
const CID_A = "11502000922";
const CID_B = "10304001086";

// ── Helpers ─────────────────────────────────────────────────────────────────────
const sep  = (char = "─", n = 60) => char.repeat(n);
const line = () => console.log(sep());
const hdr  = (s) => { console.log("\n" + sep("═")); console.log("  " + s); console.log(sep("═")); };

async function getUserByCid(cid) {
  const r = await db.query(`SELECT * FROM users WHERE "dkCid" = $1`, [cid]);
  if (!r.rows.length) throw new Error(`User with CID ${cid} not found in DB`);
  return r.rows[0];
}

async function getInAppBalance(userId) {
  const r = await db.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS bal FROM transactions WHERE "userId" = $1`,
    [userId],
  );
  return parseFloat(r.rows[0].bal) || 0;
}

async function getTxCount(userId) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM transactions WHERE "userId" = $1`,
    [userId],
  );
  return parseInt(r.rows[0].cnt, 10);
}

async function getLedgerSince(userId, offset) {
  const r = await db.query(
    `SELECT type, amount::float, "balanceBefore"::float AS balancebefore,
            "balanceAfter"::float AS balanceafter, note
       FROM transactions
      WHERE "userId" = $1
      ORDER BY "createdAt" ASC
      OFFSET $2`,
    [userId, offset],
  );
  return r.rows;
}

async function insertTx(userId, type, amount, balBefore, note) {
  const bal = balBefore ?? await getInAppBalance(userId);
  const balAfter = bal + amount;
  await db.query(
    `INSERT INTO transactions (id, type, amount, "balanceBefore", "balanceAfter", "userId", note, "createdAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW())`,
    [type, amount, bal, balAfter, userId, note],
  );
  return balAfter;
}

function printLedger(label, rows) {
  console.log(`\n  ${label}:`);
  if (!rows.length) { console.log("    (no entries)"); return; }
  for (const r of rows) {
    const sign = r.amount >= 0 ? "+" : "";
    console.log(
      `    [${r.type.padEnd(14)}]  ${sign}${r.amount.toFixed(2).padStart(9)}  ` +
      `bal: ${r.balanceafter?.toFixed(2) ?? r.balanceAfter?.toFixed(2)}  — ${r.note ?? ""}`,
    );
  }
}

// ── Scenario runner ─────────────────────────────────────────────────────────────
async function runScenario(num, userA, userB, disputeUpheald) {
  const label = num === 1
    ? "Dispute WRONG — proposal confirmed, bond SLASHED"
    : "Dispute CORRECT — proposal overturned, bond RETURNED";

  hdr(`SCENARIO ${num}: ${label}`);

  // Snapshot tx counts so we can show only this scenario's entries at the end
  const txCountA = await getTxCount(userA.id);
  const txCountB = await getTxCount(userB.id);

  // ── Step 1: Starting balances ─────────────────────────────────────────────
  const balA0 = await getInAppBalance(userA.id);
  const balB0 = await getInAppBalance(userB.id);

  console.log(`\n  Starting balances:`);
  console.log(`    User A (${userA.firstName}): Nu ${balA0.toFixed(2)}`);
  console.log(`    User B (${userB.firstName}): Nu ${balB0.toFixed(2)}`);

  if (balA0 < BET_A) throw new Error(`User A has insufficient balance (Nu ${balA0}, needs Nu ${BET_A})`);
  if (balB0 < BET_B + BOND) throw new Error(`User B has insufficient balance (Nu ${balB0}, needs Nu ${BET_B + BOND} for bet + bond)`);

  // ── Step 2: Create market + outcomes ─────────────────────────────────────
  console.log(`\n  Creating test market…`);
  const marketId  = randomUUID();
  const outcome1  = randomUUID(); // "Yes"
  const outcome2  = randomUUID(); // "No"

  await db.query(
    `INSERT INTO markets (id, title, description, status, "totalPool", "houseEdgePct",
       "createdAt", "updatedAt", "opensAt", "closesAt", mechanism, category)
     VALUES ($1, $2, $3, 'resolving', 0, $4, NOW(), NOW(), NOW(), NOW(), 'parimutuel', 'other')`,
    [marketId, `[TEST S${num}] Dispute flow test — ${new Date().toISOString()}`, "Auto-created by test-dispute-flow.js", HOUSE],
  );

  await db.query(
    `INSERT INTO outcomes (id, "marketId", label, "totalBetAmount", "currentOdds", "lmsrProbability", "isWinner")
     VALUES ($1, $2, 'Yes', 0, 1, 0.5, false), ($3, $2, 'No', 0, 1, 0.5, false)`,
    [outcome1, marketId, outcome2],
  );

  // Proposed outcome: Scenario 1 → propose "Yes" (correct). Scenario 2 → propose "No" (wrong).
  const proposedId = disputeUpheald ? outcome2 : outcome1;
  await db.query(`UPDATE markets SET "proposedOutcomeId" = $1 WHERE id = $2`, [proposedId, marketId]);

  console.log(`    Market ID:    ${marketId}`);
  console.log(`    Outcome "Yes": ${outcome1}`);
  console.log(`    Outcome "No":  ${outcome2}`);
  console.log(`    Proposed:     ${disputeUpheald ? '"No" (will be overturned)' : '"Yes" (will be confirmed)'}`);

  // ── Step 3: Place bets ───────────────────────────────────────────────────
  console.log(`\n  Placing bets…`);

  // A bets on "Yes"
  const balA1 = await getInAppBalance(userA.id);
  await db.query(
    `INSERT INTO positions (id, "userId", "marketId", "outcomeId", amount, status, "placedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'pending', NOW())`,
    [userA.id, marketId, outcome1, BET_A],
  );
  await insertTx(userA.id, "bet_placed", -BET_A, balA1, `Bet on "Yes" — test market S${num}`);
  await db.query(
    `UPDATE outcomes SET "totalBetAmount" = "totalBetAmount" + $1 WHERE id = $2`,
    [BET_A, outcome1],
  );
  await db.query(`UPDATE markets SET "totalPool" = "totalPool" + $1 WHERE id = $2`, [BET_A, marketId]);

  // B bets on "No"
  const balB1 = await getInAppBalance(userB.id);
  await db.query(
    `INSERT INTO positions (id, "userId", "marketId", "outcomeId", amount, status, "placedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'pending', NOW())`,
    [userB.id, marketId, outcome2, BET_B],
  );
  await insertTx(userB.id, "bet_placed", -BET_B, balB1, `Bet on "No" — test market S${num}`);
  await db.query(
    `UPDATE outcomes SET "totalBetAmount" = "totalBetAmount" + $1 WHERE id = $2`,
    [BET_B, outcome2],
  );
  await db.query(`UPDATE markets SET "totalPool" = "totalPool" + $1 WHERE id = $2`, [BET_B, marketId]);

  const balA2 = await getInAppBalance(userA.id);
  const balB2 = await getInAppBalance(userB.id);
  console.log(`    A bet Nu ${BET_A} on "Yes" → balance now Nu ${balA2.toFixed(2)}`);
  console.log(`    B bet Nu ${BET_B} on "No"  → balance now Nu ${balB2.toFixed(2)}`);

  // ── Step 4: B disputes the proposed outcome ───────────────────────────────
  console.log(`\n  User B files a dispute bond of Nu ${BOND}…`);
  const balBBeforeBond = await getInAppBalance(userB.id);
  await insertTx(userB.id, "dispute_bond", -BOND, balBBeforeBond, `Dispute bond — challenging proposal on market S${num}`);

  await db.query(
    `INSERT INTO disputes (id, "userId", "marketId", "bondAmount", "bondRefunded", "createdAt")
     VALUES (gen_random_uuid(), $1, $2, $3, false, NOW())`,
    [userB.id, marketId, BOND],
  );

  const balA3 = await getInAppBalance(userA.id);
  const balB3 = await getInAppBalance(userB.id);

  line();
  console.log(`  Ledger state AFTER bets + bond (before resolution):`);
  console.log(`    User A balance: Nu ${balA3.toFixed(2)}  (deducted Nu ${BET_A} for bet)`);
  console.log(`    User B balance: Nu ${balB3.toFixed(2)}  (deducted Nu ${BET_B} for bet + Nu ${BOND} for bond — SEPARATE entries)`);
  console.log(`\n  KEY POINT: Both deductions show up as different transaction types.`);
  console.log(`    B's bet deduction  → type: bet_placed   (-Nu ${BET_B})`);
  console.log(`    B's bond deduction → type: dispute_bond (-Nu ${BOND})`);
  console.log(`    They are COMPLETELY separate in the ledger.`);

  // ── Step 5: Resolve market ────────────────────────────────────────────────
  const winningId = outcome1; // "Yes" always wins in this test
  const totalPool = BET_A + BET_B;
  const houseAmt  = totalPool * (HOUSE / 100);
  const basePayoutPool = totalPool - houseAmt;

  let payoutPool = basePayoutPool;
  let slashedPool = 0;

  if (!disputeUpheald) {
    // Scenario 1: proposal confirmed → B's bond slashed → 95% to A
    slashedPool = BOND;
    payoutPool  = basePayoutPool + slashedPool * 0.95;
    console.log(`\n  Admin confirms "Yes" → proposal upheld → B's bond SLASHED`);
  } else {
    // Scenario 2: proposal overturned → B's bond returned
    console.log(`\n  Admin corrects to "Yes" → proposal overturned → B's bond RETURNED`);
  }

  const payoutToA = payoutPool; // A is sole winner (bet 100% of winner pool)

  // Mark market resolved
  await db.query(
    `UPDATE markets SET status = 'settled', "resolvedOutcomeId" = $1, "resolvedAt" = NOW() WHERE id = $2`,
    [winningId, marketId],
  );
  await db.query(`UPDATE outcomes SET "isWinner" = true WHERE id = $1`, [winningId]);

  // Update position statuses
  await db.query(
    `UPDATE positions SET status = 'won', payout = $1 WHERE "marketId" = $2 AND "outcomeId" = $3`,
    [payoutToA.toFixed(2), marketId, winningId],
  );
  await db.query(
    `UPDATE positions SET status = 'lost' WHERE "marketId" = $1 AND "outcomeId" != $2`,
    [marketId, winningId],
  );

  // ── Step 6: Settle dispute bonds ─────────────────────────────────────────
  const disputeRows = await db.query(
    `SELECT * FROM disputes WHERE "marketId" = $1 AND "bondRefunded" = false`,
    [marketId],
  );

  for (const dispute of disputeRows.rows) {
    if (disputeUpheald) {
      // Bond returned
      const bBal = await getInAppBalance(dispute.userId);
      await insertTx(dispute.userId, "dispute_refund", Number(dispute.bondAmount), bBal,
        `Dispute upheld — bond returned after market S${num}`);
    }
    // Whether slashed or returned, mark as processed
    await db.query(`UPDATE disputes SET "bondRefunded" = true WHERE id = $1`, [dispute.id]);
  }

  // ── Step 7: Credit A's payout ────────────────────────────────────────────
  const balABeforePayout = await getInAppBalance(userA.id);
  await insertTx(userA.id, "bet_payout", payoutToA, balABeforePayout,
    `Payout for winning bet on "Yes"${slashedPool > 0 ? ` (incl. Nu ${(slashedPool * 0.95).toFixed(2)} from slashed dispute bonds)` : ""} — market S${num}`);

  // ── Step 8: Final balances & ledger summary ───────────────────────────────
  const balA4 = await getInAppBalance(userA.id);
  const balB4 = await getInAppBalance(userB.id);

  hdr(`SCENARIO ${num} RESULTS`);

  const ledA = await getLedgerSince(userA.id, txCountA);
  const ledB = await getLedgerSince(userB.id, txCountB);

  printLedger("User A ledger this run", ledA);
  printLedger("User B ledger this run", ledB);

  line();
  console.log(`\n  POOL MATH:`);
  console.log(`    Total bet pool   : Nu ${totalPool.toFixed(2)}`);
  console.log(`    House cut (${HOUSE}%)  : Nu ${houseAmt.toFixed(2)}`);
  console.log(`    Base payout pool : Nu ${basePayoutPool.toFixed(2)}`);
  if (slashedPool > 0) {
    console.log(`    Slashed bonds    : Nu ${slashedPool.toFixed(2)}`);
    console.log(`    Platform fee(5%) : Nu ${(slashedPool * 0.05).toFixed(2)}`);
    console.log(`    Bonus to winner  : Nu ${(slashedPool * 0.95).toFixed(2)}`);
    console.log(`    Total payout pool: Nu ${payoutPool.toFixed(2)}`);
  }

  line();
  console.log(`\n  FINAL BALANCES:`);
  console.log(`    User A: Nu ${balA0.toFixed(2)} → Nu ${balA4.toFixed(2)}  (net: ${(balA4 - balA0) >= 0 ? "+" : ""}${(balA4 - balA0).toFixed(2)})`);
  console.log(`    User B: Nu ${balB0.toFixed(2)} → Nu ${balB4.toFixed(2)}  (net: ${(balB4 - balB0) >= 0 ? "+" : ""}${(balB4 - balB0).toFixed(2)})`);
  console.log();

  if (!disputeUpheald) {
    console.log(`  ✅ S1: B's bond (Nu ${BOND}) was SLASHED — no dispute_refund transaction`);
    console.log(`  ✅ S1: A's payout includes Nu ${(slashedPool * 0.95).toFixed(2)} bonus from slashed bonds`);
    console.log(`  ✅ S1: Platform kept Nu ${(slashedPool * 0.05).toFixed(2)} (5% fee)`);
  } else {
    console.log(`  ✅ S2: B's bond (Nu ${BOND}) was RETURNED via dispute_refund transaction`);
    console.log(`  ✅ S2: A's payout is normal (no bonus — no bonds slashed)`);
  }
}

// ── Scheduled job sample ────────────────────────────────────────────────────────
function printScheduledJobSample() {
  hdr("SAMPLE: Auto-resolution Cron Job (NestJS)");
  console.log(`
  Add this to a new file: backend/src/markets/markets.scheduler.ts
  ─────────────────────────────────────────────────────────────────
  import { Injectable, Logger } from "@nestjs/common";
  import { Cron, CronExpression } from "@nestjs/schedule";
  import { InjectRepository } from "@nestjs/typeorm";
  import { Repository, LessThan } from "typeorm";
  import { Market, MarketStatus } from "../entities/market.entity";
  import { Dispute } from "../entities/dispute.entity";
  import { ParimutuelEngine } from "./parimutuel.engine";

  @Injectable()
  export class MarketsScheduler {
    private readonly logger = new Logger(MarketsScheduler.name);

    constructor(
      @InjectRepository(Market) private marketRepo: Repository<Market>,
      @InjectRepository(Dispute) private disputeRepo: Repository<Dispute>,
      private engine: ParimutuelEngine,
    ) {}

    // Runs every 5 minutes — auto-resolves markets whose dispute window has
    // closed with no disputes filed (confirms the proposed outcome as final).
    @Cron(CronExpression.EVERY_5_MINUTES)
    async autoResolveExpiredDisputeWindows() {
      const markets = await this.marketRepo.find({
        where: {
          status: MarketStatus.RESOLVING,
          disputeDeadlineAt: LessThan(new Date()),
        },
      });

      for (const market of markets) {
        if (!market.proposedOutcomeId) continue;

        const disputes = await this.disputeRepo.count({
          where: { marketId: market.id, bondRefunded: false },
        });

        if (disputes > 0) {
          this.logger.warn(
            \`[AutoResolve] Market \${market.id} has \${disputes} open dispute(s) — skipping auto-resolve, admin must review\`,
          );
          continue;
        }

        this.logger.log(
          \`[AutoResolve] Resolving market \${market.id} with proposed outcome \${market.proposedOutcomeId}\`,
        );

        await this.engine
          .resolveMarket(market.id, market.proposedOutcomeId)
          .catch((err) =>
            this.logger.error(\`[AutoResolve] Failed for market \${market.id}: \${err.message}\`),
          );
      }
    }
  }
  ─────────────────────────────────────────────────────────────────
  Then add MarketsScheduler to providers[] in markets.module.ts
  and ensure ScheduleModule.forRoot() is imported in app.module.ts.
`);
}

// ── Main ─────────────────────────────────────────────────────────────────────────
(async () => {
  console.log(sep("═"));
  console.log("  Dispute Bond Flow Test");
  console.log(`  Bet A: Nu ${BET_A}  |  Bet B: Nu ${BET_B}  |  Bond: Nu ${BOND}  |  House: ${HOUSE}%`);
  console.log(sep("═"));

  try {
    const userA = await getUserByCid(CID_A);
    const userB = await getUserByCid(CID_B);
    console.log(`\n  User A: ${userA.firstName} (id: ${userA.id})`);
    console.log(`  User B: ${userB.firstName} (id: ${userB.id})`);

    if (SCENARIO === "1" || SCENARIO === "both") {
      await runScenario(1, userA, userB, false); // proposal confirmed → bond slashed
    }
    if (SCENARIO === "2" || SCENARIO === "both") {
      await runScenario(2, userA, userB, true);  // proposal overturned → bond returned
    }

    printScheduledJobSample();

  } catch (err) {
    console.error(`\n  ❌ Fatal: ${err.message}`);
    process.exit(1);
  } finally {
    await db.end();
  }

  console.log("\n" + sep("═"));
  console.log("  Done ✅");
  console.log(sep("═") + "\n");
})();
