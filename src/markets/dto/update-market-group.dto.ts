import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsOptional,
  IsNumber,
  IsDateString,
  IsArray,
  Min,
  Max,
  ValidateNested,
  IsNotEmpty,
} from "class-validator";
import { Type } from "class-transformer";

/**
 * One candidate's editable fields. `id` is the candidate's own market id (each
 * candidate is a separate Yes/No market sharing the group's groupId).
 */
export class CandidateUpdateDto {
  @ApiPropertyOptional({
    description:
      "Candidate market id. Omit to ADD a new candidate to the group (name required then).",
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  id?: string;

  @ApiPropertyOptional({ description: "Candidate display name, e.g. 'Sonam'" })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: "Candidate avatar image URL" })
  @IsOptional()
  @IsString()
  imageUrl?: string | null;
}

/**
 * Edit a whole grouped multi-binary event at once. Shared fields (title,
 * timing, resolution criteria, etc.) fan out to every sibling candidate market;
 * per-candidate name/image are applied individually via `candidates`.
 */
export class UpdateMarketGroupDto {
  /** Umbrella event title — rewrites groupTitle and each sibling's title prefix. */
  @ApiPropertyOptional() @IsOptional() @IsString() title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() resolutionCriteria?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() category?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() subcategory?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() settlementSource?: string;
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

  @ApiPropertyOptional({ type: [CandidateUpdateDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CandidateUpdateDto)
  candidates?: CandidateUpdateDto[];
}
