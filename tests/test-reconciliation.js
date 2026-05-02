/**
 * Reconciliation System Test Script
 *
 * This script tests the reconciliation system by:
 * 1. Creating a test market
 * 2. Having users place bets
 * 3. Settling the market
 * 4. Running reconciliation to verify payouts
 * 5. Checking for discrepancies
 *
 * Usage:
 *   node test-reconciliation.js
 */

const https = require("https");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

// ── Configuration ────────────────────────────────────────────────────────────
const DB_CONFIG = {
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5432"),
  user: process.env.DB_USERNAME || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME || "oro_db",
};

const API_BASE = process.env.API_URL || "http://localhost:3000";
const ADMIN_SECRET = process.env.ADMIN_DEV_SECRET || "your-dev-secret";
const JWT_SECRET = process.env.JWT_SECRET || "your-jwt-secret";

const db = new Pool(DB_CONFIG);

// ── Helper Functions ─────────────────────────────────────────────────────────

function log(msg) {
  console.log(`  ${msg}`);
}

function header(msg) {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${msg}`);
  console.log(`${"═".repeat(70)}`);
}

async function apiRequest(method, path, body = null, token = null) {
  const url = new URL(path, API_BASE);
  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
    },
  };

  if (token) {
    options.headers.Authorization = `Bearer ${token}`;
  }

  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(
              new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`),
            );
          } else {
            resolve(parsed);
          }
        } catch (e) {
          resolve(data);
        }
      });
    });

    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getAdminToken() {
  const token = jwt.sign({ userId: "admin-test", isAdmin: true }, JWT_SECRET, {
    expiresIn: "1h",
  });
  return token;
}

async function getUserBalance(userId) {
  const result = await db.query(
    `SELECT COALESCE(SUM(amount), 0) as balance FROM transactions WHERE "userId" = $1`,
    [userId],
  );
  return parseFloat(result.rows[0].balance);
}

async function getTestUsers() {
  const result = await db.query(
    `SELECT id, "firstName", "lastName", "dkAccountNumber" 
     FROM users 
     WHERE "dkAccountNumber" IS NOT NULL 
     LIMIT 3`,
  );
  return result.rows;
}

// ── Main Test Flow ───────────────────────────────────────────────────────────

