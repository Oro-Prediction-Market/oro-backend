import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { Repository, DataSource } from "typeorm";
import {
  Reconciliation,
  ReconciliationStatus,
  ReconciliationType,
} from "../entities/reconciliation.entity";
import { Settlement } from "../entities/settlement.entity";
import { Position, PositionStatus } from "../entities/position.entity";
import { Transaction, TransactionType } from "../entities/transaction.entity";
import { Market } from "../entities/market.entity";
import { Outcome } from "../entities/outcome.entity";
import { User } from "../entities/user.entity";

export interface ReconciliationReport {
  total: number;
  matched: number;
  mismatched: number;
  pending: number;
  corrected: number;
  totalDifference: number;
  records: Reconciliation[];
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(Reconciliation)
    private readonly reconciliationRepo: Repository<Reconciliation>,
    @InjectRepository(Settlement)
    private readonly settlementRepo: Repository<Settlement>,
    @InjectRepository(Position)
    private readonly positionRepo: Repository<Position>,
    @InjectRepository(Transaction)
    private readonly transactionRepo: Repository<Transaction>,
    @InjectRepository(Market)
    private readonly marketRepo: Repository<Market>,
    @InjectRepository(Outcome)
    private readonly outcomeRepo: Repository<Outcome>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  /**
   * Reconcile a specific settlement
   * Verifies that all winners received the correct payout amounts
   */
  async reconcileSettlement(settlementId: string): Promise<Reconciliation[]> {
    this.logger.log(
      `[Reconciliation] Starting settlement reconciliation: ${settlementId}`,
    );

    const settlement = await this.settlementRepo.findOne({
      where: { id: settlementId },
    });

    if (!settlement) {
      throw new Error(`Settlement ${settlementId} not found`);
    }

    const market = await this.marketRepo.findOne({
      where: { id: settlement.marketId },
    });

    const winningOutcome = await this.outcomeRepo.findOne({
      where: { id: settlement.winningOutcomeId },
    });

    // Get all winning positions
    const winningPositions = await this.positionRepo.find({
      where: {
        marketId: settlement.marketId,
        outcomeId: settlement.winningOutcomeId,
        status: PositionStatus.WON,
      },
    });

    const reconciliations: Reconciliation[] = [];
    const totalPool = Number(settlement.totalPool);
    const houseAmount = Number(settlement.houseAmount);
    const payoutPool = Number(settlement.payoutPool);
    const winnerPool = Number(winningOutcome?.totalBetAmount ?? 0);

    for (const position of winningPositions) {
      const expectedShare =
        winnerPool > 0 ? Number(position.amount) / winnerPool : 0;
      const expectedPayout = parseFloat(
        (payoutPool * expectedShare).toFixed(2),
      );

      // Check if bet was bonus-funded and apply cap
      const user = await this.userRepo.findOne({
        where: { id: position.userId },
        select: ["id", "bonusBalance"],
      });
      const userBonusBalance = Number(user?.bonusBalance ?? 0);
      const betIsBonusFunded =
        userBonusBalance > 0 && Number(position.amount) <= userBonusBalance;

      const BONUS_WITHDRAWABLE_CAP = 50;
      let expectedWithdrawable = expectedPayout;
      let expectedBonus = 0;

      if (betIsBonusFunded && expectedPayout > BONUS_WITHDRAWABLE_CAP) {
        expectedWithdrawable = BONUS_WITHDRAWABLE_CAP;
        expectedBonus = parseFloat(
          (expectedPayout - BONUS_WITHDRAWABLE_CAP).toFixed(2),
        );
      }

      // Get actual transactions for this position
      const payoutTxns = await this.transactionRepo.find({
        where: {
          positionId: position.id,
          type: TransactionType.POSITION_PAYOUT,
        },
      });

      const bonusTxns = await this.transactionRepo.find({
        where: {
          positionId: position.id,
          type: TransactionType.FREE_CREDIT,
        },
      });

      const actualWithdrawable = payoutTxns.reduce(
        (sum, txn) => sum + Number(txn.amount),
        0,
      );
      const actualBonus = bonusTxns.reduce(
        (sum, txn) => sum + Number(txn.amount),
        0,
      );
      const actualTotal = actualWithdrawable + actualBonus;

      const difference = parseFloat((expectedPayout - actualTotal).toFixed(2));
      const status =
        Math.abs(difference) < 0.01
          ? ReconciliationStatus.MATCHED
          : ReconciliationStatus.MISMATCH;

      // Check balance consistency
      let balanceBeforeActual = null;
      let balanceAfterActual = null;
      if (payoutTxns.length > 0) {
        balanceBeforeActual = Number(payoutTxns[0].balanceBefore);
        const lastTxn =
          bonusTxns.length > 0
            ? bonusTxns[bonusTxns.length - 1]
            : payoutTxns[payoutTxns.length - 1];
        balanceAfterActual = Number(lastTxn.balanceAfter);
      }

      const reconciliation = new Reconciliation();
      reconciliation.userId = position.userId;
      reconciliation.marketId = settlement.marketId;
      reconciliation.positionId = position.id;
      reconciliation.settlementId = settlement.id;
      reconciliation.type = ReconciliationType.SETTLEMENT;
      reconciliation.status = status;
      reconciliation.expectedAmount = expectedPayout;
      reconciliation.actualAmount = actualTotal;
      reconciliation.difference = difference;
      if (balanceBeforeActual !== null) {
        reconciliation.balanceBeforeActual = balanceBeforeActual;
      }
      if (balanceAfterActual !== null) {
        reconciliation.balanceAfterActual = balanceAfterActual;
      }
      reconciliation.details = {
        marketTitle: market?.title,
        outcomeLabel: winningOutcome?.label,
        betAmount: Number(position.amount),
        odds: payoutPool > 0 ? expectedPayout / Number(position.amount) : 0,
        houseEdge: Number(market?.houseEdgePct ?? 0),
        winnerPoolShare: expectedShare,
        bonusCapped: betIsBonusFunded && expectedBonus > 0,
        transactionIds: [...payoutTxns, ...bonusTxns].map((t) => t.id),
      };
      reconciliation.notes =
        status === ReconciliationStatus.MISMATCH
          ? `Expected BTN ${expectedPayout.toFixed(2)} (${expectedWithdrawable.toFixed(2)} withdrawable + ${expectedBonus.toFixed(2)} bonus), ` +
            `but found BTN ${actualTotal.toFixed(2)} (${actualWithdrawable.toFixed(2)} withdrawable + ${actualBonus.toFixed(2)} bonus). ` +
            `Difference: BTN ${difference.toFixed(2)}`
          : `Payout verified: BTN ${actualTotal.toFixed(2)}`;

      const saved = await this.reconciliationRepo.save(reconciliation);
      reconciliations.push(saved);

      if (status === ReconciliationStatus.MISMATCH) {
        this.logger.warn(
          `[Reconciliation] MISMATCH found for position ${position.id}: ` +
            `Expected ${expectedPayout}, Actual ${actualTotal}, Diff ${difference}`,
        );
      }
    }

    this.logger.log(
      `[Reconciliation] Completed settlement ${settlementId}: ` +
        `${reconciliations.length} records created`,
    );

    return reconciliations;
  }

