import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsOptional,
  IsNumber,
  IsDateString,
  IsArray,
  Min,
  Max,
} from "class-validator";

export class UpdateMarketDto {
  @ApiPropertyOptional() @IsOptional() @IsString() title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() category?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() subcategory?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() imageUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() imageUrlAlt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() resolutionCriteria?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() opensAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() closesAt?: string;
  /**
   * Rename existing outcome labels and/or set per-outcome image by ID.
   * Each element: { id: string; label: string; imageUrl?: string }
   * Must include all outcomes — matched by id, order-independent.
   */
  @ApiPropertyOptional({ type: "array", items: { type: "object" } })
  @IsOptional()
  @IsArray()
  outcomes?: { id: string; label: string; imageUrl?: string | null }[];
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(50)
  houseEdgePct?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(100)
  liquidityParam?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  mechanism?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  settlementSource?: string;
}
