/**
 * End-to-end settlement flow test — DK Staging
 *
 * Simulates a two-user prediction market:
 *   - User A (Sonam Tenzin,    CID 11502000922, DK 110146039368)
 *   - User B (Ashish Upadhaya, CID 10304001086, DK 100100361709)
 *
 * Flow:
 *   1. Show current in-app + DK balances for both users + merchant
 *   2. Both users place bets (deducted from in-app ledger)
 *   3. Settle: apply 8% house cut, pay out winner proportionally
 *   4. Credit winner's in-app balance
 *   5. Real DK transfer: merchant → winner's DK account
 *   6. Show final balances
 *
 * Usage:
 *   node test-settlement-flow.js                          # defaults: A=500, B=300, winner=A
 *   node test-settlement-flow.js --bet-a 500 --bet-b 300 --winner b
 */

const https = require("https");
const jwt   = require("../node_modules/jsonwebtoken");
const { Pool } = require("../node_modules/pg");
const { randomUUID, randomBytes } = require("crypto");
const path  = require("path");
const fs    = require("fs");

// ── Load .env ─────────────────────────────────────────────────────────────────
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

// ── CLI args ──────────────────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const getArg = (flag, def) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : def; };
const BET_A     = parseFloat(getArg("--bet-a", "500"));
const BET_B     = parseFloat(getArg("--bet-b", "300"));
const WINNER    = (getArg("--winner", "a")).toLowerCase(); // "a" or "b"
const HOUSE_PCT = 8;

// ── Staging users ─────────────────────────────────────────────────────────────
const CID_A = "11502000922";
const CID_B = "10304001086";
const MERCHANT_ACCOUNT = process.env.DK_BENEFICIARY_ACCOUNT      || "110158212197";
const MERCHANT_NAME    = process.env.DK_BENEFICIARY_ACCOUNT_NAME || "Tshering Zangmo";

// ── DB ────────────────────────────────────────────────────────────────────────
const db = new Pool({
  host:     process.env.DB_HOST     || "localhost",
  port:     parseInt(process.env.DB_PORT || "5432"),
  user:     process.env.DB_USERNAME || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME     || "oro_db",
});

// ── DK API ────────────────────────────────────────────────────────────────────
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
    username: process.env.DK_USERNAME, password: process.env.DK_PASSWORD,
    client_id: process.env.DK_CLIENT_ID, client_secret: process.env.DK_CLIENT_SECRET,
    grant_type: "password", scopes: "keys:read",
    source_app: SOURCE_APP, request_id: reqId(),
  });
  const auth = await httpsPost("/v1/auth/token", params.toString(), {
    "Content-Type": "application/x-www-form-urlencoded", "X-gravitee-api-key": API_KEY,
  });
  if (auth.response_code !== "0000") throw new Error(`DK auth failed: ${auth.response_description}`);
  _token = auth.response_data.access_token;
  const keyRes = await httpsPost("/v1/sign/key",
    JSON.stringify({ request_id: reqId(), source_app: SOURCE_APP }),
    { Authorization: `Bearer ${_token}`, "X-gravitee-api-key": API_KEY });
  if (typeof keyRes !== "string" || !keyRes.includes("PRIVATE KEY")) throw new Error("DK key fetch failed");
  _key = keyRes;
}

async function dkPost(ep, data) {
  await dkAuth();
  const body = { request_id: reqId(), ...data };
  const n = nonce(), ts = dkTs();
  const b64 = Buffer.from(JSON.stringify(canonicalize(body))).toString("base64");
  const sig = jwt.sign({ data: b64, timestamp: ts, nonce: n }, _key, { algorithm: "RS256" });
  return httpsPost(ep, JSON.stringify(body), {
    "X-gravitee-api-key": API_KEY, source_app: SOURCE_APP,
    Authorization: `Bearer ${_token}`,
    "DK-Signature": `DKSignature ${sig}`, "DK-Timestamp": ts, "DK-Nonce": n,
  });
}

async function getDkBalance(account) {
  const res = await dkPost("/v1/account_inquiry", { account_number: account });
  if (res.response_code !== "0000") throw new Error(`account_inquiry [${account}] failed: ${res.response_description}`);
  const raw = res.response_data?.balance_info ?? "BTN: 0";
  return {
    balance: parseFloat(raw.replace(/[^0-9.]/g, "")) || 0,
    raw,
    name: res.response_data?.beneficiary_account_name ?? "",
  };
}