  /**
   * Reconcile all settlements in a date range
   */
  async reconcileSettlementsByDateRange(
    from: Date,
    to: Date,
  ): Promise<ReconciliationReport> {
    const settlements = await this.settlementRepo
      .createQueryBuilder("s")
      .where("s.settledAt BETWEEN :from AND :to", { from, to })
      .getMany();

    const allReconciliations: Reconciliation[] = [];

    for (const settlement of settlements) {
      const records = await this.reconcileSettlement(settlement.id);
      allReconciliations.push(...records);
    }

    return this.generateReport(allReconciliations);
  }

  /**
   * Reconcile a specific market (after settlement)
   */
  async reconcileMarket(marketId: string): Promise<Reconciliation[]> {
    const settlement = await this.settlementRepo.findOne({
      where: { marketId },
    });

    if (!settlement) {
      throw new Error(`No settlement found for market ${marketId}`);
    }

    return this.reconcileSettlement(settlement.id);
  }

  /**
   * Check DK Bank transfer reconciliation
   * Verifies that external DK transfers match expected payouts
   */
  async reconcileDKTransfers(settlementId: string): Promise<Reconciliation[]> {
    this.logger.log(
      `[Reconciliation] Checking DK transfers for settlement ${settlementId}`,
    );

    const reconciliations = await this.reconciliationRepo.find({
      where: {
        settlementId,
        type: ReconciliationType.SETTLEMENT,
      },
    });

    // For each reconciliation, check if user has DK account and if transfer occurred
    for (const recon of reconciliations) {
      const user = await this.userRepo.findOne({
        where: { id: recon.userId },
        select: ["id", "dkAccountNumber", "dkAccountName"],
      });

      if (!user?.dkAccountNumber) {
        recon.notes = (recon.notes || "") + " | No DK account linked.";
        continue;
      }

      // Check for DK transfer logs or records
      // This would integrate with your DK gateway service to verify
      // For now, we'll mark it for manual review
      recon.notes =
        (recon.notes || "") +
        ` | DK account: ${user.dkAccountNumber}. Manual DK transfer verification required.`;
    }

    await this.reconciliationRepo.save(reconciliations);
    return reconciliations;
  }

