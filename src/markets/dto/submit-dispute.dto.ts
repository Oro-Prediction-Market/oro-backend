import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsNotEmpty, MaxLength } from "class-validator";

export class SubmitDisputeDto {
  @ApiProperty({
    description:
      "Your reason for objecting to the proposed outcome. Be specific — admins review every objection.",
    example: "The live score I saw was 2-1 to Team A, not Team B as proposed.",
  })
  @IsString({ message: "Reason must be in text format" })
  @IsNotEmpty({ message: "A reason is required to raise an objection" })
  @MaxLength(1000, { message: "Reason must be 1000 characters or fewer" })
  reason: string;
}
