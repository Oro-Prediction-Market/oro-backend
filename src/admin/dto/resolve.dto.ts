import { ApiProperty } from "@nestjs/swagger";
import {
  IsUUID,
  IsString,
  IsNotEmpty,
  IsUrl,
  MaxLength,
} from "class-validator";

export class ResolveDto {
  @ApiProperty({ description: "UUID of the winning outcome" })
  @IsUUID()
  winningOutcomeId: string;

  @ApiProperty({
    description:
      "Public URL to the evidence source — screenshot, official results page, or API response. " +
      "This is shown to all users on the resolution page.",
    example: "https://www.fifastatistics.com/matches/12345/result",
  })
  @IsUrl({}, { message: "evidenceUrl must be a valid URL" })
  evidenceUrl: string;

  @ApiProperty({
    description:
      "Plain-language explanation of why this outcome won, referencing the evidence. " +
      "Shown publicly on the resolution log.",
    example:
      "Official FIFA match report confirms Argentina 2–1 France at full time.",
  })
  @IsString()
  @IsNotEmpty({
    message:
      "evidenceNote is required — explain how the evidence determines the winner",
  })
  @MaxLength(2000)
  evidenceNote: string;
}
