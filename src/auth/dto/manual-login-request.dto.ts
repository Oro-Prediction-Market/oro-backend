import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsNotEmpty, Length, Matches } from "class-validator";

export class ManualLoginRequestDto {
  @ApiProperty({
    description: "Your Telegram user ID (numeric)",
    example: "123456789",
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d+$/, { message: "telegramId must be numeric" })
  telegramId: string;

  @ApiProperty({
    description: "Your 11-digit Bhutan CID number",
    example: "11000000000",
    minLength: 11,
    maxLength: 11,
  })
  @IsString()
  @IsNotEmpty()
  @Length(11, 11, { message: "CID must be exactly 11 digits" })
  @Matches(/^\d+$/, { message: "CID must be numeric" })
  cid: string;
}
