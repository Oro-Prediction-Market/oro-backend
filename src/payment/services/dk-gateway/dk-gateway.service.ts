import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
  RequestTimeoutException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
// NOTE: axios removed — using Node.js built-in fetch (v18+) to avoid supply-chain risk.
import * as jwt from "jsonwebtoken";
import { Repository } from "typeorm";
import { createHmac, randomUUID, randomBytes, timingSafeEqual } from "crypto";

import { DKGatewayAuthToken } from "../../../entities/dk-gateway-auth-token.entity";
import { classifyDkStatus } from "../../dk-status.util";

const DK_RESPONSE_CODES = {
  SUCCESS: "0000",
  /**
   * `/v1/initiate/transaction` only: DK's new core system accepted the transfer
   * but has not settled it. Resolve it through the status API with the
   * `payment_number` it returns, and never resend it.
   *
   * The same four digits mean something else on `/v1/client_inquiry`, where
   * they report that a CID has no DK account (see `lookupAccountByCID`). The
   * code is endpoint-scoped, so do not test for it outside a transfer.
   */
  PENDING: "0001",
  TIMEOUT: "2002",
  INTERNAL_FAILURE: "2004",
  RESTRICTION: "2008",
  NOT_FOUND: "3001",
  INVALID_PARAMS: "4002",
  EXCEPTION: "5001",
  DB_ERROR: "5002",
  INTERNAL_NO_RESPONSE: "2001",
} as const;

/**
 * New-core status words that mean the transfer is done and the money moved.
 *
 * Kept separate from {@link classifyDkStatus}, which only knows "SUCCESS": the
 * new rail says "settled" or "posted" instead, and its in-flight words
 * ("validating", "initiated", "approved") must not be read as an outcome.
 */
const SETTLED_STATUS_WORDS = [
  "SETTLED",
  "POSTED",
  "COMPLETED",
  "SUCCESS",
] as const;

/** DK-side failures — retryable, and never caused by what the caller sent. */
const UPSTREAM_FAILURE_CODES: ReadonlySet<string> = new Set([
  DK_RESPONSE_CODES.INTERNAL_NO_RESPONSE,
  DK_RESPONSE_CODES.TIMEOUT,
  DK_RESPONSE_CODES.INTERNAL_FAILURE,
  DK_RESPONSE_CODES.EXCEPTION,
  DK_RESPONSE_CODES.DB_ERROR,
]);

type DKTokenRow = DKGatewayAuthToken;

interface DKAuthResponse {
  response_code: string;
  response_message?: string;
  response_description?: string;
  response_data?: {
    access_token: string;
    refresh_token?: string;
    token_type?: string;
    expires_in: number;
  };
}

