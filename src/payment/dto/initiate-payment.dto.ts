import { ApiProperty } from "@nestjs/swagger";
import {
  IsString,
  IsNotEmpty,
  MinLength,
  MaxLength,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
} from "class-validator";

export class InitiatePaymentDto {
  @ApiProperty({
    description: "Payment description",
    example: "Oro Credits top-up",
    minLength: 3,
    maxLength: 500,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(500)
  description: string;

  @ApiProperty({ description: "Amount in BTN", example: 100, maximum: 15000 })
  @IsNumber()
  @IsNotEmpty()
  @Max(15000, { message: "Deposit amount cannot exceed Nu 15,000 per transaction" })
  amount: number;

  @ApiProperty({
    description:
      "Customer's 11-digit Bhutanese CID number linked to their DK Bank account",
    example: "11000000000",
  })
  @IsString()
  @IsNotEmpty()
  cid: string;

  @ApiProperty({
    description: "Market ID to link this payment to (optional)",
    required: false,
  })
  @IsOptional()
  @IsUUID()
  marketId?: string;

  @ApiProperty({
    description: "Dispute ID to link this payment to (optional)",
    required: false,
  })
  @IsOptional()
  @IsUUID()
  disputeId?: string;
}
