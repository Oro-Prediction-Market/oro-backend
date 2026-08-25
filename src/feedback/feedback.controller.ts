import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { ConfigService } from "@nestjs/config";
import { Public } from "../auth/guards";
import { EmailService } from "../shared/services/email.service";

const MAX_MESSAGE_LEN = 4000;
// Basic shape check only — the real proof an address exists is that the reply
// lands, which is not our job here.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Public "contact us" endpoint behind the footer's feedback form.
 *
 * The destination — Oro's support inbox — lives ONLY on the server (env
 * SUPPORT_EMAIL). It is deliberately never sent to or accepted from the client,
 * so the address cannot be scraped from the frontend or spoofed by a caller.
 */
@ApiTags("feedback")
@Controller("feedback")
export class FeedbackController {
  private readonly logger = new Logger(FeedbackController.name);

  constructor(
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  @Post()
  @HttpCode(200)
  @Public()
  // Public + unauthenticated + sends mail → a spam vector. Keep the window tight.
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({ summary: "Send a feedback / support message to Oro" })
  async submit(
    @Body() body: { email?: string; message?: string },
  ): Promise<{ ok: true }> {
    const email = (body?.email ?? "").trim();
    const message = (body?.message ?? "").trim();

    if (!email || !EMAIL_RE.test(email) || email.length > 254) {
      throw new BadRequestException("Please enter a valid email address.");
    }
    if (!message) {
      throw new BadRequestException("Please enter a message.");
    }
    if (message.length > MAX_MESSAGE_LEN) {
      throw new BadRequestException(
        `Message is too long (max ${MAX_MESSAGE_LEN} characters).`,
      );
    }

    // Destination is server-side only — never echoed back to the client.
    const to = this.config.get<string>("SUPPORT_EMAIL", "oro@21.tech.bt");

    const sent = await this.email.sendEmail({
      to,
      // Reply goes straight to the user who wrote in.
      replyTo: email,
      subject: `Oro feedback from ${email}`,
      text: `From: ${email}\n\n${message}`,
      html:
        `<p><strong>From:</strong> ${escapeHtml(email)}</p>` +
        `<p style="white-space:pre-wrap">${escapeHtml(message)}</p>`,
    });

    if (!sent) {
      // Either the mailer is unconfigured or the send failed. Don't leak which,
      // and don't leak the destination.
      this.logger.error("Feedback email could not be sent (mailer unavailable).");
      throw new ServiceUnavailableException(
        "We couldn't send your message right now. Please try again later.",
      );
    }

    return { ok: true };
  }
}

/** Minimal HTML-escaping so a message body can't inject markup into the email. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
