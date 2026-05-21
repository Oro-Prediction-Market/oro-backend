import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import {
  RevenueDistribution,
  DistributionStatus,
} from "../entities/revenue-distribution.entity";
import { DKGatewayService } from "../payment/services/dk-gateway/dk-gateway.service";

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

  constructor(
    @InjectRepository(RevenueDistribution)
    private distributionRepo: Repository<RevenueDistribution>,
    private configService: ConfigService,
    private dkGateway: DKGatewayService,
  ) {}

  private get publicAccountNo(): string {
    return this.configService.get<string>("DK_PUBLIC_ACCOUNT_NO") || "";
  }

  /** Admin-configurable destination account — stored in config or overridden at runtime */
  private overriddenAccountNo: string | null = null;

  getDestinationAccount(): { accountNumber: string; source: string } {
    if (this.overriddenAccountNo) {
      return { accountNumber: this.overriddenAccountNo, source: "admin" };
    }
    const envVal = this.configService.get<string>("DK_PUBLIC_ACCOUNT_NO");
    if (envVal) {
      return { accountNumber: envVal, source: "env" };
    }
    return { accountNumber: "", source: "none" };
  }

  setDestinationAccount(accountNumber: string): {
    accountNumber: string;
    source: string;
  } {
    this.overriddenAccountNo = accountNumber.trim();
    this.logger.log(
      `[Revenue] Destination account set by admin: ${this.overriddenAccountNo}`,
    );
    // Update all PENDING distributions that have no account set
    this.distributionRepo
      .createQueryBuilder()
      .update()
      .set({ publicAccountNo: this.overriddenAccountNo })
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
    return { accountNumber: this.overriddenAccountNo, source: "admin" };
  }

  private getActiveAccountNo(): string {
    return this.overriddenAccountNo || this.publicAccountNo;
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
      publicAccountNo: this.getActiveAccountNo(),
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

  /** Process all pending distributions (batch). Admin-triggered. */
  async processAllPending(): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    totalAmount: number;
  }> {
    const pending = await this.distributionRepo.find({
      where: { status: DistributionStatus.PENDING },
      order: { createdAt: "ASC" },
    });

    let succeeded = 0;
    let failed = 0;
    let totalAmount = 0;

    for (const dist of pending) {
      const result = await this.executeTransfer(dist.id);
      if (result.success) {
        succeeded++;
        totalAmount += Number(dist.amount);
      } else {
        failed++;
      }
    }

    return { processed: pending.length, succeeded, failed, totalAmount };
  }

  async getPending(): Promise<RevenueDistribution[]> {
    return this.distributionRepo.find({
      where: { status: DistributionStatus.PENDING },
      order: { createdAt: "ASC" },
    });
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
