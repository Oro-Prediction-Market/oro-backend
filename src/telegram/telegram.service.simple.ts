import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { User } from "../entities/user.entity";
import { Market } from "../entities/market.entity";
import { Position, PositionStatus } from "../entities/position.entity";
import { RedisService } from "../redis/redis.service";

@Injectable()
export class TelegramSimpleService {
  private readonly logger = new Logger(TelegramSimpleService.name);
  private readonly botToken: string;

  // TTL for propose keys stored in Redis (48 hours)
  private readonly PROPOSE_KEY_TTL_SEC = 48 * 60 * 60;

  /**
   * Register a market+outcome pair in Redis and return a short callback key.
   * The key is a millisecond timestamp which fits comfortably within Telegram's
   * 64-byte callback_data limit (13 digits + "p:" prefix = 15 bytes).
   * Persisted in Redis so server restarts don't invalidate pending buttons.
   */
  async registerProposeKey(
    marketId: string,
    outcomeId: string,
    windowMinutes: number = 60,
  ): Promise<number> {
    const key = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    await this.redis.setJsonEx(`oro:propose:${key}`, this.PROPOSE_KEY_TTL_SEC, {
      marketId,
      outcomeId,
      windowMinutes,
    });
    return key;
  }

  /** Resolve a short key back to {marketId, outcomeId, windowMinutes}, or undefined if expired/missing. */
  async resolveProposeKey(
    key: number,
  ): Promise<
    { marketId: string; outcomeId: string; windowMinutes: number } | undefined
  > {
    const val = await this.redis.getJson<{
      marketId: string;
      outcomeId: string;
      windowMinutes: number;
    }>(`oro:propose:${key}`);
    return val ?? undefined;
  }

  constructor(
    private readonly configService: ConfigService,
    private readonly redis: RedisService,
    @InjectRepository(User) private readonly userRepository: Repository<User>,
  ) {
    this.botToken = this.configService.getOrThrow<string>("TELEGRAM_BOT_TOKEN");
  }

  /**
   * Fetch user's Telegram profile photo URL via Bot API.
   * Returns the HTTPS URL or null if no photo is available.
   */
  async getUserProfilePhotoUrl(telegramId: number): Promise<string | null> {
    try {
      const photosRes = await fetch(
        `https://api.telegram.org/bot${this.botToken}/getUserProfilePhotos?user_id=${telegramId}&limit=1`,
      );
      const photosData = await photosRes.json();
      if (!photosData?.ok || !photosData.result?.photos?.length) return null;

      // Get the smallest photo (last in the array is largest, first is smallest)
      const photo = photosData.result.photos[0];
      // Pick a medium-sized version (index 1 if available, otherwise last)
      const fileObj = photo[Math.min(1, photo.length - 1)];
      if (!fileObj?.file_id) return null;

      const fileRes = await fetch(
        `https://api.telegram.org/bot${this.botToken}/getFile?file_id=${fileObj.file_id}`,
      );
      const fileData = await fileRes.json();
      if (!fileData?.ok || !fileData.result?.file_path) return null;

      return `https://api.telegram.org/file/bot${this.botToken}/${fileData.result.file_path}`;
    } catch (err: any) {
      this.logger.warn(
        `Failed to fetch profile photo for ${telegramId}: ${err.message}`,
      );
      return null;
    }
  }

  /** Send a message using built-in fetch — no axios/HttpService dependency. */
  async sendMessage(chatId: number, text: string): Promise<void> {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: false,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        this.logger.error(`Telegram sendMessage HTTP ${res.status}: ${body}`);
        return;
      }
      this.logger.log(`Message sent to chat ${chatId}`);
    } catch (error: any) {
      this.logger.error(
        `Failed to send message to chat ${chatId}: ${error.message}`,
      );
    }
  }

  /**
   * Send a message with inline keyboard buttons.
   * buttons: array of rows, each row is array of { text, callbackData }
   */
  async sendMessageWithButtons(
    chatId: number,
    text: string,
    buttons: Array<Array<{ text: string; callbackData: string }>>,
  ): Promise<void> {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const inline_keyboard = buttons.map((row) =>
        row.map((btn) => ({ text: btn.text, callback_data: btn.callbackData })),
      );
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard },
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        this.logger.error(`sendMessageWithButtons HTTP ${res.status}: ${body}`);
      }
    } catch (error: any) {
      this.logger.error(`sendMessageWithButtons failed: ${error.message}`);
    }
  }

  /** Answer a callback_query to remove the loading spinner on the button. */
  async answerCallbackQuery(
    callbackQueryId: string,
    text?: string,
  ): Promise<void> {
    try {
      await fetch(
        `https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
        },
      );
    } catch {
      // non-critical
    }
  }

  async sendMarketAnnouncement(market: Market): Promise<void> {
    // Simple implementation without complex queries
    const message = `🚀 <b>NEW MARKET</b>\n\n📊 ${market.title}\n⏰ Closes: ${new Date(market.closesAt).toLocaleString()}`;

    // Send to a hardcoded chat ID for now (you can make this dynamic later)
    await this.sendMessage(123456789, message);

    this.logger.log(`Market announcement sent: ${market.title}`);
  }

  /** Post a message to the configured Telegram channel. */
  async postToChannel(text: string): Promise<void> {
    const channelId = process.env.TELEGRAM_CHANNEL_ID;
    if (!channelId) {
      this.logger.warn(
        "[Channel] TELEGRAM_CHANNEL_ID not set — skipping channel post",
      );
      return;
    }
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: channelId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        this.logger.error(`[Channel] sendMessage HTTP ${res.status}: ${body}`);
      }
    } catch (error: any) {
      this.logger.error(
        `[Channel] Failed to post to channel: ${error.message}`,
      );
    }
  }

  async sendRefundNotification(
    telegramId: number,
    marketTitle: string,
    amount: number,
    reason: "market_cancelled" | "thin_pool" | "settlement_source_failure",
  ): Promise<void> {
    let text: string;
    if (reason === "market_cancelled") {
      text =
        `❌ <b>Market Cancelled</b>\n\n` +
        `📊 <b>${marketTitle}</b>\n\n` +
        `Your bet of <b>Nu ${amount.toLocaleString()}</b> has been fully refunded to your balance.`;
    } else if (reason === "thin_pool") {
      text =
        `⚠️ <b>Market Refunded</b>\n\n` +
        `📊 <b>${marketTitle}</b>\n\n` +
        `This market didn't get enough participation to settle fairly. ` +
        `Your <b>Nu ${amount.toLocaleString()}</b> is back in your wallet.`;
    } else {
      text =
        `⚠️ <b>Market Refunded</b>\n\n` +
        `📊 <b>${marketTitle}</b>\n\n` +
        `We couldn't verify the result through our settlement source. ` +
        `Your <b>Nu ${amount.toLocaleString()}</b> is back in your wallet.`;
    }
    await this.sendMessage(telegramId, text);
  }

  async sendPositionResult(bet: Position, market: Market): Promise<void> {
    const user = await this.userRepository.findOne({
      where: { id: bet.userId },
    });

    if (!user?.telegramId) return;

    const result = bet.status === PositionStatus.WON ? "✅ WON" : "❌ LOST";
    const message = `🎯 <b>Position Result</b>\n\n📊 ${market.title}\n📈 Result: ${result}\n💰 Amount: $${bet.amount}`;

    await this.sendMessage(Number(user.telegramId), message);

    this.logger.log(`Position result sent to user ${user.id}: ${bet.status}`);
  }
}
