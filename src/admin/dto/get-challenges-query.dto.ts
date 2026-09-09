import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsOptional,
  IsIn,
  IsInt,
  IsUUID,
  IsBooleanString,
  Min,
  Max,
  MaxLength,
} from "class-validator";
import { Type } from "class-transformer";
import { ChallengeStatus } from "../../entities/challenge.entity";

/**
 * "all" plus every state the entity defines. Built from the enum rather than
 * written out, so a new duel state becomes filterable without an edit here —
 * the same reasoning as TIER_ORDER in GetUsersQueryDto.
 */
const STATUS_FILTER_VALUES = ["all", ...Object.values(ChallengeStatus)];

export class GetChallengesQueryDto {
  @ApiPropertyOptional({
    description: "Search across duel id, market title and either username",
  })
  @IsOptional()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ enum: STATUS_FILTER_VALUES, default: "all" })
  @IsOptional()
  @IsIn(STATUS_FILTER_VALUES)
  status?: string;

  @ApiPropertyOptional({
    enum: ["true", "false"],
    description:
      "Only duels stranded on a cancelled market. cancelMarket() never calls " +
      "settleByMarket(), so an open or active duel on a cancelled market is " +
      "never settled or refunded and both wagers stay debited.",
  })
  @IsOptional()
  @IsBooleanString()
  stuck?: string;

  @ApiPropertyOptional({ description: "Only duels on this market" })
  @IsOptional()
  @IsUUID()
  marketId?: string;

  @ApiPropertyOptional({
    description: "Duels this user is on, as either creator or joiner",
  })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ default: 1, description: "Page number (1-based)" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    default: 20,
    description: "Results per page (max 100)",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
