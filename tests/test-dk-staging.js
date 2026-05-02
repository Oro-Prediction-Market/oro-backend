/**
 * DK Staging Connection Test (updated for new API)
 *
 * Usage:
 *   node test-dk-staging.js <account_number>               # account inquiry (balance + details)
 *   node test-dk-staging.js --cid <cid_number>             # CID → account number lookup
 *   node test-dk-staging.js <account_number> --pay <amt>   # auth → prompt for OTP → pay
 *
 * Example:
 *   node test-dk-staging.js 110158212197
 *   node test-dk-staging.js --cid 11502000922
 *   node test-dk-staging.js 110158212197 --pay 10
 */

// Zero third-party HTTP dependency — uses Node.js built-in https module only.
const https = require("https");
const jwt = require("../node_modules/jsonwebtoken");
const readline = require("readline");
const { randomUUID } = require("crypto");

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL = "https://internal-gateway.sit.digitalkidu.bt:8082/api/dkpg";
const API_KEY = "595987da-fa2d-484f-82e3-b3a330d5c768";
const USERNAME = "PG_AVS";
const PASSWORD = "p@PG1234";
const CLIENT_ID = "PG_AVS_123";
const CLIENT_SECRET = "PG-Requestor-TestSecret123";
const SOURCE_APP = "SRC_AVS_0201";
const BENE_ACCOUNT = "110146039368";
const BENE_NAME = "Sonam Tenzin";
const BANK_CODE = "1060";

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const cidIdx = args.indexOf("--cid");
const cidArg = cidIdx !== -1 ? args[cidIdx + 1] : null;
const accountNo =
  !cidArg && args[0] && !args[0].startsWith("--") ? args[0] : null;
const payIdx = args.indexOf("--pay");
const payAmount = payIdx !== -1 ? parseFloat(args[payIdx + 1]) : null;

if (!accountNo && !cidArg) {
  console.error(
    "Usage:\n" +
      "  node test-dk-staging.js <account_number>             # balance inquiry\n" +
      "  node test-dk-staging.js --cid <cid_number>           # CID → account lookup\n" +
      "  node test-dk-staging.js <account_number> --pay <amt> # full payment flow",
  );
  process.exit(1);
}

// ── Native HTTPS helper (replaces axios) ──────────────────────────────────────
/**
 * POST to the DK gateway using Node.js built-in https.
 * Returns parsed JSON response. Throws on non-2xx or network error.
 */
function httpsPost(path, body, headers, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const url = new URL(BASE_URL + path);

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...headers,
      },
      // Trust the DK staging self-signed cert (internal gateway only)
      rejectUnauthorized: false,
      timeout: timeoutMs,
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${text}`));
        }
        // Some DK endpoints return a raw PEM string, not JSON
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve(text);
        }
      });
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

const reqId = () =>
  `${Date.now()}-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const nonce = () => randomUUID().replace(/-/g, "");
const dkTs = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function canonicalize(obj) {
  if (Array.isArray(obj)) return obj.map(canonicalize);
  if (obj && typeof obj === "object")
    return Object.keys(obj)
      .sort()
      .reduce((a, k) => {
        a[k] = canonicalize(obj[k]);
        return a;
      }, {});
  return obj;
}

function ok(label) {
  console.log(`  ✅ ${label}`);
}
function info(label) {
  console.log(`  ℹ️  ${label}`);
}
function fail(label) {
  console.error(`  ❌ ${label}`);
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
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
    throw new Error(authRes.response_description);
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
    throw new Error("Unexpected private key response");

  return { token, privateKey: keyRes };
}

async function dkPost(endpoint, data, token, privateKey) {
  const body = { request_id: reqId(), ...data };
  const n = nonce(),
    ts = dkTs();
  const b64 = Buffer.from(JSON.stringify(canonicalize(body))).toString(
    "base64",
  );
  const sig = jwt.sign({ data: b64, timestamp: ts, nonce: n }, privateKey, {
    algorithm: "RS256",
  });
  return httpsPost(endpoint, JSON.stringify(body), {
    "Content-Type": "application/json",
    "X-gravitee-api-key": API_KEY,
    Authorization: `Bearer ${token}`,
    source_app: SOURCE_APP,
    "DK-Signature": `DKSignature ${sig}`,
    "DK-Timestamp": ts,
    "DK-Nonce": n,
  });
}

