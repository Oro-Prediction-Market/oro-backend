import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsNotEmpty,
  MaxLength,
  IsOptional,
  IsNumber,
  Min,
  IsEnum,
} from "class-validator";
import { DisputeSide } from "../../entities/dispute.entity";

export class SubmitDisputeDto {
  @ApiProperty({
    description:
      "Your reason for objecting to (or defending) the proposed outcome. Be specific — admins review every objection.",
    example: "The live score I saw was 2-1 to Team A, not Team B as proposed.",
  })
  @IsString({ message: "Reason must be in text format" })
  @IsNotEmpty({ message: "A reason is required to raise an objection" })
  @MaxLength(1000, { message: "Reason must be 1000 characters or fewer" })
  reason: string;

  @ApiPropertyOptional({
    description:
      "Bond to lock, in BTN. Only the FIRST objector may choose this (minimum 10); " +
      "every later participant must match the amount already set for the market, " +
      "so it can be omitted by them. Defaults to the minimum / matched amount.",
    example: 50,
    minimum: 10,
  })
  @IsOptional()
  @IsNumber({}, { message: "Bond amount must be a number" })
  @Min(10, { message: "The minimum bond is Nu 10" })
  bondAmount?: number;

  @ApiPropertyOptional({
    enum: DisputeSide,
    description:
      "OBJECT (default) challenges the proposal; SUPPORT defends it against objectors. " +
      "The first participant must OBJECT.",
    example: DisputeSide.OBJECT,
  })
  @IsOptional()
  @IsEnum(DisputeSide, { message: "Side must be either 'object' or 'support'" })
  side?: DisputeSide;
}
