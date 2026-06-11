import {
  Controller,
  Get,
  Post,
  Body,
  Headers,
  Logger,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { timingSafeEqual } from "crypto";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { JwtAuthGuard, AdminGuard } from "../auth/guards";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { TelegramVerificationService } from "../telegram/telegram-verification.service";
import { LeaguesService } from "../leagues/leagues.service";
import { BotPollingService } from "./bot-polling.service";
import { RedisService } from "../redis/redis.service";
import { User } from "../entities/user.entity";
import { Market, MarketStatus } from "../entities/market.entity";

@ApiTags("Bot")
@Controller("bot")
export class BotController {
  private readonly logger = new Logger(BotController.name);

  constructor(
    private readonly telegramSimpleService: TelegramSimpleService,
    private readonly telegramVerificationService: TelegramVerificationService,
    private readonly leaguesService: LeaguesService,
    private readonly botPollingService: BotPollingService,
    private readonly redis: RedisService,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Market) private readonly marketRepo: Repository<Market>,
  ) {}

  @Get("info")
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiOperation({ summary: "Verify bot token is working" })
  @ApiResponse({ status: 200, description: "Bot info retrieved successfully" })
  async getBotInfo() {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return { error: "Bot token not configured" };

    try {
      // Use built-in fetch
      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/getMe`,
      );
      const data = await response.json();
      if (!response.ok) return { error: "Invalid bot token", details: data };
      return data;
    } catch (err: any) {
      return { error: "Failed to reach Telegram API", details: err.message };
    }
  }

  @Post("webhook")
  @ApiOperation({ summary: "Handle Telegram webhook updates" })
  @ApiResponse({ status: 200, description: "Webhook processed successfully" })
  async handleWebhook(
    @Body() update: any,
    @Headers("x-telegram-bot-api-secret-token") secretToken: string | undefined,
  ) {
    // Fail closed: if the webhook secret isn't configured we cannot
    // authenticate the caller, so reject rather than silently accepting
    // unauthenticated (and therefore forgeable) Telegram updates. The bot uses
    // polling in environments without the secret, so this never blocks dev.
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!expected) {
      this.logger.error(
        "Rejecting webhook call: TELEGRAM_WEBHOOK_SECRET is not configured. " +
          "Set it (and register it with Telegram) to enable the webhook.",
      );
      throw new UnauthorizedException("Webhook is not configured");
    }
    const expectedBuf = Buffer.from(expected);
    const receivedBuf = Buffer.from(secretToken || "");
    const valid =
      expectedBuf.length === receivedBuf.length &&
      timingSafeEqual(expectedBuf, receivedBuf);
    if (!valid) throw new UnauthorizedException("Invalid webhook token");
    // Bot added to / removed from a group
    if (update.my_chat_member) {
      await this.handleMyChatMember(update.my_chat_member);
    }
    if (update.message) {
      await this.handleMessage(update.message);
    }
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
    }
    return { success: true };
  }

  private async handleMessage(message: any) {
    const chatId: number = message.chat.id;
    const chatType: string = message.chat.type ?? "private";

    // Auto-register Oro users who send messages in group chats
    if (
      (chatType === "group" || chatType === "supergroup") &&
      message.from?.id
    ) {
      await this.leaguesService
        .registerMember(
          String(chatId),
          String(message.from.id),
          message.chat.title,
        )
        .catch(() => {});
    }

    // Handle shared contact (phone verification)
    if (message.contact) {
      const contact = message.contact;
      try {
        // contact.user_id is optional in the Telegram API — fall back to
        // the sender's ID so the security check in linkTelegramPhone always
        // passes for a user sharing their own contact via request_contact.
        const contactUserId =
          contact.user_id != null
            ? String(contact.user_id)
            : String(message.from.id);
        const result = await this.telegramVerificationService.linkTelegramPhone(
          String(message.from.id),
          String(chatId),
          contactUserId,
          contact.phone_number,
        );
        if (result.requiresAccountVerification) {
          await this.redis.setEx(
            `acct_verify:${chatId}`,
            600,
            String(message.from.id),
          );
          await this.telegramSimpleService.sendMessage(
            chatId,
            "🔐 Your Telegram phone does not match your DK Bank registered phone.\n\n" +
              "Please type your 12-digit DK Bank account number below to verify your identity.\n\n" +
              "You can find it in your DK Bank app or passbook.",
          );
        } else {
          await this.telegramSimpleService.sendMessage(chatId, result.message);
        }
      } catch (err: any) {
        await this.telegramSimpleService.sendMessage(
          chatId,
          `❌ Verification failed: ${err?.message || "Unknown error"}\n\nPlease try again or contact support.`,
        );
      }
      return;
    }

    // Handle text commands
    if (message.text) {
      // Normalise command: strip @BotUsername suffix and capture any payload.
      // e.g. "/start@OroPredictBot verify" → cmd="/start", payload="verify"
      const cmdMatch = (message.text as string).match(
        /^(\/\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/,
      );
      const cmd = cmdMatch ? cmdMatch[1] : null;
      const cmdPayload = cmdMatch ? (cmdMatch[2] ?? "").trim() : "";

      // Not a slash-command — check for pending account number verification.
      if (!cmd) {
        if (message.chat?.type === "private") {
          const rawText = (message.text as string).trim();
          const digits = rawText.replace(/\D/g, "");
          const pendingTgId = await this.redis.get(`acct_verify:${chatId}`);
          if (pendingTgId && digits.length === 12) {
            const verifyUser = await this.userRepo.findOneBy({
              telegramId: pendingTgId,
            });
            if (verifyUser) {
              try {
                const result =
                  await this.telegramVerificationService.verifyByAccountNumber(
                    verifyUser.id,
                    digits,
                    String(chatId),
                  );
                await this.redis.del(`acct_verify:${chatId}`);
                await this.telegramSimpleService.sendMessage(
                  chatId,
                  result.message,
                );
              } catch (err: any) {
                await this.telegramSimpleService.sendMessage(
                  chatId,
                  `❌ ${err?.message || "Verification failed"}\n\nPlease try again.`,
                );
              }
            }
          }
        }
        return;
      }

      // /start verify — route to verify handler immediately.
      if (cmd === "/start" && cmdPayload === "verify") {
        await this.handleVerifyCommand(chatId, message.from.id);
        return;
      }

      switch (cmd) {
        case "/start": {
          const miniAppUrl = process.env.TELEGRAM_MINI_APP_URL || "";
          const channelUrl = process.env.TELEGRAM_CHANNEL_URL || "";
          const botToken = process.env.TELEGRAM_BOT_TOKEN;

          // If the payload is a referral code, append it as startapp param
          // so the Mini App can pick it up via start_param.
          const isReferral = cmdPayload.startsWith("ref_");
          const botUsername = process.env.BOT_USERNAME || "OroPredictBot";
          const miniAppLink = isReferral
            ? `https://t.me/${botUsername}/app?startapp=${cmdPayload}`
            : miniAppUrl;

          const payload: Record<string, unknown> = {
            chat_id: chatId,
            text: isReferral
              ? "🎯 <b>Welcome to Oro!</b>\n\n" +
                "You've been invited by a friend! Open the app to start predicting and earn bonuses.\n\n" +
                "To enable secure payments, please verify your phone:\n" +
                "👉 Type /verify and share your phone number.\n\n" +
                "Other commands:\n" +
                "/predict - View active markets\n" +
                "/help    - Show all commands"
              : "🎯 <b>Welcome to Oro!</b>\n\n" +
                "To enable secure payments, please verify your phone:\n" +
                "👉 Type /verify and share your phone number.\n\n" +
                "Other commands:\n" +
                "/predict - View active markets\n" +
                "/help    - Show all commands",
            parse_mode: "HTML",
          };
          const buttons: { text: string; url: string }[] = [];
          if (miniAppLink)
            buttons.push({ text: "🚀 Open Oro", url: miniAppLink });
          if (channelUrl)
            buttons.push({ text: "📢 Join Channel", url: channelUrl });
          if (buttons.length) {
            payload.reply_markup = { inline_keyboard: [buttons] };
          }
          const startRes = await fetch(
            `https://api.telegram.org/bot${botToken}/sendMessage`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            },
          );
          if (!startRes.ok) {
            console.error(
              `[Bot] /start sendMessage failed: ${await startRes.text()}`,
            );
          }
          break;
        }

        case "/verify":
          await this.handleVerifyCommand(chatId, message.from.id);
          break;

        case "/predict":
          await this.handlePredictCommand(chatId, message.from.id);
          break;

        case "/standings":
          if (!(await this.assertGroupMember(chatId, message.from?.id))) break;
          await this.leaguesService.postStandingsToGroup(String(chatId));
          break;

        case "/mystats": {
          if (!message.from?.id) break;
          if (!(await this.assertGroupMember(chatId, message.from.id))) break;
          const myTelegramId = String(message.from.id);
          const user = await this.userRepo.findOne({
            where: { telegramId: myTelegramId },
            select: [
              "id",
              "reputationTier",
              "reputationScore",
              "totalPredictions",
              "correctPredictions",
            ],
          });
          if (!user || (user.totalPredictions ?? 0) === 0) {
            await this.telegramSimpleService.sendMessage(
              chatId,
              "You haven't made any predictions yet. Open the Oro mini app to get started!",
            );
            break;
          }
          const rank = await this.leaguesService.getUserGroupRank(
            String(chatId),
            user.id,
          );
          if (rank === null) {
            await this.telegramSimpleService.sendMessage(
              chatId,
              "You're not on the group leaderboard yet. Make a prediction in the Oro mini app first!",
            );
            break;
          }
          const tierLabel =
            user.reputationTier === "legend"
              ? "Legend"
              : user.reputationTier === "hot_hand"
                ? "Hot Hand"
                : user.reputationTier === "sharpshooter"
                  ? "Sharpshooter"
                  : "Rookie";
          const score =
            user.reputationScore != null
              ? `${Math.round(user.reputationScore * 100)}%`
              : "—";
          const winRate =
            (user.totalPredictions ?? 0) > 0
              ? Math.round(
                  ((user.correctPredictions ?? 0) /
                    (user.totalPredictions ?? 1)) *
                    100,
                )
              : 0;
          await this.telegramSimpleService.sendMessage(
            chatId,
            `🎯 <b>Your group rank: #${rank}</b>\n\n` +
              `Tier: ${tierLabel}\n` +
              `Accuracy: ${score}\n` +
              `Win rate: ${winRate}%\n` +
              `Predictions: ${user.totalPredictions}`,
          );
          break;
        }

        case "/help":
          await this.telegramSimpleService.sendMessage(
            chatId,
            "🔧 <b>Available commands:</b>\n" +
              "/start      - Welcome message\n" +
              "/verify     - Link your DK Bank phone for secure payments\n" +
              "/predict    - View active markets\n" +
              "/standings  - Group prediction leaderboard\n" +
              "/mystats    - Your rank in this group\n" +
              "/help       - Show this message",
          );
          break;

        default:
          // Ignore unknown commands in groups to avoid spam; only respond in private chats
          if (chatType === "private") {
            await this.telegramSimpleService.sendMessage(
              chatId,
              "❓ Unknown command. Use /help to see available commands.",
            );
          }
      }
    }
  }

  /** Guard: returns true if the user is a registered Oro member of this group. */
  private async assertGroupMember(
    chatId: number,
    telegramUserId?: number,
  ): Promise<boolean> {
    if (!telegramUserId) return false;
    const isMember = await this.leaguesService.isGroupMember(
      String(chatId),
      String(telegramUserId),
    );
    if (!isMember) {
      await this.telegramSimpleService.sendMessage(
        chatId,
        "🔒 <b>Oro members only</b>\n\n" +
          "This command is available to users who have made at least one prediction on Oro.\n\n" +
          "👉 Open the Oro mini app, make a prediction, then try again!",
      );
    }
    return isMember;
  }

  private async handlePredictCommand(chatId: number, telegramUserId?: number) {
    const markets = await this.marketRepo.find({
      where: [
        { status: MarketStatus.OPEN },
        { status: MarketStatus.RESOLVING },
      ],
      order: { closesAt: "ASC" },
      take: 5,
    });

    if (!markets.length) {
      await this.telegramSimpleService.sendMessage(
        chatId,
        "📊 No active markets right now. Check back soon!",
      );
      return;
    }

    const miniAppUrl = process.env.TELEGRAM_MINI_APP_URL || "";
    const lines = markets.map((m) => {
      const closes = m.closesAt
        ? new Date(m.closesAt).toLocaleString("en-US", {
            dateStyle: "medium",
            timeStyle: "short",
          })
        : "TBD";
      const statusIcon = m.status === MarketStatus.RESOLVING ? "⚖️" : "🟢";
      return `${statusIcon} <b>${m.title}</b>\n⏰ ${closes}`;
    });

    // ── Reputation teaser / status ────────────────────────────────────────────
    let reputationLine = "";
    if (telegramUserId) {
      const user = await this.userRepo.findOne({
        where: { telegramId: String(telegramUserId) },
        select: ["reputationTier", "totalPredictions", "reputationScore"],
      });
      if (!user || (user.totalPredictions ?? 0) === 0) {
        reputationLine =
          "\n\n⭐ <i>Make your first prediction to start building your reputation score. Top predictors carry more weight in market probabilities.</i>";
      } else {
        const tierLabel =
          user.reputationTier === "legend"
            ? "Legend"
            : user.reputationTier === "hot_hand"
              ? "Hot Hand"
              : user.reputationTier === "sharpshooter"
                ? "Sharpshooter"
                : "Rookie";
        const pct =
          user.reputationScore != null
            ? ` · ${Math.round(user.reputationScore * 100)}% accuracy`
            : "";
        reputationLine = `\n\n⭐ Your tier: <b>${tierLabel}</b>${pct} (${user.totalPredictions} predictions)`;
      }
    }

    const text = `📊 <b>Active Markets</b>\n\n${lines.join("\n\n")}\n\n👉 <a href="${miniAppUrl}">Place your prediction</a>${reputationLine}`;
    await this.telegramSimpleService.sendMessage(chatId, text);
  }

  /**
   * Checks if the user has a DK CID linked before sending the phone-share keyboard.
   * Gives a clear step-by-step message if they haven't linked yet.
   */
  private async handleVerifyCommand(chatId: number, telegramUserId: number) {
    const user = await this.userRepo.findOneBy({
      telegramId: String(telegramUserId),
    });

    if (!user || !user.dkCid) {
      await this.telegramSimpleService.sendMessage(
        chatId,
        "⚠️ <b>DK Bank CID not linked yet</b>\n\n" +
          "Before verifying your phone, you need to link your DK Bank CID:\n\n" +
          "1️⃣ Open the <b>Oro Mini App</b>\n" +
          "2️⃣ Go to <b>Profile → Link DK Bank Account</b>\n" +
          "3️⃣ Enter your <b>11-digit CID number</b>\n" +
          "4️⃣ Come back here and type /verify again.",
      );
      return;
    }

    // CID is linked but DK Bank may not have a phone on record
    if (!user.dkPhoneHash) {
      await this.telegramSimpleService.sendMessage(
        chatId,
        "⚠️ <b>No phone number found on your DK Bank account</b>\n\n" +
          "Your CID is linked, but DK Bank has no registered phone number for it.\n\n" +
          "Please visit a <b>DK Bank branch</b> to register your phone number, then type /verify again.",
      );
      return;
    }

    if (
      user.telegramPhoneHash &&
      user.dkPhoneHash &&
      user.telegramPhoneHash === user.dkPhoneHash
    ) {
      await this.telegramSimpleService.sendMessage(
        chatId,
        "✅ <b>Your phone is already verified!</b>\n\n" +
          "Your Telegram account is securely linked to your DK Bank account.\n" +
          "You're all set to make payments on Oro.",
      );
      return;
    }

    await this.sendPhoneRequest(chatId);
  }

  /**
   * Sends a native Telegram "Share Phone Number" keyboard button.
   * Telegram verifies the phone on its end before sending the contact update.
   */
  private async sendPhoneRequest(chatId: number): Promise<void> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return;

    const body = JSON.stringify({
      chat_id: chatId,
      text:
        "🔐 <b>Phone Verification Required</b>\n\n" +
        "To secure your payments, Oro needs to confirm your phone number matches " +
        "the one registered with DK Bank.\n\n" +
        "Tap the button below to share your phone number securely via Telegram.",
      parse_mode: "HTML",
      reply_markup: {
        keyboard: [[{ text: "📱 Share Phone Number", request_contact: true }]],
        one_time_keyboard: true,
        resize_keyboard: true,
      },
    });

    try {
      const res = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        },
      );
      if (!res.ok) {
        console.error(
          `[Bot] sendPhoneRequest failed ${res.status}: ${await res.text()}`,
        );
      }
    } catch (err: any) {
      console.error("Failed to send phone request keyboard:", err.message);
    }
  }

  /** Fires when the bot's membership status in a chat changes. */
  private async handleMyChatMember(update: any): Promise<void> {
    const chat = update.chat;
    if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;

    const chatId = String(chat.id);
    const newStatus: string = update.new_chat_member?.status;

    if (newStatus === "member" || newStatus === "administrator") {
      await this.leaguesService.upsertGroup(chatId, chat.title ?? null);
      await this.telegramSimpleService.sendMessage(
        chat.id,
        "👋 <b>Oro is here!</b>\n\n" +
          "I'll track predictions for everyone in this group.\n\n" +
          "📊 /standings — see the top predictors in this group\n" +
          "🎯 /mystats — check your own rank here\n\n" +
          "Rankings update every Sunday. Make your predictions in the Oro mini app!",
      );
    } else if (newStatus === "left" || newStatus === "kicked") {
      await this.leaguesService.deactivateGroup(chatId);
    }
  }

  private async handleCallbackQuery(callback: any) {
    await this.botPollingService.handleCallbackQuery(callback);
  }
}
