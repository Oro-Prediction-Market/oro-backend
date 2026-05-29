import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import {
  RevenueDistribution,
  DistributionStatus,
} from "../entities/revenue-distribution.entity";
import { DKGatewayService } from "../payment/services/dk-gateway/dk-gateway.service";
import { RedisService } from "../redis/redis.service";

/**
 * Revenue Distribution Service
 *
 * Manages transfer of house edge (platform fee) from beneficiary account
 * to public account (DK_PUBLIC_ACCOUNT_NO).
 *
 * Flow:
 *   1. Market settles -> houseAmount recorded as PENDING
 *   2. Admin triggers transfer from admin panel
 *   3. DK Gateway: bene acc -> public acc
 *   4. Status -> COMPLETED with payment reference
 */
@Injectable()
export class RevenueDistributionService {
  private readonly logger = new Logger(RevenueDistributionService.name);
  private static readonly REDIS_KEY =
    "oro:settings:revenue_destination_account";

  constructor(
    @InjectRepository(RevenueDistribution)
    private distributionRepo: Repository<RevenueDistribution>,
    private configService: ConfigService,
    private dkGateway: DKGatewayService,
    private redisService: RedisService,
  ) {}

  private get publicAccountNo(): string {
    return this.configService.get<string>("DK_PUBLIC_ACCOUNT_NO") || "";
  }

  async getDestinationAccount(): Promise<{
    accountNumber: string;
    source: string;
  }> {
    const stored = await this.redisService.get(
      RevenueDistributionService.REDIS_KEY,
    );
    if (stored) {
      return { accountNumber: stored, source: "admin" };
    }
    const envVal = this.configService.get<string>("DK_PUBLIC_ACCOUNT_NO");
    if (envVal) {
      return { accountNumber: envVal, source: "env" };
    }
    return { accountNumber: "", source: "none" };
  }

  async setDestinationAccount(
    accountNumber: string,
  ): Promise<{ accountNumber: string; source: string }> {
    const trimmed = accountNumber.trim();
    // Persist to Redis with 10-year TTL so it survives pod restarts
    await this.redisService.setEx(
      RevenueDistributionService.REDIS_KEY,
      60 * 60 * 24 * 365 * 10,
      trimmed,
    );
    this.logger.log(`[Revenue] Destination account saved: ${trimmed}`);
    // Update all PENDING distributions that have no account set
    this.distributionRepo
      .createQueryBuilder()
      .update()
      .set({ publicAccountNo: trimmed })
      .where("status = :s", { s: DistributionStatus.PENDING })
      .andWhere(`("publicAccountNo" IS NULL OR "publicAccountNo" = '')`)
      .execute()
      .then((r) => {
        if (r.affected && r.affected > 0) {
          this.logger.log(
            `[Revenue] Updated ${r.affected} pending distribution(s) with new account`,
          );
        }
      });
    return { accountNumber: trimmed, source: "admin" };
  }

  private async getActiveAccountNo(): Promise<string> {
    const stored = await this.redisService.get(
      RevenueDistributionService.REDIS_KEY,
    );
    return stored || this.publicAccountNo;
  }

  /**
   * Record a pending revenue distribution after market settlement.
   * Called from ParimutuelEngine after settleMarket().
   */
  async recordDistribution(
    marketId: string,
    settlementId: string,
    houseAmount: number,
    houseEdgePct: number,
    totalPool: number,
  ): Promise<RevenueDistribution | null> {
    if (houseAmount <= 0) return null;

    const existing = await this.distributionRepo.findOne({
      where: { settlementId },
    });
    if (existing) {
      this.logger.warn(
        `Distribution already exists for settlement ${settlementId}`,
      );
      return existing;
    }

    const dist = this.distributionRepo.create({
      marketId,
      settlementId,
      amount: houseAmount,
      houseEdgePct,
      totalPool,
      publicAccountNo: await this.getActiveAccountNo(),
      status: DistributionStatus.PENDING,
    });

    const saved = await this.distributionRepo.save(dist);
    this.logger.log(
      `Revenue distribution recorded: ${houseAmount} Nu for market ${marketId} -> public account ${this.publicAccountNo}`,
    );
    return saved;
  }

