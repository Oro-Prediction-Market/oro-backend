import { Controller, Post, Get, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard, AdminGuard } from "../auth/guards";

@ApiTags("Telegram Channel")
@Controller("telegram/channel")
@UseGuards(JwtAuthGuard, AdminGuard)
@ApiBearerAuth()
export class TelegramChannelController {
  private readonly botToken = process.env.TELEGRAM_BOT_TOKEN || "";
  private readonly channelId = process.env.TELEGRAM_CHANNEL_ID || "";

  @Get("status")
  @ApiOperation({
    summary: "Check bot token, channel config, and bot admin status",
  })
  async getChannelStatus() {
    if (!this.botToken)
      return { ok: false, error: "TELEGRAM_BOT_TOKEN not set in .env" };
    if (!this.channelId)
      return { ok: false, error: "TELEGRAM_CHANNEL_ID not set in .env" };

    // 1. Check bot token is valid
    const botRes = await fetch(
      `https://api.telegram.org/bot${this.botToken}/getMe`,
    );
    const botData: any = await botRes.json();
    if (!botData.ok)
      return { ok: false, error: "Invalid bot token", detail: botData };

    // 2. Check bot is admin of the channel
    const memberRes = await fetch(
      `https://api.telegram.org/bot${this.botToken}/getChatMember`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.channelId,
          user_id: botData.result.id,
        }),
      },
    );
    const memberData: any = await memberRes.json();
    const isAdmin =
      memberData.ok &&
      ["administrator", "creator"].includes(memberData.result?.status);

    return {
      ok: isAdmin,
      bot: {
        username: botData.result.username,
        id: botData.result.id,
      },
      channel: {
        id: this.channelId,
        botStatus: memberData.result?.status || "unknown",
        isAdmin,
      },
      error: isAdmin
        ? null
        : "Bot is NOT an admin of the channel. Add it as admin with Post Messages permission.",
    };
  }

  @Post("test-message")
  @ApiOperation({
    summary: "Send a test message to the channel to verify everything works",
  })
  async sendTestMessage() {
    if (!this.botToken)
      return { ok: false, error: "TELEGRAM_BOT_TOKEN not set" };
    if (!this.channelId)
      return { ok: false, error: "TELEGRAM_CHANNEL_ID not set" };

    const res = await fetch(
      `https://api.telegram.org/bot${this.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.channelId,
          text: "✅ <b>Oro channel connected successfully!</b>\n\nBot is configured and posting works.",
          parse_mode: "HTML",
        }),
      },
    );
    const data: any = await res.json();
    if (!data.ok) return { ok: false, error: data.description };
    return { ok: true, message: "Test message sent to channel successfully" };
  }
}
