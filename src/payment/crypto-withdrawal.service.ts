import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { usdtIdentityVerified } from "../shared/utils/wallet.util";
import { ConfigService } from "@nestjs/config";
import {
  DataSource,
  EntityManager,
  In,
  IsNull,
  LessThan,
  LessThanOrEqual,
  Repository,
} from "typeorm";
import { User, KycStatus } from "../entities/user.entity";
import { UserNotification } from "../entities/user-notification.entity";
import {
  Transaction,
  TransactionType,
} from "../entities/transaction.entity";
import {
  CryptoWithdrawal,
  CryptoWithdrawalDestination,
  PayoutKind,
  RemoteWithdrawalStatus,
  TERMINAL_REMOTE_STATUSES,
  WithdrawalApprovalStatus,
  WithdrawalDestinationStatus,
} from "../entities/crypto-withdrawal.entity";
import { TwentyOnePayClient } from "./services/twentyone-pay/twentyone-pay.client";
import {
  CryptoNetwork,
  isCryptoNetwork,
} from "./services/twentyone-pay/twentyone-pay.types";
import { isValidAddressForNetwork, toBaseUnits } from "./usdt.util";
import { ledgerBalance } from "../shared/utils/ledger.util";
import { announceBalanceChange } from "./usdt-deposit-credit";
import { RedisService } from "../redis/redis.service";
import { SseService } from "../sse/sse.service";
import { HD_NETWORKS } from "./crypto-hd-wallet.service";

const USDT = "USDT";

/**
 * Thrown inside restore()'s transaction when another replica already claimed the
 * refund, to roll back this replica's duplicate refund insert. Never escapes
 * restore().
 */
class AlreadyRestoredError extends Error {}

/** Thrown inside reject()'s transaction when someone else decided first. */
class AlreadyDecidedError extends Error {}

/**
 * Upstream statuses that mean 21 Pay refused the request and created nothing,
 * so the withdrawal can safely go back to the approval queue.
 *
 * Deliberately absent: 409 ("idempotency key reused for a different payout")
 * — a payout with our key *exists* — and every 5xx, timeout and network error,
 * where the payout may exist. Those stay approved and are never refundable
 * from the queue.
 */
const DEFINITE_REFUSALS: ReadonlySet<number> = new Set([
  400, 401, 403, 404, 422, 429,
]);

function upstreamStatusOf(err: unknown): number | undefined {
  return (err as Error & { upstreamStatus?: number })?.upstreamStatus;
}

/**
 * USDT withdrawals.
 *
 * 21Pay owns the wallet and enforces whitelisting, a 24h destination cooldown,
 * a velocity cap, an auto-approve limit and maker-checker. Those protect the
 * tenant float. **This service answers a different question: whose money is
 * it.** 21Pay cannot know that, so our approval sits in front of theirs.
 *
 * Money is debited at request and returned by a compensating credit — not held
 * in a `lockedBalance` column, which would reintroduce the stored-balance
 * problem the derived-ledger design exists to avoid.
 *
 * See docs/usdt-oro/STAGE-F-WITHDRAWALS.md.
 */
@Injectable()
export class CryptoWithdrawalService {
  private readonly logger = new Logger(CryptoWithdrawalService.name);

  constructor(
    @InjectRepository(CryptoWithdrawal)
    private readonly withdrawalRepo: Repository<CryptoWithdrawal>,
    @InjectRepository(CryptoWithdrawalDestination)
    private readonly destRepo: Repository<CryptoWithdrawalDestination>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly client: TwentyOnePayClient,
    private readonly config: ConfigService,
    @InjectRepository(UserNotification)
    private readonly userNotifRepo: Repository<UserNotification>,
    private readonly redis: RedisService,
    private readonly sse: SseService,
  ) {}

  /**
   * Fire-and-forget in-app notification, on the default connection and never
   * throwing — a notification failure must never affect a withdrawal or its
   * compensating refund.
   */
  private notifyTransaction(
    userId: string,
    title: string,
    body: string,
    metadata: Record<string, any>,
  ): void {
    void this.userNotifRepo
      .save(
        this.userNotifRepo.create({
          userId,
          type: "transaction",
          title,
          body,
          metadata,
        }),
      )
      .catch((err: any) =>
        this.logger.warn(
          `[Notify] USDT withdrawal notification failed for ${userId}: ${err.message}`,
        ),
      );
  }