  /**
   * Execute DK Bank transfer: beneficiary acc -> public acc.
   * Triggered by admin.
   */
  async executeTransfer(distributionId: string): Promise<{
    success: boolean;
    paymentReference?: string;
    error?: string;
  }> {
    const dist = await this.distributionRepo.findOne({
      where: { id: distributionId },
    });

    if (!dist) return { success: false, error: "Distribution not found" };
    if (dist.status !== DistributionStatus.PENDING) {
      return { success: false, error: `Already ${dist.status}` };
    }

    const amount = Number(dist.amount);
    if (amount <= 0)
      return { success: false, error: "Amount must be positive" };

    if (!dist.publicAccountNo) {
      return {
        success: false,
        error: "No destination account configured. Set account number first.",
      };
    }

    try {
      const result = await this.dkGateway.transferToAccount({
        accountNumber: dist.publicAccountNo,
        accountName: "Oro Public Account",
        amount,
        reference: `REV-${dist.id.slice(0, 8)}`,
        description: `Oro house edge: Market ${dist.marketId.slice(0, 8)}`,
      });

      if (result.status === "SUCCESS") {
        const ref =
          result.txnId || result.inquiryId || result.txnStatusId || "DK-OK";
        await this.distributionRepo.update(dist.id, {
          status: DistributionStatus.COMPLETED,
          paymentReference: ref,
          paidAt: new Date(),
        });
        this.logger.log(
          `[Revenue] Transfer OK: ${amount} Nu -> ${dist.publicAccountNo}, ref: ${ref}`,
        );
        return { success: true, paymentReference: ref };
      } else {
        await this.distributionRepo.update(dist.id, {
          status: DistributionStatus.FAILED,
        });
        this.logger.error(`[Revenue] Transfer failed: ${result.statusDesc}`);
        return { success: false, error: result.statusDesc };
      }
    } catch (err: any) {
      await this.distributionRepo.update(dist.id, {
        status: DistributionStatus.FAILED,
      });
      this.logger.error(`[Revenue] Transfer exception: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /** Process all pending distributions as ONE combined transfer. Admin-triggered. */
  async processAllPending(): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    totalAmount: number;
    paymentReference?: string;
  }> {
    const pending = await this.distributionRepo.find({
      where: { status: DistributionStatus.PENDING },
      order: { createdAt: "ASC" },
    });

    if (pending.length === 0) {
      return { processed: 0, succeeded: 0, failed: 0, totalAmount: 0 };
    }

    // Sum all pending amounts into one transfer
    const totalAmount = pending.reduce((sum, d) => sum + Number(d.amount), 0);
    const accountNo =
      pending[0].publicAccountNo || (await this.getActiveAccountNo());

    if (!accountNo) {
      return {
        processed: pending.length,
        succeeded: 0,
        failed: pending.length,
        totalAmount: 0,
      };
    }

    try {
      const result = await this.dkGateway.transferToAccount({
        accountNumber: accountNo,
        accountName: "Oro Public Account",
        amount: totalAmount,
        reference: `REV-BATCH-${Date.now()}`,
        description: `Oro house edge batch: ${pending.length} markets, total ${totalAmount.toFixed(2)} Nu`,
      });

      if (result.status === "SUCCESS") {
        const ref =
          result.txnId || result.inquiryId || result.txnStatusId || "DK-OK";
        const now = new Date();
        // Mark all as completed
        for (const dist of pending) {
          await this.distributionRepo.update(dist.id, {
            status: DistributionStatus.COMPLETED,
            paymentReference: ref,
            paidAt: now,
          });
        }
        this.logger.log(
          `[Revenue] Batch transfer OK: ${totalAmount.toFixed(2)} Nu (${pending.length} distributions) -> ${accountNo}, ref: ${ref}`,
        );
        return {
          processed: pending.length,
          succeeded: pending.length,
          failed: 0,
          totalAmount,
          paymentReference: ref,
        };
      } else {
        this.logger.error(
          `[Revenue] Batch transfer failed: ${result.statusDesc}`,
        );
        return {
          processed: pending.length,
          succeeded: 0,
          failed: pending.length,
          totalAmount: 0,
        };
      }
    } catch (err: any) {
      this.logger.error(`[Revenue] Batch transfer exception: ${err.message}`);
      return {
        processed: pending.length,
        succeeded: 0,
        failed: pending.length,
        totalAmount: 0,
      };
    }
  }

  async getPending(): Promise<RevenueDistribution[]> {
    return this.distributionRepo.find({
      where: { status: DistributionStatus.PENDING },
      order: { createdAt: "ASC" },
    });
  }

  /** Get account balance from DK Bank for the configured destination account */
  async getAccountBalance(): Promise<{
    accountNumber: string;
    accountName: string;
    balance: string | null;
  }> {
    const accountNo = await this.getActiveAccountNo();
    if (!accountNo) {
      return { accountNumber: "", accountName: "", balance: null };
    }
    const info = await this.dkGateway.accountInquiry(accountNo);
    return {
      accountNumber: info.accountNumber,
      accountName: info.accountName,
      balance: info.balance,
    };
  }

  async getByMarket(marketId: string): Promise<RevenueDistribution[]> {
    return this.distributionRepo.find({ where: { marketId } });
  }

  async getAll(): Promise<RevenueDistribution[]> {
    return this.distributionRepo.find({ order: { createdAt: "DESC" } });
  }

  async getSummary(): Promise<{
    totalPending: number;
    totalCompleted: number;
    totalFailed: number;
    pendingAmount: number;
    completedAmount: number;
  }> {
    const [pending, completed, failed] = await Promise.all([
      this.distributionRepo
        .createQueryBuilder("d")
        .select("COALESCE(SUM(d.amount), 0)", "total")
        .addSelect("COUNT(*)", "count")
        .where("d.status = :s", { s: DistributionStatus.PENDING })
        .getRawOne(),
      this.distributionRepo
        .createQueryBuilder("d")
        .select("COALESCE(SUM(d.amount), 0)", "total")
        .addSelect("COUNT(*)", "count")
        .where("d.status = :s", { s: DistributionStatus.COMPLETED })
        .getRawOne(),
      this.distributionRepo
        .createQueryBuilder("d")
        .select("COUNT(*)", "count")
        .where("d.status = :s", { s: DistributionStatus.FAILED })
        .getRawOne(),
    ]);

    return {
      totalPending: Number(pending.count),
      totalCompleted: Number(completed.count),
      totalFailed: Number(failed.count),
      pendingAmount: Number(pending.total),
      completedAmount: Number(completed.total),
    };
  }
}
