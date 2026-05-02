/**
 * Probe DK Staging — Merchant → User push payout test
 *
 * Tests /v1/initiate/transaction: transfers BTN from the Tara merchant vault
 * to a user's DK Bank account (the same path used by dispatchDkPayouts).
 *
 * Usage:
 *   node probe-dk-endpoints.js                       # 1 BTN → user 110146039368
 *   node probe-dk-endpoints.js --to <account_no>     # 1 BTN → custom account
 *   node probe-dk-endpoints.js --to <account_no> --amount <n>
 *   node probe-dk-endpoints.js --balance <account_no> # just check balance
 */

const https = require("https");
const jwt = require("jsonwebtoken");
const { randomUUID, randomBytes } = require("crypto");
const path = require("path");
const fs = require("fs");

// ── Load .env ─────────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, "../.env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8")
    .split("\n")
    .forEach((line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return;
      const eq = t.indexOf("=");
      if (eq === -1) return;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim();
      if (k && !(k in process.env)) process.env[k] = v;
    });
}

// ── Config (falls back to known staging values) ───────────────────────────────
const BASE_URL =
  process.env.DK_BASE_URL ||
  "https://internal-gateway.sit.digitalkidu.bt:8082/api/dkpg";
const API_KEY = process.env.DK_API_KEY || "";
const USERNAME = process.env.DK_USERNAME || "";
const PASSWORD = process.env.DK_PASSWORD || "";
const CLIENT_ID = process.env.DK_CLIENT_ID || "";
const CLIENT_SECRET = process.env.DK_CLIENT_SECRET || "";
const SOURCE_APP = process.env.DK_SOURCE_APP || "";
const MERCHANT_ACCOUNT = process.env.DK_BENEFICIARY_ACCOUNT || "110158212197";
const MERCHANT_NAME =
  process.env.DK_BENEFICIARY_ACCOUNT_NAME || "Tshering Zangmo";
const BANK_CODE = process.env.DK_BANK_CODE || "1060";

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const toIdx = args.indexOf("--to");
const destAccount = toIdx !== -1 ? args[toIdx + 1] : "110146039368"; // default: Sonam Tenzin
const amtIdx = args.indexOf("--amount");
const amount = amtIdx !== -1 ? parseFloat(args[amtIdx + 1]) : 1.0;
const balIdx = args.indexOf("--balance");
const balanceAccount = balIdx !== -1 ? args[balIdx + 1] : null;