  private assertEnabled(): void {
    if (!this.client.enabled) {
      throw new ServiceUnavailableException(
        "USDT withdrawals are not enabled on this deployment",
      );
    }
  }

  private async requireUsdtUser(userId: string): Promise<User> {
    const user = await this.userRepo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException("User not found");
    // Holding a USDT wallet is what matters here, not being a USDT account. A
    // Bhutanese user who deposited USDT must be able to take it back out; the
    // alternative is money that can go in and never come out.
    if (!usdtIdentityVerified(user)) {
      throw new ForbiddenException("This account cannot hold USDT");
    }
    // KYC gates deposit rather than withdrawal by design — refusing to pay
    // someone we already took money from is the worse position. An unapproved
    // account cannot have deposited, so it has nothing to withdraw anyway.
    return user;
  }

  // ── Destinations ───────────────────────────────────────────────────────────

  /**
   * Whitelist a payout address.
   *
   * Validated locally before it reaches 21Pay: a wrong-network or malformed
   * address is unrecoverable once sent, and their error is a worse place to
   * find out.
   */
  async addDestination(
    userId: string,
    input: { network: string; address: string; label?: string },
  ): Promise<CryptoWithdrawalDestination> {
    this.assertEnabled();
    await this.requireUsdtUser(userId);

    const network = String(input.network ?? "").toLowerCase();
    if (!isCryptoNetwork(network)) {
      throw new BadRequestException(`Unsupported network "${input.network}"`);
    }
    if (!this.client.isNetworkEnabled(network)) {
      throw new BadRequestException(`${network} withdrawals are unavailable`);
    }

    const address = String(input.address ?? "").trim();
    if (!isValidAddressForNetwork(network as CryptoNetwork, address)) {
      throw new BadRequestException(
        `That does not look like a valid ${network} address`,
      );
    }

    const existing = await this.destRepo.findOneBy({ userId, network, address });
    if (existing) return existing;

    if (this.payoutKind === PayoutKind.CUSTOMER_PAYOUT) {
      // Customer payouts take a raw address: 21 Pay keeps no whitelist and
      // no cooldown for them. Ours stands in, so a hijacked account cannot
      // add an address and empty itself in one sitting (Stage J, D2).
      if (!HD_NETWORKS.has(network as CryptoNetwork)) {
        throw new BadRequestException(
          `${network} withdrawals are unavailable — only Tron is supported`,
        );
      }
      return this.destRepo.save(
        this.destRepo.create({
          userId,
          pay21DestinationId: null,
          network,
          address,
          label: input.label ?? null,
          status: WithdrawalDestinationStatus.COOLDOWN,
          usableAt: new Date(Date.now() + this.cooldownMs),
        }),
      );
    }

    const remote = await this.client.createWithdrawalDestination({
      network: network as CryptoNetwork,
      address,
      label: input.label,
    });

    return this.destRepo.save(
      this.destRepo.create({
        userId,
        pay21DestinationId: remote.id,
        network,
        address,
        label: input.label ?? null,
        status: this.mapDestinationStatus(remote.status),
        // `active_at` is what the API actually returns; `usable_at` is what
        // their docs describe. Reading only the documented name stored null,
        // so a destination 21Pay would refuse looked ready in Oro and the
        // rejection only surfaced at approval time.
        usableAt: remote.active_at
          ? new Date(remote.active_at)
          : remote.usable_at
            ? new Date(remote.usable_at)
            : null,
      }),
    );
  }

  async listDestinations(
    userId: string,
  ): Promise<CryptoWithdrawalDestination[]> {
    // Nothing else ever ends a cooldown: without this an address stayed
    // `cooldown` forever and could never be selected.
    await this.destRepo.update(
      {
        userId,
        status: WithdrawalDestinationStatus.COOLDOWN,
        usableAt: LessThanOrEqual(new Date()),
      },
      { status: WithdrawalDestinationStatus.ACTIVE },
    );
    const rows = await this.destRepo.find({
      where: { userId },
      order: { createdAt: "DESC" },
    });
    // A pre-HD row may have no `usableAt`; judge it by age instead.
    return rows.map((d) =>
      d.status === WithdrawalDestinationStatus.COOLDOWN && this.isUsable(d)
        ? Object.assign(d, { status: WithdrawalDestinationStatus.ACTIVE })
        : d,
    );
  }

