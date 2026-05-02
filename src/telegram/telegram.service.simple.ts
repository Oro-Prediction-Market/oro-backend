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
    await this.redis.setJsonEx(
      `oro:propose:${key}`,
      this.PROPOSE_KEY_TTL_SEC,
      { marketId, outcomeId, windowMinutes },
    );
    return key;
  }

  /** Resolve a short key back to {marketId, outcomeId, windowMinutes}, or undefined if expired/missing. */
  async resolveProposeKey(
    key: number,
  ): Promise<{ marketId: string; outcomeId: string; windowMinutes: number } | undefined> {
    const val = await this.redis.getJson<{ marketId: string; outcomeId: string; windowMinutes: number }>(
      `oro:propose:${key}`,
    );
    return val ?? undefined;
  }

  constructor(
    private readonly configService: ConfigService,
    private readonly redis: RedisService,
    @InjectRepository(User) private readonly userRepository: Repository<User>,
  ) {
    this.botToken = this.configService.getOrThrow<string>("TELEGRAM_BOT_TOKEN");
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
