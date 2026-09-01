import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "node:crypto";
import { CryptoNetwork, parseEnabledNetworks } from "./twentyone-pay.types";

/**
 * Contract settled against the 21 Pay engine source — see
 * docs/usdt-oro/21PAY-ANSWERS.md. All three discrepancies with their published
 * spec resolved in this client's favour:
 *
 *   1. Bearer on every route. The tenant resolves off the token and
 *      `X-Tenant-Id` is ignored, so there is no two-scheme split (§1.1).
 *   2. Webhook headers really are `X-T1Pay-*`; the spec's `X-21Tech-*` do not
 *      exist in the engine (§3.1). Node lower-cases inbound header names, so
 *      the lookups below match.
 *   3. The signed payload construction below is exactly what the engine
 *      computes (§3.2).
 *
 * The status union was the one place we were short: `confirming` and
 * `completed_via_topup` are real and are added below.
 */

/**
 * Lifecycle of a deposit intent, as the engine actually emits it.
 *
 * Nine states. Note that these are **not** a one-way progression:
 * `confirmed` can revert to `failed` on a chain reorg, and AML can flip a
 * detected deposit to `failed` after the fact (§2.4). Nothing in this type can
 * express that; the settlement path has to.
 */
export type IntentStatus =
  | "awaiting_deposit"
  | "confirming"
  | "accepted"
  | "confirmed"
  | "confirmed_partial"
  | "confirmed_overpaid"
  | "completed_via_topup"
  | "expired"
  | "failed";

/**
 * States in which funds have actually landed and we credit.
 *
 * `accepted` is deliberately absent: it is a tenant-configured soft threshold,
 * not chain finality (§2.2), and crediting there trades reorg risk for a few
 * seconds of UX.
 *
 * `completed_via_topup` is deliberately absent too, and this one is a double-
 * credit trap. It is set on the **parent** intent as signalling only, once a
 * child top-up settles; the money arrives against the child. Credit the
 * children, never the parent (§2.3).
 */
export const CREDITABLE_INTENT_STATUSES: ReadonlySet<string> = new Set([
  "confirmed",
  "confirmed_partial",
  "confirmed_overpaid",
]);

export interface PaymentIntent {
  id: string;
  status: IntentStatus;
  deposit_address: string;
  /** Requested amount, USDT base units (6 dp) as a decimal string. */
  amount?: string;
  /** Amount actually observed on-chain, base units. Authoritative for crediting. */
  detected_amount?: string;
  currency?: string;
  network?: string;
  tx_hash?: string;
  expires_at?: string;
}

export interface Payout {
  id: string;
  /**
   * Five states, not four. `broadcasting` is a transient marker written
   * immediately before the broadcast call so that a payout which provably
   * never broadcast can be told apart from one whose broadcast may have
   * landed. Never auto-reverse a `broadcasting` row (§4.5, §4.6).
   */
  status:
    | "pending"
    | "broadcasting"
    | "broadcast"
    | "confirmed"
    | "failed"
    | string;
  tx_hash?: string;
  to_address?: string;
  amount?: string;
}

export interface WithdrawalDestination {
  id: string;
  network: string;
  address: string;
  label?: string;
  /** `cooldown` for the first 24h after whitelisting, then `active`. */
  status: "cooldown" | "active" | "disabled" | string;
  /**
   * When the destination leaves its cooldown and can actually be paid to.
   *
   * The live API returns `active_at`; `usable_at` was what their integration
   * page described. Both are accepted because only one of them is real and it
   * is not the documented one — reading the wrong name silently yielded
   * `undefined`, so Oro treated a destination in cooldown as ready to use.
   */
  active_at?: string;
  usable_at?: string;
}

export interface Withdrawal {
  id: string;
  /** Nine states. Only `completed` means the user has been paid. */
  status:
    | "requested"
    | "pending_approval"
    | "approved"
    | "broadcasting"
    | "confirming"
    | "completed"
    | "rejected"
    | "failed"
    | "cancelled"
    | string;
  amount?: string;
  currency?: string;
  network?: string;
  destination_id?: string;
  tx_hash?: string;
  failure_reason?: string;
}

/**
 * Whether two addresses are the same address.
 *
 * EVM addresses are hex and case-insensitive — the mixed case is only an
 * EIP-55 checksum — so a byte comparison would miss a match that 21 Pay
 * considers a duplicate. Tron's base58 is case-sensitive and must not be
 * folded.
 */
