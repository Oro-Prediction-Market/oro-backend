/**
 * Test: can /v1/initiate/transaction work with USER as source → MERCHANT as beneficiary?
 * (Same endpoint used by the working dk-transfer.service.js)
 */
const https = require("https");
const jwt = require("jsonwebtoken");
const { randomUUID, randomBytes } = require("crypto");
const path = require("path");
const fs = require("fs");

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

const BASE_URL   = process.env.DK_BASE_URL;
const API_KEY    = process.env.DK_API_KEY;
const SOURCE_APP = process.env.DK_SOURCE_APP;
const MERCHANT   = process.env.DK_BENEFICIARY_ACCOUNT;
const MERCHANT_N = process.env.DK_BENEFICIARY_ACCOUNT_NAME;
const BANK_CODE  = process.env.DK_BANK_CODE;

const USER_ACCOUNT = "100100361709"; // Asseh Nepal
const USER_NAME    = "Asseh Nepal";
const AMOUNT       = 50.00;

const reqId = () => `${Date.now()}-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const nonce = () => randomUUID().replace(/-/g, "");
const dkTs  = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const stan  = () => String(100000 + (randomBytes(3).readUIntBE(0, 3) % 900000));

function canon(o) {
  if (Array.isArray(o)) return o.map(canon);
  if (o && typeof o === "object")
    return Object.keys(o).sort().reduce((a, k) => ({ ...a, [k]: canon(o[k]) }), {});
  return o;
}

function httpsPost(ep, body, hdrs) {
  return new Promise((res, rej) => {
    const pay = typeof body === "string" ? body : JSON.stringify(body);
    const u = new URL(BASE_URL + ep);
    const r = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(pay), ...hdrs },
      rejectUnauthorized: false,
    }, (rsp) => {
      const c = [];
      rsp.on("data", d => c.push(d));
      rsp.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString())); } catch { res(Buffer.concat(c).toString()); } });
    });
    r.on("error", rej); r.write(pay); r.end();
  });
}

let _token = null, _key = null;
async function auth() {
  if (_token && _key) return;
  const p = new URLSearchParams({
    username: process.env.DK_USERNAME, password: process.env.DK_PASSWORD,
    client_id: process.env.DK_CLIENT_ID, client_secret: process.env.DK_CLIENT_SECRET,
    grant_type: "password", scopes: "keys:read", source_app: SOURCE_APP, request_id: reqId(),
  });
  const r = await httpsPost("/v1/auth/token", p.toString(), { "Content-Type": "application/x-www-form-urlencoded", "X-gravitee-api-key": API_KEY });
  _token = r.response_data.access_token;
  const k = await httpsPost("/v1/sign/key", JSON.stringify({ request_id: reqId(), source_app: SOURCE_APP }),
    { Authorization: `Bearer ${_token}`, "X-gravitee-api-key": API_KEY });
  _key = k;
}

async function dkPost(ep, data) {
  await auth();
  const body = { request_id: reqId(), ...data };
  const n = nonce(), ts = dkTs();
  const b64 = Buffer.from(JSON.stringify(canon(body))).toString("base64");
  const sig = jwt.sign({ data: b64, timestamp: ts, nonce: n }, _key, { algorithm: "RS256" });
  return httpsPost(ep, JSON.stringify(body), {
    "X-gravitee-api-key": API_KEY, source_app: SOURCE_APP,
    Authorization: `Bearer ${_token}`, "DK-Signature": `DKSignature ${sig}`,
    "DK-Timestamp": ts, "DK-Nonce": n,
  });
}

async function balance(account) {
  const r = await dkPost("/v1/account_inquiry", { account_number: account });
  return r.response_data?.balance_info ?? "N/A";
}

(async () => {
  console.log("═══════════════════════════════════════════════════════");
  console.log(" Test: /v1/initiate/transaction  USER → MERCHANT");
  console.log(`  User     : ${USER_ACCOUNT} (${USER_NAME})`);
  console.log(`  Merchant : ${MERCHANT} (${MERCHANT_N})`);
  console.log(`  Amount   : BTN ${AMOUNT}`);
  console.log("═══════════════════════════════════════════════════════\n");

  await auth();
  console.log("✅ Auth OK\n");

  console.log("── Balances BEFORE ──");
  const userBefore = await balance(USER_ACCOUNT);
  const mercBefore = await balance(MERCHANT);
  console.log(`  Asseh   : ${userBefore}`);
  console.log(`  Merchant: ${mercBefore}\n`);

  const stanNo = stan();
  console.log("── Calling /v1/initiate/transaction (user as source) ──");
  const res = await dkPost("/v1/initiate/transaction", {
    inquiry_id: `Oro-DEPOSIT-${stanNo}`,
    transaction_datetime: dkTs(),
    source_app: SOURCE_APP,
    transaction_amount: AMOUNT.toFixed(2),
    currency: "BTN",
    payment_type: "INTRA",
    source_account_name: USER_NAME,
    source_account_number: USER_ACCOUNT,
    bene_cust_name: MERCHANT_N,
    bene_account_number: MERCHANT,
    bene_bank_code: BANK_CODE,
    narration: "Oro deposit test via initiate/transaction",
  });
  console.log("Full response:", JSON.stringify(res, null, 2));

  await new Promise(r => setTimeout(r, 2000));

  console.log("\n── Balances AFTER (2s later) ──");
  const userAfter = await balance(USER_ACCOUNT);
  const mercAfter = await balance(MERCHANT);
  console.log(`  Asseh   : ${userAfter}`);
  console.log(`  Merchant: ${mercAfter}`);

  const userChanged = userBefore !== userAfter;
  const mercChanged = mercBefore !== mercAfter;
  console.log("\n── Result ──");
  console.log(`  Asseh balance changed  : ${userChanged ? "✅ YES" : "❌ NO"}`);
  console.log(`  Merchant balance changed: ${mercChanged ? "✅ YES" : "❌ NO"}`);

  if (userChanged && mercChanged) {
    console.log("\n✅ /v1/initiate/transaction WORKS for user→merchant deposits!");
  } else if (!userChanged && !mercChanged && res.response_code === "0000") {
    console.log("\n⚠️  DK accepted the request but balances unchanged (batch mode)");
  } else {
    console.log("\n❌ Transfer failed or rejected");
  }
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
