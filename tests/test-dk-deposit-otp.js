/**
 * Quick test: does DK staging accept OTP 998811 for debit_request?
 *
 * Flow:
 *   1. account_auth/pull-payment  → get bfsTxnId  (DK sends SMS to staging phone)
 *   2. debit_request/pull-payment → submit OTP 998811
 *
 * Usage:
 *   node test-dk-deposit-otp.js
 *   node test-dk-deposit-otp.js --otp 123456   (try a different OTP)
 *   node test-dk-deposit-otp.js --cid 10304001086 --amount 100
 */

const https = require("https");
const jwt   = require("jsonwebtoken");
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
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (k && !(k in process.env)) process.env[k] = v;
  });
}

// ── CLI args ──────────────────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const getArg = (flag, def) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : def; };
const TEST_OTP = getArg("--otp",    "998811");
const TEST_CID = getArg("--cid",    "10304001086"); // Ashish Upadhaya
const AMOUNT   = parseFloat(getArg("--amount", "50"));

// ── DK config ─────────────────────────────────────────────────────────────────
const BASE_URL   = process.env.DK_BASE_URL   || "https://internal-gateway.sit.digitalkidu.bt:8082/api/dkpg";
const API_KEY    = process.env.DK_API_KEY    || "";
const SOURCE_APP = process.env.DK_SOURCE_APP || "";
const BANK_CODE  = process.env.DK_BANK_CODE  || "1060";
const MERCHANT_ACCOUNT = process.env.DK_BENEFICIARY_ACCOUNT      || "110146039368";
const MERCHANT_NAME    = process.env.DK_BENEFICIARY_ACCOUNT_NAME || "Sonam Tenzin";

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

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const W = 56;
  console.log(`\n╔${"═".repeat(W)}╗`);
  console.log(`║  DK Staging — Deposit OTP Test${" ".repeat(W - 31)}║`);
  console.log(`║  CID: ${TEST_CID}  Amount: BTN ${AMOUNT}  OTP: ${TEST_OTP}${" ".repeat(W - 7 - TEST_CID.length - String(AMOUNT).length - TEST_OTP.length - 19)}║`);
  console.log(`╚${"═".repeat(W)}╝`);

  await dkAuth();
  console.log(`\n  ✅ DK auth OK`);

  // ── Step 1: Look up account by CID ────────────────────────────────────────
  console.log(`\n── 1. client_inquiry (CID ${TEST_CID})`);
  const inquiryRes = await dkPost("/v1/client_inquiry", {
    id_type: "CID",
    id_number: TEST_CID,
  });

  if (inquiryRes.response_code !== "0000" || !inquiryRes.response_data?.[0]) {
    console.log(`  ❌ client_inquiry failed: ${inquiryRes.response_description}`);
    process.exit(1);
  }
  const acct = inquiryRes.response_data[0];
  const accountNumber = acct.account_number;
  const accountName   = [acct.first_name, acct.middle_name, acct.last_name].filter(Boolean).join(" ");
  const phone         = acct.phone_number || "";
  console.log(`  Account : ${accountNumber}`);
  console.log(`  Name    : ${accountName}`);
  console.log(`  Phone   : ${phone || "(none)"}`);

  // ── Step 2: account_auth — triggers DK SMS OTP ────────────────────────────
  console.log(`\n── 2. account_auth/pull-payment  (DK should send SMS OTP)`);
  const stanNo   = stan();
  const txDatetime = dkTs();

  const authRes = await dkPost("/v1/account_auth/pull-payment", {
    account_number:       accountNumber,
    transaction_datetime: txDatetime,
    stan_number:          stanNo,
    transaction_amount:   AMOUNT.toFixed(2),
    payment_desc:         "Oro staging OTP test",
    account_name:         accountName,
    phone_number:         BASE_URL.includes(".sit.") ? "17000000" : phone,
    remitter_account_number: accountNumber,
    remitter_account_name:   accountName,
    remitter_bank_id:        BANK_CODE,
  });

  console.log(`  response_code : ${authRes.response_code}`);
  console.log(`  response_msg  : ${authRes.response_description || authRes.response_message || "—"}`);

  if (authRes.response_code !== "0000" || !authRes.response_data?.bfs_txn_id) {
    console.log(`\n  ❌ account_auth failed — cannot proceed to debit_request`);
    console.log(`  Full response: ${JSON.stringify(authRes, null, 2)}`);
    process.exit(1);
  }

  const bfsTxnId = authRes.response_data.bfs_txn_id;
  console.log(`  ✅ bfs_txn_id : ${bfsTxnId}`);

  // ── Step 3: debit_request with OTP 998811 ─────────────────────────────────
  console.log(`\n── 3. debit_request/pull-payment  (OTP: ${TEST_OTP})`);
  const debitRes = await dkPost("/v1/debit_request/pull-payment", {
    bfs_TxnId:            bfsTxnId,
    bfs_remitter_Otp:     TEST_OTP,
    stan_number:          stanNo,
    transaction_datetime: txDatetime,
    transaction_amount:   AMOUNT.toFixed(2),
    currency:             "BTN",
    payment_type:         "INTRA",
    source_account_name:  accountName,
    source_account_number: accountNumber,
    bene_cust_name:       MERCHANT_NAME,
    bene_account_number:  MERCHANT_ACCOUNT,
    bene_bank_code:       BANK_CODE,
    narration:            "Oro staging OTP test",
  });

  console.log(`  response_code : ${debitRes.response_code}`);
  console.log(`  response_msg  : ${debitRes.response_description || debitRes.response_message || "—"}`);

  const ok = debitRes.response_code === "0000";
  if (ok) {
    console.log(`  ✅ debit_request ACCEPTED`);
    console.log(`  txn_status_id : ${debitRes.response_data?.txn_status_id || "—"}`);
  } else {
    console.log(`  ❌ debit_request REJECTED`);
    console.log(`  Full response: ${JSON.stringify(debitRes, null, 2)}`);
  }

  console.log(`\n╔${"═".repeat(W)}╗`);
  if (ok) {
    console.log(`║  ✅ OTP ${TEST_OTP} works in DK staging — deposit flow confirmed${" ".repeat(W - 49 - TEST_OTP.length)}║`);
  } else {
    console.log(`║  ❌ OTP ${TEST_OTP} rejected by DK staging${" ".repeat(W - 32 - TEST_OTP.length)}║`);
  }
  console.log(`╚${"═".repeat(W)}╝\n`);

  process.exit(ok ? 0 : 1);

})().catch(err => {
  console.error(`\n  ❌ Fatal: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
