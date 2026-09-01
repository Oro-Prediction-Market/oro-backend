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
      "Bond to lock, in your account's own currency — the contest belongs to " +
      "the market book your position is in. Only the FIRST objector may choose " +
      "it; every later participant must match the amount already set for that " +
      "book, so they can omit it. Defaults to the minimum / matched amount. " +
      "The floor is per currency (Nu 10 / 0.5 USDT) and is enforced by the " +
      "server, which is the only place the currency is known — see " +
      "GET /markets/:id/dispute-info for the exact figure that applies to you.",
    example: 50,
  })
  @IsOptional()
  @IsNumber({}, { message: "Bond amount must be a number" })
  // Smallest representable unit of the finest-grained currency (USDT, 6dp).
  // The real per-currency floor cannot live here: a DTO does not know which
  // book the caller is bonding into, and a hardcoded Nu 10 rejected every
  // legitimate USDT bond before the service ever saw it.
  @Min(0.000001, { message: "Bond amount must be greater than zero" })
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
