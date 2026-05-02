/**
 * Three-user settlement flow test — DK Staging
 *
 * Users:
 *   A — Sonam Tenzin    (CID 11502000922, DK 110146039368)  ← also the merchant account
 *   B — Ashish Upadhaya (CID 10304001086, DK 100100361709)
 *   C — Test User C     (synthetic, no DK account — in-app credit only)
 *
 * Scenario:
 *   A & C bet on YES (winning side, payout split proportionally by stake)
 *   B bets on NO     (losing side)
 *
 * Settlement (8% house cut):
 *   Total pool       = BET_A + BET_B + BET_C
 *   House amount     = total × 0.08
 *   Payout pool      = total − house
 *   A payout         = (BET_A / (BET_A + BET_C)) × payout pool
 *   C payout         = (BET_C / (BET_A + BET_C)) × payout pool
 *
 * DK transfers:
 *   A — merchant → A's DK account (real staging transfer)
 *   B — none (lost)
 *   C — no DK account linked; receives in-app credit only
 *
 * Usage:
 *   node test-three-user-settlement.js
 *   node test-three-user-settlement.js --bet-a 500 --bet-b 300 --bet-c 200
 *   node test-three-user-settlement.js --bet-a 500 --bet-b 300 --bet-c 200 --no-cleanup
 */

const https  = require("https");
const jwt    = require("jsonwebtoken");
const { Pool } = require("pg");
const { randomUUID, randomBytes } = require("crypto");
const path   = require("path");
const fs     = require("fs");

// ── Load .env ─────────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    const eq = t.indexOf("=");
    if (eq === -1) return;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (k && !(k in process.env)) process.env[k] = v;
  });
}

// ── CLI args ──────────────────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const getArg = (flag, def) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : def; };
const BET_A     = parseFloat(getArg("--bet-a", "500"));
const BET_B     = parseFloat(getArg("--bet-b", "300"));
const BET_C     = parseFloat(getArg("--bet-c", "200"));
const NO_CLEANUP = args.includes("--no-cleanup");
const HOUSE_PCT  = 8;

// ── User config ───────────────────────────────────────────────────────────────
const CID_A = "11502000922";
const CID_B = "10304001086";
const USER_C_ID   = "00000000-0000-0000-0000-000000000c3c"; // synthetic, stable UUID
const USER_C_NAME = { first: "Test", last: "User-C" };

// ── Merchant (reads from .env, updated to Sonam Tenzin) ──────────────────────
const MERCHANT_ACCOUNT = process.env.DK_BENEFICIARY_ACCOUNT      || "110146039368";
const MERCHANT_NAME    = process.env.DK_BENEFICIARY_ACCOUNT_NAME || "Sonam Tenzin";

// ── DB ────────────────────────────────────────────────────────────────────────
const db = new Pool({
  host:     process.env.DB_HOST     || "localhost",
  port:     parseInt(process.env.DB_PORT || "5432"),
  user:     process.env.DB_USERNAME || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME     || "oro_db",
});

// ── DK API helpers ────────────────────────────────────────────────────────────
const BASE_URL   = process.env.DK_BASE_URL   || "https://internal-gateway.sit.digitalkidu.bt:8082/api/dkpg";
const API_KEY    = process.env.DK_API_KEY    || "";
const SOURCE_APP = process.env.DK_SOURCE_APP || "";
const BANK_CODE  = process.env.DK_BANK_CODE  || "1060";

