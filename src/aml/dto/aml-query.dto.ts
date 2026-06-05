import {
  IsOptional,
  IsString,
  IsEnum,
  IsBoolean,
  IsInt,
  Min,
} from "class-validator";
import { Type, Transform } from "class-transformer";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { AmlAlertType, AmlRiskLevel } from "../entities/aml-alert.entity";

export class AmlAlertsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ enum: AmlAlertType })
  @IsOptional()
  @IsEnum(AmlAlertType)
  alertType?: AmlAlertType;

  @ApiPropertyOptional({ enum: AmlRiskLevel })
  @IsOptional()
  @IsEnum(AmlRiskLevel)
  riskLevel?: AmlRiskLevel;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === "true" || value === true)
  @IsBoolean()
  isResolved?: boolean;

  @ApiPropertyOptional({ description: "ISO date string" })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ description: "ISO date string" })
  @IsOptional()
  @IsString()
  to?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 50;
}

export class AmlScanDto {
  @ApiPropertyOptional({ description: "ISO date — defaults to 30 days ago" })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ description: "ISO date — defaults to now" })
  @IsOptional()
  @IsString()
  to?: string;
}

export class ResolveAlertDto {
  @ApiPropertyOptional()
  @IsString()
  resolution: string;
}
