import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsIn, IsInt, IsNumber, Min, Max, MaxLength } from "class-validator";
import { Type } from "class-transformer";
import { TIER_ORDER } from "../../markets/tiers";

/** "all" plus every rung, so the filter validates against the real ladder. */
const TIER_FILTER_VALUES = ["all", ...TIER_ORDER];

export class GetUsersQueryDto {
  @ApiPropertyOptional({ description: "Search query (max 200 chars)" })
  @IsOptional()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ enum: ["all", "admin", "user"], default: "all" })
  @IsOptional()
  @IsIn(["all", "admin", "user"])
  role?: "all" | "admin" | "user";

  @ApiPropertyOptional({ enum: ["all", "linked", "unlinked"], default: "all" })
  @IsOptional()
  @IsIn(["all", "linked", "unlinked"])
  dkStatus?: "all" | "linked" | "unlinked";

  @ApiPropertyOptional({
    enum: ["all", "BTN", "USDT"],
    default: "all",
    description:
      "Native currency of the account. This list is built around the DK Bank " +
      "rail, so a USDT account shows here with every one of those columns " +
      "empty; International Accounts is the page for those.",
  })
  @IsOptional()
  @IsIn(["all", "BTN", "USDT"])
  currency?: "all" | "BTN" | "USDT";

  @ApiPropertyOptional({
    enum: TIER_FILTER_VALUES,
    default: "all",
    description:
      "Reputation rung. Validated against TIER_ORDER, so adding a rung to the " +
      "ladder makes it filterable here without touching this DTO.",
  })
  @IsOptional()
  @IsIn(TIER_FILTER_VALUES)
  tier?: string;

  @ApiPropertyOptional({
    enum: ["name", "balance", "streak", "joined", "profit"],
    default: "joined",
  })
  @IsOptional()
  @IsIn(["name", "balance", "streak", "joined", "profit"])
  sortField?: "name" | "balance" | "streak" | "joined" | "profit";

  @ApiPropertyOptional({
    enum: ["all", "profitable", "losing", "even", "none"],
    default: "all",
    description:
      "Betting P&L on settled, real-money bets: payouts minus stakes. " +
      "`none` = no settled bets yet. Measured in BTN, or USDT when the " +
      "currency filter is USDT — never the two added together.",
  })
  @IsOptional()
  @IsIn(["all", "profitable", "losing", "even", "none"])
  profit?: "all" | "profitable" | "losing" | "even" | "none";

  @ApiPropertyOptional({ description: "Minimum betting P&L (inclusive)" })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  minProfit?: number;

  @ApiPropertyOptional({ description: "Maximum betting P&L (inclusive)" })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  maxProfit?: number;

  @ApiPropertyOptional({ enum: ["asc", "desc"], default: "desc" })
  @IsOptional()
  @IsIn(["asc", "desc"])
  sortDir?: "asc" | "desc";

  @ApiPropertyOptional({ default: 1, description: "Page number (1-based)" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, description: "Results per page (max 100)" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