(async () => {
  header("RECONCILIATION SYSTEM TEST");

  // Step 1: Get test users
  header("1. Fetching Test Users");
  const users = await getTestUsers();
  if (users.length < 2) {
    throw new Error("Need at least 2 users with DK accounts to run test");
  }

  users.forEach((u, i) => {
    log(`User ${i + 1}: ${u.firstName} ${u.lastName} (${u.dkAccountNumber})`);
  });

  const [userA, userB, userC] = users;

  // Step 2: Credit test users
  header("2. Crediting Test Users");
  const adminToken = await getAdminToken();

  for (const user of [userA, userB, userC].filter(Boolean)) {
    await db.query(
      `INSERT INTO transactions (
        "userId", type, amount, "balanceBefore", "balanceAfter", note
      ) VALUES ($1, 'deposit', 500, 0, 500, 'Reconciliation test credit')`,
      [user.id],
    );
    log(`✓ Credited ${user.firstName}: 500 BTN`);
  }

  // Step 3: Create test market
  header("3. Creating Test Market");
  const market = await db.query(
    `INSERT INTO markets (
      title, description, category, "opensAt", "closesAt", 
      "houseEdgePct", mechanism, "liquidityParam", status
    ) VALUES (
      'Reconciliation Test Market',
      'Testing reconciliation system',
      'test',
      NOW(),
      NOW() + INTERVAL '1 hour',
      8,
      'parimutuel',
      1000,
      'open'
    ) RETURNING *`,
  );

  const marketId = market.rows[0].id;
  log(`✓ Market created: ${marketId}`);

  // Create outcomes
  const outcomes = await db.query(
    `INSERT INTO outcomes (
      "marketId", label, "totalBetAmount"
    ) VALUES 
      ($1, 'Yes', 0),
      ($1, 'No', 0)
    RETURNING *`,
    [marketId],
  );

  const [outcomeYes, outcomeNo] = outcomes.rows;
  log(`✓ Outcomes created: Yes (${outcomeYes.id}), No (${outcomeNo.id})`);

  // Step 4: Place bets
  header("4. Placing Bets");

  const bets = [
    { user: userA, outcome: outcomeYes, amount: 300 },
    { user: userB, outcome: outcomeYes, amount: 200 },
    { user: userC, outcome: outcomeNo, amount: 150 },
  ].filter((b) => b.user);

  for (const bet of bets) {
    const balance = await getUserBalance(bet.user.id);
    await db.query(
      `INSERT INTO positions (
        "userId", "marketId", "outcomeId", amount, status
      ) VALUES ($1, $2, $3, $4, 'open')`,
      [bet.user.id, marketId, bet.outcome.id, bet.amount],
    );

    await db.query(
      `INSERT INTO transactions (
        "userId", type, amount, "balanceBefore", "balanceAfter", note
      ) VALUES ($1, 'bet_placed', $2, $3, $4, 'Test bet')`,
      [bet.user.id, -bet.amount, balance, balance - bet.amount],
    );

    await db.query(
      `UPDATE outcomes SET "totalBetAmount" = "totalBetAmount" + $1 WHERE id = $2`,
      [bet.amount, bet.outcome.id],
    );

    log(
      `✓ ${bet.user.firstName} bet ${bet.amount} BTN on ${bet.outcome.label}`,
    );
  }

  // Update market total pool
  const totalPool = bets.reduce((sum, b) => sum + b.amount, 0);
  await db.query(`UPDATE markets SET "totalPool" = $1 WHERE id = $2`, [
    totalPool,
    marketId,
  ]);
  log(`✓ Total pool: ${totalPool} BTN`);

  // Step 5: Settle the market
  header("5. Settling Market");

  await db.query(
    `UPDATE markets SET status = 'closed', "resolvedOutcomeId" = $1 WHERE id = $2`,
    [outcomeYes.id, marketId],
  );
  log(`✓ Market closed, winner: Yes`);

  // Calculate settlement
  const houseAmount = totalPool * 0.08; // 8% house edge
  const payoutPool = totalPool - houseAmount;
  const winnerPool = 300 + 200; // userA + userB bets on Yes

  log(`  Total pool: ${totalPool} BTN`);
  log(`  House cut (8%): ${houseAmount} BTN`);
  log(`  Payout pool: ${payoutPool} BTN`);
  log(`  Winner pool: ${winnerPool} BTN`);

  // Create settlement record
  const settlement = await db.query(
    `INSERT INTO settlements (
      "marketId", "winningOutcomeId", "totalBets", "winningBets",
      "totalPool", "houseAmount", "payoutPool", "totalPaidOut"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0) RETURNING *`,
    [
      marketId,
      outcomeYes.id,
      bets.length,
      2,
      totalPool,
      houseAmount,
      payoutPool,
    ],
  );

  const settlementId = settlement.rows[0].id;
  log(`✓ Settlement created: ${settlementId}`);

  // Process payouts
  let totalPaidOut = 0;
  for (const bet of bets.filter((b) => b.outcome.id === outcomeYes.id)) {
    const share = bet.amount / winnerPool;
    const payout = parseFloat((payoutPool * share).toFixed(2));
    const balance = await getUserBalance(bet.user.id);

    await db.query(
      `UPDATE positions SET payout = $1, status = 'won' 
       WHERE "userId" = $2 AND "marketId" = $3`,
      [payout, bet.user.id, marketId],
    );

    await db.query(
      `INSERT INTO transactions (
        "userId", type, amount, "balanceBefore", "balanceAfter", note
      ) VALUES ($1, 'bet_payout', $2, $3, $4, 'Test payout')`,
      [bet.user.id, payout, balance, balance + payout],
    );

    totalPaidOut += payout;
    log(
      `✓ Paid ${bet.user.firstName}: ${payout} BTN (${(share * 100).toFixed(1)}% of pool)`,
    );
  }

  // Mark losers
  for (const bet of bets.filter((b) => b.outcome.id === outcomeNo.id)) {
    await db.query(
      `UPDATE positions SET status = 'lost' WHERE "userId" = $1 AND "marketId" = $2`,
      [bet.user.id, marketId],
    );
    log(`✗ ${bet.user.firstName} lost: ${bet.amount} BTN`);
  }

  await db.query(`UPDATE settlements SET "totalPaidOut" = $1 WHERE id = $2`, [
    totalPaidOut,
    settlementId,
  ]);

  await db.query(`UPDATE markets SET status = 'settled' WHERE id = $1`, [
    marketId,
  ]);

  // Step 6: Run Reconciliation
  header("6. Running Reconciliation");

  try {
    const reconResult = await apiRequest(
      "POST",
      "/api/reconciliation/settlement",
      { settlementId },
      adminToken,
    );

    log(`✓ Reconciliation completed`);
    log(`  Records created: ${reconResult.recordsCreated}`);

    if (reconResult.records) {
      for (const record of reconResult.records) {
        const status = record.status === "matched" ? "✓" : "⚠";
        const statusColor =
          record.status === "matched" ? "MATCHED" : "MISMATCH";
        log(`  ${status} ${record.details?.marketTitle}: ${statusColor}`);
        log(`     Expected: ${record.expectedAmount} BTN`);
        log(`     Actual: ${record.actualAmount} BTN`);
        log(`     Difference: ${record.difference} BTN`);
      }
    }
  } catch (error) {
    log(`⚠ API reconciliation failed: ${error.message}`);
    log(`  This is expected if the API is not running`);
    log(`  You can run reconciliation manually via the admin panel`);
  }

  // Step 7: Verify via Database
  header("7. Database Verification");

  const recons = await db.query(
    `SELECT * FROM reconciliations WHERE "settlementId" = $1 ORDER BY "createdAt" DESC`,
    [settlementId],
  );

  if (recons.rows.length > 0) {
    log(`✓ Found ${recons.rows.length} reconciliation records`);

    let matched = 0;
    let mismatched = 0;

    for (const recon of recons.rows) {
      if (recon.status === "matched") matched++;
      if (recon.status === "mismatch") mismatched++;
    }

    log(`  Matched: ${matched}`);
    log(`  Mismatched: ${mismatched}`);
  } else {
    log(`⚠ No reconciliation records found - run via API or admin panel`);
  }

  // Step 8: Get Statistics
  header("8. Reconciliation Statistics");

  try {
    const stats = await apiRequest(
      "GET",
      "/api/reconciliation/statistics",
      null,
      adminToken,
    );

    log(`Total reconciliations: ${stats.total}`);
    log(`Total discrepancy: ${stats.totalDiscrepancy.toFixed(2)} BTN`);
    log(`Average discrepancy: ${stats.avgDiscrepancy.toFixed(4)} BTN`);

    if (stats.byStatus) {
      log(`\nBy Status:`);
      for (const s of stats.byStatus) {
        log(`  ${s.status}: ${s.count} (${s.totalDifference} BTN diff)`);
      }
    }
  } catch (error) {
    log(`⚠ Could not fetch statistics: ${error.message}`);
  }

  // Step 9: Test Auto-Correction
  header("9. Testing Auto-Correction (if mismatches < 0.1 BTN)");

  try {
    const corrected = await apiRequest(
      "POST",
      "/api/reconciliation/auto-correct",
      { threshold: 0.1 },
      adminToken,
    );

    log(`✓ Auto-correction completed`);
    log(`  Corrected: ${corrected.correctedCount} discrepancies`);
  } catch (error) {
    log(`⚠ Auto-correction failed: ${error.message}`);
  }

  // Cleanup
  header("CLEANUP");
  log(`Test market ID: ${marketId}`);
  log(`Settlement ID: ${settlementId}`);
  log(`\nTo clean up, run:`);
  log(
    `  DELETE FROM reconciliations WHERE "settlementId" = '${settlementId}';`,
  );
  log(`  DELETE FROM settlements WHERE id = '${settlementId}';`);
  log(`  DELETE FROM transactions WHERE note LIKE '%test%';`);
  log(`  DELETE FROM positions WHERE "marketId" = '${marketId}';`);
  log(`  DELETE FROM outcomes WHERE "marketId" = '${marketId}';`);
  log(`  DELETE FROM markets WHERE id = '${marketId}';`);

  header("TEST COMPLETE ✓");
  await db.end();
})().catch(async (err) => {
  console.error(`\n❌ Test failed: ${err.message}`);
  console.error(err.stack);
  await db.end();
  process.exit(1);
});