@Injectable()
export class DKGatewayService {
  private readonly logger = new Logger(DKGatewayService.name);
  private readonly baseUrl: string;
  private readonly timeoutMs = 60_000;
  private privateKeyCache: string | null = null;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(DKGatewayAuthToken)
    private readonly tokenRepo: Repository<DKTokenRow>,
  ) {
    this.baseUrl = (
      this.configService.get<string>("DK_BASE_URL") || ""
    ).replace(/\/$/, "");
  }

  private get apiKey(): string {
    return this.configService.getOrThrow<string>("DK_API_KEY");
  }
  private get username(): string {
    return this.configService.getOrThrow<string>("DK_USERNAME");
  }
  private get password(): string {
    return this.configService.getOrThrow<string>("DK_PASSWORD");
  }
  private get clientId(): string {
    return this.configService.getOrThrow<string>("DK_CLIENT_ID");
  }
  private get clientSecret(): string {
    return this.configService.getOrThrow<string>("DK_CLIENT_SECRET");
  }
  private get sourceApp(): string {
    return this.configService.getOrThrow<string>("DK_SOURCE_APP");
  }
  private get beneficiaryAccount(): string {
    return this.configService.getOrThrow<string>("DK_BENEFICIARY_ACCOUNT");
  }
  private get beneficiaryName(): string {
    return this.configService.getOrThrow<string>("DK_BENEFICIARY_ACCOUNT_NAME");
  }
  private get bankCode(): string {
    return this.configService.getOrThrow<string>("DK_BANK_CODE");
  }
  private get webhookSecret(): string | null {
    return this.configService.get<string>("DK_WEBHOOK_SECRET") || null;
  }

  private canonicalize(obj: unknown): unknown {
    if (Array.isArray(obj)) return obj.map((v) => this.canonicalize(v));
    if (obj && typeof obj === "object") {
      const rec = obj as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(rec).sort())
        out[k] = this.canonicalize(rec[k]);
      return out;
    }
    return obj;
  }

  private generateRequestId(): string {
    return `${Date.now()}-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  }

  private generateNonce(): string {
    return randomUUID().replace(/-/g, "");
  }

  private generateDkTimestamp(): string {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  /** 6-digit System Trace Audit Number — must be consistent across account_auth and debit_request. */
  generateStanNumber(): string {
    return String(100000 + (randomBytes(3).readUIntBE(0, 3) % 900000));
  }

  private async signHeaders(requestBody: Record<string, unknown>) {
    if (!this.privateKeyCache) await this.fetchPrivateKey();
    if (!this.privateKeyCache)
      throw new UnauthorizedException("DK RSA private key not available");

    const timestamp = this.generateDkTimestamp();
    const nonce = this.generateNonce();
    const bodyBase64 = Buffer.from(
      JSON.stringify(this.canonicalize(requestBody)),
    ).toString("base64");
    const signature = jwt.sign(
      { data: bodyBase64, timestamp, nonce },
      this.privateKeyCache,
      { algorithm: "RS256" },
    );

    return {
      "DK-Signature": `DKSignature ${signature}`,
      "DK-Timestamp": timestamp,
      "DK-Nonce": nonce,
    };
  }

  /**
   * Thin native-fetch wrapper — replaces axios to avoid supply-chain risk.
   * Throws on non-2xx or network timeout.
   */
  private async nativeFetch<T = unknown>(
    endpoint: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      if (!res.ok) {
        this.logger.error(`DK HTTP ${res.status} on ${endpoint}: ${text}`);
        if (res.status === 502 || res.status === 503 || res.status === 504) {
          throw new ServiceUnavailableException(
            "DK payment gateway unavailable",
          );
        }
        throw new BadRequestException(`DK gateway HTTP ${res.status}: ${text}`);
      }
      // Some DK endpoints return a raw PEM string, not JSON
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    } catch (err: any) {
      clearTimeout(timer);
      if (err?.name === "AbortError" || err?.message?.includes("abort")) {
        throw new RequestTimeoutException("DK payment request timed out");
      }
      // Network-level failures (ECONNREFUSED, SSL errors, DNS failures, etc.)
      // must not bubble up as 500s — surface as a 503 with a clear message.
      if (
        err instanceof ServiceUnavailableException ||
        err instanceof RequestTimeoutException ||
        err instanceof BadRequestException ||
        err instanceof UnauthorizedException
      ) {
        throw err;
      }
      this.logger.error(
        `DK gateway network error on ${endpoint}: ${err?.message}`,
      );
      throw new ServiceUnavailableException(
        "DK Bank payment gateway is temporarily unavailable. Please try again later.",
      );
    }
  }

  private async fetchPrivateKey(): Promise<void> {
    const token = await this.getValidAccessToken();
    const body = JSON.stringify({
      request_id: this.generateRequestId(),
      source_app: this.sourceApp,
    });
    const data = await this.nativeFetch<string>("/v1/sign/key", body, {
      "Content-Type": "application/json",
      "X-gravitee-api-key": this.apiKey,
      Authorization: `Bearer ${token}`,
    });
    if (
      typeof data === "string" &&
      data.includes("BEGIN") &&
      data.includes("PRIVATE KEY")
    ) {
      this.privateKeyCache = data;
      return;
    }
    throw new Error("DK private key response format invalid");
  }

  private async getValidAccessToken(): Promise<string> {
    const bufferMs = 2 * 60 * 1000;
    const tokenRow = await this.tokenRepo
      .createQueryBuilder("t")
      .where("t.expiresAt > :cutoff", {
        cutoff: new Date(Date.now() + bufferMs),
      })
      .orderBy("t.updatedAt", "DESC")
      .getOne();
    if (tokenRow?.accessToken) return tokenRow.accessToken;

    await this.refreshAccessToken();
    const refreshed = await this.tokenRepo
      .createQueryBuilder("t")
      .where("t.expiresAt > :cutoff", {
        cutoff: new Date(Date.now() + bufferMs),
      })
      .orderBy("t.updatedAt", "DESC")
      .getOne();
    if (!refreshed?.accessToken) throw new Error("DK token refresh failed");
    return refreshed.accessToken;
  }

  private async refreshAccessToken(): Promise<void> {
    const params = new URLSearchParams();
    params.append("username", this.username);
    params.append("password", this.password);
    params.append("client_id", this.clientId);
    params.append("client_secret", this.clientSecret);
    params.append("grant_type", "password");
    params.append("scopes", "keys:read");
    params.append("source_app", this.sourceApp);
    params.append("request_id", this.generateRequestId());

    // TEMP: shape-check each credential so we can spot mismatches.
    // Logs fingerprint (first 3 + last 3 + length), never the value.
    const fp = (k: string) => {
      const v = params.get(k) ?? "";
      return `${k}: len=${v.length} first=${v.slice(0, 3)} last=${v.slice(-3)}`;
    };
    this.logger.warn(
      "DK auth/token request fingerprint:\n  " +
        ["username", "password", "client_id", "client_secret", "source_app"]
          .map(fp)
          .join("\n  ") +
        `\n  X-gravitee-api-key fp: len=${this.apiKey.length} first=${this.apiKey.slice(0, 3)} last=${this.apiKey.slice(-3)}`,
    );

    const res = await this.nativeFetch<DKAuthResponse>(
      "/v1/auth/token",
      params.toString(),
      {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-gravitee-api-key": this.apiKey,
      },
    );
    const data = res;
    if (
      data.response_code !== DK_RESPONSE_CODES.SUCCESS ||
      !data.response_data
    ) {
      throw new Error(
        `DK token fetch failed: ${data.response_description || data.response_message || data.response_code}`,
      );
    }

    const tokenData = data.response_data;
    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
    await this.tokenRepo.save({
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      expiresAt,
    });
    this.privateKeyCache = null;
    this.logger.log("DK access token refreshed");
  }

  private async dkPost<T = unknown>(
    endpoint: string,
    data: Record<string, unknown>,
    requireSignature = true,
  ): Promise<T> {
    const requestBody = { request_id: this.generateRequestId(), ...data };
    const headers: Record<string, string> = {
      "X-gravitee-api-key": this.apiKey,
      source_app: this.sourceApp,
      "Content-Type": "application/json",
    };

    if (requireSignature) {
      const token = await this.getValidAccessToken();
      const signedHeaders = await this.signHeaders(requestBody);
      headers.Authorization = `Bearer ${token}`;
      Object.assign(headers, signedHeaders);
    }

    try {
      this.logger.debug(`DK POST ${endpoint} → ${JSON.stringify(requestBody)}`);
      const res = await this.nativeFetch<T>(
        endpoint,
        JSON.stringify(requestBody),
        headers,
      );
      this.logger.debug(`DK POST ${endpoint} ← ${JSON.stringify(res)}`);
      return res;
    } catch (err: any) {
      // nativeFetch already converts HTTP errors and timeouts — just re-throw.
      this.logger.error(`DK POST ${endpoint} failed: ${err?.message}`);
      throw err;
    }
  }

  // ── Public API methods ────────────────────────────────────────────────────────
  /**
   * Step 1: Look up a customer's DK Bank account by their CID.
   * Returns account number, name, and phone for use in authorizeTransaction.
   */
  async lookupAccountByCID(cid: string): Promise<{
    accountNumber: string;
    accountName: string;
    phoneNumber: string;
  }> {
    const res = await this.dkPost<{
      response_code: string;
      response_message?: string;
      response_description?: string;
      response_data?: Array<{
        national_id: string;
        account_number: string;
        first_name?: string;
        middle_name?: string | null;
        last_name?: string;
        phone_number?: string;
      }>;
    }>("/v1/client_inquiry", { id_type: "CID", id_number: cid }, true);

    if (
      res.response_code !== DK_RESPONSE_CODES.SUCCESS ||
      !res.response_data?.length
    ) {
      const dkMsg = (
        res.response_description ||
        res.response_message ||
        ""
      ).toLowerCase();
      // DK returns "Missing record/record not found" when the CID has no DK Bank account
      if (
        dkMsg.includes("missing record") ||
        dkMsg.includes("not found") ||
        res.response_code === "0001"
      ) {
        throw new BadRequestException(
          "No DK Bank account found for this CID. Please check your 11-digit CID and try again.",
        );
      }
      // Anything else is DK-side (5002 "Error form other adapter" = their core
      // banking adapter failed). That is not the caller's fault and their
      // internal wording means nothing to a user, so surface it as upstream
      // unavailability with the real text kept in the log.
      if (UPSTREAM_FAILURE_CODES.has(res.response_code)) {
        this.logger.error(
          `DK client_inquiry upstream failure ${res.response_code}: ${res.response_description || res.response_message || ""}`,
        );
        throw new ServiceUnavailableException(
          "DK Bank is not responding right now. Please try again in a few minutes.",
        );
      }
      throw new BadRequestException(
        res.response_description ||
          res.response_message ||
          "CID account inquiry failed",
      );
    }

    const acct = res.response_data[0];
    if (!acct?.account_number)
      throw new BadRequestException(
        "No DK Bank account found for this CID. Please check your 11-digit CID and try again.",
      );

    const firstName = acct.first_name || "";
    const middleName = acct.middle_name ? ` ${acct.middle_name}` : "";
    const lastName = acct.last_name ? ` ${acct.last_name}` : "";
    const fullName = `${firstName}${middleName}${lastName}`.trim() || cid;

    return {
      accountNumber: acct.account_number,
      accountName: fullName,
      phoneNumber: acct.phone_number || "",
    };
  }

  /**
   * Step 2: Authorize a pull-payment transaction.
   * Must be called after lookupAccountByCID. Returns bfsTxnId needed for OTP confirmation.
   * DK will send an OTP to the customer's phone after this call.
   */
  async authorizeTransaction(params: {
    customerAccountNumber: string;
    customerAccountName: string;
    customerPhone: string;
    amount: number;
    description: string;
    stanNumber: string;
  }): Promise<{
    bfsTxnId: string;
    stanNumber: string;
    txDatetime: string;
  }> {
    const txDatetime = this.generateDkTimestamp();

    const res = await this.dkPost<{
      response_code: string;
      response_message?: string;
      response_description?: string;
      response_data?: {
        bfs_txn_id: string;
        stan_number: string;
        account_number: string;
        remitter_account_number: string;
      };
    }>(
      "/v1/account_auth/pull-payment",
      {
        account_number: this.beneficiaryAccount,
        account_name: this.beneficiaryName,
        transaction_datetime: txDatetime,
        stan_number: params.stanNumber,
        transaction_amount: params.amount.toFixed(2),
        payment_desc: params.description,
        // DK staging requires phone_number field but cannot send real SMS — use staging placeholder.
        // In production this will be the customer's real registered phone number.
        phone_number: this.baseUrl.includes(".sit.")
          ? "17000000"
          : params.customerPhone,
        remitter_account_number: params.customerAccountNumber,
        remitter_account_name: params.customerAccountName,
        remitter_bank_id: this.bankCode,
      },
      true,
    );

    if (
      res.response_code !== DK_RESPONSE_CODES.SUCCESS ||
      !res.response_data?.bfs_txn_id
    ) {
      throw new BadRequestException(
        res.response_description ||
          res.response_message ||
          "Transaction authorization failed",
      );
    }

    return {
      bfsTxnId: res.response_data.bfs_txn_id,
      stanNumber: params.stanNumber,
      txDatetime,
    };
  }

  /**
   * Step 3: Execute the transaction using the OTP entered by the customer.
   * Returns a txnStatusId for polling the final transaction status.
   */
  async executeTransactionWithOtp(params: {
    bfsTxnId: string;
    otp: string;
    stanNumber: string;
    txDatetime: string;
    sourceAccountNumber: string;
    sourceAccountName: string;
    amount: number;
    description: string;
  }): Promise<{
    txnStatusId: string | null;
    paymentUrl?: string;
    qrCode?: string;
    raw: any;
  }> {
    const res = await this.dkPost<{
      response_code: string;
      response_description?: string;
      response_message?: string;
      response_data?: {
        txn_status_id?: string;
        payment_url?: string;
        qr_code?: string;
        [k: string]: unknown;
      };
    }>(
      "/v1/debit_request/pull-payment",
      {
        bfs_TxnId: params.bfsTxnId,
        bfs_remitter_Otp: params.otp,
        stan_number: params.stanNumber,
        transaction_datetime: params.txDatetime,
        transaction_amount: params.amount.toFixed(2),
        currency: "BTN",
        payment_type: "INTRA",
        source_account_name: this.beneficiaryName,
        source_account_number: this.beneficiaryAccount,
        bene_cust_name: this.beneficiaryName,
        bene_account_number: this.beneficiaryAccount,
        bene_bank_code: this.bankCode,
        narration: params.description,
      },
      true,
    );

    if (res.response_code === DK_RESPONSE_CODES.RESTRICTION) {
      throw new BadRequestException(
        res.response_description || "Transaction restricted by DK",
      );
    }
    if (res.response_code !== DK_RESPONSE_CODES.SUCCESS) {
      throw new BadRequestException(
        res.response_description ||
          res.response_message ||
          "Transaction failed",
      );
    }
    const isBatchMode = !res.response_data?.txn_status_id;

    if (isBatchMode) {
      // debit_request succeeded (0000) but returned batch mode (no txn_status_id).
      // Previously we fell back to /v1/initiate/transaction here, but that API
      // is a push-payment (fund_transfer) intended only for refunds/payouts
      // from the merchant account. Using it to pull from a user's account is
      // incorrect and was flagged by DK Bank.
      //
      // Instead, treat the batch-mode debit_request as successful — the funds
      // will settle via DK's batch processing. Use the bfs_txn_id as the
      // transaction reference for status polling.
      const batchRef =
        (res.response_data as any)?.bfs_txn_id ?? params.bfsTxnId;
      this.logger.warn(
        `[Payment] debit_request returned batch mode (no txn_status_id). ` +
          `Treating as successful — funds will settle via batch. ` +
          `bfs_txn_id=${batchRef}`,
      );
      return {
        txnStatusId: batchRef,
        raw: res.response_data,
      };
    }

    const txnStatusId =
      res.response_data?.txn_status_id ??
      (res.response_data as any)?.bfs_txn_id ??
      null;

    return {
      txnStatusId,
      paymentUrl:
        (res.response_data as any)?.payment_url ||
        (res.response_data as any)?.paymentUrl ||
        undefined,
      qrCode: (res.response_data as any)?.qr_code || undefined,
      raw: res.response_data,
    };
  }

  async checkTransactionStatus(transactionId: string) {
    const res = await this.dkPost<{
      response_code: string;
      response_description?: string;
      response_message?: string;
      response_data?: {
        status: {
          status: string;
          status_desc?: string;
          amount?: string | number;
          debit_account?: string;
          credit_account?: string;
          txn_ts?: string;
        };
        [k: string]: unknown;
      };
    }>(
      "/v1/transaction/status",
      {
        transaction_id: transactionId,
        bene_account_number: this.beneficiaryAccount,
      },
      true,
    );

    if (res.response_code === DK_RESPONSE_CODES.NOT_FOUND) {
      return {
        status: "PENDING",
        statusDesc: "Transaction not found (yet)",
        raw: res,
      };
    }
    if (
      res.response_code !== DK_RESPONSE_CODES.SUCCESS ||
      !res.response_data?.status
    ) {
      throw new BadRequestException(
        res.response_description ||
          res.response_message ||
          "Transaction status check failed",
      );
    }

    const s = res.response_data.status;
    return {
      status: (s.status || "PENDING").toUpperCase(),
      statusDesc: s.status_desc || undefined,
      amount: s.amount,
      debitAccount: s.debit_account,
      creditAccount: s.credit_account,
      txnTimestamp: s.txn_ts,
      raw: res.response_data,
    };
  }

  /**
   * Ask DK where a transfer stands, on the new core system's status endpoint.
   *
   * `referenceNo` is whichever handle the transfer left us: the
   * `payment_number` from a pending (0001) initiate response, the
   * `txn_status_id` from a settled one, or our own request id.
   * `beneAccountNumber` is the account that was CREDITED — for a withdrawal
   * that is the user's account, never the merchant vault.
   *
   * The verdict is deliberately hard to move to `failed`, because `failed` is
   * what refunds a user:
   *
   * - a settlement timestamp means the money moved, whatever DK calls the row;
   * - a rejection word with no settlement timestamp is a refusal;
   * - `0000` with a settled word, or with no word at all, is a settlement;
   * - everything else is `pending`, including `2001`, `3001`, `4002`, `4008`
   *   and any code DK invents later.
   *
   * That last line is the whole point. `3001` means the reference is not
   * indexed yet, `4002` that the query was malformed, `4008` that our key
   * lacks the scope — each is a fact about the lookup, not about the transfer.
   * Reading one as a refusal refunds a payout that is still on its way.
   */
  async checkTransferStatus(params: {
    referenceNo: string;
    beneAccountNumber: string;
  }): Promise<{
    verdict: "success" | "failed" | "pending";
    status: string | null;
    settledAt: string | null;
    paymentNumber: string | null;
    responseCode: string;
    statusDesc?: string;
    raw?: unknown;
  }> {
    const res = await this.dkPost<{
      response_code?: string;
      response_message?: string;
      response_description?: string;
      response_data?: {
        payment_number?: string;
        external_id?: string;
        status?: string;
        settled_at?: string | null;
        statement_date?: string | null;
        amount?: number;
        currency?: string;
      };
    }>(
      "/v1/intra-transaction/status",
      {
        reference_no: params.referenceNo,
        bene_account_number: params.beneAccountNumber,
      },
      true,
    );

    const data = res?.response_data;
    const code = res?.response_code ?? "";
    const statusWord = data?.status ?? null;
    const settledAt = data?.settled_at ?? null;
    const refused = classifyDkStatus(statusWord) === "failed";
    // Matched whole, never as a substring: "not settled" contains "settled",
    // and reading it as a settlement is the one mistake here that pays twice.
    // A word we do not recognise falls through to pending, which is safe.
    const settledWord =
      !!statusWord &&
      (SETTLED_STATUS_WORDS as readonly string[]).includes(
        statusWord.trim().toUpperCase(),
      );

    let verdict: "success" | "failed" | "pending";
    if (settledAt) {
      // Checked before the rejection word on purpose: a row DK both stamps as
      // settled and calls rejected is the one case where refunding is certain
      // to double-pay, because the money is already in the user's account.
      verdict = "success";
    } else if (refused) {
      verdict = "failed";
    } else if (code === DK_RESPONSE_CODES.SUCCESS && (settledWord || !statusWord)) {
      verdict = "success";
    } else {
      verdict = "pending";
    }

    return {
      verdict,
      status: statusWord,
      settledAt,
      paymentNumber: data?.payment_number ?? null,
      responseCode: code,
      statusDesc: res?.response_description ?? res?.response_message,
      raw: res,
    };
  }

  /** Public client inquiry — used by the /client-inquiry controller endpoint. */
  async clientInquiry(dto: { id_type: "CID"; id_number: string }) {
    return this.dkPost<{
      response_code: string;
      response_message?: string;
      response_description?: string;
      response_data?: any[];
    }>("/v1/client_inquiry", dto, true);
  }

  /** Account inquiry — returns account name and balance */
  async accountInquiry(accountNumber: string): Promise<{
    accountNumber: string;
    accountName: string;
    balance: string | null;
    inquiryId: string | null;
  }> {
    const res = await this.dkPost<{
      response_code: string;
      response_message?: string;
      response_description?: string;
      response_data?: {
        inquiry_id?: string;
        beneficiary_account_name?: string;
        account_number?: string;
        balance_info?: string;
      };
    }>("/v1/account_inquiry", { account_number: accountNumber }, true);

    if (res.response_code !== DK_RESPONSE_CODES.SUCCESS || !res.response_data) {
      throw new BadRequestException(
        res.response_description ||
          res.response_message ||
          "Account inquiry failed",
      );
    }

    return {
      accountNumber: res.response_data.account_number || accountNumber,
      accountName: res.response_data.beneficiary_account_name || "",
      balance: res.response_data.balance_info || null,
      inquiryId: res.response_data.inquiry_id || null,
    };
  }

  /** Bound the liveness probe well under the 60s request timeout so a hung
   *  gateway fails the check fast instead of blocking the caller. */
  private readonly probeTimeoutMs = 8_000;

  /**
   * Read-only liveness probe: is the DK gateway answering right now?
   *
   * Runs an `account_inquiry` on the merchant's own beneficiary account — no
   * money moves, no side effects. DK responding at all counts as reachable
   * (even a business/auth error means it's up); only a 5xx, a network-level
   * failure, or a timeout counts as unreachable. Used as a pre-debit guard so
   * we never take a user's balance while DK is in maintenance / offline.
   */
  async isReachable(): Promise<boolean> {
    const probe = (async (): Promise<boolean> => {
      try {
        await this.accountInquiry(this.beneficiaryAccount);
        return true; // DK answered a valid inquiry
      } catch (err) {
        // DK answered, just with a business/auth error → still up.
        if (
          err instanceof BadRequestException ||
          err instanceof UnauthorizedException
        ) {
          return true;
        }
        // 5xx, network failure (ECONNREFUSED/DNS/SSL), or timeout → down.
        this.logger.warn(
          `[DK] liveness probe failed — treating gateway as unreachable: ${
            (err as any)?.message ?? err
          }`,
        );
        return false;
      }
    })();

    // Fail the probe fast if the inquiry hangs past the probe budget.
    const bail = new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), this.probeTimeoutMs),
    );
    return Promise.race([probe, bail]);
  }

  /**
   * Merchant vault → user DK Bank account (withdrawal / payout transfer).
   *
   * Uses /v1/initiate/transaction — the push/credit endpoint that works in both
   * staging and production (unlike /v1/fund_transfer which returns 404 in staging).
   *
   * Required fields discovered from DK staging 422 validation:
   *   source_account_number, source_account_name, bene_account_number,
   *   bene_cust_name, bene_bank_code, inquiry_id
   *
   * Returns a normalised result so callers can branch on `status === "SUCCESS"`.
   */
  async transferToAccount(params: {
    accountNumber: string;
    accountName?: string;
    amount: number;
    currency?: string;
    reference: string;
    description?: string;
  }): Promise<{
    txnId: string | null;
    txnStatusId: string | null;
    inquiryId: string | null;
    /** New core, pending (0001) only: DK's preferred status-API handle. */
    paymentNumber: string | null;
    /** New core, pending (0001) only: our request id, echoed back. */
    requestId: string | null;
    status: string;
    statusDesc: string;
    raw?: unknown;
  }> {
    const stanNumber = this.generateStanNumber();
    const txDatetime = this.generateDkTimestamp();

    const body = {
      source_account_number: this.beneficiaryAccount, // merchant (source of funds)
      source_account_name: this.beneficiaryName, // merchant name
      bene_account_number: params.accountNumber, // destination (user)
      bene_cust_name: params.accountName ?? "Oro User",
      bene_bank_code: this.bankCode,
      transaction_amount: params.amount.toFixed(2),
      transaction_datetime: txDatetime,
      stan_number: stanNumber,
      inquiry_id: `Oro-PAYOUT-${params.reference}-${stanNumber}`,
      currency: params.currency ?? "BTN",
      payment_type: "INTRA",
      payment_desc: params.description ?? "Oro payout",
      source_app: this.sourceApp,
      narration: params.description ?? "Oro platform payout",
    };

    let raw: any;
    try {
      raw = await this.dkPost<{
        response_code: string;
        response_message?: string;
        response_description?: string;
        response_data?: {
          inquiry_id?: string;
          txn_status_id?: string;
          transaction_id?: string;
          txn_id?: string;
          /** New core, pending (0001): the handle the status API wants. */
          payment_number?: string;
          /** New core, pending (0001): echoes the request id we sent. */
          external_id?: string;
        };
      }>("/v1/initiate/transaction", body, true);
    } catch (err: any) {
      throw new Error(
        `DK Bank transfer failed: ${err?.message ?? "unknown error"}`,
      );
    }

    const code = raw?.response_code;
    const txnId =
      raw?.response_data?.transaction_id ?? raw?.response_data?.txn_id ?? null;

    // Any handle DK gives us is enough to reconcile against later. The payout
    // response does not necessarily carry `transaction_id`: the pull-payment
    // flow returns `txn_status_id`, and batch mode returns only `bfs_txn_id`,
    // so demanding `transaction_id` specifically would reject good transfers.
    const paymentNumber = raw?.response_data?.payment_number ?? null;
    const requestId = raw?.response_data?.external_id ?? null;

    // Ordered by how well each handle identifies the transfer, settled handles
    // first. A pending (0001) response carries only the last two, so without
    // them a payout reaches the reconciler with nothing to ask DK about.
    const anyReference =
      txnId ??
      raw?.response_data?.txn_status_id ??
      raw?.response_data?.inquiry_id ??
      (raw?.response_data as { bfs_txn_id?: string } | undefined)?.bfs_txn_id ??
      paymentNumber ??
      requestId ??
      null;

    // The response CODE is the only success signal. `response_message` is free
    // text and must never be substring-matched: `"UNSUCCESSFUL".includes(
    // "SUCCESS")` is true, so a message-based check silently turns every DK
    // rejection carrying that word into a confirmed payout — the user is
    // debited, the refund branch is skipped, and no money ever leaves the bank.
    const codeSaysSuccess = code === DK_RESPONSE_CODES.SUCCESS;

    // `0000` with no reference of any kind is still treated as success. It is
    // unreconcilable and that is worth knowing about — hence the error log
    // below — but DK's payout response shape has never actually been captured,
    // so refusing it here would park every payout in PROCESSING if the real
    // field name is one we do not check. Tighten this once a real response has
    // been observed in `payment.metadata.dkTransfer.raw`.
    const missingTxnId = codeSaysSuccess && !anyReference;
    const success = codeSaysSuccess;

    // FAILED is the only verdict that refunds, so it is the only one stated as
    // an allowlist. A code reaches it solely by being a rejection DK documents
    // as final: the request was turned down and no money moved. Everything
    // else — a timeout, an internal error, the new core's pending `0001`, or a
    // code DK has never sent us before — is AMBIGUOUS, and the caller leaves
    // the withdrawal PROCESSING with the debit intact for reconciliation
    // against /v1/intra-transaction/status.
    //
    // The inverted list this replaces is what refunded four withdrawals DK had
    // accepted. DK answered `0001` — "Payment Engine transaction is
    // validating", still in flight — and because `0001` was in neither list it
    // fell through to FAILED. An unknown code is not a rejection; it is the
    // absence of an answer, and the safe reading of no answer is "wait".
    //
    // 2011 is deliberately absent: it carries its real reason in
    // `response_data` (invalid OTP, account closed, insufficient funds), so
    // the code alone does not establish that no money moved.
    //
    // Known limitation, and the reason the reconciler exists. On the evening
    // of 20 Sep 2026 DK answered two payouts with a definite rejection and
    // executed both anyway; Oro refunded them and Nu 100 left the vault. An
    // allowlist cannot catch that — only DK reporting its own transfers
    // honestly can. What it does catch is every code we have not classified.
    const DEFINITE_REJECTION_CODES: string[] = [
      DK_RESPONSE_CODES.NOT_FOUND, // 3001 — beneficiary account not found
      DK_RESPONSE_CODES.RESTRICTION, // 2008 — restricted by DK
      DK_RESPONSE_CODES.INVALID_PARAMS, // 4002 — request rejected as malformed
    ];
    const definitelyRejected =
      !codeSaysSuccess && DEFINITE_REJECTION_CODES.includes(code);
    const status = success
      ? "SUCCESS"
      : definitelyRejected
        ? "FAILED"
        : "AMBIGUOUS";

    if (missingTxnId) {
      this.logger.error(
        `DK transfer for ${params.reference} returned ${code} with no ` +
          `reference of any kind — it cannot be reconciled against DK: ` +
          JSON.stringify(raw),
      );
    }

    return {
      // Fall back to whichever handle DK did send, so the payout is
      // reconcilable even when `transaction_id` is absent.
      txnId: txnId ?? anyReference,
      txnStatusId: raw?.response_data?.txn_status_id ?? null,
      inquiryId: raw?.response_data?.inquiry_id ?? null,
      paymentNumber,
      requestId,
      status,
      statusDesc:
        raw?.response_description ??
        raw?.response_message ??
        (success
          ? "Transfer queued"
          : definitelyRejected
            ? "Transfer failed"
            : "Transfer status indeterminate"),
      raw,
    };
  }

  verifyWebhookSignature(
    body: unknown,
    signatureHeader: string | undefined,
  ): boolean {
    if (!this.webhookSecret)
      throw new Error(
        "DK_WEBHOOK_SECRET is not configured — refusing to accept unsigned webhook",
      );
    if (!signatureHeader?.trim()) return false;
    // Use canonicalized JSON (sorted keys) so property order differences don't
    // cause valid payloads to fail verification
    const canonical = JSON.stringify(this.canonicalize(body));
    const computedHex = createHmac("sha256", this.webhookSecret)
      .update(canonical)
      .digest("hex");
    const computed = Buffer.from(computedHex);
    const received = Buffer.from(signatureHeader.trim());
    if (computed.length !== received.length) return false;
    return timingSafeEqual(computed, received);
  }
}
