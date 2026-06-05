import { IsString, IsOptional, IsEnum } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { AmlReportType } from "../entities/aml-report.entity";

export class GenerateReportDto {
  @ApiProperty({ enum: AmlReportType, example: AmlReportType.PERIODIC })
  @IsEnum(AmlReportType)
  reportType: AmlReportType;

  @ApiProperty({ description: "Period start — ISO date string", example: "2026-05-01" })
  @IsString()
  from: string;

  @ApiProperty({ description: "Period end — ISO date string", example: "2026-05-31" })
  @IsString()
  to: string;

  @ApiPropertyOptional({ description: "Optional compliance officer notes" })
  @IsOptional()
  @IsString()
  notes?: string;
}