// ── Helpers ───────────────────────────────────────────────────────────────────
const reqId = () =>
  `${Date.now()}-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const nonce = () => randomUUID().replace(/-/g, "");
const dkTs = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const stan = () => String(100000 + (randomBytes(3).readUIntBE(0, 3) % 900000));

function canonicalize(obj) {
  if (Array.isArray(obj)) return obj.map(canonicalize);
  if (obj && typeof obj === "object")
    return Object.keys(obj)
      .sort()
      .reduce((a, k) => ({ ...a, [k]: canonicalize(obj[k]) }), {});
  return obj;
}

function httpsPost(endpointPath, body, headers, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const url = new URL(BASE_URL + endpointPath);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
        rejectUnauthorized: false, // DK staging uses self-signed cert
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode < 200 || res.statusCode >= 300)
            return reject(new Error(`HTTP ${res.statusCode}: ${text}`));
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve(text);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── Auth + signing ────────────────────────────────────────────────────────────
async function getTokenAndKey() {
  const params = new URLSearchParams({
    username: USERNAME,
    password: PASSWORD,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "password",
    scopes: "keys:read",
    source_app: SOURCE_APP,
    request_id: reqId(),
  });

  const authRes = await httpsPost("/v1/auth/token", params.toString(), {
    "Content-Type": "application/x-www-form-urlencoded",
    "X-gravitee-api-key": API_KEY,
  });

  if (authRes.response_code !== "0000")
    throw new Error(
      `Auth failed [${authRes.response_code}]: ${authRes.response_description || authRes.response_message}`,
    );

  const token = authRes.response_data.access_token;

  const keyRes = await httpsPost(
    "/v1/sign/key",
    JSON.stringify({ request_id: reqId(), source_app: SOURCE_APP }),
    {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-gravitee-api-key": API_KEY,
    },
  );

  if (typeof keyRes !== "string" || !keyRes.includes("PRIVATE KEY"))
    throw new Error("Private key response invalid");

  return { token, privateKey: keyRes };
}

async function dkPost(endpointPath, data, token, privateKey) {
  const body = { request_id: reqId(), ...data };
  const n = nonce();
  const ts = dkTs();
  const b64 = Buffer.from(JSON.stringify(canonicalize(body))).toString(
    "base64",
  );
  const sig = jwt.sign({ data: b64, timestamp: ts, nonce: n }, privateKey, {
    algorithm: "RS256",
  });

  return httpsPost(endpointPath, JSON.stringify(body), {
    "Content-Type": "application/json",
    "X-gravitee-api-key": API_KEY,
    source_app: SOURCE_APP,
    Authorization: `Bearer ${token}`,
    "DK-Signature": `DKSignature ${sig}`,
    "DK-Timestamp": ts,
    "DK-Nonce": n,
  });
}

// ── Steps ─────────────────────────────────────────────────────────────────────
async function checkBalance(token, privateKey, accountNumber) {
  console.log(`\n── Account Inquiry: ${accountNumber} ──`);
  const res = await dkPost(
    "/v1/account_inquiry",
    { account_number: accountNumber },
    token,
    privateKey,
  );
  console.log("  Full response:", JSON.stringify(res, null, 2));
  if (res.response_code === "0000") {
    const d = res.response_data;
    console.log(`  ✅ Name   : ${d?.beneficiary_account_name}`);
    console.log(`  ✅ Balance: ${d?.balance_info}`);
  } else {
    console.log(
      `  ❌ [${res.response_code}] ${res.response_description || res.response_message}`,
    );
  }
  return res;
}

async function pushPayout(token, privateKey, toAccount, toName, payAmount) {
  const stanNumber = stan();
  const txDatetime = dkTs();
  const inquiryId = `TARA-PROBE-${stanNumber}`;

  const body = {
    source_account_number: MERCHANT_ACCOUNT,
    source_account_name: MERCHANT_NAME,
    bene_account_number: toAccount,
    bene_cust_name: toName,
    bene_bank_code: BANK_CODE,
    transaction_amount: payAmount.toFixed(2),
    transaction_datetime: txDatetime,
    stan_number: stanNumber,
    inquiry_id: inquiryId,
    currency: "BTN",
    payment_type: "INTRA",
    payment_desc: "Tara probe payout",
    source_app: SOURCE_APP,
    narration: "Tara probe payout test",
  };

  console.log("\n── Push Payout: /v1/initiate/transaction ──");
  console.log("  Request body:", JSON.stringify(body, null, 2));

  const res = await dkPost("/v1/initiate/transaction", body, token, privateKey);

  console.log("\n  Full response:", JSON.stringify(res, null, 2));

  const success =
    res?.response_code === "0000" ||
    (res?.response_message ?? "").toUpperCase().includes("SUCCESS");

  if (success) {
    console.log(`\n  ✅ Transfer queued!`);
    console.log(
      `     txn_id       : ${res?.response_data?.transaction_id ?? res?.response_data?.txn_id ?? "n/a"}`,
    );
    console.log(
      `     txn_status_id: ${res?.response_data?.txn_status_id ?? "n/a"}`,
    );
    console.log(
      `     inquiry_id   : ${res?.response_data?.inquiry_id ?? inquiryId}`,
    );
  } else {
    console.log(
      `\n  ❌ Transfer FAILED [${res?.response_code}]: ${res?.response_description || res?.response_message}`,
    );
  }

  return res;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log("═══════════════════════════════════════════════════");
  console.log(" DK Staging — Payout Probe");
  console.log(`  Merchant (source) : ${MERCHANT_ACCOUNT} (${MERCHANT_NAME})`);
  if (balanceAccount) {
    console.log(`  Mode              : balance inquiry for ${balanceAccount}`);
  } else {
    console.log(`  Destination       : ${destAccount}`);
    console.log(`  Amount            : BTN ${amount.toFixed(2)}`);
    console.log(`  Endpoint          : /v1/initiate/transaction`);
  }
  console.log("═══════════════════════════════════════════════════");

  try {
    console.log("\n── Step 1: Authenticate + fetch signing key ──");
    const { token, privateKey } = await getTokenAndKey();
    console.log("  ✅ Token obtained | Private key received");

    if (balanceAccount) {
      await checkBalance(token, privateKey, balanceAccount);
      return;
    }

    // Check merchant balance first so we know if there are funds
    await checkBalance(token, privateKey, MERCHANT_ACCOUNT);

    // Check destination account exists
    await checkBalance(token, privateKey, destAccount);

    // Look up destination name
    let toName = "Tara User";
    try {
      const inq = await dkPost(
        "/v1/account_inquiry",
        { account_number: destAccount },
        token,
        privateKey,
      );
      if (inq.response_code === "0000")
        toName = inq.response_data?.beneficiary_account_name || toName;
    } catch {}

    // Execute push payout
    await pushPayout(token, privateKey, destAccount, toName, amount);
  } catch (err) {
    console.error(`\n  ❌ Fatal: ${err.message}`);
    process.exit(1);
  }

  console.log("\n═══════════════════════════════════════════════════");
  console.log(" Done ✅");
  console.log("═══════════════════════════════════════════════════\n");
})();
