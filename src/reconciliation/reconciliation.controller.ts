import {
  Controller,
  Get,
  Post,
  Query,
  Param,
  Body,
  UseGuards,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from "@nestjs/swagger";
import { ReconciliationService } from "./reconciliation.service";
import {
  ReconcileSettlementDto,
  ReconcileMarketDto,
  ReconcileDateRangeDto,
  AutoCorrectDto,
  ReconciliationFiltersDto,
} from "./dto/reconciliation.dto";
import { JwtAuthGuard, AdminGuard } from "../auth/guards";

@ApiTags("Reconciliation")
@Controller("reconciliation")
@UseGuards(JwtAuthGuard, AdminGuard)
@ApiBearerAuth()
export class ReconciliationController {
  constructor(private readonly reconciliationService: ReconciliationService) {}

  @Post("settlement")
  @ApiOperation({
    summary: "Reconcile a specific settlement (Admin only)",
    description:
      "Verifies all payout transactions for a settlement and identifies discrepancies",
  })
  @ApiResponse({ status: 201, description: "Reconciliation completed" })
  async reconcileSettlement(@Body() dto: ReconcileSettlementDto) {
    const records = await this.reconciliationService.reconcileSettlement(
      dto.settlementId,
    );
    return {
      message: `Reconciliation completed for settlement ${dto.settlementId}`,
      recordsCreated: records.length,
      records,
    };
  }

  @Post("market")
  @ApiOperation({
    summary: "Reconcile a specific market (Admin only)",
    description: "Reconciles all settlements for a given market",
  })
  @ApiResponse({ status: 201, description: "Reconciliation completed" })
  async reconcileMarket(@Body() dto: ReconcileMarketDto) {
    const records = await this.reconciliationService.reconcileMarket(
      dto.marketId,
    );
    return {
      message: `Reconciliation completed for market ${dto.marketId}`,
      recordsCreated: records.length,
      records,
    };
  }

  @Post("date-range")
  @ApiOperation({
    summary: "Reconcile all settlements in a date range (Admin only)",
    description:
      "Batch reconciliation for all settlements within the specified period",
  })
  @ApiResponse({ status: 201, description: "Batch reconciliation completed" })
  async reconcileDateRange(@Body() dto: ReconcileDateRangeDto) {
    const report =
      await this.reconciliationService.reconcileSettlementsByDateRange(
        new Date(dto.from),
        new Date(dto.to),
      );
    return {
      message: `Reconciliation completed for date range ${dto.from} to ${dto.to}`,
      report,
    };
  }

  @Post("auto-correct")
  @ApiOperation({
    summary: "Auto-correct small discrepancies (Admin only)",
    description:
      "Automatically corrects mismatches below the specified threshold",
  })
  @ApiResponse({ status: 201, description: "Auto-correction completed" })
  async autoCorrect(@Body() dto: AutoCorrectDto) {
    const threshold = dto.threshold || 0.1;
    const corrected =
      await this.reconciliationService.autoCorrectDiscrepancies(threshold);
    return {
      message: `Auto-correction completed (threshold: ${threshold} BTN)`,
      correctedCount: corrected.length,
      corrected,
    };
  }

  @Get()
  @ApiOperation({
    summary: "Get all reconciliations with filters (Admin only)",
    description:
      "Retrieve paginated reconciliation records with optional filters",
  })
  @ApiResponse({ status: 200, description: "Reconciliations retrieved" })
  async getReconciliations(@Query() filters: ReconciliationFiltersDto) {
    const result = await this.reconciliationService.getReconciliations({
      ...filters,
      from: filters.from ? new Date(filters.from) : undefined,
      to: filters.to ? new Date(filters.to) : undefined,
    });
    return result;
  }

  @Get("statistics")
  @ApiOperation({
    summary: "Get reconciliation statistics (Admin only)",
    description: "Summary statistics for reconciliations",
  })
  @ApiResponse({ status: 200, description: "Statistics retrieved" })
  async getStatistics(@Query("from") from?: string, @Query("to") to?: string) {
    return this.reconciliationService.getStatistics(
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
    );
  }

  @Get("report")
  @ApiOperation({
    summary: "Generate comprehensive reconciliation report (Admin only)",
    description: "Full reconciliation report with all records",
  })
  @ApiResponse({ status: 200, description: "Report generated" })
  async generateReport() {
    return this.reconciliationService.generateReport();
  }

  @Get(":id")
  @ApiOperation({
    summary: "Get reconciliation by ID (Admin only)",
  })
  @ApiParam({ name: "id", description: "Reconciliation ID" })
  @ApiResponse({ status: 200, description: "Reconciliation retrieved" })
  async getReconciliationById(@Param("id") id: string) {
    return this.reconciliationService.getReconciliationById(id);
  }

  @Post("dk-transfers/:settlementId")
  @ApiOperation({
    summary: "Reconcile DK Bank transfers for a settlement (Admin only)",
    description: "Verifies external DK transfers match expected payouts",
  })
  @ApiParam({ name: "settlementId", description: "Settlement ID" })
  @ApiResponse({
    status: 201,
    description: "DK transfer reconciliation completed",
  })
  async reconcileDKTransfers(@Param("settlementId") settlementId: string) {
    const records =
      await this.reconciliationService.reconcileDKTransfers(settlementId);
    return {
      message: `DK transfer reconciliation completed for settlement ${settlementId}`,
      recordsUpdated: records.length,
      records,
    };
  }
}
