import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  UseGuards,
  Req,
  Res,
} from "@nestjs/common";
import { Response } from "express";
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiParam,
} from "@nestjs/swagger";
import { JwtAuthGuard, AdminGuard } from "../auth/guards";
import { AmlService } from "./aml.service";
import { AmlReportService } from "./aml-report.service";
import {
  AmlAlertsQueryDto,
  AmlScanDto,
  ResolveAlertDto,
} from "./dto/aml-query.dto";
import { GenerateReportDto } from "./dto/generate-report.dto";

@ApiTags("AML")
@Controller("aml")
@UseGuards(JwtAuthGuard, AdminGuard)
@ApiBearerAuth()
export class AmlController {
  constructor(
    private readonly aml: AmlService,
    private readonly reporter: AmlReportService,
  ) {}

  // ── Overview ──────────────────────────────────────────────────────────────────

  @Get("summary")
  @ApiOperation({ summary: "AML overview — total alerts, by risk level, open count (Admin)" })
  getSummary() {
    return this.aml.getSummary();
  }

  // ── Scan ──────────────────────────────────────────────────────────────────────

  @Post("scan")
  @ApiOperation({
    summary: "Run AML detection scan over a date range (Admin)",
    description:
      "Detects: rapid deposit-withdrawal, low gambling ratio, high transaction frequency, near-limit deposits. Defaults to the last 30 days.",
  })
  runScan(@Body() dto: AmlScanDto) {
    const to = dto.to ? new Date(dto.to) : new Date();
    const from = dto.from
      ? new Date(dto.from)
      : new Date(to.getTime() - 30 * 86_400_000);
    return this.aml.runScan(from, to);
  }

  // ── Alerts ────────────────────────────────────────────────────────────────────

  @Get("alerts")
  @ApiOperation({ summary: "List AML alerts with filters (Admin)" })
  getAlerts(@Query() query: AmlAlertsQueryDto) {
    return this.aml.getAlerts({
      userId: query.userId,
      alertType: query.alertType,
      riskLevel: query.riskLevel,
      isResolved: query.isResolved,
      from: query.from,
      to: query.to,
      page: query.page ?? 1,
      limit: query.limit ?? 50,
    });
  }

  @Get("alerts/:id")
  @ApiOperation({ summary: "Get a single AML alert by ID (Admin)" })
  @ApiParam({ name: "id", description: "Alert UUID" })
  getAlert(@Param("id") id: string) {
    return this.aml.getAlert(id);
  }

  @Patch("alerts/:id/resolve")
  @ApiOperation({ summary: "Mark an AML alert as resolved (Admin)" })
  @ApiParam({ name: "id", description: "Alert UUID" })
  resolveAlert(
    @Param("id") id: string,
    @Body() dto: ResolveAlertDto,
    @Req() req: any,
  ) {
    return this.aml.resolveAlert(id, req.user.id, dto.resolution);
  }

  // ── Reports ───────────────────────────────────────────────────────────────────

  @Get("reports")
  @ApiOperation({ summary: "List generated AML reports (Admin)" })
  @ApiQuery({ name: "page", required: false, example: 1 })
  @ApiQuery({ name: "limit", required: false, example: 20 })
  getReports(
    @Query("page") page = "1",
    @Query("limit") limit = "20",
  ) {
    return this.aml.getReports(Number(page), Number(limit));
  }

  @Post("reports/generate")
  @ApiOperation({
    summary: "Generate a new AML report snapshot (Admin)",
    description:
      "Captures all alerts in the given period into a versioned report record. Returns report metadata including the ID needed for download.",
  })
  generateReport(@Body() dto: GenerateReportDto, @Req() req: any) {
    const adminName: string | null =
      req.user?.username ?? req.user?.email ?? null;
    return this.aml.generateReport(dto, req.user.id, adminName);
  }

  @Get("reports/:id")
  @ApiOperation({ summary: "Get AML report metadata (Admin)" })
  @ApiParam({ name: "id", description: "Report UUID" })
  async getReport(@Param("id") id: string) {
    const { report } = await this.aml.getReportWithAlerts(id);
    return report;
  }

  @Get("reports/:id/download")
  @ApiOperation({
    summary: "Download AML report as PDF or CSV (Admin)",
    description: "Pass ?format=pdf (default) or ?format=csv",
  })
  @ApiParam({ name: "id", description: "Report UUID" })
  @ApiQuery({ name: "format", enum: ["pdf", "csv"], required: false })
  async downloadReport(
    @Param("id") id: string,
    @Query("format") format: "pdf" | "csv" = "pdf",
    @Res() res: Response,
  ) {
    const { report, alerts } = await this.aml.getReportWithAlerts(id);
    const slug = `aml-${report.reportType}-${id.slice(0, 8)}`;

    if (format === "csv") {
      const csv = this.reporter.generateCsv(report, alerts);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${slug}.csv"`,
      );
      return res.end(csv);
    }

    const buffer = await this.reporter.generatePdfBuffer(report, alerts);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${slug}.pdf"`,
    );
    return res.end(buffer);
  }
}
