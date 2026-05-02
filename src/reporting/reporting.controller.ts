import { Controller, Get, Query, Param, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards";
import { AdminGuard } from "../auth/guards";
import { ReportingService } from "./reporting.service";
import { TransactionAuditsQueryDto } from "./dto/transaction-audits-query.dto";
import { TransactionStatsQueryDto } from "./dto/transaction-stats-query.dto";
import { PaginationQueryDto } from "./dto/pagination-query.dto";
import { AdminAuditLogsQueryDto } from "./dto/admin-audit-logs-query.dto";
import { DisputesQueryDto } from "./dto/disputes-query.dto";

@ApiTags("Reporting")
@Controller("reporting")
export class ReportingController {
  constructor(private readonly reportingService: ReportingService) {}

  // ============================================================================
  // Transaction Audit Endpoints (Admin only)
  // ============================================================================

  @Get("transaction-audits")
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get transaction audit logs (Admin only)",
    description: "Query transaction audits with filters for admin oversight",
  })
  @ApiResponse({ status: 200, description: "Paginated transaction audits" })
  async getTransactionAudits(
    @Query() query: TransactionAuditsQueryDto,
  ): Promise<any> {
    return this.reportingService.findTransactionAudits(
      query.userId,
      query.type,
      query.status,
      query.marketId,
      query.from,
      query.to,
      query.search,
      query.page || 1,
      query.limit || 50,
    );
  }

  @Get("transaction-audits/stats")
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get transaction statistics (Admin only)",
    description: "Summary statistics for admin dashboard",
  })
  async getTransactionStats(@Query() query: TransactionStatsQueryDto) {
    return this.reportingService.getTransactionStats(query.from, query.to);
  }

  @Get("transaction-audits/all")
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get all transaction audits (Admin only)",
    description: "Returns paginated list of all transactions",
  })
  async getAllTransactionAudits(
    @Query() query: PaginationQueryDto,
  ): Promise<any> {
    return this.reportingService.findTransactionAudits(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      query.page || 1,
      query.limit || 50,
    );
  }

  @Get("transaction-audits/:id")
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get transaction audit by ID (Admin only)",
  })
  @ApiParam({ name: "id", description: "Transaction audit ID", required: true })
  async getTransactionAuditById(@Param("id") id: string) {
    return this.reportingService.findTransactionAuditById(id);
  }

  // ============================================================================
  // Admin Audit Log Endpoints
  // ============================================================================

  @Get("admin-audit-logs")
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get admin audit logs (Admin only)",
    description: "Query admin audit logs with filters",
  })
  async getAdminAuditLogs(
    @Query() query: AdminAuditLogsQueryDto,
  ): Promise<any> {
    return this.reportingService.findAdminAuditLogs(
      query.userId,
      query.action,
      query.page || 1,
      query.limit || 50,
    );
  }

  // ============================================================================
  // Dispute Reporting Endpoints (GMC Authority / Admin)
  // ============================================================================

  @Get("disputes")
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get disputes (GMC/Admin only)",
    description: "Query disputes from markets module with filters",
  })
  async getDisputes(@Query() query: DisputesQueryDto): Promise<any> {
    return this.reportingService.findDisputes(
      query.marketId,
      query.from,
      query.to,
      query.page || 1,
      query.limit || 50,
    );
  }

  @Get("disputes/stats")
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get dispute statistics (GMC/Admin only)",
  })
  async getDisputeStats() {
    return this.reportingService.getDisputeStats();
  }

  @Get("disputes/all")
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get all disputes (GMC/Admin only)",
    description: "Returns paginated list of all disputes",
  })
  async getAllDisputes(@Query() query: PaginationQueryDto): Promise<any> {
    return this.reportingService.findDisputes(
      undefined,
      undefined,
      undefined,
      query.page || 1,
      query.limit || 50,
    );
  }

  @Get("disputes/:id")
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get dispute by ID (GMC/Admin only)",
  })
  @ApiParam({ name: "id", description: "Dispute ID", required: true })
  async getDisputeById(@Param("id") id: string) {
    return this.reportingService.findDisputeById(id);
  }

  @Get("disputes/summary/all")
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get all markets dispute summary (Admin/GMC only)",
    description: "Returns dispute summaries for all markets with disputes",
  })
  async getAllMarketsDisputeSummary() {
    return this.reportingService.getAllMarketsDisputeSummary();
  }

  @Get("disputes/market/:marketId/summary")
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get dispute summary for a market (Admin/GMC only)",
    description:
      "Combined view of all disputes for a market with bond totals and voter count",
  })
  @ApiParam({ name: "marketId", description: "Market ID", required: true })
  async getMarketDisputeSummary(@Param("marketId") marketId: string) {
    return this.reportingService.getMarketDisputeSummary(marketId);
  }

  @Get("disputes/pending/gmc")
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get pending disputes for GMC review (Admin/GMC only)",
    description: "Get all unresolved disputes ordered by bond amount",
  })
  async getPendingDisputes(@Query() query: PaginationQueryDto): Promise<any> {
    return this.reportingService.getPendingDisputes(
      query.page || 1,
      query.limit || 50,
    );
  }
}
