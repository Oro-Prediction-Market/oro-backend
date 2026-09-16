import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { User } from "../entities/user.entity";
import { Market } from "../entities/market.entity";
import { Position, PositionStatus } from "../entities/position.entity";
import { RedisService } from "../redis/redis.service";

/**
 * One inline-keyboard button. `url` renders a deep link (e.g.
 * `https://t.me/<bot>?startapp=m_<id>`) that launches the Mini App at a
 * specific place; `callbackData` renders a button that pings the bot back.
 * Exactly one of the two should be set per button.
 */
export interface InlineButton {
  text: string;
  url?: string;
  callbackData?: string;
}

/**
 * The outcome of a send, for callers that have to count deliveries.
 *
 * `code` is Telegram's `error_code` when it gave one. Its absence means the call
 * never reached Telegram (a network error), which is retryable — whereas a 403
 * is Telegram telling you this user has blocked the bot, and never will not be.
 */
export interface SendResult {
  ok: boolean;
  status?: number;
  code?: number;
  description?: string;
  /** Seconds Telegram asked us to wait, on a 429. */
  retryAfter?: number;
}

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

  isEphemeralPhotoUrl(url?: string | null): boolean {
    return !!url && /api\.telegram\.org\/file\/bot/i.test(url);
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

  /**
   * Send a message using built-in fetch — no axios/HttpService dependency.
   *
   * Pass `buttons` (rows of {@link InlineButton}) to attach an inline keyboard,
   * e.g. a "Open market" URL button that deep-links back into the Mini App.
   */
  async sendMessage(
    // A string is accepted so a channel can be addressed by "@name" as well as
    // by its numeric id — Telegram's chat_id takes either. Widening only; every
    // existing numeric caller is unaffected.
    chatId: number | string,
    text: string,
    buttons?: InlineButton[][],
  ): Promise<void> {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const payload: Record<string, unknown> = {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      };
      if (buttons?.length) {
        payload.reply_markup = {
          inline_keyboard: buttons.map((row) =>
            row.map((btn) => ({
              text: btn.text,
              ...(btn.url ? { url: btn.url } : {}),
              ...(btn.callbackData ? { callback_data: btn.callbackData } : {}),
            })),
          ),
        };
      }
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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
   * Like {@link sendMessage}, but REPORTS what happened.
   *
   * `sendMessage` returns void on every outcome, which is right for the ~15
   * fire-and-forget callers that must not fail because Telegram hiccuped — and
   * useless for a broadcast, where "1,809 delivered, 31 failed" is the whole
   * point. Rather than change a contract that much of the codebase relies on,
   * this is a sibling.
   *
   * Still does not throw. The caller decides what is terminal and what is worth
   * retrying, because that decision differs: a 403 means the user blocked the
   * bot and no amount of retrying will help, while a 429 just means slow down.
   */
  async sendMessageChecked(
    chatId: number | string,
    text: string,
    buttons?: InlineButton[][],
  ): Promise<SendResult> {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const payload: Record<string, unknown> = {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      };
      if (buttons?.length) {
        payload.reply_markup = {
          inline_keyboard: buttons.map((row) =>
            row.map((btn) => ({
              text: btn.text,
              ...(btn.url ? { url: btn.url } : {}),
              ...(btn.callbackData ? { callback_data: btn.callbackData } : {}),
            })),
          ),
        };
      }
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body: any = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        return {
          ok: false,
          status: res.status,
          // Telegram's own machine-readable code, e.g. 403 for "bot was blocked
          // by the user". More reliable than the HTTP status for classification.
          code: typeof body?.error_code === "number" ? body.error_code : res.status,
          description:
            typeof body?.description === "string" ? body.description : undefined,
          retryAfter:
            typeof body?.parameters?.retry_after === "number"
              ? body.parameters.retry_after
              : undefined,
        };
      }
      return { ok: true };
    } catch (error: any) {
      // A network error, not a Telegram verdict — worth retrying, so no code.
      return { ok: false, description: error?.message ?? "network error" };
    }
  }

  /**
   * Stage a photo message for the user to forward into a chat of their choosing.
   *
   * This is how a share card reaches a chat as an actual image. The Web Share
   * API cannot do it: Telegram runs Mini Apps in WKWebView on iOS, where sharing
   * files works, and in a plain Android WebView, where `navigator.share` does
   * not exist at all — so Android users have silently been sharing text-only.
   * Going through Telegram itself behaves identically on both.
   *
   * The caller passes a URL rather than bytes because `InlineQueryResultPhoto`
   * takes a URL, and Telegram fetches it from the public internet — so it must
   * be reachable from outside, and it must be **JPEG** ("Photo must be in JPEG
   * format. Photo size must not exceed 5MB").
   *
   * Requires inline mode to be enabled for the bot in BotFather; without it this
   * call fails with an error that does not obviously point at the cause.
   *
   * Unlike everything else in this file, this returns a value and throws on
   * failure instead of logging and swallowing — the caller cannot proceed
   * without the id, and a silent null here would surface as a share that does
   * nothing when tapped.
   *
   * @returns the prepared message id, to be handed to the Mini App's
   *          `shareMessage()`.
   * @see https://core.telegram.org/bots/api#savepreparedinlinemessage
   */
  async savePreparedInlineMessage(opts: {
    /** Telegram user id of the person who will send it. */
    userId: number;
    /** Publicly reachable JPEG. */
    photoUrl: string;
    /** 0-1024 characters, HTML-parsed. */
    caption: string;
    /** Optional button rendered under the photo, e.g. "Open on Oro". */
    button?: InlineButton;
  }): Promise<string> {
    const url = `https://api.telegram.org/bot${this.botToken}/savePreparedInlineMessage`;
    const payload = {
      user_id: opts.userId,
      result: {
        type: "photo",
        // Unique per result; Telegram only needs it to be distinct, 1-64 bytes.
        id: `card_${Date.now().toString(36)}`,
        photo_url: opts.photoUrl,
        // Required by the API. The card is small enough to be its own thumbnail.
        thumb_url: opts.photoUrl,
        thumbnail_url: opts.photoUrl,
        caption: opts.caption.slice(0, 1024),
        parse_mode: "HTML",
        ...(opts.button
          ? {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: opts.button.text,
                      ...(opts.button.url ? { url: opts.button.url } : {}),
                      ...(opts.button.callbackData
                        ? { callback_data: opts.button.callbackData }
                        : {}),
                    },
                  ],
                ],
              },
            }
          : {}),
      },
      // Everywhere a person might plausibly want to post a prediction.
      allow_user_chats: true,
      allow_group_chats: true,
      allow_channel_chats: true,
      allow_bot_chats: false,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: { id?: string };
      description?: string;
    } | null;

    // A non-2xx AND an `ok: false` both mean failure; the Bot API can return 200
    // with ok:false, so checking only res.ok would let that through as a success
    // and hand the client an undefined id.
    if (!res.ok || !body?.ok || !body.result?.id) {
      const reason = body?.description ?? `HTTP ${res.status}`;
      this.logger.error(
        `savePreparedInlineMessage failed for user ${opts.userId}: ${reason}`,
      );
      throw new Error(reason);
    }
    return body.result.id;
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
    reason:
      | "market_cancelled"
      | "thin_pool"
      | "payout_floor_underfunded"
      | "settlement_source_failure",
  ): Promise<void> {
    let text: string;
    if (reason === "market_cancelled") {
      text =
        `↩️ <b>Market Cancelled — Full Refund</b>\n\n` +
        `📊 <b>${marketTitle}</b>\n\n` +
        `We're sorry — this market had to be cancelled due to an unforeseen inconvenience. ` +
        `Your prediction of <b>Nu ${amount.toLocaleString()}</b> has been fully refunded to your wallet.\n\n` +
        `We sincerely apologize for any trouble this may have caused. 🙏\n\n` +
        `Other markets are still open — we'd love to see you there!`;
    } else if (reason === "thin_pool") {
      text =
        `⚠️ <b>Market Refunded</b>\n\n` +
        `📊 <b>${marketTitle}</b>\n\n` +
        `This market didn't get enough participation to settle fairly. ` +
        `Your <b>Nu ${amount.toLocaleString()}</b> is back in your wallet.`;
      // NOTE: there is no `payout_floor_underfunded` branch any more. That
      // refund no longer happens — when the pool cannot fund the 1.05× floor,
      // settlement waives the house edge and pays the winners instead of
      // refunding everyone. The reason string is kept on the union and on
      // `Settlement.cancelReason` for the rows already written under the old
      // behaviour, so historical data still reads correctly.
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
