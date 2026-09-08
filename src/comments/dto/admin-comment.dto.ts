import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBooleanString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

export class AdminlistCommentsDto {
  /** "true" surfaces only reported comments, most-reported first. */
  @ApiPropertyOptional({ description: "Only comments with at least one flag" })
  @IsOptional()
  @IsBooleanString()
  flagged?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  marketId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  userId?: string;

  // `transform: true` on the global pipe does not coerce query strings to
  // numbers on its own — @Type is what does it. See reporting/dto.
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class AdminDeleteCommentDto {
  @ApiProperty({
    description: "Shown to the author in their notification — keep it human.",
  })
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason: string;
}

export class AdminMuteUserDto {
  @ApiProperty({ description: "Hours to block this user from commenting" })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24 * 365)
  hours: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}