  /** Which API approvals go through. Customer payouts unless told otherwise. */
  private get payoutKind(): PayoutKind {
    return this.config.get<string>("USDT_PAYOUT_MODE") === "destination"
      ? PayoutKind.DESTINATION
      : PayoutKind.CUSTOMER_PAYOUT;
  }

  /** Our cooldown on a new payout address. 24 h unless configured. */
  private get cooldownMs(): number {
    const hours = Number(
      this.config.get<string>("USDT_DESTINATION_COOLDOWN_HOURS") ?? "24",
    );
    return (Number.isFinite(hours) && hours >= 0 ? hours : 24) * 3_600_000;
  }

  /** Whether a destination may be paid to now. */
  private isUsable(d: CryptoWithdrawalDestination): boolean {
    if (d.status === WithdrawalDestinationStatus.DISABLED) return false;
    // A future `usableAt` always wins, whatever the status says: for a
    // whitelisted destination it is 21 Pay's own cooldown.
    if (d.usableAt) return new Date(d.usableAt).getTime() <= Date.now();
    if (d.status === WithdrawalDestinationStatus.ACTIVE) return true;
    // A pre-HD row in cooldown with no `usableAt`: judge it by its age.
    const created = new Date(d.createdAt).getTime();
    return Number.isFinite(created) && created + this.cooldownMs <= Date.now();
  }

  private mapDestinationStatus(raw: string): WithdrawalDestinationStatus {
    const known = Object.values(WithdrawalDestinationStatus) as string[];
    return known.includes(raw)
      ? (raw as WithdrawalDestinationStatus)
      : WithdrawalDestinationStatus.COOLDOWN;
  }

  // ── Requesting ─────────────────────────────────────────────────────────────

  /**
   * Request a withdrawal.
   *
   * Debits immediately so the same balance cannot be requested twice while an
   * admin decides, then waits for our approval. Nothing is sent to 21Pay yet.
   */
  async request(
    userId: string,
    input: {
      destinationId: string;
      amountUsdt: string;
      clientRequestId: string;
    },
  ): Promise<CryptoWithdrawal> {
    this.assertEnabled();
    await this.requireUsdtUser(userId);

    const destination = await this.destRepo.findOneBy({
      id: input.destinationId,
    });
    if (!destination || destination.userId !== userId) {
      throw new NotFoundException("Withdrawal address not found");
    }
    if (destination.status === WithdrawalDestinationStatus.DISABLED) {
      throw new BadRequestException("That withdrawal address is disabled");
    }
    if (!this.isUsable(destination)) {
      // Explained rather than refused blankly. A winner who cannot be paid for
      // 24 hours needs to know why, or the product looks broken at exactly the
      // moment it matters most.
      const when = destination.usableAt
        ? ` It can be used from ${destination.usableAt.toISOString()}.`
        : "";
      throw new BadRequestException(
        `New withdrawal addresses are held for 24 hours before first use.${when}`,
      );
    }

    const amount = this.parseAmount(input.amountUsdt);
    const idempotencyKey = `wd:${userId}:${String(input.clientRequestId ?? "").trim()}`;
    if (!input.clientRequestId?.trim()) {
      throw new BadRequestException("clientRequestId is required");
    }

    const existing = await this.withdrawalRepo.findOneBy({ idempotencyKey });
    if (existing) return existing;

    const created = await this.dataSource.transaction(async (em) => {
      // A transaction alone does not stop two requests from both reading the
      // same SUM and both passing the check. Locking the user row makes the
      // second wait, then read the already-debited balance and fail.
      await this.lockUser(em, userId);
      const balance = await ledgerBalance(em, userId, USDT);
      if (balance < amount) {
        throw new BadRequestException("Insufficient balance");
      }

      const debit = await em.save(
        Transaction,
        em.create(Transaction, {
          userId,
          type: TransactionType.WITHDRAWAL,
          amount: -amount,
          currency: USDT,
          balanceBefore: balance,
          balanceAfter: balance - amount,
          isBonus: false,
          note: `USDT withdrawal requested · ${destination.network}`,
        }),
      );

      return em.save(
        CryptoWithdrawal,
        em.create(CryptoWithdrawal, {
          userId,
          destinationId: destination.id,
          network: destination.network,
          amountUsdt: amount,
          approvalStatus: WithdrawalApprovalStatus.PENDING_APPROVAL,
          debitTransactionId: debit.id,
          idempotencyKey,
        }),
      );
    });

    await announceBalanceChange(this.redis, this.sse, userId, {
      currency: USDT,
      withdrawalId: created.id,
    });
    return created;
  }

