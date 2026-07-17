import { ApiProperty } from "@nestjs/swagger";
import { IsDateString } from "class-validator";

export class ReopenMarketDto {
  @ApiProperty({
    description: "New closesAt for the reopened market (ISO 8601, future)",
    example: "2026-07-18T02:00:00+06:00",
  })
  @IsDateString()
  closesAt!: string;
}
