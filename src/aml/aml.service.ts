import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In } from "typeorm";
import { AmlAlert, AmlAlertType, AmlRiskLevel } from "./entities/aml-alert.entity";
import { AmlReport, AmlReportType } from "./entities/aml-report.entity";
import { AmlDetectorService } from "./aml-detector.service";
import { GenerateReportDto } from "./dto/generate-report.dto";

@Injectable()
export class AmlService {
  constructor(
    @InjectRepository(AmlAlert)
    private readonly alertRepo: Repository<AmlAlert>,
    @InjectRepository(AmlReport)
    private readonly reportRepo: Repository<AmlReport>,
    private readonly detector: AmlDetectorService,
  ) {}

  // ── Scan ─────────────────────────────────────────────────────────────────────

  async runScan(
    from: Date,
    to: Date,
  ): Promise<{ newAlerts: number; candidates: number; period: { from: Date; to: Date } }> {
    const candidates = await this.detector.runScan(from, to);
    let newCount = 0;

    for (const c of candidates) {
      // Skip if an identical alert type for this user already exists in the window
      const exists = await this.alertRepo
        .createQueryBuilder("a")
        .where("a.userId = :userId", { userId: c.userId })
        .andWhere("a.alertType = :alertType", { alertType: c.alertType })
        .andWhere("a.createdAt BETWEEN :from AND :to", { from, to })
        .getOne();

      if (exists) continue;

      await this.alertRepo.save(
        this.alertRepo.create({
          userId: c.userId,
          alertType: c.alertType,
          riskLevel: c.riskLevel,
          description: c.description,
          totalAmount: c.totalAmount,
          transactionCount: c.transactionCount,
          metadata: c.metadata,
        }),
      );
      newCount++;
    }

    return { newAlerts: newCount, candidates: candidates.length, period: { from, to } };
  }

  // ── Alerts ────────────────────────────────────────────────────────────────────

  async getAlerts(params: {
    userId?: string;
    alertType?: AmlAlertType;
    riskLevel?: AmlRiskLevel;
    isResolved?: boolean;
    from?: string;
    to?: string;
    page: number;
    limit: number;
  }) {
    const qb = this.alertRepo
      .createQueryBuilder("a")
      .leftJoinAndSelect("a.user", "user");

    if (params.userId) qb.andWhere("a.userId = :userId", { userId: params.userId });
    if (params.alertType) qb.andWhere("a.alertType = :alertType", { alertType: params.alertType });
    if (params.riskLevel) qb.andWhere("a.riskLevel = :riskLevel", { riskLevel: params.riskLevel });
    if (params.isResolved !== undefined)
      qb.andWhere("a.isResolved = :isResolved", { isResolved: params.isResolved });
    if (params.from) qb.andWhere("a.createdAt >= :from", { from: new Date(params.from) });
    if (params.to) qb.andWhere("a.createdAt <= :to", { to: new Date(params.to) });

    // Sort: HIGH first, then by date desc
    qb.orderBy(
      `CASE a.riskLevel WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`,
      "ASC",
    ).addOrderBy("a.createdAt", "DESC");

    const [data, total] = await qb
      .skip((params.page - 1) * params.limit)
      .take(params.limit)
      .getManyAndCount();

    return {
      data,
      total,
      page: params.page,
      pages: Math.ceil(total / params.limit) || 1,
    };
  }

  async getAlert(id: string): Promise<AmlAlert> {
    const alert = await this.alertRepo.findOne({
      where: { id },
      relations: ["user"],
    });
    if (!alert) throw new NotFoundException(`AML alert ${id} not found`);
    return alert;
  }

  async resolveAlert(
    id: string,
    adminId: string,
    resolution: string,
  ): Promise<AmlAlert> {
    const alert = await this.getAlert(id);
    alert.isResolved = true;
    alert.resolution = resolution;
    alert.resolvedBy = adminId;
    alert.resolvedAt = new Date();
    return this.alertRepo.save(alert);
  }

  // ── Reports ───────────────────────────────────────────────────────────────────

  async generateReport(
    dto: GenerateReportDto,
    adminId: string,
    adminName: string | null,
  ): Promise<AmlReport> {
    const from = new Date(dto.from);
    const to = new Date(dto.to);

    const alerts = await this.alertRepo
      .createQueryBuilder("a")
      .where("a.createdAt BETWEEN :from AND :to", { from, to })
      .getMany();

    const highRisk = alerts.filter((a) => a.riskLevel === AmlRiskLevel.HIGH).length;
    const mediumRisk = alerts.filter((a) => a.riskLevel === AmlRiskLevel.MEDIUM).length;
    const lowRisk = alerts.filter((a) => a.riskLevel === AmlRiskLevel.LOW).length;
    const affectedUsers = new Set(alerts.map((a) => a.userId)).size;

    const report = this.reportRepo.create({
      reportType: dto.reportType,
      periodFrom: from,
      periodTo: to,
      alertIds: alerts.map((a) => a.id),
      totalAlerts: alerts.length,
      highRiskCount: highRisk,
      mediumRiskCount: mediumRisk,
      lowRiskCount: lowRisk,
      affectedUsers,
      generatedBy: adminId,
      generatedByName: adminName,
      notes: dto.notes ?? null,
    });

    return this.reportRepo.save(report);
  }

  async getReports(page: number, limit: number) {
    const [data, total] = await this.reportRepo.findAndCount({
      order: { createdAt: "DESC" },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total, page, pages: Math.ceil(total / limit) || 1 };
  }

  async getReportWithAlerts(
    reportId: string,
  ): Promise<{ report: AmlReport; alerts: AmlAlert[] }> {
    const report = await this.reportRepo.findOne({ where: { id: reportId } });
    if (!report) throw new NotFoundException(`AML report ${reportId} not found`);

    const alerts =
      report.alertIds.length > 0
        ? await this.alertRepo
            .createQueryBuilder("a")
            .leftJoinAndSelect("a.user", "user")
            .where("a.id IN (:...ids)", { ids: report.alertIds })
            .orderBy(
              `CASE a.riskLevel WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`,
              "ASC",
            )
            .addOrderBy("a.createdAt", "DESC")
            .getMany()
        : [];

    return { report, alerts };
  }

  // ── Summary ───────────────────────────────────────────────────────────────────

  async getSummary() {
    const [totalAlerts, highRisk, mediumRisk, lowRisk, unresolved, totalReports] =
      await Promise.all([
        this.alertRepo.count(),
        this.alertRepo.count({ where: { riskLevel: AmlRiskLevel.HIGH } }),
        this.alertRepo.count({ where: { riskLevel: AmlRiskLevel.MEDIUM } }),
        this.alertRepo.count({ where: { riskLevel: AmlRiskLevel.LOW } }),
        this.alertRepo.count({ where: { isResolved: false } }),
        this.reportRepo.count(),
      ]);

    return {
      totalAlerts,
      byRisk: { high: highRisk, medium: mediumRisk, low: lowRisk },
      unresolved,
      totalReports,
    };
  }
}
