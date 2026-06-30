import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean } from "class-validator";

export class SetOutcomeEliminatedDto {
  @ApiProperty({
    description:
      "true to eliminate the outcome (stops new bets on it), false to restore it",
  })
  @IsBoolean()
  isEliminated: boolean;
}
