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

const DK_RESPONSE_CODES = {
  SUCCESS: "0000",
  TIMEOUT: "2002",
  INTERNAL_FAILURE: "2004",
  RESTRICTION: "2008",
  NOT_FOUND: "3001",
  INVALID_PARAMS: "4002",
  EXCEPTION: "5001",
  DB_ERROR: "5002",
  INTERNAL_NO_RESPONSE: "2001",
} as const;

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
      this.logger.log(`DK POST ${endpoint} → ${JSON.stringify(requestBody)}`);
      const res = await this.nativeFetch<T>(
        endpoint,
        JSON.stringify(requestBody),
        headers,
      );
      this.logger.log(`DK POST ${endpoint} ← ${JSON.stringify(res)}`);
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
        account_number: params.customerAccountNumber,
        transaction_datetime: txDatetime,
        stan_number: params.stanNumber,
        transaction_amount: params.amount.toFixed(2),
        payment_desc: params.description,
        account_name: params.customerAccountName,
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
    // Safety check: source (customer) and destination (merchant) must be different accounts
    if (params.sourceAccountNumber === this.beneficiaryAccount) {
      this.logger.error(
        `[CRITICAL] Source account ${params.sourceAccountNumber} is the same as merchant beneficiary account ${this.beneficiaryAccount}. ` +
          `This would cause debit and credit on the same account. Aborting transaction.`,
      );
      throw new BadRequestException(
        "Transaction cannot be processed: source and merchant accounts are the same. Please contact support.",
      );
    }

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
        source_account_name: params.sourceAccountName,
        source_account_number: params.sourceAccountNumber,
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

  /** Public client inquiry — used by the /client-inquiry controller endpoint. */
  async clientInquiry(dto: { id_type: "CID"; id_number: string }) {
    return this.dkPost<{
      response_code: string;
      response_message?: string;
      response_description?: string;
      response_data?: any[];
    }>("/v1/client_inquiry", dto, true);
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
        };
      }>("/v1/initiate/transaction", body, true);
    } catch (err: any) {
      throw new Error(
        `DK Bank transfer failed: ${err?.message ?? "unknown error"}`,
      );
    }

    const success =
      raw?.response_code === DK_RESPONSE_CODES.SUCCESS ||
      (raw?.response_message ?? "").toUpperCase().includes("SUCCESS");

    return {
      txnId:
        raw?.response_data?.transaction_id ??
        raw?.response_data?.txn_id ??
        null,
      txnStatusId: raw?.response_data?.txn_status_id ?? null,
      inquiryId: raw?.response_data?.inquiry_id ?? null,
      status: success ? "SUCCESS" : "FAILED",
      statusDesc:
        raw?.response_description ??
        raw?.response_message ??
        (success ? "Transfer queued" : "Transfer failed"),
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