  /** Serialises balance-check-then-write on one user's ledger. */
  private async lockUser(em: EntityManager, userId: string): Promise<void> {
    const locked = await em
      .getRepository(User)
      .createQueryBuilder("u")
      .setLock("pessimistic_write")
      .where("u.id = :id", { id: userId })
      .getOne();
    if (!locked) throw new NotFoundException("User not found");
  }

  private parseAmount(raw: string): number {
    const s = String(raw ?? "").trim();
    if (!/^\d+(\.\d+)?$/.test(s)) {
      throw new BadRequestException("Enter a valid amount");
    }
    if ((s.split(".")[1]?.length ?? 0) > 6) {
      throw new BadRequestException("USDT supports at most 6 decimal places");
    }
    const value = Number(s);
    const min = Number(this.config.get("USDT_MIN_WITHDRAWAL", "1"));
    if (value < min) {
      throw new BadRequestException(`Minimum withdrawal is ${min} USDT`);
    }
    return value;
  }

  // ── Approval ───────────────────────────────────────────────────────────────

  /** Withdrawals awaiting our decision, oldest first. */
  async pendingApprovals(limit = 50): Promise<
    (CryptoWithdrawal & {
      destinationAddress: string | null;
      destinationLabel: string | null;
      destinationUsableAt: Date | null;
    })[]
  > {
    const rows = await this.withdrawalRepo.find({
      where: { approvalStatus: WithdrawalApprovalStatus.PENDING_APPROVAL },
      order: { createdAt: "ASC" },
      take: Math.min(limit, 200),
    });
    if (!rows.length) return [];

    // The destination is the whole decision. A reviewer approving a payout
    // without seeing the address and chain it goes to is not reviewing
    // anything, and a wrong-chain send is unrecoverable.
    const destinations = await this.destRepo.find({
      where: { id: In(rows.map((r) => r.destinationId)) },
    });
    const byId = new Map(destinations.map((d) => [d.id, d]));

    return rows.map((row) => {
      const dest = byId.get(row.destinationId);
      return Object.assign(row, {
        destinationAddress: dest?.address ?? null,
        destinationLabel: dest?.label ?? null,
        // Surfaced so a reviewer is not left guessing why 21Pay refused a
        // payout they just approved.
        destinationUsableAt: dest?.usableAt ?? null,
      });
    });
  }

  /**
   * Approve, then submit to 21 Pay.
   *
   * The approval is **claimed before anything is sent**: a conditional update
   * from `pending_approval`, so two admins — or an approve racing a reject —
   * cannot both act. Without it, a reject landing while the payout request is
   * in flight refunds the user *and* pays them.
   */
  async approve(
    adminId: string,
    withdrawalId: string,
  ): Promise<CryptoWithdrawal> {
    this.assertEnabled();
    const wd = await this.requirePending(withdrawalId);

    // Maker-checker on our side too: a user who is also an admin must not be
    // able to release their own money.
    if (wd.userId === adminId) {
      throw new ForbiddenException(
        "You cannot approve your own withdrawal",
      );
    }

    const destination = await this.destRepo.findOneBy({
      id: wd.destinationId,
    });
    if (!destination) {
      throw new BadRequestException("Withdrawal address not found");
    }
    const kind = this.payoutKind;
    this.assertSendable(destination, kind);

    const claim = await this.withdrawalRepo.update(
      { id: wd.id, approvalStatus: WithdrawalApprovalStatus.PENDING_APPROVAL },
      {
        approvalStatus: WithdrawalApprovalStatus.APPROVED,
        approvedBy: adminId,
        approvedAt: new Date(),
        kind,
      },
    );
    if (!claim.affected) {
      throw new ForbiddenException("This withdrawal has already been decided");
    }

    await this.submit(
      {
        ...wd,
        approvalStatus: WithdrawalApprovalStatus.APPROVED,
        approvedBy: adminId,
        kind,
      },
      destination,
    );

    this.logger.log(`[USDT] Withdrawal ${wd.id} approved by ${adminId}`);
    return (await this.withdrawalRepo.findOneBy({ id: wd.id }))!;
  }

