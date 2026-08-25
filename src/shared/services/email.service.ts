import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const enabled = this.config.get<string>("EMAIL_ENABLED") === "true";
    if (!enabled) {
      this.logger.debug("Email service disabled");
      return;
    }

    const host = this.config.get<string>("EMAIL_SMTP_HOST", "");
    const user = this.config.get<string>("EMAIL_SMTP_USER", "");
    if (!host || !user) {
      this.logger.warn("Email provider not configured (EMAIL_SMTP_HOST / EMAIL_SMTP_USER missing)");
      return;
    }

    const port = Number(this.config.get<string>("EMAIL_SMTP_PORT", "587"));
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: {
        user,
        pass: this.config.get<string>("EMAIL_SMTP_PASSWORD", ""),
      },
    });

    this.logger.log(`EmailService initialized (host: ${host})`);
  }

  async sendEmail(options: {
    to: string | string[];
    subject: string;
    text?: string;
    html?: string;
    /** Address replies should go to (e.g. the user who sent feedback). */
    replyTo?: string;
  }): Promise<boolean> {
    if (!this.transporter) {
      this.logger.debug("Email transporter not configured, skipping");
      return false;
    }

    const from = this.config.get<string>("EMAIL_FROM", "noreply@oro.bt");
    const fromName = this.config.get<string>("EMAIL_FROM_NAME", "Oro");

    try {
      await this.transporter.sendMail({
        from: `"${fromName}" <${from}>`,
        to: Array.isArray(options.to) ? options.to.join(", ") : options.to,
        replyTo: options.replyTo,
        subject: options.subject,
        text: options.text,
        html: options.html,
      });
      this.logger.log(`Email sent to ${options.to} — ${options.subject}`);
      return true;
    } catch (error) {
      this.logger.error(`Email send error: ${(error as Error).message}`);
      return false;
    }
  }

  async sendOtp(to: string, otp: string, expiryMinutes = 5): Promise<boolean> {
    return this.sendEmail({
      to,
      subject: "Oro — OTP Verification",
      text: `Your Oro OTP is: ${otp}\n\nValid for ${expiryMinutes} minute${expiryMinutes === 1 ? "" : "s"}. Do not share this code.`,
      html: `<p>Your Oro OTP is: <strong style="font-size:24px;letter-spacing:4px">${otp}</strong></p><p>Valid for ${expiryMinutes} minute${expiryMinutes === 1 ? "" : "s"}. Do not share this code.</p>`,
    });
  }
}