const reqId = () => `${Date.now()}-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const nonce = () => randomUUID().replace(/-/g, "");
const dkTs  = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const stan  = () => String(100000 + (randomBytes(3).readUIntBE(0, 3) % 900000));

function canonicalize(obj) {
  if (Array.isArray(obj)) return obj.map(canonicalize);
  if (obj && typeof obj === "object")
    return Object.keys(obj).sort().reduce((a, k) => ({ ...a, [k]: canonicalize(obj[k]) }), {});
  return obj;
}

function httpsPost(ep, body, headers, ms = 30_000) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const url = new URL(BASE_URL + ep);
    const req = https.request({
      hostname: url.hostname, port: url.port || 443,
      path: url.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...headers },
      rejectUnauthorized: false, timeout: ms,
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(Buffer.concat(chunks).toString()); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("DK timeout")); });
    req.on("error", reject);
    req.write(payload); req.end();
  });
}

let _token = null, _key = null;

async function dkAuth() {
  if (_token && _key) return;
  const params = new URLSearchParams({
    username:      process.env.DK_USERNAME,
    password:      process.env.DK_PASSWORD,
    client_id:     process.env.DK_CLIENT_ID,
    client_secret: process.env.DK_CLIENT_SECRET,
    grant_type:    "password",
    scopes:        "keys:read",
    source_app:    SOURCE_APP,
    request_id:    reqId(),
  });
  const auth = await httpsPost("/v1/auth/token", params.toString(), {
    "Content-Type": "application/x-www-form-urlencoded",
    "X-gravitee-api-key": API_KEY,
  });
  if (auth.response_code !== "0000")
    throw new Error(`DK auth failed: ${auth.response_description}`);
  _token = auth.response_data.access_token;

  const keyRes = await httpsPost("/v1/sign/key",
    JSON.stringify({ request_id: reqId(), source_app: SOURCE_APP }),
    { Authorization: `Bearer ${_token}`, "X-gravitee-api-key": API_KEY });
  if (typeof keyRes !== "string" || !keyRes.includes("PRIVATE KEY"))
    throw new Error("DK signing key fetch failed");
  _key = keyRes;
}

async function dkPost(ep, data) {
  await dkAuth();
  const body = { request_id: reqId(), ...data };
  const n = nonce(), ts = dkTs();
  const b64 = Buffer.from(JSON.stringify(canonicalize(body))).toString("base64");
  const sig  = jwt.sign({ data: b64, timestamp: ts, nonce: n }, _key, { algorithm: "RS256" });
  return httpsPost(ep, JSON.stringify(body), {
    "X-gravitee-api-key": API_KEY,
    source_app: SOURCE_APP,
    Authorization: `Bearer ${_token}`,
    "DK-Signature": `DKSignature ${sig}`,
    "DK-Timestamp": ts,
    "DK-Nonce": n,
  });
}

async function getDkBalance(account) {
  const res = await dkPost("/v1/account_inquiry", { account_number: account });
  if (res.response_code !== "0000")
    throw new Error(`account_inquiry [${account}] failed: ${res.response_description}`);
  const raw = res.response_data?.balance_info ?? "BTN: 0";
  return {
    balance: parseFloat(raw.replace(/[^0-9.]/g, "")) || 0,
    raw,
    name: res.response_data?.beneficiary_account_name ?? "",
  };
}

// ── In-app ledger helpers ─────────────────────────────────────────────────────

async function getInAppBalance(userId) {
  const r = await db.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS bal FROM transactions WHERE "userId" = $1`,
    [userId],
  );
  return parseFloat(r.rows[0].bal) || 0;
}

async function debitLedger(userId, amount, note) {
  const bal = await getInAppBalance(userId);
  if (bal < amount)
    throw new Error(`Insufficient balance for user ${userId}: has BTN ${bal.toFixed(2)}, needs BTN ${amount}`);
  await db.query(`
    INSERT INTO transactions (id, type, amount, "balanceBefore", "balanceAfter", "userId", note, "createdAt")
    VALUES (gen_random_uuid(), 'bet_placed', $1, $2, $3, $4, $5, NOW())
  `, [-amount, bal, bal - amount, userId, note]);
  return bal - amount;
}

async function creditLedger(userId, amount, note) {
  const bal = await getInAppBalance(userId);
  await db.query(`
    INSERT INTO transactions (id, type, amount, "balanceBefore", "balanceAfter", "userId", note, "createdAt")
    VALUES (gen_random_uuid(), 'bet_payout', $1, $2, $3, $4, $5, NOW())
  `, [amount, bal, bal + amount, userId, note]);
  return bal + amount;
}

// ── DK payout transfer ────────────────────────────────────────────────────────

