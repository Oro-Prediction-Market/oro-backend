import { IsOptional, IsString } from "class-validator";

export class TelegramAuthDto {
  @IsString()
  initData: string;

  /**
   * Optional referral code from a deep-link like t.me/OroPredictBot?start=ref_<telegramId>.
   * Passed through as-is; auth service strips the "ref_" prefix and resolves the referrer.
   */
  @IsOptional()
  @IsString()
  referralCode?: string;
}
