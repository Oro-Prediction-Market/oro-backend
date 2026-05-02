/**
 * End-to-end deposit test: Ashish deposits BTN 100 via DK Bank (OTP 998811 on staging)
 * Verifies: initiate → confirm → in-app balance credited → payment record updated
 *
 * Run: node test-e2e-deposit.js
 */

"use strict";

const { execSync } = require("child_process");
const { Client } = require("pg");

// ── Config ──────────────────────────────────────────────────────────────────
const BASE_URL   = "http://localhost:3000/api";
const JWT_SECRET = "3edb9e25120ba0a4793fe780683ce1a7c00abd79ea4700e368b277bb4c84138c6631fc19cf7d54d31fbae456861f5f0b";
const ASHISH_ID  = "f86ff3be-1535-496d-8be4-c785ee4c0501";
const ASHISH_CID = "10304001086";
const DEPOSIT    = 100;
const DK_OTP     = "998811";

const DB = {
  host: "localhost", port: 5432,
  user: "postgres",  password: "postgres",
  database: "oro_db",
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function pass(label, detail = "") {
  console.log(`  ✅ ${label}${detail ? "  →  " + detail : ""}`);
}
function fail(label, detail = "") {
  console.error(`  ❌ ${label}${detail ? "  →  " + detail : ""}`);
}
function info(msg) { console.log(`     ${msg}`); }

/** Sign a JWT using Node's crypto — no npm dep needed */
function signJwt(payload) {
  const { createHmac } = require("crypto");
  const b64url = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  const header  = b64url({ alg: "HS256", typ: "JWT" });
  const now     = Math.floor(Date.now() / 1000);
  const body    = b64url({ ...payload, iat: now, exp: now + 8 * 3600 });
  const sig     = createHmac("sha256", JWT_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${sig}`;
}

async function post(path, token, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log("\n══════════════════════════════════════════════");
  console.log(" Oro E2E Deposit Test  —  Ashish  (BTN 100)");
  console.log("══════════════════════════════════════════════\n");

  const db = new Client(DB);
  await db.connect();

  // ── 1. Pre-state ──────────────────────────────────────────────────────────
  console.log("[ 1/6 ] Querying Ashish's current balance…");
  const { rows: [ashishMeta] } = await db.query(
    `SELECT username FROM users WHERE id = $1`,
    [ASHISH_ID],
  );
  if (!ashishMeta) { fail("Ashish not found in DB"); process.exit(1); }

  // Balance is ledger-based (SUM of transactions), not stored in users table
  const { rows: [balBeforeRow] } = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS balance FROM transactions WHERE "userId" = $1`,
    [ASHISH_ID],
  );
  const balBefore = parseFloat(balBeforeRow.balance);
  pass("User found", `${ashishMeta.username}  |  ledger balance = BTN ${balBefore}`);

  // ── 2. JWT ────────────────────────────────────────────────────────────────
  console.log("\n[ 2/6 ] Generating JWT for Ashish…");
  const token = signJwt({ sub: ASHISH_ID, isAdmin: false });
  pass("JWT generated", `${token.slice(0, 40)}…`);

  // ── 3. Initiate ───────────────────────────────────────────────────────────
  console.log("\n[ 3/6 ] POST /payments/dkbank/initiate…");
  const initRes = await post("/payments/dkbank/initiate", token, {
    amount:      DEPOSIT,
    cid:         ASHISH_CID,
    description: "E2E deposit test",
  });

  info(`HTTP ${initRes.status}`);
  info(JSON.stringify(initRes.json, null, 2));

  if (initRes.status !== 200) {
    fail("Initiate failed", `HTTP ${initRes.status}`);
    await db.end(); process.exit(1);
  }

  const paymentId = initRes.json?.paymentId || initRes.json?.id;
  if (!paymentId) {
    fail("No paymentId in response");
    await db.end(); process.exit(1);
  }
  pass("Initiate OK", `paymentId = ${paymentId}`);

  // Verify payment row in DB
  const { rows: [pmtInit] } = await db.query(
    `SELECT status, metadata FROM payments WHERE id = $1`,
    [paymentId],
  );
  if (!pmtInit) { fail("Payment row not found in DB"); }
  else {
    pass("Payment row created", `status = ${pmtInit.status}`);
    const hasBfsTxnId = pmtInit.metadata?.bfsTxnId;
    if (hasBfsTxnId) pass("bfsTxnId stored in metadata", pmtInit.metadata.bfsTxnId);
    else info("⚠  bfsTxnId not yet in metadata (DK staging may skip it)");
  }

  // ── 4. Confirm ────────────────────────────────────────────────────────────
  console.log("\n[ 4/6 ] POST /payments/dkbank/confirm  (OTP = 998811)…");

  // Brief pause — staging account_auth + debit_request may be async
  await new Promise(r => setTimeout(r, 1000));

  const confirmRes = await post("/payments/dkbank/confirm", token, {
    paymentId,
    otp: DK_OTP,
  });

  info(`HTTP ${confirmRes.status}`);
  info(JSON.stringify(confirmRes.json, null, 2));

  if (confirmRes.status !== 200) {
    fail("Confirm failed", `HTTP ${confirmRes.status}`);
    await db.end(); process.exit(1);
  }
  pass("Confirm OK");

  // ── 5. Post-state ─────────────────────────────────────────────────────────
  console.log("\n[ 5/6 ] Verifying in-app balance after deposit…");
  const { rows: [balAfterRow] } = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS balance FROM transactions WHERE "userId" = $1`,
    [ASHISH_ID],
  );
  const balAfter = parseFloat(balAfterRow.balance);
  const diff     = balAfter - balBefore;

  info(`Balance before : BTN ${balBefore}`);
  info(`Balance after  : BTN ${balAfter}`);
  info(`Difference     : BTN ${diff}`);

  if (Math.abs(diff - DEPOSIT) < 0.01) {
    pass("Balance credited correctly", `+BTN ${diff}`);
  } else {
    fail(
      "Balance mismatch",
      `expected +${DEPOSIT}, got ${diff > 0 ? "+" : ""}${diff}`,
    );
  }

  // ── 6. Payment record final state ─────────────────────────────────────────
  console.log("\n[ 6/6 ] Checking payment record final status…");
  const { rows: [pmtFinal] } = await db.query(
    `SELECT status, dktxnstatusid, "confirmedAt", metadata FROM payments WHERE id = $1`,
    [paymentId],
  );

  if (!pmtFinal) {
    fail("Payment row gone?");
  } else {
    info(`status        : ${pmtFinal.status}`);
    info(`dktxnstatusid : ${pmtFinal.dktxnstatusid ?? "(null — normal on staging)"}`);
    info(`confirmedAt   : ${pmtFinal.confirmedAt ?? "(null)"}`);
    if (pmtFinal.status === "success") {
      pass("Payment status = success");
    } else {
      fail("Unexpected payment status", pmtFinal.status);
    }
    if (pmtFinal.confirmedAt) {
      pass("confirmedAt set", pmtFinal.confirmedAt);
    } else {
      fail("confirmedAt not set");
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════");
  console.log(" DONE");
  console.log("══════════════════════════════════════════════\n");

  await db.end();
})().catch(err => {
  console.error("\n💥 Unhandled error:", err.message || err);
  process.exit(1);
});
