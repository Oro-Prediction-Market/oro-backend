import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsNumber, IsOptional, IsUUID, Min } from "class-validator";

export class OpenPositionDto {
  @ApiProperty() @IsUUID() outcomeId: string;
  @ApiProperty() @IsNumber() @Min(1) amount: number;

  /**
   * Which wallet the stake comes from.
   *
   * Optional, and omitting it means the account's native currency — so every
   * existing client keeps working untouched. An account that holds both
   * ngultrum and USDT sends this to say which one it is spending; sending a
   * currency the account cannot hold is refused.
   */
  @ApiPropertyOptional({ enum: ["BTN", "USDT"] })
  @IsOptional()
  @IsIn(["BTN", "USDT"])
  currency?: string;
}
