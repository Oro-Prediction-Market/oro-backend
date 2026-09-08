import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsOptional, IsString, MaxLength } from "class-validator";
import { CommentFlagReason } from "../../entities/market-comment-flag.entity";

export class FlagCommentDto {
  @ApiProperty({ enum: CommentFlagReason })
  @IsEnum(CommentFlagReason)
  reason: CommentFlagReason;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