// ── Steps ─────────────────────────────────────────────────────────────────────
async function step_auth() {
  console.log("\n── Step 1: Authenticate ──");
  const result = await getTokenAndKey();
  ok(`Token obtained | Private key received`);
  return result;
}

async function step_clientInquiry(token, privateKey, cid) {
  console.log(`\n── Step 2: Client Inquiry (CID → Account Number) ──`);
  const res = await dkPost(
    "/v1/client_inquiry",
    { id_type: "CID", id_number: cid },
    token,
    privateKey,
  );

  if (res.response_code !== "0000") {
    console.error("  Full response:", JSON.stringify(res, null, 4));
    throw new Error(
      `[${res.response_code}] ${res.response_description || res.response_message || "client_inquiry failed"}`,
    );
  }

  console.log("  Full response:", JSON.stringify(res, null, 4));

  const accounts = res.response_data;
  if (!accounts || accounts.length === 0) {
    throw new Error("No accounts found for this CID in staging");
  }

  ok(`Found ${accounts.length} account(s) for CID ${cid}:`);
  accounts.forEach((acc, i) => {
    console.log(`\n     Account ${i + 1}:`);
    console.log(`       Account Number : ${acc.account_number}`);
    console.log(`       Account Name   : ${acc.account_name}`);
    console.log(`       CID            : ${acc.cid_no || cid}`);
    console.log(`       Phone Hash     : ${acc.phone_hash || "—"}`);
  });

  return accounts;
}

async function step_accountInquiry(token, privateKey, accountNumber) {
  console.log(`\n── Step 2: Account Inquiry (balance + details) ──`);
  const res = await dkPost(
    "/v1/account_inquiry",
    { account_number: accountNumber },
    token,
    privateKey,
  );

  if (res.response_code !== "0000") {
    console.error("  Full response:", JSON.stringify(res, null, 4));
    throw new Error(
      `[${res.response_code}] ${res.response_description || res.response_message || "account_inquiry failed"}`,
    );
  }

  const d = res.response_data;
  ok(`Account found!`);
  console.log(`     Account Number : ${d?.account_number}`);
  console.log(`     Account Name   : ${d?.beneficiary_account_name}`);
  console.log(`     Balance        : ${d?.balance_info}`);
  console.log(`     Inquiry ID     : ${d?.inquiry_id}`);
  console.log(`     Response Time  : ${d?.response_time}`);
  return d;
}

async function step_accountAuth(
  token,
  privateKey,
  accountNumber,
  amount,
  stanNumber,
  txDatetime,
) {
  console.log(
    `\n── Step 3: Account Auth / Send OTP (account: ${accountNumber}) ──`,
  );
  const res = await dkPost(
    "/v1/account_auth/pull-payment",
    {
      account_number: accountNumber,
      transaction_datetime: txDatetime,
      stan_number: stanNumber,
      transaction_amount: amount.toFixed(2),
      payment_desc: "Oro staging test",
      account_name: BENE_NAME,
      phone_number: "17000000", // staging placeholder
      remitter_account_number: accountNumber,
      remitter_account_name: "Staging Test User",
      remitter_bank_id: BANK_CODE,
    },
    token,
    privateKey,
  );

  if (res.response_code !== "0000") {
    console.error("  Full response:", JSON.stringify(res, null, 4));
    throw new Error(
      `[${res.response_code}] ${res.response_description || res.response_message || "account_auth failed"}`,
    );
  }

  const bfsTxnId = res.response_data?.bfs_txn_id;
  ok(`Authorized! bfs_txn_id: ${bfsTxnId}`);
  console.log("  Full account_auth response:", JSON.stringify(res, null, 4));
  info(
    "DK Bank should now send an OTP to the account holder's registered phone.",
  );
  return bfsTxnId;
}

