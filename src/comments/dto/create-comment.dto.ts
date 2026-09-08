import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from "class-validator";

export const COMMENT_MAX_LENGTH = 500;

export class CreateCommentDto {
  @ApiProperty({
    maxLength: COMMENT_MAX_LENGTH,
    example: "City have kept four clean sheets in a row — taking them at 1.8x.",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(COMMENT_MAX_LENGTH, {
    message: `A comment cannot be longer than ${COMMENT_MAX_LENGTH} characters.`,
  })
  body: string;

  /**
   * Reply to this comment. Omit for a top-level comment. Must be a live
   * top-level comment on the same market — threading is one level deep.
   */
  @ApiPropertyOptional({ format: "uuid" })
  @IsOptional()
  @IsUUID()
  parentId?: string;
}

/**
 * An edit carries only the new text — the parent never changes, because moving
 * a comment to another thread would strand the replies underneath it.
 */
export class EditCommentDto {
  @ApiProperty({ maxLength: COMMENT_MAX_LENGTH })
  @IsString()
  @MinLength(1)
  @MaxLength(COMMENT_MAX_LENGTH, {
    message: `A comment cannot be longer than ${COMMENT_MAX_LENGTH} characters.`,
  })
  body: string;
}
