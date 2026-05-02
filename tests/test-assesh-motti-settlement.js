/**
 * Real two-user settlement flow test — DK Staging
 *
 * Users:
 *   A — Ashish Upadhaya    (CID 10304001086, DK 100100361709)  ← bets YES (winner)
 *   B — Udap Kharka/Motti  (CID 11804001746, DK 110101427948)  ← bets NO  (loser)
 *
 * Merchant:
 *   Sonam Tenzin  (DK 110146039368)  ← collects deposits, pays out winnings
 *
 * Flow:
 *   1. Show DK balances for all 3 accounts + in-app balances
 *   2. Simulate deposits (in-app credit — DK debit_request requires SMS OTP, bypassed in staging)
 *   3. Place bets (debit in-app ledger)
 *   4. Settlement math (8% house cut)
 *   5. Credit winner (Ashish) in-app
 *   6. DK payout: merchant → Ashish via initiate/transaction (real staging call)
 *   7. Final balances + verification
 *
 * Note on deposit direction:
 *   DK_STAGING_DEPOSIT_BYPASS=true — staging gateway cannot send SMS OTP for debit_request,
 *   so real-money user→merchant DK pulls are skipped. In production this would debit the user's
 *   DK account and credit the merchant. Here we credit in-app directly to simulate the effect.
 *   The payout direction (merchant→user) IS real in staging (DK_STAGING_PAYOUT_BYPASS=false).
 *
 * Usage:
 *   node test-assesh-motti-settlement.js
 *   node test-assesh-motti-settlement.js --bet-a 300 --bet-b 200
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
const BET_A     = parseFloat(getArg("--bet-a", "300")); // Ashish — YES (winner)
const BET_B     = parseFloat(getArg("--bet-b", "200")); // Motti  — NO  (loser)
const HOUSE_PCT = 8;

// ── Users ─────────────────────────────────────────────────────────────────────
const CID_A = "10304001086"; // Ashish Upadhaya
const CID_B = "11804001746"; // Udap Kharka / Motti Mongar

// ── Merchant (reads from .env) ────────────────────────────────────────────────
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

async function depositLedger(userId, amount, note) {
  const bal = await getInAppBalance(userId);
  await db.query(`
    INSERT INTO transactions (id, type, amount, "balanceBefore", "balanceAfter", "userId", note, "createdAt")
    VALUES (gen_random_uuid(), 'deposit', $1, $2, $3, $4, $5, NOW())
  `, [amount, bal, bal + amount, userId, note]);
  return bal + amount;
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

// ── DK payout transfer (merchant → user) ─────────────────────────────────────

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
    inquiry_id:            `ORO-AM-${ref}-${stanNo}`,
    currency:              "BTN",
    payment_type:          "INTRA",
    payment_desc:          "Oro settlement payout",
    source_app:            SOURCE_APP,
    narration:             "Oro Assesh-Motti E2E settlement test",
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

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const W = 60;
  const sep = "─".repeat(W);

  console.log(`\n╔${"═".repeat(W)}╗`);
  console.log(`║  Assesh & Motti Settlement Test — DK Staging${" ".repeat(W - 46)}║`);
  console.log(`║  Merchant : ${MERCHANT_NAME} (${MERCHANT_ACCOUNT})${" ".repeat(W - 13 - MERCHANT_NAME.length - MERCHANT_ACCOUNT.length - 3)}║`);
  console.log(`║  Scenario : Ashish bets YES (wins), Motti bets NO (loses)${" ".repeat(W - 58)}║`);
  console.log(`╚${"═".repeat(W)}╝`);

  // ── Step 0: Resolve users from DB ─────────────────────────────────────────
  console.log(`\n── 0. Resolving Users  ${sep.slice(22)}`);

  const { rows: realUsers } = await db.query(
    `SELECT id, "firstName", "lastName", "dkCid", "dkAccountNumber"
     FROM users WHERE "dkCid" = ANY($1)`,
    [[CID_A, CID_B]],
  );
  const userA = realUsers.find(u => u.dkCid === CID_A); // Ashish
  const userB = realUsers.find(u => u.dkCid === CID_B); // Motti
  if (!userA) throw new Error(`User A (CID ${CID_A}) not found in database`);
  if (!userB) throw new Error(`User B (CID ${CID_B}) not found in database`);

  console.log(`\n  User A (Ashish) : ${userA.firstName} ${userA.lastName}  (CID ${userA.dkCid})  DK: ${userA.dkAccountNumber}  DB: ${userA.id}`);
  console.log(`  User B (Motti)  : ${userB.firstName} ${userB.lastName}  (CID ${userB.dkCid})  DK: ${userB.dkAccountNumber}  DB: ${userB.id}`);
  console.log(`  Merchant        : ${MERCHANT_NAME}  DK: ${MERCHANT_ACCOUNT}`);
  console.log(`\n  Bet A = BTN ${BET_A} (YES — winner)  |  Bet B = BTN ${BET_B} (NO — loser)  |  House: ${HOUSE_PCT}%`);

  // ── Step 1: Before balances ────────────────────────────────────────────────
  console.log(`\n── 1. Balances Before  ${sep.slice(22)}`);
  await dkAuth();

  const [dkA0, dkB0, dkM0] = await Promise.all([
    getDkBalance(userA.dkAccountNumber),
    getDkBalance(userB.dkAccountNumber),
    getDkBalance(MERCHANT_ACCOUNT),
  ]);
  const [appA0, appB0] = await Promise.all([
    getInAppBalance(userA.id),
    getInAppBalance(userB.id),
  ]);

  console.log(`\n  ${"Account".padEnd(36)} ${"DK Balance".padEnd(16)} In-App Balance`);
  console.log(`  ${sep}`);
  console.log(`  Merchant  ${MERCHANT_ACCOUNT.padEnd(26)} BTN ${dkM0.balance.toFixed(2).padStart(10)}  (platform vault)`);
  console.log(`  Ashish    ${userA.dkAccountNumber.padEnd(26)} BTN ${dkA0.balance.toFixed(2).padStart(10)}  BTN ${appA0.toFixed(2)}`);
  console.log(`  Motti     ${userB.dkAccountNumber.padEnd(26)} BTN ${dkB0.balance.toFixed(2).padStart(10)}  BTN ${appB0.toFixed(2)}`);

  // ── Step 2: Simulate deposits (user → merchant) ────────────────────────────
  console.log(`\n── 2. Simulating Deposits (User → Merchant)  ${sep.slice(44)}`);
  console.log(`\n  ⚠  DK_STAGING_DEPOSIT_BYPASS=true`);
  console.log(`     Real debit_request requires SMS OTP to user's phone — not available in staging.`);
  console.log(`     Crediting in-app ledger directly to simulate user deposit.`);
  console.log(`     In production: user confirms OTP → DK debits user account → merchant receives funds.`);

  const depositNoteA = `[TEST DEPOSIT] Ashish → Merchant BTN ${BET_A} (staging bypass)`;
  const depositNoteB = `[TEST DEPOSIT] Motti  → Merchant BTN ${BET_B} (staging bypass)`;

  const appA_dep = await depositLedger(userA.id, BET_A, depositNoteA);
  const appB_dep = await depositLedger(userB.id, BET_B, depositNoteB);

  console.log(`\n  ✅ Ashish  +BTN ${BET_A.toFixed(2)} deposited → in-app: BTN ${appA_dep.toFixed(2)}`);
  console.log(`  ✅ Motti   +BTN ${BET_B.toFixed(2)} deposited → in-app: BTN ${appB_dep.toFixed(2)}`);

  // ── Step 3: Place bets ─────────────────────────────────────────────────────
  console.log(`\n── 3. Placing Bets  ${sep.slice(19)}`);

  const appA_aft_bet = await debitLedger(userA.id, BET_A, `[TEST BET] BTN ${BET_A} on YES — Assesh-Motti E2E test`);
  const appB_aft_bet = await debitLedger(userB.id, BET_B, `[TEST BET] BTN ${BET_B} on NO  — Assesh-Motti E2E test`);

  console.log(`  ✅ Ashish  −BTN ${BET_A}  (YES) → in-app: BTN ${appA_aft_bet.toFixed(2)}`);
  console.log(`  ✅ Motti   −BTN ${BET_B}  (NO)  → in-app: BTN ${appB_aft_bet.toFixed(2)}`);

  // ── Step 4: Settlement math ────────────────────────────────────────────────
  console.log(`\n── 4. Settlement Calculation  ${sep.slice(29)}`);

  const totalPool  = parseFloat((BET_A + BET_B).toFixed(2));
  const houseAmt   = parseFloat((totalPool * HOUSE_PCT / 100).toFixed(2));
  const payoutPool = parseFloat((totalPool - houseAmt).toFixed(2));
  // Ashish is the sole YES bettor → receives entire payout pool
  const payoutA    = payoutPool;

  console.log(`\n  Total pool     : BTN ${totalPool.toFixed(2)}  (Ashish: ${BET_A} + Motti: ${BET_B})`);
  console.log(`  House ${HOUSE_PCT}%       : BTN ${houseAmt.toFixed(2)}  (stays in merchant vault)`);
  console.log(`  Payout pool    : BTN ${payoutPool.toFixed(2)}`);
  console.log(`  Winning side   : YES  (sole winner: Ashish)`);
  console.log(`  ──────────────────────────────────────────────────────`);
  console.log(`  Ashish payout  : BTN ${payoutA.toFixed(2)}  (net profit: +BTN ${(payoutA - BET_A).toFixed(2)})`);
  console.log(`  Motti  payout  : BTN 0.00  (lost BTN ${BET_B.toFixed(2)})`);

  // ── Step 5: Credit winner in-app ──────────────────────────────────────────
  console.log(`\n── 5. Crediting Winner (In-App)  ${sep.slice(32)}`);

  const poolNote = `total BTN ${totalPool}, house BTN ${houseAmt}, payout pool BTN ${payoutPool}`;
  const appA_after = await creditLedger(
    userA.id, payoutA,
    `[TEST PAYOUT] BTN ${payoutA} to Ashish — ${poolNote}`,
  );
  console.log(`  ✅ Ashish  +BTN ${payoutA.toFixed(2)} → in-app: BTN ${appA_after.toFixed(2)}`);
  console.log(`  ✅ Motti   no credit (lost)`);

  // ── Step 6: DK Bank payout — merchant → Ashish ────────────────────────────
  console.log(`\n── 6. DK Bank Payout: Merchant → Ashish  ${sep.slice(40)}`);
  console.log(`\n  Merchant ${MERCHANT_ACCOUNT} → Ashish ${userA.dkAccountNumber}  BTN ${payoutA.toFixed(2)}`);

  const dkTxA = await dkPushPayout(
    userA.dkAccountNumber,
    dkA0.name || `${userA.firstName} ${userA.lastName}`,
    payoutA,
    userA.id.slice(0, 8),
  );

  if (dkTxA.ok) {
    console.log(`  ✅ Transfer accepted by DK Bank`);
    console.log(`     txn_status_id : ${dkTxA.txnStatusId}`);
    console.log(`     inquiry_id    : ${dkTxA.inquiryId}`);
  } else {
    console.log(`  ❌ DK transfer FAILED`);
    console.log(`     Response: ${JSON.stringify(dkTxA.raw, null, 2)}`);
  }

  console.log(`\n  Motti — no DK transfer (lost bet)`);

  // Wait 2 s for DK to settle
  await new Promise(r => setTimeout(r, 2000));

  // ── Step 7: Final balances ─────────────────────────────────────────────────
  console.log(`\n── 7. Final Balances  ${sep.slice(21)}`);

  const [dkA1, dkB1, dkM1] = await Promise.all([
    getDkBalance(userA.dkAccountNumber),
    getDkBalance(userB.dkAccountNumber),
    getDkBalance(MERCHANT_ACCOUNT),
  ]);
  const [appA_f, appB_f] = await Promise.all([
    getInAppBalance(userA.id),
    getInAppBalance(userB.id),
  ]);
  const fmt = n => (n >= 0 ? "+" : "") + n.toFixed(2);

  console.log(`\n  ${"Account".padEnd(36)} ${"DK Balance".padEnd(16)} In-App Balance`);
  console.log(`  ${sep}`);
  console.log(`  Merchant  ${MERCHANT_ACCOUNT.padEnd(26)} BTN ${dkM1.balance.toFixed(2).padStart(10)}  ${fmt(dkM1.balance - dkM0.balance)} DK (house: +BTN ${houseAmt.toFixed(2)} expected)`);
  console.log(`  Ashish    ${userA.dkAccountNumber.padEnd(26)} BTN ${dkA1.balance.toFixed(2).padStart(10)}  BTN ${appA_f.toFixed(2)}  (${fmt(dkA1.balance - dkA0.balance)} DK / ${fmt(appA_f - appA0)} in-app)`);
  console.log(`  Motti     ${userB.dkAccountNumber.padEnd(26)} BTN ${dkB1.balance.toFixed(2).padStart(10)}  BTN ${appB_f.toFixed(2)}  (${fmt(dkB1.balance - dkB0.balance)} DK / ${fmt(appB_f - appB0)} in-app)`);

  // ── Step 8: Verification ───────────────────────────────────────────────────
  console.log(`\n── 8. Verification  ${sep.slice(19)}`);

  const dkADelta = dkA1.balance - dkA0.balance;
  const dkBDelta = dkB1.balance - dkB0.balance;
  const dkMDelta = dkM1.balance - dkM0.balance;

  // DK checks
  const checkA_dk   = Math.abs(dkADelta - payoutA)  < 0.02; // Ashish received payout
  const checkB_dk   = Math.abs(dkBDelta)             < 0.02; // Motti unchanged (no DK touch)
  const checkM_dk   = dkTxA.ok;                              // Merchant transfer accepted

  // In-app checks (net from before deposits, because deposit was credited in-app):
  // Ashish: +deposit(BET_A) − bet(BET_A) + payout(payoutA) = +payoutA
  const checkA_inapp = Math.abs((appA_f - appA0) - payoutA) < 0.02;
  // Motti:  +deposit(BET_B) − bet(BET_B) + 0             = 0
  const checkB_inapp = Math.abs(appB_f - appB0) < 0.02;

  console.log(`\n  ${checkA_dk    ? "✅" : "⚠️ "} Ashish DK received  : ${fmt(dkADelta)} BTN   (expected +${payoutA.toFixed(2)})`);
  console.log(`  ${checkM_dk    ? "✅" : "⚠️ "} Merchant DK payout  : transfer ${dkTxA.ok ? "accepted" : "REJECTED"} by DK Bank`);
  console.log(`  ${checkB_dk    ? "✅" : "⚠️ "} Motti  DK unchanged : ${fmt(dkBDelta)} BTN   (expected 0.00 — deposit bypass)`);
  console.log(`  ${checkA_inapp ? "✅" : "⚠️ "} Ashish in-app net   : ${fmt(appA_f - appA0)} BTN   (expected +${payoutA.toFixed(2)} — deposit+payout, bet cancels deposit)`);
  console.log(`  ${checkB_inapp ? "✅" : "⚠️ "} Motti  in-app net   : ${fmt(appB_f - appB0)} BTN   (expected 0.00 — deposit and bet cancel out)`);

  console.log(`\n  House retained by merchant: BTN ${houseAmt.toFixed(2)} (${HOUSE_PCT}% of BTN ${totalPool.toFixed(2)} pool)`);
  console.log(`  Merchant DK delta: ${fmt(dkMDelta)} BTN (deposit bypass → no inflow; outflow = payout BTN ${payoutA.toFixed(2)})`);

  const allPass = checkA_dk && checkM_dk && checkB_dk && checkA_inapp && checkB_inapp;

  await db.end();

  console.log(`\n╔${"═".repeat(W)}╗`);
  if (allPass) {
    console.log(`║  ✅ All checks passed — end-to-end staging flow verified${" ".repeat(W - 57)}║`);
  } else {
    console.log(`║  ⚠️  Some checks failed — review output above${" ".repeat(W - 47)}║`);
  }
  console.log(`╚${"═".repeat(W)}╝\n`);

  process.exit(allPass ? 0 : 1);

})().catch(async err => {
  console.error(`\n  ❌ Fatal: ${err.message}`);
  if (err.stack) console.error(err.stack);
  await db.end().catch(() => {});
  process.exit(1);
});
