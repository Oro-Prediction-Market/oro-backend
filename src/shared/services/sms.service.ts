import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(private readonly config: ConfigService) {}

  async sendSms(to: string, message: string): Promise<boolean> {
    const enabled = this.config.get<string>("SMS_ENABLED") === "true";
    if (!enabled) {
      this.logger.debug(`SMS disabled. Skipping message to ${to}`);
      return false;
    }

    const apiUrl = this.config.get<string>("SMS_API_URL", "");
    const username = this.config.get<string>("SMS_USERNAME", "");
    const password = this.config.get<string>("SMS_PASSWORD", "");
    const from = this.config.get<string>("SMS_FROM", "Oro");

    if (!apiUrl || !username) {
      this.logger.warn(
        "SMS provider not configured (SMS_API_URL / SMS_USERNAME missing)",
      );
      return false;
    }

    // Kannel gateway expects local Bhutanese number (8 digits) without country code
    let cleanTo = to.replace(/^\+/, "");
    // Strip Bhutan country code 975 if present
    if (cleanTo.startsWith("975") && cleanTo.length === 11) {
      cleanTo = cleanTo.substring(3);
    }

    try {
      const params = new URLSearchParams({
        username,
        password,
        from,
        to: cleanTo,
        text: message,
      });
      const response = await fetch(`${apiUrl}${params.toString()}`, {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        this.logger.warn(`SMS send failed (${response.status}): ${text}`);
        return false;
      }

      this.logger.log(`SMS sent to ${to}`);
      return true;
    } catch (error) {
      this.logger.error(
        `SMS send error for ${to}: ${(error as Error).message}`,
      );
      return false;
    }
  }

  async sendOtp(to: string, otp: string, expiryMinutes = 5): Promise<boolean> {
    const message = `Your Oro OTP is: ${otp}. Valid for ${expiryMinutes} minute${expiryMinutes === 1 ? "" : "s"}. Do not share this code.`;
    return this.sendSms(to, message);
  }
}
