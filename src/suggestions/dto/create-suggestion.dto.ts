import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";
import { MarketCategory } from "../../entities/market.entity";

export class CreateSuggestionDto {
  @ApiProperty({ example: "Will Paro FC win the 2026 BPL title?" })
  @IsString()
  @MinLength(10)
  @MaxLength(200)
  title: string;

  @ApiPropertyOptional({ example: "They've led the table since matchday 3." })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ enum: MarketCategory, default: MarketCategory.OTHER })
  @IsOptional()
  @IsEnum(MarketCategory)
  category?: MarketCategory;
}
