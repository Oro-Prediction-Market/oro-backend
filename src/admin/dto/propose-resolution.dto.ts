import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsUUID, IsInt, IsOptional, IsIn } from "class-validator";

const ALLOWED_WINDOW_MINUTES = [10, 20, 30, 60, 120] as const;

export class ProposeResolutionDto {
  @ApiProperty({ description: "UUID of the proposed winning outcome" })
  @IsUUID()
  proposedOutcomeId: string;

  @ApiPropertyOptional({
    description: `Objection window length in minutes. Allowed: ${ALLOWED_WINDOW_MINUTES.join(", ")}. Defaults to 60.`,
    example: 30,
    enum: ALLOWED_WINDOW_MINUTES,
  })
  @IsOptional()
  @IsInt()
  @IsIn(ALLOWED_WINDOW_MINUTES, {
    message: `windowMinutes must be one of: ${ALLOWED_WINDOW_MINUTES.join(", ")}`,
  })
  windowMinutes?: number;
}