  /**
   * Auto-correct small discrepancies (< 0.10 BTN)
   */
  async autoCorrectDiscrepancies(
    threshold: number = 0.1,
  ): Promise<Reconciliation[]> {
    return this.dataSource.transaction(async (em) => {
      const mismatches = await em.find(Reconciliation, {
        where: { status: ReconciliationStatus.MISMATCH },
      });

      const corrected: Reconciliation[] = [];

      for (const recon of mismatches) {
        const absDiff = Math.abs(Number(recon.difference));

        if (absDiff < threshold) {
          // Create correction transaction
          const { balance } = await em
            .getRepository(Transaction)
            .createQueryBuilder("t")
            .select("COALESCE(SUM(t.amount), 0)", "balance")
            .where("t.userId = :userId", { userId: recon.userId })
            .getRawOne();

          const balanceBefore = Number(balance);
          const correctionAmount = Number(recon.difference);

          const correctionTxn = em.create(Transaction, {
            userId: recon.userId,
            type: TransactionType.FREE_CREDIT,
            amount: correctionAmount,
            balanceBefore,
            balanceAfter: balanceBefore + correctionAmount,
            positionId: recon.positionId,
            note: `Reconciliation auto-correction for ${recon.id} (diff: ${correctionAmount.toFixed(2)} BTN)`,
          });

          await em.save(Transaction, correctionTxn);

          recon.status = ReconciliationStatus.CORRECTED;
          recon.correctionTransactionId = correctionTxn.id;
          recon.resolvedAt = new Date();
          recon.resolutionAction = `Auto-corrected ${correctionAmount.toFixed(2)} BTN (below threshold ${threshold})`;

          await em.save(Reconciliation, recon);
          corrected.push(recon);

          this.logger.log(
            `[Reconciliation] Auto-corrected ${recon.id}: ${correctionAmount.toFixed(2)} BTN`,
          );
        }
      }

      return corrected;
    });
  }

