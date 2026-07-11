import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsOptional,
  IsNumber,
  IsDateString,
  IsArray,
  ArrayMinSize,
  Min,
  Max,
  ValidateNested,
  IsNotEmpty,
} from "class-validator";
import { Type } from "class-transformer";

export class CandidateInputDto {
  @ApiProperty({ description: "Candidate name, e.g. 'Sonam'" })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imageUrl?: string | null;
}

/**
 * Grouped multi-binary market (Polymarket-style): one umbrella event with N
 * candidates, each candidate becoming its own 2-outcome Yes/No parimutuel
 * market. All children share a groupId + groupTitle.
 */
export class CreateMarketGroupDto {
  @ApiProperty({ description: "Umbrella event title, e.g. 'Who will win the 2026 election?'" })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() imageUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() resolutionCriteria?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() opensAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() closesAt?: string;

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

  @ApiPropertyOptional({ default: "political" })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() subcategory?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() settlementSource?: string;

  @ApiProperty({ type: [CandidateInputDto], description: "One Yes/No child market is created per candidate" })
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => CandidateInputDto)
  candidates: CandidateInputDto[];
}