async function dkPushPayout(toAccount, toName, amount, ref) {
  const stanNo = stan(), ts = dkTs();
  const res = await dkPost("/v1/initiate/transaction", {
    source_account_number: MERCHANT_ACCOUNT,
    source_account_name:   MERCHANT_NAME,
    bene_account_number:   toAccount,
    bene_cust_name:        toName,
    bene_bank_code:        BANK_CODE,
    transaction_amount:    amount.toFixed(2),
    transaction_datetime:  ts,
    stan_number:           stanNo,
    inquiry_id:            `ORO-3USER-${ref}-${stanNo}`,
    currency:              "BTN",
    payment_type:          "INTRA",
    payment_desc:          "Oro 3-user settlement test payout",
    source_app:            SOURCE_APP,
    narration:             "Oro three-user E2E settlement test",
  });
  const ok = res?.response_code === "0000" ||
    (res?.response_message ?? "").toUpperCase().includes("SUCCESS");
  return {
    ok,
    txnStatusId: res?.response_data?.txn_status_id,
    inquiryId:   res?.response_data?.inquiry_id,
    raw:         res,
  };
}

// ── User C upsert (synthetic test user, no DK account) ───────────────────────

async function upsertUserC() {
  const exists = await db.query(`SELECT id FROM users WHERE id = $1`, [USER_C_ID]);
  if (exists.rows.length > 0) return;

  await db.query(`
    INSERT INTO users (
      id, "firstName", "lastName", "telegramId", "isAdmin",
      "reputationScore", "totalPredictions", "correctPredictions",
      "createdAt", "updatedAt"
    ) VALUES (
      $1, $2, $3, $4, false,
      NULL, 0, 0,
      NOW(), NOW()
    )
  `, [USER_C_ID, USER_C_NAME.first, USER_C_NAME.last, `TEST_C_${Date.now()}`]);
}

async function cleanupUserC() {
  await db.query(`DELETE FROM transactions WHERE "userId" = $1`, [USER_C_ID]);
  await db.query(`DELETE FROM users WHERE id = $1`, [USER_C_ID]);
}

// ── Fund helper (direct ledger top-up, staging only) ─────────────────────────