  /**
   * Generate reconciliation report
   */
  async generateReport(
    reconciliations?: Reconciliation[],
  ): Promise<ReconciliationReport> {
    if (!reconciliations) {
      reconciliations = await this.reconciliationRepo.find();
    }

    const total = reconciliations.length;
    const matched = reconciliations.filter(
      (r) => r.status === ReconciliationStatus.MATCHED,
    ).length;
    const mismatched = reconciliations.filter(
      (r) => r.status === ReconciliationStatus.MISMATCH,
    ).length;
    const pending = reconciliations.filter(
      (r) => r.status === ReconciliationStatus.PENDING,
    ).length;
    const corrected = reconciliations.filter(
      (r) => r.status === ReconciliationStatus.CORRECTED,
    ).length;

    const totalDifference = reconciliations.reduce(
      (sum, r) => sum + Math.abs(Number(r.difference)),
      0,
    );

    return {
      total,
      matched,
      mismatched,
      pending,
      corrected,
      totalDifference,
      records: reconciliations,
    };
  }

  /**
   * Get all reconciliations with filters
   */
  async getReconciliations(filters: {
    status?: ReconciliationStatus;
    userId?: string;
    marketId?: string;
    settlementId?: string;
    from?: Date;
    to?: Date;
    page?: number;
    limit?: number;
  }): Promise<{ data: Reconciliation[]; total: number; pages: number }> {
    const qb = this.reconciliationRepo.createQueryBuilder("r");

    if (filters.status) {
      qb.andWhere("r.status = :status", { status: filters.status });
    }
    if (filters.userId) {
      qb.andWhere("r.userId = :userId", { userId: filters.userId });
    }
    if (filters.marketId) {
      qb.andWhere("r.marketId = :marketId", { marketId: filters.marketId });
    }
    if (filters.settlementId) {
      qb.andWhere("r.settlementId = :settlementId", {
        settlementId: filters.settlementId,
      });
    }
    if (filters.from && filters.to) {
      qb.andWhere("r.createdAt BETWEEN :from AND :to", {
        from: filters.from,
        to: filters.to,
      });
    }

    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 50, 100);
    const skip = (page - 1) * limit;

    const [data, total] = await qb
      .orderBy("r.createdAt", "DESC")
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return {
      data,
      total,
      pages: Math.ceil(total / limit) || 1,
    };
  }

  /**
   * Get reconciliation by ID
   */
  async getReconciliationById(id: string): Promise<Reconciliation> {
    const recon = await this.reconciliationRepo.findOne({ where: { id } });
    if (!recon) {
      throw new Error(`Reconciliation ${id} not found`);
    }
    return recon;
  }

  /**
   * Get reconciliation statistics
   */
  async getStatistics(
    from?: Date,
    to?: Date,
  ): Promise<{
    total: number;
    byStatus: { status: string; count: number; totalDifference: number }[];
    byType: { type: string; count: number }[];
    totalDiscrepancy: number;
    avgDiscrepancy: number;
  }> {
    const qb = this.reconciliationRepo.createQueryBuilder("r");

    if (from && to) {
      qb.where("r.createdAt BETWEEN :from AND :to", { from, to });
    }

    const [total, byStatus, byType] = await Promise.all([
      qb.getCount(),
      this.reconciliationRepo
        .createQueryBuilder("r")
        .select("r.status", "status")
        .addSelect("COUNT(*)", "count")
        .addSelect("SUM(ABS(r.difference))", "totalDifference")
        .groupBy("r.status")
        .getRawMany(),
      this.reconciliationRepo
        .createQueryBuilder("r")
        .select("r.type", "type")
        .addSelect("COUNT(*)", "count")
        .groupBy("r.type")
        .getRawMany(),
    ]);

    const totalDiscrepancy = byStatus.reduce(
      (sum, s) => sum + Number(s.totalDifference || 0),
      0,
    );
    const avgDiscrepancy = total > 0 ? totalDiscrepancy / total : 0;

    return {
      total,
      byStatus,
      byType,
      totalDiscrepancy,
      avgDiscrepancy,
    };
  }
}
