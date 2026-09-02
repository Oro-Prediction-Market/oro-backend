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
import { DataSource, In, Repository } from "typeorm";
import { User, KycStatus } from "../entities/user.entity";
import { UserNotification } from "../entities/user-notification.entity";
import {
  Transaction,
  TransactionType,
} from "../entities/transaction.entity";
import {
  CryptoWithdrawal,
  CryptoWithdrawalDestination,
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

const USDT = "USDT";

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
    return this.destRepo.find({
      where: { userId },
      order: { createdAt: "DESC" },
    });
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
    if (destination.status === WithdrawalDestinationStatus.COOLDOWN) {
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

    return this.dataSource.transaction(async (em) => {
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

  /** Approve, then submit to 21Pay. */
  async approve(
    adminId: string,
    withdrawalId: string,
  ): Promise<CryptoWithdrawal> {
    this.assertEnabled();
    const wd = await this.requirePending(withdrawalId);

    // Maker-checker on our side too: 21Pay enforces it on theirs, and a user
    // who is also an admin must not be able to release their own money.
    if (wd.userId === adminId) {
      throw new ForbiddenException(
        "You cannot approve your own withdrawal",
      );
    }

    const destination = await this.destRepo.findOneBy({
      id: wd.destinationId,
    });
    if (!destination?.pay21DestinationId) {
      throw new BadRequestException("Withdrawal address is not registered");
    }

    // Refuse locally before calling out.
    //
    // 21Pay would reject this anyway, but the admin UI is not the authority —
    // the endpoint is reachable directly — and a pointless call to the money
    // API on every premature click is worth avoiding on its own.
    if (destination.usableAt && destination.usableAt.getTime() > Date.now()) {
      throw new BadRequestException(
        "This destination is still in its 24-hour cooldown at 21 Pay. It " +
          `becomes usable at ${destination.usableAt.toISOString()}. The ` +
          "withdrawal stays pending until then.",
      );
    }

    // A destination inside 21Pay's cooldown, disabled, or unknown to them is a
    // precondition failure, not an outage. Surfaced as 503 "temporarily
    // unavailable" it reads as our fault and invites a retry that cannot
    // succeed, so it is translated before it reaches the admin.
    const remote = await this.client
      .createWithdrawal({
      idempotencyKey: wd.idempotencyKey,
      destinationId: destination.pay21DestinationId,
      amountBaseUnits: toBaseUnits(String(wd.amountUsdt)),
        network: wd.network,
        // The user who requested it, not the admin approving — see the client.
        requestedBy: wd.userId,
      })
      .catch((err: unknown) => {
        const message = (err as Error)?.message ?? "";
        if (/422/.test(message)) {
          const when = destination.usableAt
            ? ` It becomes usable at ${destination.usableAt.toISOString()}.`
            : "";
          throw new BadRequestException(
            "21 Pay will not pay to this destination yet — it is in cooldown, " +
              `disabled, or unknown to them.${when} The withdrawal stays ` +
              "pending and can be approved once that clears.",
          );
        }
        throw err;
      });

    await this.withdrawalRepo.update(
      { id: wd.id },
      {
        approvalStatus: WithdrawalApprovalStatus.APPROVED,
        approvedBy: adminId,
        approvedAt: new Date(),
        pay21WithdrawalId: remote.id,
        remoteStatus: remote.status,
      },
    );

    this.logger.log(
      `[USDT] Withdrawal ${wd.id} approved by ${adminId}, submitted as ${remote.id}`,
    );
    return (await this.withdrawalRepo.findOneBy({ id: wd.id }))!;
  }

  /** Reject before anything is sent, and give the money back. */
  async reject(
    adminId: string,
    withdrawalId: string,
    reason: string,
  ): Promise<CryptoWithdrawal> {
    if (!reason?.trim()) {
      throw new BadRequestException("A rejection reason is required");
    }
    const wd = await this.requirePending(withdrawalId);

    await this.restore(wd, `rejected: ${reason.trim()}`);
    await this.withdrawalRepo.update(
      { id: wd.id },
      {
        approvalStatus: WithdrawalApprovalStatus.REJECTED,
        approvedBy: adminId,
        rejectionReason: reason.trim().slice(0, 255),
      },
    );
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
      await this.withdrawalRepo.update(
        { id: wd.id },
        {
          remoteStatus: remote.status,
          txHash,
          completedAt: new Date(),
        },
      );
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

      await this.restore(wd, remote.failure_reason ?? remote.status);
      await this.withdrawalRepo.update(
        { id: wd.id },
        {
          remoteStatus: remote.status,
          failureReason: (remote.failure_reason ?? remote.status).slice(0, 255),
        },
      );
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
      return;
    }

    // In flight: requested, approved, broadcasting, confirming. Not paid.
    await this.withdrawalRepo.update(
      { id: wd.id },
      { remoteStatus: remote.status, txHash },
    );
  }

  /** Compensating credit. Idempotent via `restoreTransactionId`. */
  private async restore(
    wd: CryptoWithdrawal,
    reason: string,
  ): Promise<void> {
    if (wd.restoreTransactionId) return;

    await this.dataSource.transaction(async (em) => {
      const amount = Number(wd.amountUsdt);
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
      await em.update(
        CryptoWithdrawal,
        { id: wd.id },
        { restoreTransactionId: credit.id },
      );
    });

    this.logger.log(
      `[USDT] Restored ${wd.amountUsdt} USDT to user ${wd.userId} (${reason})`,
    );
  }

  async listForUser(userId: string, limit = 20): Promise<CryptoWithdrawal[]> {
    return this.withdrawalRepo.find({
      where: { userId },
      order: { createdAt: "DESC" },
      take: Math.min(limit, 100),
    });
  }
}