function sameAddress(a: string, b: string, network: CryptoNetwork): boolean {
  if (network === CryptoNetwork.TRON) return a === b;
  return a.toLowerCase() === b.toLowerCase();
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** 21 Pay signs `t=<timestamp>.<rawBody>`; reject deliveries older than this. */
const WEBHOOK_TOLERANCE_SEC = 300;

@Injectable()
export class TwentyOnePayClient {
  private readonly logger = new Logger(TwentyOnePayClient.name);

  constructor(private readonly config: ConfigService) {}

  get baseUrl(): string {
    return (
      this.config.get<string>("TWENTYONE_PAY_BASE_URL") ??
      "https://21pay.tech.bt/v1"
    ).replace(/\/+$/, "");
  }

  /**
   * Chains enabled for this deployment. There is no default network: every
   * call names its chain explicitly, because a default is how a user is handed
   * a Tron address for a Base transfer — an unrecoverable send.
   *
   * Throws at first access if the env var names an unsupported chain.
   */
  get enabledNetworks(): CryptoNetwork[] {
    return parseEnabledNetworks(
      this.config.get<string>("TWENTYONE_PAY_NETWORKS"),
    );
  }

  isNetworkEnabled(network: CryptoNetwork): boolean {
    return this.enabledNetworks.includes(network);
  }

  get intentTtlMinutes(): number {
    const raw = Number(
      this.config.get<string>("TWENTYONE_PAY_INTENT_TTL_MINUTES"),
    );
    return Number.isFinite(raw) && raw > 0 ? raw : 30;
  }

  get enabled(): boolean {
    return this.config.get<string>("USDT_ENABLED") === "true";
  }

  private get apiKey(): string {
    // TWENTY_ONE_PAY_API is the pre-existing name in .env and holds the bearer
    // token; kept as a fallback so the rail works without re-configuring.
    const key =
      this.config.get<string>("TWENTYONE_PAY_API_KEY") ||
      this.config.get<string>("TWENTY_ONE_PAY_API");
    if (!key) {
      throw new ServiceUnavailableException(
        "Twenty-one Pay API key is not configured (TWENTYONE_PAY_API_KEY or TWENTY_ONE_PAY_API)",
      );
    }
    return key;
  }

  private assertNetworkEnabled(network: CryptoNetwork): void {
    if (!this.isNetworkEnabled(network)) {
      throw new ServiceUnavailableException(
        `Network ${network} is not enabled for this deployment`,
      );
    }
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        // Never log the request body — it is not secret, but the Authorization
        // header and any provider echo of it must not reach the logs.
        this.logger.error(
          `[21pay] ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`,
        );
        const failure = new ServiceUnavailableException(
          `Twenty-one Pay ${method} ${path} failed with ${res.status}`,
        );
        (failure as Error & { upstreamStatus?: number }).upstreamStatus =
          res.status;
        throw failure;
      }
      return (text ? JSON.parse(text) : {}) as T;
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new ServiceUnavailableException(
          `Twenty-one Pay ${method} ${path} timed out after ${DEFAULT_TIMEOUT_MS}ms`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Create a deposit intent. `amountBaseUnits` is a decimal string in USDT
   * smallest units (6 dp) — "1000000" is 1.00 USDT. Never pass a JS number
   * here; float rounding at 6 dp is a real loss of funds.
   *
   * `idempotencyKey` should be the local Payment row id so a retry after a
   * network blip returns the same intent instead of minting a second one.
   */
  createPaymentIntent(params: {
    idempotencyKey: string;
    network: CryptoNetwork;
    amountBaseUnits: string;
    expiresAt: Date;
  }): Promise<PaymentIntent> {
    this.assertNetworkEnabled(params.network);
    return this.request<PaymentIntent>("POST", "/payment-intents", {
      idempotency_key: params.idempotencyKey,
      network: params.network,
      amount: params.amountBaseUnits,
      currency: "USDT",
      expires_at: params.expiresAt.toISOString(),
    });
  }

  /**
   * Top up an underpaid or expired intent.
   *
   * Creates a **child** intent reusing the parent's derived address, with the
   * remainder computed engine-side. The child carries its own credit; the
   * parent only ever gets marked `completed_via_topup`, which is signalling.
   */
  createTopup(params: {
    intentId: string;
    idempotencyKey: string;
  }): Promise<PaymentIntent> {
    return this.request<PaymentIntent>(
      "POST",
      `/payment-intents/${encodeURIComponent(params.intentId)}/topup`,
      { idempotency_key: params.idempotencyKey },
    );
  }

  getPaymentIntent(intentId: string): Promise<PaymentIntent> {
    return this.request<PaymentIntent>(
      "GET",
      `/payment-intents/${encodeURIComponent(intentId)}`,
    );
  }

  // ── Withdrawals, not payouts ───────────────────────────────────────────────
  //
  // `POST /v1/payouts` is operator-only: it takes a raw `from_address` +
  // `key_handle` with no ownership binding, so the engine 403s a merchant
  // token with "raw payouts are operator-only; withdraw via /v1/withdrawals".
  // We are never meant to name a wallet, and would never be issued a key
  // handle.
  //
  // The merchant contract is `/v1/withdrawal-destinations` and
  // `/v1/withdrawals`, with whitelisting, a 24h destination cooldown, a
  // velocity cap and maker-checker approval all enforced engine-side. Those
  // methods land in Stage F. They are absent rather than stubbed on purpose —
  // a dead method on the money path is worse than a missing one.
  //
  // See docs/usdt-oro/21PAY-ANSWERS.md §4.

  /**
   * Networks the engine knows about, and whether ours are switched on.
   *
   * `status: "available"` means the engine supports the chain; `activated:
   * true` means **our tenant** has an xpub registered and a watcher running.
   * Only the second is safe to offer a user — an address derived on a chain
   * nobody is watching takes the deposit and never credits it.
   */
  listNetworks(): Promise<{
    networks: {
      network: string;
      status: string;
      activated: boolean;
      confirmations?: number;
      gas_token?: string;
      usdt_contract?: string;
    }[];
  }> {
    return this.request("GET", "/networks");
  }

  /** Whitelist a payout address. Starts in 24h cooldown, engine-side. */
  async createWithdrawalDestination(params: {
    network: CryptoNetwork;
    address: string;
    label?: string;
  }): Promise<WithdrawalDestination> {
    this.assertNetworkEnabled(params.network);
    try {
      return await this.request<WithdrawalDestination>(
        "POST",
        "/withdrawal-destinations",
        {
          network: params.network,
          address: params.address,
          label: params.label,
        },
      );
    } catch (err) {
      const status = (err as Error & { upstreamStatus?: number })
        .upstreamStatus;
      if (status !== 409) throw err;

      const existing = (await this.listWithdrawalDestinations()).find(
        (d) =>
          d.network === params.network &&
          sameAddress(d.address, params.address, params.network),
      );
      if (!existing) throw err;

      this.logger.log(
        "[21pay] Destination already registered on their side; adopting it.",
      );
      return existing;
    }
  }

  async listWithdrawalDestinations(): Promise<WithdrawalDestination[]> {
    const res = await this.request<
      WithdrawalDestination[] | { items?: WithdrawalDestination[] }
    >("GET", "/withdrawal-destinations");
    return Array.isArray(res) ? res : (res.items ?? []);
  }

  /**
   * Request a withdrawal to a whitelisted destination.
   *
   * The engine checks the balance and debits atomically with the send, so the
   * same balance cannot be withdrawn twice. It may land in `pending_approval`
   * if the amount is over our tenant's auto-approve limit.
   */
  createWithdrawal(params: {
    idempotencyKey: string;
    destinationId: string;
    amountBaseUnits: string;
    network: string;
    /**
     * Who asked for the money — the Oro user, not the admin releasing it.
     *
     * Opaque to 21Pay, and deliberately the requester: their side runs its own
     * maker-checker, and naming the approver here would collapse the two roles
     * into one.
     */
    requestedBy: string;
  }): Promise<Withdrawal> {

    return this.request<Withdrawal>("POST", "/withdrawals", {
      idempotency_key: params.idempotencyKey,
      destination_id: params.destinationId,
      amount: params.amountBaseUnits,
      currency: "USDT",
      network: params.network,
      requested_by: params.requestedBy,
    });
  }

  /**
   * Read withdrawal state.
   *
   * This is the only way to learn it: withdrawals are **not** in the webhook
   * fan-out (§3.7), so polling is the mechanism rather than a safety net.
   */
  getWithdrawal(withdrawalId: string): Promise<Withdrawal> {
    return this.request<Withdrawal>(
      "GET",
      `/withdrawals/${encodeURIComponent(withdrawalId)}`,
    );
  }

  cancelWithdrawal(withdrawalId: string): Promise<Withdrawal> {
    return this.request<Withdrawal>(
      "POST",
      `/withdrawals/${encodeURIComponent(withdrawalId)}/cancel`,
    );
  }

  /**
   * Verify a Twenty-one Pay webhook signature.
   *
   * Signed payload is exactly `"t=" + timestamp + "." + rawBody`, HMAC-SHA256,
   * hex-encoded, compared in constant time.
   *
   * NOTE: this deliberately does not use the provider's sample verbatim —
   * `timingSafeEqual` throws on length mismatch, so a short/garbage signature
   * would raise instead of returning false. Length and shape are checked first.
   */
  verifyWebhook(
    headers: Record<string, unknown>,
    rawBody: Buffer | undefined,
    nowMs: number = Date.now(),
  ): boolean {
    const secret = this.config.get<string>("TWENTYONE_PAY_WEBHOOK_SECRET");
    if (!secret) {
      this.logger.error(
        "[21pay] TWENTYONE_PAY_WEBHOOK_SECRET is not configured — rejecting webhook",
      );
      return false;
    }
    if (!rawBody || rawBody.length === 0) {
      this.logger.warn("[21pay] webhook rejected: raw body unavailable");
      return false;
    }

    const first = (v: unknown): string | undefined =>
      Array.isArray(v) ? (v[0] as string) : (v as string | undefined);
    const ts = first(headers["x-t1pay-timestamp"]);
    const sig = first(headers["x-t1pay-signature"]);
    if (!ts || !sig) return false;

    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) return false;
    if (Math.abs(nowMs / 1000 - tsNum) > WEBHOOK_TOLERANCE_SEC) {
      this.logger.warn("[21pay] webhook rejected: timestamp outside tolerance");
      return false;
    }

    const expected = crypto
      .createHmac("sha256", secret)
      .update(`t=${ts}.`)
      .update(rawBody)
      .digest();

    // Constant-time compare requires equal lengths; check shape first so a
    // malformed signature is a clean reject rather than a thrown exception.
    if (!/^[0-9a-f]+$/i.test(sig) || sig.length !== expected.length * 2) {
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(sig, "hex"), expected);
  }
}