  /**
   * Refuse locally before calling out. The admin UI is not the authority —
   * the endpoint is reachable directly — and a wrong-chain or premature send
   * is not something to learn about from 21 Pay.
   */
  private assertSendable(
    destination: CryptoWithdrawalDestination,
    kind: PayoutKind,
  ): void {
    if (destination.status === WithdrawalDestinationStatus.DISABLED) {
      throw new BadRequestException("That withdrawal address is disabled");
    }
    if (!this.isUsable(destination)) {
      const when = destination.usableAt
        ? ` It becomes usable at ${destination.usableAt.toISOString()}.`
        : "";
      throw new BadRequestException(
        "This withdrawal address is still in its 24-hour cooldown." +
          `${when} The withdrawal stays pending until then.`,
      );
    }
    if (
      !isValidAddressForNetwork(
        destination.network as CryptoNetwork,
        destination.address,
      )
    ) {
      throw new BadRequestException(
        `The saved address is not a valid ${destination.network} address`,
      );
    }
    if (kind === PayoutKind.CUSTOMER_PAYOUT) {
      if (!HD_NETWORKS.has(destination.network as CryptoNetwork)) {
        throw new BadRequestException(
          `${destination.network} payouts are not supported — only Tron`,
        );
      }
    } else if (!destination.pay21DestinationId) {
      throw new BadRequestException("Withdrawal address is not registered");
    }
  }

  /**
   * Send an approved withdrawal to 21 Pay.
   *
   * Three outcomes, and the difference between the last two is the whole
   * point of this method:
   *
   * - **accepted** — the payout id is stored and its state applied.
   * - **definitely refused** (a 4xx in {@link DEFINITE_REFUSALS}) — nothing
   *   exists at 21 Pay, so the withdrawal goes back to the approval queue.
   * - **unknown** (timeout, 5xx, network) — the payout may exist. It stays
   *   approved with no payout id and {@link resubmitUnconfirmed} re-sends it
   *   with the **same idempotency key**, which 21 Pay answers with the
   *   original payout if there is one. It must never return to the queue:
   *   from there a reject would refund money that may already be leaving.
   */
  private async submit(
    wd: CryptoWithdrawal,
    destination: CryptoWithdrawalDestination,
  ): Promise<void> {
    let remote: { id: string; status: string; tx_hash?: string; failure_reason?: string };
    try {
      remote =
        wd.kind === PayoutKind.CUSTOMER_PAYOUT
          ? await this.client.createCustomerPayout({
              idempotencyKey: wd.idempotencyKey,
              endUserId: wd.userId,
              network: destination.network as CryptoNetwork,
              toAddress: destination.address,
              amountBaseUnits: toBaseUnits(String(wd.amountUsdt)),
            })
          : await this.client.createWithdrawal({
              idempotencyKey: wd.idempotencyKey,
              destinationId: destination.pay21DestinationId!,
              amountBaseUnits: toBaseUnits(String(wd.amountUsdt)),
              network: wd.network,
              // The user who requested it, not the admin approving.
              requestedBy: wd.userId,
            });
    } catch (err) {
      const status = upstreamStatusOf(err);

      if (status !== undefined && DEFINITE_REFUSALS.has(status)) {
        await this.withdrawalRepo.update(
          {
            id: wd.id,
            approvalStatus: WithdrawalApprovalStatus.APPROVED,
            pay21WithdrawalId: IsNull(),
          },
          {
            approvalStatus: WithdrawalApprovalStatus.PENDING_APPROVAL,
            approvedBy: null,
            approvedAt: null,
          },
        );
        throw new BadRequestException(
          this.refusalMessage(status, destination, wd.kind),
        );
      }

      if (status === 409) {
        // A payout already carries this key with different details. That
        // should be impossible — amount and address never change — so a
        // person looks before anything else happens.
        await this.withdrawalRepo.update(
          { id: wd.id },
          {
            needsManualReview: true,
            failureReason: "21 Pay: idempotency key already used (409)",
          },
        );
        this.logger.error(
          `[USDT] Withdrawal ${wd.id}: 21 Pay answered 409 for its key — ` +
            `held for review, not re-sent and not refunded`,
        );
        return;
      }

      this.logger.error(
        `[USDT] Withdrawal ${wd.id}: payout request outcome unknown ` +
          `(${(err as Error)?.message}). Stays approved; will be re-sent ` +
          `with the same key.`,
      );
      return;
    }

    await this.withdrawalRepo.update(
      { id: wd.id, pay21WithdrawalId: IsNull() },
      { pay21WithdrawalId: remote.id },
    );
    this.logger.log(
      `[USDT] Withdrawal ${wd.id} submitted as ${remote.id} (${remote.status})`,
    );
    // Also settles an immediately-final answer (rejected on the spot).
    await this.applyRemoteState(wd.id, remote);
  }

