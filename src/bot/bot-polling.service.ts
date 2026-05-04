import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { TelegramVerificationService } from "../telegram/telegram-verification.service";
import { LeaguesService } from "../leagues/leagues.service";
import { RedisService } from "../redis/redis.service";
import { User } from "../entities/user.entity";
import { Market, MarketStatus } from "../entities/market.entity";
import { Outcome } from "../entities/outcome.entity";

/**
 * BotPollingService
 *
 * Automatically switches the bot between two modes:
 *
 *  • WEBHOOK mode  — when TELEGRAM_WEBHOOK_URL is set to a real https:// URL.
 *    The service registers the webhook with Telegram and then does nothing —
 *    updates arrive via POST /api/bot/webhook.
 *
 *  • POLLING mode  — when TELEGRAM_WEBHOOK_URL is absent or still the
 *    placeholder "https://your-domain.com/…".
 *    The service clears any registered webhook and starts a getUpdates
 *    long-polling loop so contact shares and commands work locally without
 *    needing ngrok.
 *
 * Both modes share the same message-handling logic as BotController so
 * behaviour is identical in dev and production.
 */
@Injectable()
export class BotPollingService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(BotPollingService.name);
  private botToken: string;
  private pollingActive = false;
  private offset = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly telegramSimple: TelegramSimpleService,
    private readonly telegramVerification: TelegramVerificationService,
    private readonly leaguesService: LeaguesService,
    private readonly redis: RedisService,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Market) private readonly marketRepo: Repository<Market>,
    @InjectRepository(Outcome)
    private readonly outcomeRepo: Repository<Outcome>,
  ) {}

  async onApplicationBootstrap() {
    this.botToken =
      this.config.get<string>("TELEGRAM_BOT_TOKEN") ||
      process.env.TELEGRAM_BOT_TOKEN ||
      "";
    if (!this.botToken) {
      this.logger.warn("[Bot] TELEGRAM_BOT_TOKEN not set — bot disabled.");
      return;
    }

    const webhookUrl = this.config.get<string>("TELEGRAM_WEBHOOK_URL") || "";
    const isRealWebhook =
      webhookUrl.startsWith("https://") &&
      !webhookUrl.includes("your-domain.com");

    if (isRealWebhook) {
      await this.registerWebhook(webhookUrl);
    } else {
      this.logger.log(
        "[Bot] No real webhook URL configured — starting getUpdates polling loop.",
      );
      await this.clearWebhook();
      this.pollingActive = true;
      this.poll();
    }
  }

  onApplicationShutdown() {
    this.pollingActive = false;
  }

  // ── Webhook registration ──────────────────────────────────────────────────

  private async registerWebhook(url: string) {
    try {
      const secretToken =
        this.config.get<string>("TELEGRAM_WEBHOOK_SECRET") ||
        process.env.TELEGRAM_WEBHOOK_SECRET ||
        undefined;

      const payload: Record<string, unknown> = {
        url,
        allowed_updates: ["message", "callback_query"],
      };
      if (secretToken) {
        payload.secret_token = secretToken;
      }

      const res = await fetch(
        `https://api.telegram.org/bot${this.botToken}/setWebhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data: any = await res.json();
      if (data.ok) {
        this.logger.log(`[Bot] Webhook registered: ${url}`);
      } else {
        this.logger.error(
          `[Bot] Failed to register webhook: ${JSON.stringify(data)}`,
        );
      }
    } catch (err: any) {
      this.logger.error(`[Bot] Webhook registration error: ${err.message}`);
    }
  }

  private async clearWebhook() {
    try {
      await fetch(
        `https://api.telegram.org/bot${this.botToken}/deleteWebhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ drop_pending_updates: false }),
        },
      );
      this.logger.log("[Bot] Webhook cleared — polling mode active.");
    } catch (err: any) {
      this.logger.warn(`[Bot] Could not clear webhook: ${err.message}`);
    }
  }

  // ── Long-polling loop ─────────────────────────────────────────────────────

  private async poll() {
    while (this.pollingActive) {
      try {
        const params = new URLSearchParams({
          offset: String(this.offset),
          timeout: "30",
          allowed_updates: JSON.stringify([
            "message",
            "callback_query",
            "my_chat_member",
          ]),
        });
        const res = await fetch(
          `https://api.telegram.org/bot${this.botToken}/getUpdates?${params}`,
        );
        if (!res.ok) {
          this.logger.warn(
            `[Bot] getUpdates HTTP ${res.status} — retrying in 5s`,
          );
          await this.sleep(5000);
          continue;
        }

        const data: any = await res.json();
        if (!data.ok) {
          this.logger.warn(
            `[Bot] getUpdates error: ${JSON.stringify(data)} — retrying in 5s`,
          );
          await this.sleep(5000);
          continue;
        }

        for (const update of data.result as any[]) {
          this.offset = update.update_id + 1;
          await this.dispatch(update);
        }
      } catch (err: any) {
        if (this.pollingActive) {
          this.logger.warn(
            `[Bot] Polling error: ${err.message} — retrying in 5s`,
          );
          await this.sleep(5000);
        }
      }
    }
  }

  // ── Shared dispatcher (same logic as BotController.handleWebhook) ─────────

  async dispatch(update: any) {
    if (update.my_chat_member) {
      await this.handleMyChatMember(update.my_chat_member);
    }
    if (update.message) {
      await this.handleMessage(update.message);
    }
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
    }
  }

  private async handleMessage(message: any) {
    const chatId: number = message.chat.id;
    const chatType: string = message.chat.type ?? "private";

    // Auto-register Oro users who send messages in group chats
    if ((chatType === "group" || chatType === "supergroup") && message.from?.id) {
      await this.leaguesService
        .registerMember(String(chatId), String(message.from.id), message.chat.title)
        .catch(() => {});
    }

    // ── Contact share → telegramPhoneHash ─────────────────────────────────
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
        const result = await this.telegramVerification.linkTelegramPhone(
          String(message.from.id),
          String(chatId),
          contactUserId,
          contact.phone_number,
        );
        await this.telegramSimple.sendMessage(chatId, result.message);
      } catch (err: any) {
        await this.telegramSimple.sendMessage(
          chatId,
          `❌ Verification failed: ${err?.message || "Unknown error"}\n\nPlease try again or contact support.`,
        );
      }
      return;
    }

    // ── Text commands ────────────────────────────────────────────────────
    if (message.text) {
      // Normalise command: strip @BotUsername suffix and capture any payload.
      // e.g. "/start@OroPredictBot verify" → cmd="/start", payload="verify"
      const cmdMatch = (message.text as string).match(
        /^(\/\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/,
      );
      const cmd = cmdMatch ? cmdMatch[1] : null;
      const cmdPayload = cmdMatch ? (cmdMatch[2] ?? "").trim() : "";

      // Not a slash-command — in private chats nudge the user if they
      // have a pending phone verification instead of typing a message.
      if (!cmd) {
        if (chatType === "private") {
          const pendingUser = await this.userRepo.findOneBy({
            telegramId: String(message.from?.id),
          });
          if (
            pendingUser?.dkCid &&
            pendingUser?.dkPhoneHash &&
            !pendingUser?.telegramPhoneHash
          ) {
            await this.sendPhoneRequest(chatId);
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
          const miniAppUrl =
            this.config.get<string>("TELEGRAM_MINI_APP_URL") ||
            process.env.TELEGRAM_MINI_APP_URL ||
            "";
          const payload: Record<string, unknown> = {
            chat_id: chatId,
            text:
              "🎯 <b>Welcome to Oro!</b>\n\n" +
              "To enable secure payments, please verify your phone:\n" +
              "👉 Type /verify and share your phone number.\n\n" +
              "Other commands:\n" +
              "/predict - View active markets\n" +
              "/help    - Show all commands",
            parse_mode: "HTML",
          };
          if (miniAppUrl) {
            payload.reply_markup = {
              inline_keyboard: [[{ text: "🚀 Open Oro", url: miniAppUrl }]],
            };
          }
          const res = await fetch(
            `https://api.telegram.org/bot${this.botToken}/sendMessage`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            },
          );
          if (!res.ok) {
            this.logger.error(
              `[Bot] /start sendMessage failed: ${await res.text()}`,
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
          await this.handleStandingsCommand(chatId, message.from?.id);
          break;

        case "/mystats":
          await this.handleMyStatsCommand(chatId, message.from?.id);
          break;

        case "/help":
          await this.telegramSimple.sendMessage(
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
          // Only reply to unknown commands in private chats — groups should stay silent.
          if (chatType === "private") {
            await this.telegramSimple.sendMessage(
              chatId,
              "❓ Unknown command. Use /help to see available commands.",
            );
          }
      }
    }
  }

  // ── Group standings/stats commands ──────────────────────────────────────

  /** Guard: returns true if the user is an Oro member of this group chat. */
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
      await this.telegramSimple.sendMessage(
        chatId,
        "🔒 <b>Oro members only</b>\n\n" +
          "This command is available to users who have made at least one prediction on Oro.\n\n" +
          "👉 Open the Oro mini app, make a prediction, then try again!",
      );
    }
    return isMember;
  }

  private async handleStandingsCommand(
    chatId: number,
    telegramUserId?: number,
  ): Promise<void> {
    if (!(await this.assertGroupMember(chatId, telegramUserId))) return;
    await this.leaguesService.postStandingsToGroup(String(chatId));
  }

  private async handleMyStatsCommand(
    chatId: number,
    telegramUserId?: number,
  ): Promise<void> {
    if (!(await this.assertGroupMember(chatId, telegramUserId))) return;

    const user = await this.userRepo.findOne({
      where: { telegramId: String(telegramUserId) },
      select: [
        "id",
        "reputationTier",
        "reputationScore",
        "totalPredictions",
        "correctPredictions",
      ],
    });

    if (!user || (user.totalPredictions ?? 0) === 0) {
      await this.telegramSimple.sendMessage(
        chatId,
        "You haven't made any predictions yet. Open the Oro mini app to get started!",
      );
      return;
    }

    const rank = await this.leaguesService.getUserGroupRank(String(chatId), user.id);
    if (rank === null) {
      await this.telegramSimple.sendMessage(
        chatId,
        "You're not on the group leaderboard yet. Make a prediction in the Oro mini app first!",
      );
      return;
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
            ((user.correctPredictions ?? 0) / (user.totalPredictions ?? 1)) *
              100,
          )
        : 0;

    await this.telegramSimple.sendMessage(
      chatId,
      `🎯 <b>Your group rank: #${rank}</b>\n\n` +
        `Tier: ${tierLabel}\n` +
        `Accuracy: ${score}\n` +
        `Win rate: ${winRate}%\n` +
        `Predictions: ${user.totalPredictions}`,
    );
  }

  /** Called when the bot's membership status in a chat changes. */
  private async handleMyChatMember(update: any): Promise<void> {
    const chat = update.chat;
    if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;

    const chatId = String(chat.id);
    const newStatus: string = update.new_chat_member?.status;

    if (newStatus === "member" || newStatus === "administrator") {
      await this.leaguesService.upsertGroup(chatId, chat.title ?? null);
      await this.telegramSimple.sendMessage(
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

  private async handlePredictCommand(chatId: number, telegramUserId?: number) {
    const markets = await this.marketRepo.find({
      where: [
        { status: MarketStatus.OPEN },
        { status: MarketStatus.RESOLVING },
      ],
      relations: ["outcomes"],
      order: { closesAt: "ASC" },
      take: 5,
    });

    if (!markets.length) {
      await this.telegramSimple.sendMessage(
        chatId,
        "📊 No active markets right now. Check back soon!",
      );
      return;
    }

    const miniAppUrl =
      this.config.get<string>("TELEGRAM_MINI_APP_URL") ||
      process.env.TELEGRAM_MINI_APP_URL ||
      "";
    const lines = markets.map((m) => {
      const closes = m.closesAt
        ? new Date(m.closesAt).toLocaleString("en-US", {
            dateStyle: "medium",
            timeStyle: "short",
          })
        : "TBD";
      const statusIcon = m.status === MarketStatus.RESOLVING ? "⚖️" : "🟢";

      const totalPool = Number(m.totalPool);
      const outcomeLines = (m.outcomes ?? [])
        .map((o) => {
          const rawPct =
            o.lmsrProbability != null && o.lmsrProbability > 0
              ? o.lmsrProbability * 100
              : totalPool > 0
                ? (Number(o.totalBetAmount) / totalPool) * 100
                : 100 / (m.outcomes?.length || 2);
          const pct = Math.round(Math.min(100, Math.max(0, rawPct)));
          const filled = Math.min(10, Math.round(pct / 10));
          const bar = "█".repeat(filled) + "░".repeat(10 - filled);
          const label = o.label
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
          return `${label}: ${bar} ${pct}%`;
        })
        .join("\n");

      return `${statusIcon} <b>${m.title}</b>\n<pre>${outcomeLines}</pre>\n⏰ ${closes}`;
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
    await this.telegramSimple.sendMessage(chatId, text);
  }

  private async handleVerifyCommand(chatId: number, telegramUserId: number) {
    // Check if this Telegram user has a DK CID linked yet
    const user = await this.userRepo.findOneBy({
      telegramId: String(telegramUserId),
    });

    if (!user || !user.dkCid) {
      await this.telegramSimple.sendMessage(
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
      await this.telegramSimple.sendMessage(
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
      await this.telegramSimple.sendMessage(
        chatId,
        "✅ <b>Your phone is already verified!</b>\n\n" +
          "Your Telegram account is securely linked to your DK Bank account.\n" +
          "You're all set to make payments on <b>Oro</b>.",
      );
      return;
    }

    await this.sendPhoneRequest(chatId);
  }

  private async sendPhoneRequest(chatId: number) {
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
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        },
      );
      if (!res.ok) {
        this.logger.error(
          `[Bot] sendPhoneRequest failed ${res.status}: ${await res.text()}`,
        );
      }
    } catch (err: any) {
      this.logger.error(`[Bot] Failed to send phone request: ${err.message}`);
    }
  }

  async handleCallbackQuery(callback: any) {
    const chatId: number = callback.message?.chat?.id;
    const data: string = callback.data ?? "";
    const callbackQueryId: string = callback.id;

    // ── p:<key>  — short propose key registered by KeeperService ─────────
    if (data.startsWith("p:")) {
      const key = Number(data.slice(2));
      this.logger.log(`[Bot] propose callback received — key=${key} from=${callback.from?.id} chatId=${chatId}`);

      // Always answer the callback query immediately to dismiss the spinner.
      // Telegram only allows ONE answer per callback_query_id, so we must NOT
      // call answerCallbackQuery again inside the try/catch below.
      await this.telegramSimple.answerCallbackQuery(callbackQueryId, "⏳ Processing…");

      // Security: only the configured admin may trigger this
      const adminTelegramId = this.config.get<string>("ADMIN_TELEGRAM_ID");
      if (!adminTelegramId || String(callback.from?.id) !== String(adminTelegramId)) {
        this.logger.warn(
          `[Bot] Unauthorised propose attempt — from=${callback.from?.id} expected=${adminTelegramId}`,
        );
        await this.telegramSimple.sendMessage(chatId, "⛔ <b>Not authorised.</b>");
        return;
      }

      // Resolve the short key back to {marketId, outcomeId} from Redis
      this.logger.log(`[Bot] resolving propose key ${key} from Redis…`);
      const resolved = await this.telegramSimple.resolveProposeKey(key);
      if (!resolved) {
        this.logger.warn(`[Bot] propose key ${key} not found in Redis (expired or Redis down)`);
        await this.telegramSimple.sendMessage(
          chatId,
          "⏰ <b>Button expired.</b> Please use the admin panel to propose a resolution.",
        );
        return;
      }

      const { marketId, outcomeId, windowMinutes: resolvedWindowMins } = resolved;
      this.logger.log(`[Bot] resolved key ${key} → marketId=${marketId} outcomeId=${outcomeId} windowMinutes=${resolvedWindowMins}`);

      try {
        // Load market — use update() later to avoid cascade-save on eager outcomes
        const market = await this.marketRepo.findOne({
          where: { id: marketId },
          relations: ["outcomes"],
        });
        if (!market) throw new Error(`Market ${marketId} not found`);

        this.logger.log(`[Bot] market "${market.title}" status=${market.status}`);

        if (market.status === MarketStatus.RESOLVING) {
          const proposed = (market.outcomes ?? []).find(
            (o) => o.id === market.proposedOutcomeId,
          );
          const deadline = market.disputeDeadlineAt
            ? new Date(market.disputeDeadlineAt).toLocaleString()
            : "unknown";
          await this.telegramSimple.sendMessage(
            chatId,
            `ℹ️ <b>Dispute window already open</b>\n\n` +
              `📊 <b>${market.title}</b>\n` +
              `🏆 Current proposed winner: <b>${proposed?.label ?? "unknown"}</b>\n` +
              `📅 Window closes: ${deadline}\n\n` +
              `The keeper will auto-settle when it expires. If objections come in, resolve via the admin panel.`,
          );
          return;
        }

        if (market.status !== MarketStatus.CLOSED) {
          await this.telegramSimple.sendMessage(
            chatId,
            `⚠️ <b>Cannot open dispute window</b>\n\n` +
              `📊 <b>${market.title}</b>\n` +
              `Current status: <b>${market.status}</b>\n\n` +
              `Only closed markets can enter the dispute phase.`,
          );
          return;
        }

        const outcome = (market.outcomes ?? []).find((o) => o.id === outcomeId);
        if (!outcome) throw new Error(`Outcome ${outcomeId} not found in market`);

        // Use the window duration stored in the Redis key (set by keeper when sending the button)
        const disputeDeadlineAt = new Date(Date.now() + resolvedWindowMins * 60 * 1000);
        await this.marketRepo.update(
          { id: marketId },
          {
            proposedOutcomeId: outcomeId,
            windowMinutes: resolvedWindowMins,
            disputeDeadlineAt,
            status: MarketStatus.RESOLVING,
          },
        );
        await this.redis.del("oro:cache:markets:all", `oro:cache:market:${marketId}`);

        this.logger.log(`[Bot] market "${market.title}" transitioned to RESOLVING via bot propose`);

        // Post objection window announcement to the channel so users see it
        const miniAppUrl =
          this.config.get<string>("TELEGRAM_MINI_APP_URL") ||
          process.env.TELEGRAM_MINI_APP_URL ||
          "";
        const windowLabel =
          resolvedWindowMins >= 60
            ? `${resolvedWindowMins / 60} hour${resolvedWindowMins > 60 ? "s" : ""}`
            : `${resolvedWindowMins} minutes`;
        await this.telegramSimple.postToChannel(
          `⚖️ <b>OBJECTION WINDOW OPEN</b>\n\n` +
            `📊 <b>${market.title}</b>\n\n` +
            `🔖 <b>Proposed Winner:</b> ${outcome.label}\n` +
            `⏳ Window: ${windowLabel} — object if you disagree\n` +
            `💡 Evidence will be published when the market is settled.\n\n` +
            `👉 <a href="${miniAppUrl}">View Market</a>`,
        );

        await this.telegramSimple.sendMessage(
          chatId,
          `⚖️ <b>Dispute Window Opened</b>\n\n` +
            `📊 <b>${market.title}</b>\n` +
            `🏆 Proposed winner: <b>${outcome.label}</b>\n` +
            `⏳ Window: ${windowLabel}\n` +
            `📅 Deadline: ${disputeDeadlineAt.toLocaleString()}\n\n` +
            `The keeper will auto-settle when the window expires with no valid disputes.`,
        );
      } catch (err: any) {
        this.logger.error(`[Bot] propose callback failed: ${err.message}`, err.stack);
        await this.telegramSimple.sendMessage(
          chatId,
          `❌ <b>Could not open dispute window</b>\n\nError: ${err.message}\n\nPlease use the admin panel instead.`,
        );
      }
      return;
    }

    // ── (legacy) propose:<marketId>:<outcomeId> — kept for safety ─────────
    if (data.startsWith("propose:")) {
      const [, marketId, outcomeId] = data.split(":");

      // Security: only the configured admin may trigger this
      await this.telegramSimple.answerCallbackQuery(callbackQueryId, "⏳ Processing…");

      const adminTelegramId = this.config.get<string>("ADMIN_TELEGRAM_ID");
      if (!adminTelegramId || String(callback.from?.id) !== String(adminTelegramId)) {
        await this.telegramSimple.sendMessage(chatId, "⛔ <b>Not authorised.</b>");
        return;
      }

      try {
        const market = await this.marketRepo.findOne({
          where: { id: marketId },
          relations: ["outcomes"],
        });
        if (!market) throw new Error("Market not found");
        if (market.status === MarketStatus.RESOLVING) {
          const proposed = (market.outcomes ?? []).find(
            (o) => o.id === market.proposedOutcomeId,
          );
          const deadline = market.disputeDeadlineAt
            ? new Date(market.disputeDeadlineAt).toLocaleString()
            : "unknown";
          await this.telegramSimple.sendMessage(
            chatId,
            `ℹ️ <b>Dispute window already open</b>\n\n` +
              `📊 <b>${market.title}</b>\n` +
              `🏆 Current proposed winner: <b>${proposed?.label ?? "unknown"}</b>\n` +
              `📅 Window closes: ${deadline}\n\n` +
              `The keeper will auto-settle when it expires. If objections come in, resolve via the admin panel.`,
          );
          return;
        }
        if (market.status !== MarketStatus.CLOSED)
          throw new Error(`Market is "${market.status}", expected "closed"`);

        const outcome = (market.outcomes ?? []).find((o) => o.id === outcomeId);
        if (!outcome) throw new Error("Outcome not found in market");

        const LEGACY_WINDOW_MINS = 60; // 1-hour default for legacy callbacks
        const disputeDeadlineAt = new Date(Date.now() + LEGACY_WINDOW_MINS * 60 * 1000);
        await this.marketRepo.update(
          { id: marketId },
          {
            proposedOutcomeId: outcomeId,
            windowMinutes: LEGACY_WINDOW_MINS,
            disputeDeadlineAt,
            status: MarketStatus.RESOLVING,
          },
        );
        await this.redis.del("oro:cache:markets:all", `oro:cache:market:${marketId}`);
        this.logger.log(`[Bot][legacy] Admin proposed "${outcome.label}" for "${market.title}"`);

        // Post objection window announcement to the channel
        const miniAppUrlLegacy =
          this.config.get<string>("TELEGRAM_MINI_APP_URL") ||
          process.env.TELEGRAM_MINI_APP_URL ||
          "";
        const legacyWindowLabel = `1 hour`;
        await this.telegramSimple.postToChannel(
          `⚖️ <b>OBJECTION WINDOW OPEN</b>\n\n` +
            `📊 <b>${market.title}</b>\n\n` +
            `🔖 <b>Proposed Winner:</b> ${outcome.label}\n` +
            `⏳ Window: ${legacyWindowLabel} — object if you disagree\n` +
            `💡 Evidence will be published when the market is settled.\n\n` +
            `👉 <a href="${miniAppUrlLegacy}">View Market</a>`,
        );

        await this.telegramSimple.sendMessage(
          chatId,
          `⚖️ <b>Dispute Window Opened</b>\n\n` +
            `📊 <b>${market.title}</b>\n` +
            `🏆 Proposed winner: <b>${outcome.label}</b>\n` +
            `⏳ Window: ${legacyWindowLabel}\n` +
            `📅 Deadline: ${disputeDeadlineAt.toLocaleString()}\n\n` +
            `The keeper will auto-settle when the window expires with no valid disputes.`,
        );
      } catch (err: any) {
        this.logger.error(`[Bot][legacy] propose callback failed: ${err.message}`);
        await this.telegramSimple.sendMessage(
          chatId,
          `❌ <b>Could not open dispute window</b>\n\nError: ${err.message}\n\nPlease use the admin panel instead.`,
        );
      }
      return;
    }

    // ── Default ────────────────────────────────────────────────────────────
    await this.telegramSimple.answerCallbackQuery(callbackQueryId);
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
