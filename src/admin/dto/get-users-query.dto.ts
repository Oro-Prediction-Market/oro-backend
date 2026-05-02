import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsIn, IsInt, Min, Max, MaxLength } from "class-validator";
import { Type } from "class-transformer";

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
    enum: ["name", "balance", "streak", "joined"],
    default: "joined",
  })
  @IsOptional()
  @IsIn(["name", "balance", "streak", "joined"])
  sortField?: "name" | "balance" | "streak" | "joined";

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
