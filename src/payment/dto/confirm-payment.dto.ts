import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsNotEmpty, MinLength, MaxLength } from "class-validator";

export class ConfirmPaymentDto {
  @ApiProperty({ description: "Payment ID from initiation", example: "uuid-here" })
  @IsString()
  @IsNotEmpty()
  paymentId: string;

  @ApiProperty({ description: "6-digit OTP sent via Telegram", example: "123456" })
  @IsString()
  @IsNotEmpty()
  @MinLength(4)
  @MaxLength(8)
  otp: string;
}
