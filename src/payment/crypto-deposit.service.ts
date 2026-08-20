import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { Repository } from "typeorm";
import { User, KycStatus } from "../entities/user.entity";
import { usdtIdentityVerified } from "../shared/utils/wallet.util";
import {
  CryptoIntentStatus,
  CryptoPaymentIntent,
} from "../entities/crypto-payment-intent.entity";
import { TwentyOnePayClient } from "./services/twentyone-pay/twentyone-pay.client";
import {
  CryptoNetwork,
  isCryptoNetwork,
} from "./services/twentyone-pay/twentyone-pay.types";
import { fromBaseUnits, toBaseUnits, USDT_DECIMALS } from "./usdt.util";

/** How long to trust 21Pay's activation list. Activation changes ~never. */
const NETWORK_CACHE_MS = 5 * 60_000;

/**
 * Display copy per chain, owned by the backend.
 *
 * The network must be shown spelled out and never as a chain id: all three EVM
 * chains share the `0x` address format, so the name is the only thing standing
 * between a user and an unrecoverable wrong-chain send.
 */
const NETWORK_DISPLAY: Record<CryptoNetwork, DepositNetworkView> = {
  [CryptoNetwork.TRON]: {
    id: "tron",
    name: "Tron (TRC-20)",
    confirmationHint: "Usually about a minute",
    warning:
      "Sending TRC-20 USDT needs a small amount of TRX for network fees. " +
      "If your wallet holds only USDT, the transfer will not go through.",
  },
  [CryptoNetwork.BASE]: {
    id: "base",
    name: "Base network",
    confirmationHint: "Usually under a minute",
    warning: null,
  },
  [CryptoNetwork.POLYGON]: {
    id: "polygon",
    name: "Polygon network",
    confirmationHint: "Usually a couple of minutes",
    warning: null,
  },
  [CryptoNetwork.ARBITRUM]: {
    id: "arbitrum",
    name: "Arbitrum network",
    confirmationHint: "Usually under a minute",
    warning: null,
  },
};

/** Explorer bases, so no client maintains a per-chain URL table. */
const EXPLORER_TX: Record<CryptoNetwork, string> = {
  [CryptoNetwork.TRON]: "https://tronscan.org/#/transaction/",
  [CryptoNetwork.BASE]: "https://basescan.org/tx/",
  [CryptoNetwork.POLYGON]: "https://polygonscan.com/tx/",
  [CryptoNetwork.ARBITRUM]: "https://arbiscan.io/tx/",
};

/**
 * What the client needs to render a network picker.
 *
 * Everything here is display copy the backend owns, so no client maintains a
 * per-chain table that can drift from what the rail actually supports.
 */
export interface DepositNetworkView {
  id: string;
  /** Spelled out, never a chain id. "Base network", not "8453". */
  name: string;
  /** Roughly how long a deposit takes to confirm, in human terms. */
  confirmationHint: string;
  /**
   * Set where the sender needs a gas token they may not hold.
   *
   * A TRC-20 transfer burns ~13-30 TRX in energy unless the sender has staked.
   * Someone holding only USDT and zero TRX cannot send at all — the single
   * most common Tron support issue, and one line of copy pre-empts it.
   */
  warning: string | null;
}

export interface DepositIntentView {
  intentId: string;
  network: string;
  depositAddress: string;
  amountUsdt: string;
  amountBaseUnits: string;
  detectedAmountUsdt: string | null;
  status: CryptoIntentStatus;
  expiresAt: Date;
  txHash: string | null;
  explorerUrl: string | null;
}

/**
 * Creating and reading USDT deposit intents.
 *
 * 21Pay derives a fresh address per intent from our xpub, watches the chain,
 * and tells us what arrived. This service owns everything on our side of that:
 * who is allowed to ask, for how much, and the local row settlement will later
 * attach a credit to.
 *
 * Crediting lives in the settlement service, not here. Nothing in this file
 * moves money.
 */
@Injectable()
export class CryptoDepositService {
  private readonly logger = new Logger(CryptoDepositService.name);
  private networkCache: { at: number; value: DepositNetworkView[] } | null =
    null;

  constructor(
    @InjectRepository(CryptoPaymentIntent)
    private readonly intentRepo: Repository<CryptoPaymentIntent>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly client: TwentyOnePayClient,
    private readonly config: ConfigService,
  ) {}