async function step_debitRequest(
  token,
  privateKey,
  bfsTxnId,
  otp,
  stanNumber,
  txDatetime,
  accountNumber,
  amount,
) {
  console.log(`\n── Step 3: Execute Payment (OTP: ${otp}) ──`);
  const res = await dkPost(
    "/v1/debit_request/pull-payment",
    {
      bfs_TxnId: bfsTxnId,
      bfs_remitter_Otp: otp,
      stan_number: stanNumber,
      transaction_datetime: txDatetime,
      transaction_amount: amount.toFixed(2),
      currency: "BTN",
      payment_type: "INTRA",
      source_account_name: "Staging Test User",
      source_account_number: accountNumber,
      bene_cust_name: BENE_NAME,
      bene_account_number: BENE_ACCOUNT,
      bene_bank_code: BANK_CODE,
      narration: "Oro staging test payment",
    },
    token,
    privateKey,
  );

  if (res.response_code !== "0000") {
    throw new Error(
      res.response_description ||
        res.response_message ||
        "debit_request failed",
    );
  }

  ok(`Payment initiated! txn_status_id: ${res.response_data?.txn_status_id}`);
  return res.response_data?.txn_status_id;
}

async function step_checkStatus(token, privateKey, txnStatusId) {
  console.log(`\n── Step 4: Check Transaction Status ──`);
  const res = await dkPost(
    "/v1/transaction/status",
    {
      transaction_id: txnStatusId,
      bene_account_number: BENE_ACCOUNT,
    },
    token,
    privateKey,
  );

  console.log("  Status response:", JSON.stringify(res, null, 4));
  return res;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const amount = payAmount ?? 10;

  console.log("═══════════════════════════════════════");
  console.log(" DK Staging Test");
  if (cidArg) {
    console.log(`  CID:     ${cidArg}`);
    console.log(`  Mode:    CID → account number lookup`);
  } else {
    console.log(`  Account: ${accountNo}`);
    console.log(`  Amount:  BTN ${amount}`);
    console.log(
      `  Mode:    ${payAmount !== null ? "auth + OTP + pay" : "balance inquiry"}`,
    );
  }
  console.log("═══════════════════════════════════════");

  try {
    const { token, privateKey } = await step_auth();

    // ── CID lookup mode ──────────────────────────────────────────
    if (cidArg) {
      await step_clientInquiry(token, privateKey, cidArg);
      console.log("\n═══════════════════════════════════════");
      console.log(" Done ✅");
      console.log("═══════════════════════════════════════\n");
      return;
    }

    // ── Account number mode ──────────────────────────────────────
    // Always show balance + account details first
    await step_accountInquiry(token, privateKey, accountNo);

    const stanNumber = String(Math.floor(100000 + Math.random() * 900000));
    const txDatetime = dkTs();

    const bfsTxnId = await step_accountAuth(
      token,
      privateKey,
      accountNo,
      amount,
      stanNumber,
      txDatetime,
    );

    if (payAmount !== null) {
      const otp = await prompt(
        "\n  Enter OTP received on your DK Bank registered phone: ",
      );
      if (!otp) {
        console.log("  No OTP entered — skipping payment.");
        process.exit(0);
      }

      const txnStatusId = await step_debitRequest(
        token,
        privateKey,
        bfsTxnId,
        otp,
        stanNumber,
        txDatetime,
        accountNo,
        amount,
      );
      await step_checkStatus(token, privateKey, txnStatusId);
    } else {
      info(
        "Skipping payment. Run with --pay <amount> to test full flow (e.g. --pay 10)",
      );
    }

    console.log("\n═══════════════════════════════════════");
    console.log(" Done ✅");
    console.log("═══════════════════════════════════════\n");
  } catch (e) {
    fail(e.message || String(e));
    process.exit(1);
  }
})();
