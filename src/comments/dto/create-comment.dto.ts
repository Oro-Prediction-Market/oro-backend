import { ApiProperty } from "@nestjs/swagger";
import { IsString, MaxLength, MinLength } from "class-validator";

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
}