  /**
   * Networks a user may actually deposit on.
   *
   * The intersection of what we have configured and what 21Pay reports as
   * `activated` for our tenant. Config alone is not enough: a chain listed in
   * `TWENTYONE_PAY_NETWORKS` but not activated at 21Pay has no watcher, so a
   * deposit to its derived address is simply lost. Offering it would be worse
   * than offering nothing.
   *
   * Cached briefly — the picker is on a hot path and activation changes about
   * never. If 21Pay is unreachable we return nothing rather than falling back
   * to config, because the failure mode of guessing is an unrecoverable
   * deposit.
   */
  async availableNetworks(): Promise<DepositNetworkView[]> {
    this.assertEnabled();

    const fresh =
      this.networkCache &&
      Date.now() - this.networkCache.at < NETWORK_CACHE_MS;
    if (fresh) return this.networkCache!.value;

    const configured = new Set(this.client.enabledNetworks as string[]);
    let activated: Set<string>;
    try {
      const { networks } = await this.client.listNetworks();
      activated = new Set(
        networks.filter((n) => n.activated).map((n) => n.network),
      );
    } catch (err) {
      this.logger.error(
        `[USDT] Could not read activated networks from 21Pay: ` +
          `${(err as Error).message}. Offering none.`,
      );
      return [];
    }

    const usable = [...configured].filter((n) => activated.has(n));
    const dropped = [...configured].filter((n) => !activated.has(n));
    if (dropped.length) {
      // Loud: somebody configured a chain 21Pay is not watching for us.
      this.logger.warn(
        `[USDT] Configured but not activated at 21Pay, withheld from users: ` +
          dropped.join(", "),
      );
    }

    const value = usable.map((id) => NETWORK_DISPLAY[id as CryptoNetwork]);
    this.networkCache = { at: Date.now(), value };
    return value;
  }

  private assertEnabled(): void {
    if (!this.client.enabled) {
      throw new ServiceUnavailableException(
        "USDT deposits are not enabled on this deployment",
      );
    }
  }

  /**
   * The floor we enforce, because **21Pay enforces none**.
   *
   * A deposit worth less than the gas to sweep it costs us money to accept, so
   * ours is the only thing standing between the product and dust. Per chain,
   * because sweep costs differ by an order of magnitude between Tron and an L2.
   */
  private minDeposit(): number {
    return Number(this.config.get("USDT_MIN_DEPOSIT", "1"));
  }

  private maxDeposit(): number {
    return Number(this.config.get("USDT_MAX_DEPOSIT", "1000"));
  }

  private ttlMinutes(): number {
    return this.client.intentTtlMinutes;
  }

  /**
   * Create a deposit intent.
   *
   * Guards run before anything is sent to 21Pay: a rejected request should
   * never burn an HD derivation index.
   */
  async createIntent(
    userId: string,
    input: { network: string; amountUsdt: string; clientRequestId: string },
  ): Promise<DepositIntentView> {
    this.assertEnabled();

    const user = await this.userRepo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException("User not found");

    // Who may fund a USDT wallet: an approved document, or a linked DK Bank
    // account, which is national identity verified by a bank and strictly
    // stronger evidence than a photographed passport.
    //
    // This is no longer "is this a USDT account". A Bhutanese account holds
    // ngultrum natively and may hold a USDT wallet beside it — the two never
    // mix, and depositing here cannot touch a BTN balance, because the credit
    // is written with `currency = 'USDT'` and every BTN sum is scoped.
    if (!usdtIdentityVerified(user)) {
      throw new ForbiddenException(
        "Your identity check must be approved before you can deposit",
      );
    }

    const network = String(input.network ?? "").toLowerCase();
    if (!isCryptoNetwork(network)) {
      throw new BadRequestException(`Unsupported network "${input.network}"`);
    }
    if (!this.client.isNetworkEnabled(network)) {
      throw new BadRequestException(
        `${network} deposits are not available right now`,
      );
    }

    const amount = this.parseAmount(input.amountUsdt);

    if (!input.clientRequestId?.trim()) {
      throw new BadRequestException("clientRequestId is required");
    }
    // Server-side, from the client's per-attempt id: a retry replays rather
    // than minting a second intent and burning another derivation index.
    const idempotencyKey = `intent:${userId}:${input.clientRequestId.trim()}`;

    const existing = await this.intentRepo.findOneBy({ idempotencyKey });
    if (existing) return this.toView(existing);

    const expiresAt = new Date(Date.now() + this.ttlMinutes() * 60_000);
    // The engine does not check that expiry is in the future; a past timestamp
    // is accepted and then expires on the next tick, leaving the user an
    // address they can never successfully pay.
    if (expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException("Intent expiry must be in the future");
    }

    const created = await this.client.createPaymentIntent({
      idempotencyKey,
      network,
      amountBaseUnits: toBaseUnits(amount),
      expiresAt,
    });

    // Written only after 21Pay accepts. The idempotency key makes a retry
    // safe, whereas an orphan local row is harder to clean up than a repeated
    // call.
    const row = await this.intentRepo.save(
      this.intentRepo.create({
        userId,
        pay21IntentId: created.id,
        network,
        depositAddress: created.deposit_address,
        derivationIndex: null,
        amountUsdt: Number(amount),
        status: this.mapStatus(created.status),
        idempotencyKey,
        expiresAt: created.expires_at ? new Date(created.expires_at) : expiresAt,
      }),
    );

    this.logger.log(
      `[USDT] Intent ${created.id} created on ${network} for user ${userId}`,
    );
    return this.toView(row);
  }

