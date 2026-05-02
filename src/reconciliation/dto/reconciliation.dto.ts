import {
  IsEnum,
  IsOptional,
  IsDateString,
  IsUUID,
  IsNumber,
  Min,
  Max,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ReconciliationStatus,
  ReconciliationType,
} from "../../entities/reconciliation.entity";

export class ReconcileSettlementDto {
  @ApiProperty({ description: "Settlement ID to reconcile" })
  @IsUUID()
  settlementId: string;
}

export class ReconcileMarketDto {
  @ApiProperty({ description: "Market ID to reconcile" })
  @IsUUID()
  marketId: string;
}

export class ReconcileDateRangeDto {
  @ApiProperty({ description: "Start date (ISO 8601)" })
  @IsDateString()
  from: string;

  @ApiProperty({ description: "End date (ISO 8601)" })
  @IsDateString()
  to: string;
}

export class AutoCorrectDto {
  @ApiPropertyOptional({
    description: "Threshold for auto-correction (BTN)",
    default: 0.1,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  threshold?: number;
}

export class ReconciliationFiltersDto {
  @ApiPropertyOptional({ enum: ReconciliationStatus })
  @IsOptional()
  @IsEnum(ReconciliationStatus)
  status?: ReconciliationStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  marketId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  settlementId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number;
}