  private refusalMessage(
    status: number,
    destination: CryptoWithdrawalDestination,
    kind: PayoutKind,
  ): string {
    const back = " The withdrawal is back in the queue.";
    if (status === 429) {
      return "21 Pay's account-wide withdrawal limit is reached. Try again later." + back;
    }
    if (status === 422) {
      return kind === PayoutKind.CUSTOMER_PAYOUT
        ? "21 Pay refused the payout: invalid address, or not enough balance " +
            "in the 21 Pay account." + back
        : "21 Pay will not pay to this destination yet — it is in cooldown, " +
            "disabled, or unknown to them." +
            (destination.usableAt
              ? ` It becomes usable at ${destination.usableAt.toISOString()}.`
              : "") +
            back;
    }
    if (status === 403) {
      return "21 Pay refused: this account type cannot make that kind of payout." + back;
    }
    return `21 Pay refused the payout (HTTP ${status}).` + back;
  }

  /**
   * Re-send approved withdrawals whose submission outcome was never learned.
   *
   * Safe because the idempotency key is the withdrawal's own: 21 Pay returns
   * the original payout if the first request created one, and creates it
   * otherwise. Called by the poller.
   */
  async resubmitUnconfirmed(olderThanMs = 60_000): Promise<void> {
    const stuck = await this.withdrawalRepo.find({
      where: {
        approvalStatus: WithdrawalApprovalStatus.APPROVED,
        pay21WithdrawalId: IsNull(),
        needsManualReview: false,
        approvedAt: LessThan(new Date(Date.now() - olderThanMs)),
      },
      order: { approvedAt: "ASC" },
      take: 20,
    });

    for (const wd of stuck) {
      const destination = await this.destRepo.findOneBy({
        id: wd.destinationId,
      });
      if (!destination) continue;
      try {
        await this.submit(wd, destination);
      } catch (err) {
        // A definite refusal put it back in the queue; the admin sees it there.
        this.logger.warn(
          `[USDT] Re-send of withdrawal ${wd.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * A `withdrawals.<net>.<status>` webhook.
   *
   * The body names the payout (`id`) and our key (`idempotency_key`). We act
   * on 21 Pay's **current** record, fetched here, not on the body: events can
   * arrive out of order, and this is the path that refunds.
   */
  async handleWebhook(
    payload: Record<string, any>,
  ): Promise<{ handled: boolean; reason?: string }> {
    const payoutId = payload?.id ? String(payload.id) : null;
    const key = payload?.idempotency_key ? String(payload.idempotency_key) : null;

    let wd = payoutId
      ? await this.withdrawalRepo.findOneBy({ pay21WithdrawalId: payoutId })
      : null;

    if (!wd && key) {
      // The submit response was lost, so we never stored the payout id.
      wd = await this.withdrawalRepo.findOneBy({ idempotencyKey: key });
      if (wd && !wd.pay21WithdrawalId && payoutId) {
        if (wd.approvalStatus !== WithdrawalApprovalStatus.APPROVED) {
          // Never adopt a payout for a withdrawal we did not approve.
          this.logger.error(
            `[USDT] Payout ${payoutId} names withdrawal ${wd.id}, which is ` +
              `${wd.approvalStatus} — ignored`,
          );
          return { handled: false, reason: "not_approved" };
        }
        await this.withdrawalRepo.update(
          { id: wd.id, pay21WithdrawalId: IsNull() },
          { pay21WithdrawalId: payoutId },
        );
        wd.pay21WithdrawalId = payoutId;
      }
    }

    if (!wd?.pay21WithdrawalId) {
      return { handled: false, reason: "unknown_withdrawal" };
    }
    if (key && key !== wd.idempotencyKey) {
      this.logger.error(
        `[USDT] Payout ${payoutId} carries key ${key}, but withdrawal ` +
          `${wd.id} has ${wd.idempotencyKey} — ignored`,
      );
      return { handled: false, reason: "key_mismatch" };
    }

    const remote = await this.client.getWithdrawal(wd.pay21WithdrawalId);
    await this.applyRemoteState(wd.id, remote);
    return { handled: true };
  }

  /**
   * Reject before anything is sent, and give the money back.
   *
   * The claim and the refund are one transaction: a reject that lost the race
   * to an approval refunds nothing, and one that won cannot leave the user
   * rejected but unrefunded.
   */
  async reject(
    adminId: string,
    withdrawalId: string,
    reason: string,
  ): Promise<CryptoWithdrawal> {
    if (!reason?.trim()) {
      throw new BadRequestException("A rejection reason is required");
    }
    const wd = await this.requirePending(withdrawalId);
    const why = reason.trim();

    try {
      await this.restore(wd, `rejected: ${why}`, async (em) => {
        const claim = await em.update(
          CryptoWithdrawal,
          { id: wd.id, approvalStatus: WithdrawalApprovalStatus.PENDING_APPROVAL },
          {
            approvalStatus: WithdrawalApprovalStatus.REJECTED,
            approvedBy: adminId,
            rejectionReason: why.slice(0, 255),
          },
        );
        if (!claim.affected) throw new AlreadyDecidedError();
      });
    } catch (err) {
      if (err instanceof AlreadyDecidedError) {
        throw new ForbiddenException("This withdrawal has already been decided");
      }
      throw err;
    }
    return (await this.withdrawalRepo.findOneBy({ id: wd.id }))!;
  }

  private async requirePending(id: string): Promise<CryptoWithdrawal> {
    const wd = await this.withdrawalRepo.findOneBy({ id });
    if (!wd) throw new NotFoundException("Withdrawal not found");
    if (wd.approvalStatus !== WithdrawalApprovalStatus.PENDING_APPROVAL) {
      throw new ForbiddenException("This withdrawal has already been decided");
    }
    return wd;
  }

  // ── Terminal handling ──────────────────────────────────────────────────────

  /**
   * Apply a state read from 21Pay.
   *
   * **`failed` does not mean the money stayed put.** Three paths reach it and
   * only two are safe:
   *
   * - never broadcast, or mined and reverted → nothing moved, restore
   * - failed while broadcasting, or a reorg orphan of a confirmed payout →
   *   the transfer may have landed, and 21Pay's own reaper refuses to
   *   auto-reverse these for exactly that reason
   *
   * We cannot see which path it was, but a `tx_hash` tells us a broadcast
   * happened. So: restore only when no hash was ever set, otherwise hold for
   * review. Restoring blind pays the user twice — once on chain, once back
   * into their balance.
   */
  async applyRemoteState(
    withdrawalId: string,
    remote: { status: string; tx_hash?: string; failure_reason?: string },
  ): Promise<void> {
    const wd = await this.withdrawalRepo.findOneBy({ id: withdrawalId });
    if (!wd) return;
    if (wd.remoteStatus && TERMINAL_REMOTE_STATUSES.has(wd.remoteStatus)) {
      return; // already settled
    }

    const txHash = remote.tx_hash ?? wd.txHash ?? null;

    if (remote.status === RemoteWithdrawalStatus.COMPLETED) {
      // Every replica polls, so several can observe COMPLETED at once. Claim the
      // transition with a conditional update on completedAt (set only here, so
      // `IS NULL` means "not yet completed") and notify only if we won it —
      // otherwise each replica would send a duplicate "Withdrawal sent".
      const res = await this.withdrawalRepo.update(
        { id: wd.id, completedAt: IsNull() },
        {
          remoteStatus: remote.status,
          txHash,
          completedAt: new Date(),
        },
      );
      if (res.affected && res.affected > 0) {
        this.logger.log(`[USDT] Withdrawal ${wd.id} completed`);
        this.notifyTransaction(
          wd.userId,
          "Withdrawal sent",
          `${wd.amountUsdt} USDT was sent to your wallet.`,
          {
            kind: "withdrawal",
            currency: USDT,
            amount: Number(wd.amountUsdt),
            network: wd.network,
            txHash,
          },
        );
      }
      return;
    }

    const isFailure =
      remote.status === RemoteWithdrawalStatus.FAILED ||
      remote.status === RemoteWithdrawalStatus.REJECTED ||
      remote.status === RemoteWithdrawalStatus.CANCELLED;

    if (isFailure) {
      if (txHash) {
        // A broadcast happened. We do not know whether it landed.
        await this.withdrawalRepo.update(
          { id: wd.id },
          {
            remoteStatus: remote.status,
            txHash,
            needsManualReview: true,
            failureReason: (remote.failure_reason ?? remote.status).slice(0, 255),
          },
        );
        this.logger.error(
          `[USDT] Withdrawal ${wd.id} failed WITH a tx hash — held for review, ` +
            `not restored. Reconcile against 21Pay before crediting anyone back.`,
        );
        return;
      }

      const didRestore = await this.restore(
        wd,
        remote.failure_reason ?? remote.status,
      );
      await this.withdrawalRepo.update(
        { id: wd.id },
        {
          remoteStatus: remote.status,
          failureReason: (remote.failure_reason ?? remote.status).slice(0, 255),
        },
      );
      // Only the replica whose restore() actually posted the refund notifies,
      // so the user gets one "refunded" message, not one per replica.
      if (didRestore) {
        this.notifyTransaction(
          wd.userId,
          "Withdrawal refunded",
          `Your ${wd.amountUsdt} USDT withdrawal couldn't be completed and has been returned to your balance.`,
          {
            kind: "withdrawal",
            currency: USDT,
            amount: Number(wd.amountUsdt),
            network: wd.network,
            result: "refunded",
          },
        );
      }
      return;
    }

    // In flight: requested, approved, broadcasting, confirming. Not paid.
    await this.withdrawalRepo.update(
      { id: wd.id },
      { remoteStatus: remote.status, txHash },
    );
  }

