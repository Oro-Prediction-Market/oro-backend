import { ApiProperty } from "@nestjs/swagger";
import { IsEnum } from "class-validator";
import { MarketStatus } from "../../entities/market.entity";

export class TransitionDto {
  @ApiProperty({ enum: MarketStatus })
  @IsEnum(MarketStatus)
  status: MarketStatus;
}