  /**
   * Top up an underpaid or expired intent.
   *
   * Built now rather than later because underpayment will be common: exchange
   * withdrawals sometimes deduct the network fee from the amount sent, and
   * users typing figures by hand get them wrong. Without this, every one of
   * those is a support ticket and a stranded balance.
   *
   * The child settles independently and carries its own credit. The parent is
   * only ever marked `completed_via_topup`, which is signalling — crediting it
   * would pay twice.
   */
  async createTopup(
    userId: string,
    intentId: string,
    clientRequestId: string,
  ): Promise<DepositIntentView> {
    this.assertEnabled();

    const parent = await this.requireOwned(userId, intentId);
    const toppable = [
      CryptoIntentStatus.CONFIRMED_PARTIAL,
      CryptoIntentStatus.EXPIRED,
    ];
    if (!toppable.includes(parent.status)) {
      throw new BadRequestException(
        "This deposit cannot be topped up",
      );
    }

    const idempotencyKey = `topup:${userId}:${clientRequestId?.trim()}`;
    const existing = await this.intentRepo.findOneBy({ idempotencyKey });
    if (existing) return this.toView(existing);

    const child = await this.client.createTopup({
      intentId: parent.pay21IntentId,
      idempotencyKey,
    });

    const row = await this.intentRepo.save(
      this.intentRepo.create({
        userId,
        pay21IntentId: child.id,
        network: parent.network,
        // The child reuses the parent's derived address, so a user who already
        // sent to it can simply send again.
        depositAddress: child.deposit_address ?? parent.depositAddress,
        amountUsdt: child.amount
          ? Number(fromBaseUnits(child.amount))
          : Number(parent.amountUsdt),
        status: this.mapStatus(child.status),
        parentIntentId: parent.pay21IntentId,
        idempotencyKey,
        expiresAt: child.expires_at
          ? new Date(child.expires_at)
          : new Date(Date.now() + this.ttlMinutes() * 60_000),
      }),
    );
    return this.toView(row);
  }

  async getIntent(userId: string, intentId: string): Promise<DepositIntentView> {
    return this.toView(await this.requireOwned(userId, intentId));
  }

  async listIntents(
    userId: string,
    limit = 20,
  ): Promise<DepositIntentView[]> {
    const rows = await this.intentRepo.find({
      where: { userId },
      order: { createdAt: "DESC" },
      take: Math.min(limit, 100),
    });
    return rows.map((r) => this.toView(r));
  }

  private async requireOwned(
    userId: string,
    intentId: string,
  ): Promise<CryptoPaymentIntent> {
    const row = await this.intentRepo.findOneBy({ id: intentId });
    // Same response for "not yours" as for "does not exist": otherwise the
    // route confirms which intent ids are real.
    if (!row || row.userId !== userId) {
      throw new NotFoundException("Deposit not found");
    }
    return row;
  }

  /**
   * Parse and validate a human USDT amount.
   *
   * Rejects anything that cannot be represented exactly at 6dp rather than
   * truncating it. A truncated expectation never equals the detected amount,
   * so every such deposit would land as `confirmed_partial` — a support ticket
   * manufactured at validation time.
   */
  private parseAmount(raw: string): string {
    const s = String(raw ?? "").trim();
    if (!/^\d+(\.\d+)?$/.test(s)) {
      throw new BadRequestException("Enter a valid amount");
    }
    const decimals = s.split(".")[1]?.length ?? 0;
    if (decimals > USDT_DECIMALS) {
      throw new BadRequestException(
        `USDT supports at most ${USDT_DECIMALS} decimal places`,
      );
    }
    const value = Number(s);
    if (value < this.minDeposit()) {
      throw new BadRequestException(
        `Minimum deposit is ${this.minDeposit()} USDT`,
      );
    }
    if (value > this.maxDeposit()) {
      throw new BadRequestException(
        `Maximum deposit is ${this.maxDeposit()} USDT`,
      );
    }
    return s;
  }

  /** Unknown statuses are not silently dropped — they are a contract change. */
  private mapStatus(raw: string | undefined): CryptoIntentStatus {
    const known = Object.values(CryptoIntentStatus) as string[];
    if (raw && known.includes(raw)) return raw as CryptoIntentStatus;
    this.logger.error(
      `[USDT] Unrecognised intent status from 21Pay: "${raw}". ` +
        `Treating as awaiting_deposit; this needs a code change.`,
    );
    return CryptoIntentStatus.AWAITING_DEPOSIT;
  }

  private toView(row: CryptoPaymentIntent): DepositIntentView {
    const net = row.network as CryptoNetwork;
    return {
      intentId: row.id,
      network: row.network,
      depositAddress: row.depositAddress,
      amountUsdt: String(row.amountUsdt),
      amountBaseUnits: toBaseUnits(String(row.amountUsdt)),
      detectedAmountUsdt:
        row.detectedAmountUsdt === null || row.detectedAmountUsdt === undefined
          ? null
          : String(row.detectedAmountUsdt),
      status: row.status,
      expiresAt: row.expiresAt,
      txHash: row.txHash,
      explorerUrl:
        row.txHash && EXPLORER_TX[net]
          ? `${EXPLORER_TX[net]}${row.txHash}`
          : null,
    };
  }
}
