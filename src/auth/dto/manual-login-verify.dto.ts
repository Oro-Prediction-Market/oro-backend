import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsNotEmpty, Length, Matches } from "class-validator";

export class ManualLoginVerifyDto {
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

  @ApiProperty({
    description: "6-digit OTP sent to your Telegram",
    example: "123456",
    minLength: 6,
    maxLength: 6,
  })
  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: "OTP must be exactly 6 digits" })
  @Matches(/^\d+$/, { message: "OTP must be numeric" })
  otp: string;

  @ApiProperty({
    description: "Your phone number (must match DK Bank registered number)",
    example: "97517123456",
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[\d\s\-+]+$/, { message: "Invalid phone number format" })
  phoneNumber: string;
}