async function getInAppBalance(userId) {
  const r = await db.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS bal FROM transactions WHERE "userId" = $1`,
    [userId],
  );
  return parseFloat(r.rows[0].bal) || 0;
}

async function debitLedger(userId, amount, note) {
  const bal = await getInAppBalance(userId);
  if (bal < amount) throw new Error(`Insufficient balance: has BTN ${bal.toFixed(2)}, needs BTN ${amount}`);
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
    inquiry_id:            `TARA-TEST-${ref}-${stanNo}`,
    currency:              "BTN",
    payment_type:          "INTRA",
    payment_desc:          "Tara settlement test payout",
    source_app:            SOURCE_APP,
    narration:             "Tara end-to-end settlement test",
  });
  const ok = res?.response_code === "0000" ||
    (res?.response_message ?? "").toUpperCase().includes("SUCCESS");
  return { ok, txnStatusId: res?.response_data?.txn_status_id, inquiryId: res?.response_data?.inquiry_id, raw: res };
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const sep = "─".repeat(54);

  console.log(`\n╔${"═".repeat(54)}╗`);
  console.log(`║   End-to-End Settlement Test — DK Staging${" ".repeat(12)}║`);
  console.log(`╚${"═".repeat(54)}╝`);

  // Look up both users
  const { rows: users } = await db.query(
    `SELECT id, "firstName", "lastName", "dkCid", "dkAccountNumber", "dkAccountName"
     FROM users WHERE "dkCid" = ANY($1)`,
    [[CID_A, CID_B]],
  );
  const userA = users.find(u => u.dkCid === CID_A);
  const userB = users.find(u => u.dkCid === CID_B);
  if (!userA) throw new Error(`User A (CID ${CID_A}) not found`);
  if (!userB) throw new Error(`User B (CID ${CID_B}) not found`);

  console.log(`\n  User A : ${userA.firstName} ${userA.lastName || ""}  (CID ${userA.dkCid})`);
  console.log(`           DK account: ${userA.dkAccountNumber}`);
  console.log(`  User B : ${userB.firstName} ${userB.lastName || ""}  (CID ${userB.dkCid})`);
  console.log(`           DK account: ${userB.dkAccountNumber}`);
  console.log(`\n  Bet A = BTN ${BET_A}  |  Bet B = BTN ${BET_B}  |  Winner = User ${WINNER.toUpperCase()}  |  House = ${HOUSE_PCT}%`);

  // ── 1. Before balances ───────────────────────────────────────────────────────
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

  console.log(`\n  Account                    DK Balance          In-App Balance`);
  console.log(`  ${"─".repeat(62)}`);
  console.log(`  Merchant ${MERCHANT_ACCOUNT}  BTN ${String(dkM0.balance.toFixed(2)).padStart(12)}  (platform vault)`);
  console.log(`  User A   ${userA.dkAccountNumber}  BTN ${String(dkA0.balance.toFixed(2)).padStart(12)}  BTN ${appA0.toFixed(2)}`);
  console.log(`  User B   ${userB.dkAccountNumber}  BTN ${String(dkB0.balance.toFixed(2)).padStart(12)}  BTN ${appB0.toFixed(2)}`);

  // ── 2. Place bets ────────────────────────────────────────────────────────────
  console.log(`\n── 2. Place Bets  ${sep.slice(17)}`);
  const appA1 = await debitLedger(userA.id, BET_A, `[TEST] Bet on Outcome A — market settlement test`);
  const appB1 = await debitLedger(userB.id, BET_B, `[TEST] Bet on Outcome B — market settlement test`);
  console.log(`  ✅ User A  -BTN ${BET_A}  →  in-app balance: BTN ${appA1.toFixed(2)}`);
  console.log(`  ✅ User B  -BTN ${BET_B}  →  in-app balance: BTN ${appB1.toFixed(2)}`);

  // ── 3. Settlement math ───────────────────────────────────────────────────────
  console.log(`\n── 3. Settlement Calculation  ${sep.slice(29)}`);
  const totalPool  = parseFloat((BET_A + BET_B).toFixed(2));
  const houseAmt   = parseFloat((totalPool * HOUSE_PCT / 100).toFixed(2));
  const payoutPool = parseFloat((totalPool - houseAmt).toFixed(2));

  const winnerUser   = WINNER === "a" ? userA : userB;
  const loserUser    = WINNER === "a" ? userB : userA;
  const winnerDkAcct = winnerUser.dkAccountNumber;
  const winnerDkName = WINNER === "a" ? dkA0.name : dkB0.name;
  const winnerBet    = WINNER === "a" ? BET_A : BET_B;
  const winnerPayout = payoutPool; // sole winner takes full payout pool

  console.log(`\n  Total pool   : BTN ${totalPool}`);
  console.log(`  House ${HOUSE_PCT}%    : BTN ${houseAmt}  (stays in merchant vault)`);
  console.log(`  Payout pool  : BTN ${payoutPool}`);
  console.log(`  Winner       : User ${WINNER.toUpperCase()} (${winnerUser.firstName}) — stake BTN ${winnerBet}`);
  console.log(`  Payout       : BTN ${winnerPayout}  (net profit: +BTN ${(winnerPayout - winnerBet).toFixed(2)})`);

  // ── 4. Credit winner in-app ──────────────────────────────────────────────────
  console.log(`\n── 4. Credit Winner In-App  ${sep.slice(27)}`);
  const winnerAppFinal = await creditLedger(
    winnerUser.id,
    winnerPayout,
    `[TEST] Payout — total pool BTN ${totalPool}, house BTN ${houseAmt}, payout pool BTN ${payoutPool}`,
  );
  console.log(`  ✅ Credited BTN ${winnerPayout} → User ${WINNER.toUpperCase()} in-app: BTN ${winnerAppFinal.toFixed(2)}`);

  // ── 5. Real DK payout transfer ───────────────────────────────────────────────
  console.log(`\n── 5. DK Bank Transfer  ${sep.slice(23)}`);
  console.log(`  Merchant ${MERCHANT_ACCOUNT} → ${winnerDkAcct}  BTN ${winnerPayout}`);
  const dkTx = await dkPushPayout(winnerDkAcct, winnerDkName, winnerPayout, `${winnerUser.id.slice(0,8)}`);

  if (dkTx.ok) {
    console.log(`  ✅ Transfer queued by DK Bank`);
    console.log(`     txn_status_id : ${dkTx.txnStatusId}`);
    console.log(`     inquiry_id    : ${dkTx.inquiryId}`);
  } else {
    console.log(`  ❌ DK transfer FAILED`);
    console.log(`     Response: ${JSON.stringify(dkTx.raw, null, 2)}`);
  }

  // Wait 2 s for DK to settle the transaction
  await new Promise(r => setTimeout(r, 2000));

  // ── 6. Final balances ────────────────────────────────────────────────────────
  console.log(`\n── 6. Balances After  ${sep.slice(21)}`);
  const [dkA1, dkB1, dkM1] = await Promise.all([
    getDkBalance(userA.dkAccountNumber),
    getDkBalance(userB.dkAccountNumber),
    getDkBalance(MERCHANT_ACCOUNT),
  ]);
  const [appA_f, appB_f] = await Promise.all([
    getInAppBalance(userA.id),
    getInAppBalance(userB.id),
  ]);

  const fmt = (n) => (n >= 0 ? "+" : "") + n.toFixed(2);

  console.log(`\n  Account                    DK Balance          In-App Balance`);
  console.log(`  ${"─".repeat(62)}`);
  console.log(`  Merchant ${MERCHANT_ACCOUNT}  BTN ${String(dkM1.balance.toFixed(2)).padStart(12)}  ${fmt(dkM1.balance - dkM0.balance)} DK`);
  console.log(`  User A   ${userA.dkAccountNumber}  BTN ${String(dkA1.balance.toFixed(2)).padStart(12)}  BTN ${appA_f.toFixed(2)}  (${fmt(dkA1.balance - dkA0.balance)} DK / ${fmt(appA_f - appA0)} in-app)`);
  console.log(`  User B   ${userB.dkAccountNumber}  BTN ${String(dkB1.balance.toFixed(2)).padStart(12)}  BTN ${appB_f.toFixed(2)}  (${fmt(dkB1.balance - dkB0.balance)} DK / ${fmt(appB_f - appB0)} in-app)`);

  console.log(`\n  House cut retained in merchant vault: BTN ${houseAmt}`);
  console.log(`  Merchant DK delta: ${fmt(dkM1.balance - dkM0.balance)} BTN  (expected: -${winnerPayout.toFixed(2)} payout out)`);

  const winnerDkDelta = WINNER === "a" ? dkA1.balance - dkA0.balance : dkB1.balance - dkB0.balance;
  const pass = Math.abs(winnerDkDelta - winnerPayout) < 0.01;
  console.log(`\n  ${pass ? "✅" : "⚠️ "} Winner DK delta: ${fmt(winnerDkDelta)} BTN  (expected: +${winnerPayout.toFixed(2)})`);

  await db.end();
  console.log(`\n╔${"═".repeat(54)}╗`);
  console.log(`║  Done ✅${" ".repeat(46)}║`);
  console.log(`╚${"═".repeat(54)}╝\n`);
})().catch(async err => {
  console.error(`\n  ❌ Fatal: ${err.message}`);
  await db.end().catch(() => {});
  process.exit(1);
});
