import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { User } from "../entities/user.entity";
import { Market } from "../entities/market.entity";
import { Dispute, DisputeBondStatus } from "../entities/dispute.entity";
import { Transaction, BTN_CURRENCY } from "../entities/transaction.entity";
import { AuditLog } from "../entities/audit-log.entity";

export interface PaginationResult<T> {
  data: T[];
  total: number;
  page: number;
  pages: number;
}

@Injectable()
export class ReportingService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Market)
    private readonly marketRepo: Repository<Market>,
    @InjectRepository(Dispute)
    private readonly disputeRepo: Repository<Dispute>,
    @InjectRepository(Transaction)
    private readonly transactionRepo: Repository<Transaction>,
    @InjectRepository(AuditLog)
    private readonly auditLogRepo: Repository<AuditLog>,
  ) {}

  // ============================================================================
  // Transaction / Audit Log Reporting (from existing tables)
  // ============================================================================

  async findTransactionAudits(
    userId?: string,
    type?: string,
    status?: string,
    marketId?: string,
    from?: string,
    to?: string,
    search?: string,
    page: number = 1,
    limit: number = 50,
  ): Promise<PaginationResult<Transaction>> {
    const qb = this.transactionRepo.createQueryBuilder("t").leftJoinAndSelect("t.user", "user");
    if (userId) qb.andWhere("t.userId = :userId", { userId });
    if (type) qb.andWhere("t.type = :type", { type });
    if (status) qb.andWhere("t.status = :status", { status });
    if (marketId) qb.andWhere("t.marketId = :marketId", { marketId });
    if (from && to) qb.andWhere("t.createdAt BETWEEN :from AND :to", { from: new Date(from), to: new Date(to) });
    if (search) qb.andWhere("LOWER(t.note) LIKE :search", { search: `%${search.toLowerCase()}%` });
    const [data, total] = await qb.orderBy("t.createdAt", "DESC").skip((page - 1) * limit).take(limit).getManyAndCount();
    return { data, total, page, pages: Math.ceil(total / limit) || 1 };
  }

  async findTransactionAuditById(id: string): Promise<Transaction> {
    const txn = await this.transactionRepo.findOne({ where: { id }, relations: ["user"] });
    if (!txn) throw new NotFoundException(`Transaction ${id} not found`);
    return txn;
  }

  async getTransactionStats(from?: string, to?: string): Promise<any> {
    const qb = this.transactionRepo.createQueryBuilder("t");
    if (from && to) qb.where("t.createdAt BETWEEN :from AND :to", { from: new Date(from), to: new Date(to) });
    const [totalCount, byType] = await Promise.all([
      qb.getCount(),
      this.transactionRepo
        .createQueryBuilder("t")
        .select("t.type", "type")
        .addSelect("t.currency", "currency")
        .addSelect("COUNT(*)", "count")
        .addSelect("SUM(t.amount)", "totalAmount")
        .groupBy("t.type, t.currency")
        .getRawMany(),
    ]);
    return { totalCount, byType };
  }

  async findAdminAuditLogs(userId?: string, action?: string, page: number = 1, limit: number = 50): Promise<PaginationResult<AuditLog>> {
    const qb = this.auditLogRepo.createQueryBuilder("log").leftJoinAndSelect("log.admin", "admin");
    if (userId) qb.andWhere("log.userId = :userId", { userId });
    if (action) qb.andWhere("log.action = :action", { action });
    const [data, total] = await qb.orderBy("log.createdAt", "DESC").skip((page - 1) * limit).take(limit).getManyAndCount();
    return { data, total, page, pages: Math.ceil(total / limit) || 1 };
  }

  // ============================================================================
  // Dispute Reporting (from existing disputes table)
  // ============================================================================

  async findDisputes(
    marketId?: string,
    from?: string,
    to?: string,
    page: number = 1,
    limit: number = 50,
  ): Promise<PaginationResult<Dispute>> {
    const qb = this.disputeRepo.createQueryBuilder("d").leftJoinAndSelect("d.user", "user").leftJoinAndSelect("d.market", "market");
    if (marketId) qb.andWhere("d.marketId = :marketId", { marketId });
    if (from && to) qb.andWhere("d.createdAt BETWEEN :from AND :to", { from: new Date(from), to: new Date(to) });
    const [data, total] = await qb.orderBy("d.createdAt", "DESC").skip((page - 1) * limit).take(limit).getManyAndCount();
    return { data, total, page, pages: Math.ceil(total / limit) || 1 };
  }

  async findDisputeById(id: string): Promise<Dispute> {
    const dispute = await this.disputeRepo.findOne({ where: { id }, relations: ["user", "market"] });
    if (!dispute) throw new NotFoundException(`Dispute ${id} not found`);
    return dispute;
  }

  /**
   * Bond totals, split by the currency the bonds were locked in.
   *
   * Resolution contests are per book, so a single `SUM(bondAmount)` adds
   * ngultrum to USDT and reports a number that means nothing — the reporting
   * equivalent of the mint-money bug `ledger-currency-guard.spec.ts` exists to
   * prevent. `totalBond` is kept as the BTN figure, which is what it has always
   * been in practice, and `bondsByCurrency` carries the rest.
   */
  private bondTotals(
    rows: { currency: string; totalBond: string | null }[],
  ): { totalBond: number; bondsByCurrency: Record<string, number> } {
    const bondsByCurrency: Record<string, number> = {};
    for (const row of rows) {
      const ccy = row.currency ?? BTN_CURRENCY;
      bondsByCurrency[ccy] =
        (bondsByCurrency[ccy] ?? 0) + Number(row.totalBond ?? 0);
    }
    return {
      totalBond: bondsByCurrency[BTN_CURRENCY] ?? 0,
      bondsByCurrency,
    };
  }

  async getDisputeStats(): Promise<any> {
    const [total, pending, resolved, bondRows] = await Promise.all([
      this.disputeRepo.count(),
      this.disputeRepo.count({ where: { bondStatus: DisputeBondStatus.LOCKED } }),
      this.disputeRepo.createQueryBuilder("d")
        .where("d.bondStatus IN (:...statuses)", {
          statuses: [DisputeBondStatus.REWARDED, DisputeBondStatus.FORFEITED],
        })
        .getCount(),
      this.disputeRepo.createQueryBuilder("d")
        .select("d.currency", "currency")
        .addSelect("SUM(d.bondAmount)", "totalBond")
        .groupBy("d.currency")
        .getRawMany(),
    ]);
    return {
      total,
      pending,
      resolved,
      ...this.bondTotals(bondRows ?? []),
    };
  }

  /** {@link bondTotals} for already-loaded dispute rows. */
  private bondsFromRows(
    disputes: { currency: string; bondAmount: number }[],
  ): { totalBond: number; bondsByCurrency: Record<string, number> } {
    const bondsByCurrency: Record<string, number> = {};
    for (const d of disputes) {
      const ccy = d.currency ?? BTN_CURRENCY;
      bondsByCurrency[ccy] = (bondsByCurrency[ccy] ?? 0) + Number(d.bondAmount);
    }
    return {
      totalBond: bondsByCurrency[BTN_CURRENCY] ?? 0,
      bondsByCurrency,
    };
  }

  async getMarketDisputeSummary(marketId: string): Promise<any> {
    const market = await this.marketRepo.findOne({ where: { id: marketId }, relations: ["outcomes"] });
    if (!market) throw new NotFoundException(`Market ${marketId} not found`);
    const disputes = await this.disputeRepo.find({ where: { marketId }, relations: ["user"], order: { createdAt: "DESC" } });
    const bonds = this.bondsFromRows(disputes);
    const uniqueVoters = new Set(disputes.map(d => d.userId)).size;
    return { market, disputes, ...bonds, uniqueVoters, hasMinVoters: uniqueVoters >= 3 };
  }

  async getAllMarketsDisputeSummary(): Promise<any[]> {
    const markets = await this.marketRepo.find({ relations: ["outcomes"] });
    const summaries = await Promise.all(
      markets.map(async (market) => {
        const disputes = await this.disputeRepo.find({ where: { marketId: market.id }, relations: ["user"] });
        const bonds = this.bondsFromRows(disputes);
        const uniqueVoters = new Set(disputes.map(d => d.userId)).size;
        return { market, disputeCount: disputes.length, ...bonds, uniqueVoters, hasMinVoters: uniqueVoters >= 3 };
      })
    );
    // Ranked by the ngultrum total, which is what this list has always ordered
    // by. A cross-currency ranking would need an exchange rate, and there is
    // deliberately none in this system — a USDT-only contest therefore sorts as
    // zero here. `bondsByCurrency` is the figure to read per row.
    return summaries.filter(s => s.disputeCount > 0).sort((a, b) => b.totalBond - a.totalBond);
  }

  async getPendingDisputes(page: number = 1, limit: number = 50): Promise<PaginationResult<Dispute>> {
    const qb = this.disputeRepo.createQueryBuilder("d")
      .leftJoinAndSelect("d.user", "user")
      .leftJoinAndSelect("d.market", "market")
      .where("d.bondStatus = :status", { status: DisputeBondStatus.LOCKED });
    const [data, total] = await qb
      .orderBy("d.bondAmount", "DESC")
      .addOrderBy("d.createdAt", "ASC")
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { data, total, page, pages: Math.ceil(total / limit) || 1 };
  }
}