async function ensureBalance(userId, minAmount, label) {
  const bal = await getInAppBalance(userId);
  if (bal >= minAmount) return bal;
  const topUp = minAmount - bal + 100; // +100 buffer
  await db.query(`
    INSERT INTO transactions (id, type, amount, "balanceBefore", "balanceAfter", "userId", note, "createdAt")
    VALUES (gen_random_uuid(), 'deposit', $1, $2, $3, $4, $5, NOW())
  `, [topUp, bal, bal + topUp, userId, `[TEST FUND] Top-up for ${label}`]);
  return bal + topUp;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const W = 56;
  const sep = "─".repeat(W);

  console.log(`\n╔${"═".repeat(W)}╗`);
  console.log(`║  Three-User Settlement Test — DK Staging${" ".repeat(W - 41)}║`);
  console.log(`║  Merchant: ${MERCHANT_NAME} (${MERCHANT_ACCOUNT})${" ".repeat(W - 12 - MERCHANT_NAME.length - MERCHANT_ACCOUNT.length - 3)}║`);
  console.log(`╚${"═".repeat(W)}╝`);

  // ── Step 0: Resolve users ──────────────────────────────────────────────────
  console.log(`\n── 0. Resolving Users  ${sep.slice(22)}`);

  const { rows: realUsers } = await db.query(
    `SELECT id, "firstName", "lastName", "dkCid", "dkAccountNumber"
     FROM users WHERE "dkCid" = ANY($1)`,
    [[CID_A, CID_B]],
  );
  const userA = realUsers.find(u => u.dkCid === CID_A);
  const userB = realUsers.find(u => u.dkCid === CID_B);
  if (!userA) throw new Error(`User A (CID ${CID_A}) not found in database`);
  if (!userB) throw new Error(`User B (CID ${CID_B}) not found in database`);

  await upsertUserC();
  const userC = { id: USER_C_ID, firstName: USER_C_NAME.first, lastName: USER_C_NAME.last,
                  dkCid: null, dkAccountNumber: null };

  console.log(`\n  User A : ${userA.firstName} ${userA.lastName}  (CID ${userA.dkCid})  DK: ${userA.dkAccountNumber}`);
  console.log(`  User B : ${userB.firstName} ${userB.lastName}  (CID ${userB.dkCid})  DK: ${userB.dkAccountNumber}`);
  console.log(`  User C : ${userC.firstName} ${userC.lastName}  (synthetic — no DK account)`);

  console.log(`\n  Bet A = BTN ${BET_A}  (YES)  |  Bet B = BTN ${BET_B}  (NO)  |  Bet C = BTN ${BET_C}  (YES)`);
  console.log(`  Winners: A & C share payout proportionally  |  House: ${HOUSE_PCT}%`);

  // ── Step 1: Before balances ────────────────────────────────────────────────
  console.log(`\n── 1. Balances Before  ${sep.slice(22)}`);
  await dkAuth();

  const [dkA0, dkB0, dkM0] = await Promise.all([
    getDkBalance(userA.dkAccountNumber),
    getDkBalance(userB.dkAccountNumber),
    getDkBalance(MERCHANT_ACCOUNT),
  ]);
  await Promise.all([
    ensureBalance(userA.id, BET_A, "User A"),
    ensureBalance(userB.id, BET_B, "User B"),
    ensureBalance(userC.id, BET_C, "User C"),
  ]);
  const [appA0, appB0, appC0] = await Promise.all([
    getInAppBalance(userA.id),
    getInAppBalance(userB.id),
    getInAppBalance(userC.id),
  ]);

  console.log(`\n  ${"Account".padEnd(32)} ${"DK Balance".padEnd(20)} In-App Balance`);
  console.log(`  ${sep}`);
  console.log(`  ${"Merchant  " + MERCHANT_ACCOUNT}  BTN ${String(dkM0.balance.toFixed(2)).padStart(12)}  (platform vault)`);
  console.log(`  ${"User A    " + userA.dkAccountNumber}  BTN ${String(dkA0.balance.toFixed(2)).padStart(12)}  BTN ${appA0.toFixed(2)}`);
  console.log(`  ${"User B    " + userB.dkAccountNumber}  BTN ${String(dkB0.balance.toFixed(2)).padStart(12)}  BTN ${appB0.toFixed(2)}`);
  console.log(`  ${"User C    (no DK account)".padEnd(32)} ${"—".padStart(20)}  BTN ${appC0.toFixed(2)}`);

  // ── Step 2: Place bets ─────────────────────────────────────────────────────
  console.log(`\n── 2. Placing Bets  ${sep.slice(19)}`);
  const appA1 = await debitLedger(userA.id, BET_A, `[TEST] Bet BTN ${BET_A} on YES — 3-user settlement test`);
  const appB1 = await debitLedger(userB.id, BET_B, `[TEST] Bet BTN ${BET_B} on NO  — 3-user settlement test`);
  const appC1 = await debitLedger(userC.id, BET_C, `[TEST] Bet BTN ${BET_C} on YES — 3-user settlement test`);
  console.log(`  ✅ User A  −BTN ${BET_A}  (YES)  → in-app: BTN ${appA1.toFixed(2)}`);
  console.log(`  ✅ User B  −BTN ${BET_B}  (NO)   → in-app: BTN ${appB1.toFixed(2)}`);
  console.log(`  ✅ User C  −BTN ${BET_C}  (YES)  → in-app: BTN ${appC1.toFixed(2)}`);

  // ── Step 3: Settlement math ────────────────────────────────────────────────
  console.log(`\n── 3. Settlement Calculation  ${sep.slice(29)}`);
  const totalPool    = parseFloat((BET_A + BET_B + BET_C).toFixed(2));
  const houseAmt     = parseFloat((totalPool * HOUSE_PCT / 100).toFixed(2));
  const payoutPool   = parseFloat((totalPool - houseAmt).toFixed(2));
  const totalWinners = parseFloat((BET_A + BET_C).toFixed(2));
  const payoutA      = parseFloat(((BET_A / totalWinners) * payoutPool).toFixed(2));
  const payoutC      = parseFloat((payoutPool - payoutA).toFixed(2)); // remainder avoids rounding drift

  console.log(`\n  Total pool     : BTN ${totalPool.toFixed(2)}  (A: ${BET_A} + B: ${BET_B} + C: ${BET_C})`);
  console.log(`  House ${HOUSE_PCT}%       : BTN ${houseAmt.toFixed(2)}  (stays in merchant vault)`);
  console.log(`  Payout pool    : BTN ${payoutPool.toFixed(2)}`);
  console.log(`  Winners stake  : BTN ${totalWinners.toFixed(2)}  (A: ${BET_A} + C: ${BET_C})`);
  console.log(`  ─────────────────────────────────────────────────────`);
  console.log(`  User A payout  : BTN ${payoutA.toFixed(2)}  (net profit: +BTN ${(payoutA - BET_A).toFixed(2)})`);
  console.log(`  User B payout  : BTN 0.00  (lost BTN ${BET_B})`);
  console.log(`  User C payout  : BTN ${payoutC.toFixed(2)}  (net profit: +BTN ${(payoutC - BET_C).toFixed(2)})`);

  // ── Step 4: Credit winners in-app ─────────────────────────────────────────
  console.log(`\n── 4. Crediting Winners (In-App)  ${sep.slice(33)}`);
  const poolNote = `total BTN ${totalPool}, house BTN ${houseAmt}, payout pool BTN ${payoutPool}`;
  const appA_after = await creditLedger(userA.id, payoutA, `[TEST] Payout BTN ${payoutA} — ${poolNote}`);
  const appC_after = await creditLedger(userC.id, payoutC, `[TEST] Payout BTN ${payoutC} — ${poolNote}`);
  console.log(`  ✅ User A  +BTN ${payoutA.toFixed(2)} → in-app: BTN ${appA_after.toFixed(2)}`);
  console.log(`  ✅ User C  +BTN ${payoutC.toFixed(2)} → in-app: BTN ${appC_after.toFixed(2)}  (no DK transfer)`);

  // ── Step 5: DK Bank transfer for User A ────────────────────────────────────
  console.log(`\n── 5. DK Bank Payout Transfers  ${sep.slice(31)}`);

  // User A — real DK transfer
  console.log(`\n  [A] Merchant ${MERCHANT_ACCOUNT} → ${userA.dkAccountNumber}  BTN ${payoutA.toFixed(2)}`);
  const dkTxA = await dkPushPayout(
    userA.dkAccountNumber,
    dkA0.name || `${userA.firstName} ${userA.lastName}`,
    payoutA,
    userA.id.slice(0, 8),
  );
  if (dkTxA.ok) {
    console.log(`     ✅ Transfer accepted by DK Bank`);
    console.log(`        txn_status_id : ${dkTxA.txnStatusId}`);
    console.log(`        inquiry_id    : ${dkTxA.inquiryId}`);
  } else {
    console.log(`     ❌ DK transfer FAILED`);
    console.log(`        Response: ${JSON.stringify(dkTxA.raw, null, 2)}`);
  }

  // User B — no payout (lost)
  console.log(`\n  [B] No DK transfer — User B lost their bet of BTN ${BET_B}`);

  // User C — no DK account
  console.log(`\n  [C] No DK transfer — User C has no linked DK account (in-app credit only)`);

  // Wait 2 s for DK to settle
  await new Promise(r => setTimeout(r, 2000));

  // ── Step 6: Final balances ─────────────────────────────────────────────────
  console.log(`\n── 6. Final Balances  ${sep.slice(21)}`);
  const [dkA1, dkB1, dkM1] = await Promise.all([
    getDkBalance(userA.dkAccountNumber),
    getDkBalance(userB.dkAccountNumber),
    getDkBalance(MERCHANT_ACCOUNT),
  ]);
  const [appA_f, appB_f, appC_f] = await Promise.all([
    getInAppBalance(userA.id),
    getInAppBalance(userB.id),
    getInAppBalance(userC.id),
  ]);
  const fmt = n => (n >= 0 ? "+" : "") + n.toFixed(2);

  console.log(`\n  ${"Account".padEnd(32)} ${"DK Balance".padEnd(20)} In-App Balance`);
  console.log(`  ${sep}`);
  console.log(`  ${"Merchant  " + MERCHANT_ACCOUNT}  BTN ${String(dkM1.balance.toFixed(2)).padStart(12)}  ${fmt(dkM1.balance - dkM0.balance)} DK`);
  console.log(`  ${"User A    " + userA.dkAccountNumber}  BTN ${String(dkA1.balance.toFixed(2)).padStart(12)}  BTN ${appA_f.toFixed(2)}  (${fmt(dkA1.balance - dkA0.balance)} DK / ${fmt(appA_f - appA0)} in-app)`);
  console.log(`  ${"User B    " + userB.dkAccountNumber}  BTN ${String(dkB1.balance.toFixed(2)).padStart(12)}  BTN ${appB_f.toFixed(2)}  (${fmt(dkB1.balance - dkB0.balance)} DK / ${fmt(appB_f - appB0)} in-app)`);
  console.log(`  ${"User C    (no DK account)".padEnd(32)} ${"—".padStart(20)}  BTN ${appC_f.toFixed(2)}  (${fmt(appC_f - appC0)} in-app)`);

  // ── Step 7: Verification ───────────────────────────────────────────────────
  console.log(`\n── 7. Verification  ${sep.slice(19)}`);

  const dkADelta = dkA1.balance - dkA0.balance;
  const dkMDelta = dkM1.balance - dkM0.balance;

  // In staging, User A and the merchant share the same DK account (110146039368).
  // A self-transfer nets to zero balance change on both sides — that is expected.
  // What matters is that DK Bank accepted the transfer (txn_status_id received).
  const selfTransfer  = userA.dkAccountNumber === MERCHANT_ACCOUNT;
  const checkA_dk     = selfTransfer ? dkTxA.ok : Math.abs(dkADelta - payoutA)  < 0.02;
  const checkM_dk     = selfTransfer ? dkTxA.ok : Math.abs(dkMDelta + payoutA)  < 0.02;
  const checkA_inapp  = Math.abs((appA_f - appA0) - (payoutA - BET_A)) < 0.02;
  const checkB_inapp  = Math.abs((appB_f - appB0) + BET_B)             < 0.02;
  const checkC_inapp  = Math.abs((appC_f - appC0) - (payoutC - BET_C)) < 0.02;

  const selfNote = selfTransfer ? "  (self-transfer — merchant = User A's account, delta is 0 by design)" : "";
  console.log(`\n  ${checkA_dk    ? "✅" : "⚠️ "} User A DK delta  : ${fmt(dkADelta)} BTN   (expected +${payoutA.toFixed(2)})${selfNote}`);
  console.log(`  ${checkM_dk    ? "✅" : "⚠️ "} Merchant DK delta: ${fmt(dkMDelta)} BTN   (expected −${payoutA.toFixed(2)}  house ${houseAmt.toFixed(2)} retained)${selfNote}`);
  console.log(`  ${checkA_inapp ? "✅" : "⚠️ "} User A in-app net : ${fmt(appA_f - appA0)} BTN   (expected ${fmt(payoutA - BET_A)})`);
  console.log(`  ${checkB_inapp ? "✅" : "⚠️ "} User B in-app net : ${fmt(appB_f - appB0)} BTN   (expected −${BET_B.toFixed(2)})`);
  console.log(`  ${checkC_inapp ? "✅" : "⚠️ "} User C in-app net : ${fmt(appC_f - appC0)} BTN   (expected ${fmt(payoutC - BET_C)})`);

  const allPass = checkA_dk && checkM_dk && checkA_inapp && checkB_inapp && checkC_inapp;

  // ── Cleanup ────────────────────────────────────────────────────────────────
  if (!NO_CLEANUP) {
    await cleanupUserC();
    console.log(`\n  🧹 Synthetic User C cleaned up from database`);
  } else {
    console.log(`\n  ℹ️  --no-cleanup passed — User C (${USER_C_ID}) kept in database`);
  }

  await db.end();

  console.log(`\n╔${"═".repeat(W)}╗`);
  if (allPass) {
    console.log(`║  ✅ All checks passed — staging flow verified${" ".repeat(W - 46)}║`);
  } else {
    console.log(`║  ⚠️  Some checks failed — review output above${" ".repeat(W - 46)}║`);
  }
  console.log(`╚${"═".repeat(W)}╝\n`);

  process.exit(allPass ? 0 : 1);

})().catch(async err => {
  console.error(`\n  ❌ Fatal: ${err.message}`);
  if (err.stack) console.error(err.stack);
  await db.end().catch(() => {});
  process.exit(1);
});
