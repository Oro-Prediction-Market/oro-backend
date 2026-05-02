import { IsOptional, IsString } from "class-validator";

export class TransactionStatsQueryDto {
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;
}