  /**
   * Compensating credit. Returns true only if THIS call posted the refund.
   *
   * Every replica polls, so two can reach here for the same withdrawal with a
   * stale in-memory `restoreTransactionId === null` and each try to refund. The
   * refund insert and the `restoreTransactionId` claim run in one transaction,
   * and the claim is conditional on `restoreTransactionId IS NULL`: the first
   * committer wins (affected = 1), the loser's UPDATE matches zero rows once the
   * winner's value is visible, so we throw to roll back its refund insert. The
   * user is credited exactly once, and returning false keeps the duplicate
   * "refunded" notification from being sent.
   */
  private async restore(
    wd: CryptoWithdrawal,
    reason: string,
    /** Runs first, in the same transaction; throwing rolls the refund back. */
    inSameTransaction?: (em: EntityManager) => Promise<void>,
  ): Promise<boolean> {
    if (wd.restoreTransactionId) return false; // fast path: already restored

    try {
      await this.dataSource.transaction(async (em) => {
        if (inSameTransaction) await inSameTransaction(em);
        const amount = Number(wd.amountUsdt);
        // Same user-row lock as request(), so balanceBefore/After are not read
        // from a SUM another debit is about to change.
        await this.lockUser(em, wd.userId);
        const balance = await ledgerBalance(em, wd.userId, USDT);
        const credit = await em.save(
          Transaction,
          em.create(Transaction, {
            userId: wd.userId,
            type: TransactionType.REFUND,
            amount,
            currency: USDT,
            balanceBefore: balance,
            balanceAfter: balance + amount,
            isBonus: false,
            note: `USDT withdrawal returned · ${reason}`.slice(0, 255),
          }),
        );
        const claim = await em.update(
          CryptoWithdrawal,
          { id: wd.id, restoreTransactionId: IsNull() },
          { restoreTransactionId: credit.id },
        );
        if (!claim.affected) {
          // Another replica already restored this withdrawal between our load
          // and now. Roll back our refund insert — exactly-once.
          throw new AlreadyRestoredError();
        }
      });
    } catch (err) {
      if (err instanceof AlreadyRestoredError) {
        this.logger.warn(
          `[USDT] Withdrawal ${wd.id} already restored by another worker — ` +
            `duplicate refund rolled back`,
        );
        return false;
      }
      throw err;
    }

    this.logger.log(
      `[USDT] Restored ${wd.amountUsdt} USDT to user ${wd.userId} (${reason})`,
    );
    await announceBalanceChange(this.redis, this.sse, wd.userId, {
      currency: USDT,
      withdrawalId: wd.id,
    });
    return true;
  }

  async listForUser(userId: string, limit = 20): Promise<CryptoWithdrawal[]> {
    return this.withdrawalRepo.find({
      where: { userId },
      order: { createdAt: "DESC" },
      take: Math.min(limit, 100),
    });
  }
}
