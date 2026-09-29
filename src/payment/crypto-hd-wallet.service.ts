import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { User } from "../entities/user.entity";
import { UserNotification } from "../entities/user-notification.entity";
import { CryptoPaymentIntent } from "../entities/crypto-payment-intent.entity";
import {
  CryptoDepositAddress,
  CryptoHdDeposit,
} from "../entities/crypto-hd-wallet.entity";
import { usdtIdentityVerified } from "../shared/utils/wallet.util";
import { TwentyOnePayClient } from "./services/twentyone-pay/twentyone-pay.client";
import {
  CryptoNetwork,
  isCryptoNetwork,
} from "./services/twentyone-pay/twentyone-pay.types";
import { fromBaseUnits } from "./usdt.util";
import { writeUsdtDepositCredit } from "./usdt-deposit-credit";
import { EXPLORER_TX } from "./crypto-deposit.service";

/**
 * Networks with permanent addresses. Tron only for now: it is the only chain
 * 21 Pay's HD contract covers ("other chains come later").
 */
export const HD_NETWORKS: ReadonlySet<CryptoNetwork> = new Set([
  CryptoNetwork.TRON,
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The fields of a `deposits.<net>.credited` body that we act on. */
export interface HdCreditedEvent {
  intentId: string;
  endUserId: string;
  network: string;
  /** Base units, as sent. What the customer sent — not `net_amount`. */
  amountBaseUnits: string;
  depositAddress?: string | null;
  txHash?: string | null;
  blockNumber?: string | null;
  fee?: string | null;
  netAmount?: string | null;
}

export interface HdCreditOutcome {
  handled: boolean;
  credited: boolean;
  reason?: string;
}

export interface DepositAddressView {
  network: string;
  depositAddress: string;
  createdAt: Date;
}

export interface HdDepositView {
  id: string;
  network: string;
  amountUsdt: string;
  txHash: string | null;
  explorerUrl: string | null;
  status: "credited" | "in_review";
  createdAt: Date;
}

/**
 * Single HD wallet deposits: permanent addresses, and crediting them.
 *
 * Contract: docs/usdt-oro/21PAY-HD-WALLET-CONTRACT.md. The one rule that
 * matters: credit `amount` to `end_user_id` on `deposits.<net>.credited`,
 * once per `intent_id`, and act on no other deposit event.
 */
@Injectable()
export class CryptoHdWalletService {
  private readonly logger = new Logger(CryptoHdWalletService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(CryptoDepositAddress)
    private readonly addressRepo: Repository<CryptoDepositAddress>,
    @InjectRepository(CryptoHdDeposit)
    private readonly depositRepo: Repository<CryptoHdDeposit>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(UserNotification)
    private readonly userNotifRepo: Repository<UserNotification>,
    private readonly client: TwentyOnePayClient,
    private readonly config: ConfigService,
  ) {}

  // ── Addresses ──────────────────────────────────────────────────────────────

  /**
   * The user's permanent address, fetched from 21 Pay the first time and read
   * from our table afterwards.
   *
   * Same identity gate as invoice deposits: an address is only handed to a
   * verified account. Once handed out it accepts money forever, so the gate
   * has to be here rather than at credit time.
   */
  async getDepositAddress(
    userId: string,
    rawNetwork: string = CryptoNetwork.TRON,
  ): Promise<DepositAddressView> {
    if (!this.client.enabled) {
      throw new ServiceUnavailableException(
        "USDT deposits are not enabled on this deployment",
      );
    }

    const network = String(rawNetwork ?? "").toLowerCase();
    if (!isCryptoNetwork(network) || !HD_NETWORKS.has(network)) {
      throw new BadRequestException(`Unsupported network "${rawNetwork}"`);
    }
    if (!this.client.isNetworkEnabled(network)) {
      throw new BadRequestException(
        `${network} deposits are not available right now`,
      );
    }

    const existing = await this.addressRepo.findOneBy({ userId, network });
    if (existing) return this.toAddressView(existing);

    const user = await this.userRepo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException("User not found");
    if (!usdtIdentityVerified(user)) {
      throw new ForbiddenException(
        "Your identity check must be approved before you can deposit",
      );
    }

    const remote = await this.client.getOrCreateCustomerDepositAddress({
      endUserId: userId,
      network,
    });
    if (!remote?.deposit_address) {
      throw new ServiceUnavailableException(
        "Twenty-one Pay returned no deposit address",
      );
    }

    // Two tabs opening the deposit screen at once both reach here. 21 Pay
    // returns the same address to both; the unique index keeps one row.
    await this.addressRepo
      .createQueryBuilder()
      .insert()
      .into(CryptoDepositAddress)
      .values({ userId, network, address: remote.deposit_address })
      .orIgnore()
      .execute();

    const row = await this.addressRepo.findOneBy({ userId, network });
    if (!row) {
      throw new ServiceUnavailableException("Could not save deposit address");
    }
    if (row.address !== remote.deposit_address) {
      // 21 Pay promises the same address on every call. If it ever changes,
      // the old one may still receive money, so this must be loud.
      this.logger.error(
        `[USDT-HD] 21 Pay returned a different address for user ${userId} ` +
          `on ${network} than the one stored — keeping the stored one`,
      );
    }

    this.logger.log(`[USDT-HD] Address issued on ${network} for user ${userId}`);
    return this.toAddressView(row);
  }

  async listDeposits(userId: string, limit = 20): Promise<HdDepositView[]> {
    const rows = await this.depositRepo.find({
      where: { userId },
      order: { createdAt: "DESC" },
      take: Math.min(Math.max(limit, 1), 100),
    });
    return rows.map((r) => this.toDepositView(r));
  }

  // ── Crediting ──────────────────────────────────────────────────────────────

  /**
   * Parse a `credited` body. Returns null for an invoice payment (no
   * `end_user_id`), which the invoice flow handles as before.
   */
  static parseCreditedEvent(
    payload: Record<string, any>,
  ): HdCreditedEvent | null {
    const endUserId = payload?.end_user_id;
    if (endUserId === undefined || endUserId === null || endUserId === "") {
      return null;
    }
    return {
      intentId: String(payload?.intent_id ?? ""),
      endUserId: String(endUserId),
      network: String(payload?.network ?? "").toLowerCase(),
      amountBaseUnits: String(payload?.amount ?? ""),
      depositAddress: payload?.deposit_address ?? null,
      txHash: payload?.tx_hash ?? null,
      blockNumber:
        payload?.block_number != null ? String(payload.block_number) : null,
      fee: payload?.fee != null ? String(payload.fee) : null,
      netAmount: payload?.net_amount != null ? String(payload.net_amount) : null,
    };
  }

  /**
   * Credit one HD deposit, exactly once.
   *
   * Nothing here throws for a bad or unattributable event: a retry cannot fix
   * the payload or conjure the user, and a 5xx would only burn 21 Pay's ~32 h
   * of retries. Those return `handled: false` with a reason, and the webhook
   * row keeps the evidence. A thrown error is reserved for our own failures
   * (database down), where the retry is exactly what we want.
   */
  async credit(event: HdCreditedEvent): Promise<HdCreditOutcome> {
    const invalid = this.validate(event);
    if (invalid) {
      this.logger.error(
        `[USDT-HD] credited event for intent ${event.intentId || "?"} ` +
          `rejected: ${invalid}`,
      );
      return { handled: false, credited: false, reason: invalid };
    }

    const amount = Number(fromBaseUnits(event.amountBaseUnits));
    const credited: { userId: string | null } = { userId: null };

    const outcome = await this.dataSource.transaction(async (em) => {
      // An invoice intent already credits on `confirmed`. 21 Pay says invoice
      // payments carry no `end_user_id`, so this should never match — but if
      // it does, the invoice path owns it.
      const invoice = await em.findOne(CryptoPaymentIntent, {
        where: { pay21IntentId: event.intentId },
      });
      if (invoice) {
        return { handled: true, credited: false, reason: "invoice_intent" };
      }

      const user = await em.findOne(User, { where: { id: event.endUserId } });
      const owner = event.depositAddress
        ? await em.findOne(CryptoDepositAddress, {
            where: { network: event.network, address: event.depositAddress },
          })
        : null;

      let unattributable: string | null = null;
      if (!user) unattributable = "unknown_customer";
      else if (owner && owner.userId !== user.id) {
        unattributable = "address_mismatch";
      }

      const overMax = amount > this.maxDeposit();
      const inserted = await em
        .createQueryBuilder()
        .insert()
        .into(CryptoHdDeposit)
        .values({
          pay21IntentId: event.intentId,
          userId: unattributable ? null : user!.id,
          network: event.network,
          depositAddress: event.depositAddress ?? null,
          amountUsdt: amount,
          txHash: event.txHash ?? null,
          blockNumber: event.blockNumber ?? null,
          needsReview: Boolean(unattributable) || overMax,
          reviewReason: unattributable ?? (overMax ? "over_max_deposit" : null),
        })
        .orIgnore()
        .returning(["id"])
        .execute();

      const depositId: string | undefined = inserted.raw?.[0]?.id;
      if (!depositId) {
        // The unique index on pay21IntentId. A concurrent duplicate waits on
        // it and lands here once the first delivery commits.
        return { handled: true, credited: false, reason: "duplicate" };
      }

      if (unattributable) {
        // Money we hold that belongs to no one we can name. Recorded for an
        // admin; crediting a guess would be worse.
        this.logger.error(
          `[USDT-HD] ${amount} USDT for intent ${event.intentId} NOT credited: ` +
            `${unattributable} (end_user_id ${event.endUserId})`,
        );
        return { handled: false, credited: false, reason: unattributable };
      }

      const { paymentId, transactionId } = await writeUsdtDepositCredit(em, {
        userId: user!.id,
        amount,
        externalPaymentId: event.intentId,
        network: event.network,
        metadata: {
          source: "hd_wallet",
          txHash: event.txHash ?? null,
          depositAddress: event.depositAddress ?? null,
          fee: event.fee ?? null,
          netAmount: event.netAmount ?? null,
        },
      });

      await em.update(
        CryptoHdDeposit,
        { id: depositId },
        { paymentId, transactionId, creditedAt: new Date() },
      );

      if (overMax) {
        // Credited all the same: a permanent address cannot refuse an amount,
        // and holding money that has arrived strands it (Stage J, D3).
        this.logger.warn(
          `[USDT-HD] ${amount} USDT for user ${user!.id} is over the ` +
            `${this.maxDeposit()} USDT limit — credited, flagged for review`,
        );
      }

      credited.userId = user!.id;
      this.logger.log(
        `[USDT-HD] Credited ${amount} USDT to user ${user!.id} ` +
          `for intent ${event.intentId}`,
      );
      return { handled: true, credited: true };
    });

    if (credited.userId) {
      this.notifyDeposit(credited.userId, amount, event.network);
    }
    return outcome;
  }

  private validate(event: HdCreditedEvent): string | null {
    if (!event.intentId || event.intentId.length > 64) return "invalid_intent_id";
    // Our end_user_id is always a user uuid; anything else is not ours and
    // must not reach a uuid column, where Postgres would throw.
    if (!UUID_RE.test(event.endUserId)) return "unknown_customer";
    if (!isCryptoNetwork(event.network)) return "invalid_network";
    if (!/^\d+$/.test(event.amountBaseUnits) || /^0+$/.test(event.amountBaseUnits)) {
      return "invalid_amount";
    }
    return null;
  }

  private maxDeposit(): number {
    return Number(this.config.get("USDT_MAX_DEPOSIT", "1000"));
  }

  /** Never on the credit transaction, and never throwing. */
  private notifyDeposit(userId: string, amount: number, network: string): void {
    void this.userNotifRepo
      .save(
        this.userNotifRepo.create({
          userId,
          type: "transaction",
          title: "Deposit received",
          body: `${amount} USDT was added to your balance.`,
          metadata: { kind: "deposit", currency: "USDT", amount, network },
        }),
      )
      .catch((err: any) =>
        this.logger.warn(
          `[Notify] USDT deposit notification failed for ${userId}: ${err.message}`,
        ),
      );
  }

  private toAddressView(row: CryptoDepositAddress): DepositAddressView {
    return {
      network: row.network,
      depositAddress: row.address,
      createdAt: row.createdAt,
    };
  }

  private toDepositView(row: CryptoHdDeposit): HdDepositView {
    const explorer = EXPLORER_TX[row.network as CryptoNetwork];
    return {
      id: row.id,
      network: row.network,
      amountUsdt: String(row.amountUsdt),
      txHash: row.txHash,
      explorerUrl: row.txHash && explorer ? `${explorer}${row.txHash}` : null,
      status: row.creditedAt ? "credited" : "in_review",
      createdAt: row.createdAt,
    };
  }
}
