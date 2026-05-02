import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, Not, IsNull } from "typeorm";
import { User } from "../entities/user.entity";
import { Market, MarketStatus } from "../entities/market.entity";
import { Position, PositionStatus } from "../entities/position.entity";

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

interface TelegramInlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

interface TelegramInlineKeyboard {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

interface TelegramInlineKeyboardRow {
  inline_keyboard: TelegramInlineKeyboardButton[];
}

interface TelegramMessage {
  message_id: number;
  text: string;
  chat: {
    id: number;
    type: string;
    first_name: string;
    last_name?: string;
    username?: string;
  };
  from: TelegramUser;
  date: number;
}

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly botToken: string;
  private readonly webhookUrl: string;
  private readonly miniAppUrl: string;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(User) private readonly userRepository: Repository<User>,
    @InjectRepository(Market)
    private readonly marketRepository: Repository<Market>,
    @InjectRepository(Position) private readonly betRepository: Repository<Position>,
  ) {
    this.botToken = this.configService.getOrThrow<string>("TELEGRAM_BOT_TOKEN");
    this.webhookUrl = this.configService.getOrThrow<string>("TELEGRAM_WEBHOOK_URL");
    this.miniAppUrl = this.configService.getOrThrow<string>("TELEGRAM_MINI_APP_URL");
  }

  async setWebhook(): Promise<void> {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/setWebhook`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: this.webhookUrl,
          allowed_updates: ["message", "callback_query"],
          secret_token: this.configService.get<string>(
            "TELEGRAM_WEBHOOK_SECRET",
          ),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      this.logger.log("Telegram webhook set successfully");
    } catch (error: any) {
      this.logger.error("Failed to set Telegram webhook", error.message);
      throw error;
    }
  }

  async sendMessage(
    chatId: number,
    text: string,
    keyboard?: TelegramInlineKeyboard,
  ): Promise<void> {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const payload: Record<string, unknown> = {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      };
      if (keyboard) {
        payload.reply_markup = { inline_keyboard: keyboard.inline_keyboard };
      }
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        this.logger.error(
          `Telegram sendMessage HTTP ${res.status}: ${await res.text()}`,
        );
        return;
      }
      this.logger.log(`Message sent to chat ${chatId}: ${text}`);
    } catch (error: any) {
      this.logger.error(
        `Failed to send message to chat ${chatId}: ${error.message}`,
      );
    }
  }

  async sendMarketAnnouncement(market: Market): Promise<void> {
    const users = await this.userRepository.find({
      where: { telegramId: Not(IsNull()) },
    });

    const message = this.formatMarketAnnouncement(market);
    const keyboard = this.createMarketKeyboard([market]);

    for (const user of users) {
      await this.sendMessage(Number(user.telegramId), message, keyboard);
    }

    this.logger.log(
      `Market announcement sent to ${users.length} users: ${market.title}`,
    );
  }

  async sendPositionResult(bet: Position, market: Market): Promise<void> {
    const user = await this.userRepository.findOne({
      where: { id: bet.userId },
    });

    if (!user?.telegramId) return;

    const message = this.formatPositionResult(bet, market);
    await this.sendMessage(Number(user.telegramId), message);

    // Update user streak
    await this.updateUserStreak(user.id, bet.status === PositionStatus.WON);

    this.logger.log(`Position result sent to user ${user.id}: ${bet.status}`);
  }

  async sendPredictionRequest(chatId: number): Promise<void> {
    const activeMarkets = await this.marketRepository.find({
      where: { status: MarketStatus.OPEN },
      order: { closesAt: "ASC" },
      take: 5,
    });

    if (activeMarkets.length === 0) {
      await this.sendMessage(
        chatId,
        "🎯 No active markets right now. Check back later!",
      );
      return;
    }

    const keyboard = this.createPredictionKeyboard(activeMarkets);
    await this.sendMessage(chatId, "🎯 Select a market to predict:", keyboard);
  }

  async handleCallbackQuery(callbackQuery: any): Promise<void> {
    const { data, from, message } = callbackQuery;

    try {
      if (data.startsWith("predict_")) {
        const marketId = data.replace("predict_", "");
        await this.sendMiniAppLink(from.id, marketId, message.message_id);
      } else if (data.startsWith("bet_")) {
        await this.handleQuickPosition(data, from.id);
      } else if (data === "view_portfolio") {
        await this.sendPortfolioView(from.id);
      } else if (data === "view_markets") {
        await this.sendPredictionRequest(from.id);
      }
    } catch (error) {
      this.logger.error("Error handling callback query", error);
    }
  }

  private async sendMiniAppLink(
    chatId: number,
    marketId: string,
    messageId: number,
  ): Promise<void> {
    const miniAppUrl = `${this.miniAppUrl}?market=${marketId}&tgWebAppStartParam=${encodeURIComponent(JSON.stringify({ chatId }))}`;

    const keyboard: TelegramInlineKeyboard = {
      inline_keyboard: [
        [
          {
            text: "🎯 Open Prediction App",
            url: miniAppUrl,
          },
        ],
      ],
    };

    await this.sendMessage(
      chatId,
      "🚀 Opening prediction interface...",
      keyboard,
    );
  }

  private async handleQuickPosition(
    callbackData: string,
    userId: number,
  ): Promise<void> {
    const [_, marketId, outcome] = callbackData.split("_");

    const market = await this.marketRepository.findOne({
      where: { id: marketId },
    });
    if (!market || market.status !== MarketStatus.OPEN) {
      return;
    }

    // Create quick bet logic here
    // This would integrate with your existing betting system
    this.logger.log(
      `Quick bet request: ${marketId} - ${outcome} by user ${userId}`,
    );
  }

  private async sendPortfolioView(chatId: number): Promise<void> {
    const user = await this.userRepository.findOne({
      where: { telegramId: String(chatId) },
    });

    if (!user) {
      await this.sendMessage(
        chatId,
        "📊 No portfolio found. Start making predictions!",
      );
      return;
    }

    const bets = await this.betRepository.find({
      where: { userId: user.id },
      relations: ["market"],
      order: { placedAt: "DESC" },
      take: 10,
    });

    const message = this.formatPortfolioView(user, bets);
    await this.sendMessage(chatId, message);
  }

  private async updateUserStreak(userId: string, won: boolean): Promise<void> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) return;

    const currentStreak = user.telegramStreak || 0;
    const newStreak = won ? currentStreak + 1 : 0;

    await this.userRepository.update(userId, { telegramStreak: newStreak });

    if (newStreak > currentStreak && newStreak >= 3) {
      // Send streak notification
      const userWithChat = await this.userRepository.findOne({
        where: { id: userId },
      });
      if (userWithChat?.telegramId) {
        await this.sendMessage(
          Number(userWithChat.telegramId),
          `🔥 ${newStreak} wins in a row! You're on fire! 🔥`,
        );
      }
    }
  }

  private formatMarketAnnouncement(market: Market): string {
    const closesAt = new Date(market.closesAt).toLocaleString();
    const outcomes = market.outcomes.map((o) => o.label).join(" vs ");

    return (
      `🎯 <b>New Market Available</b>\n\n` +
      `📊 ${market.title}\n` +
      `🎲 ${outcomes}\n` +
      `⏰ Closes: ${closesAt}\n\n` +
      `👇 Click below to make your prediction!`
    );
  }

  private formatPositionResult(bet: Position, market: Market): string {
    const outcome = market.outcomes.find((o) => o.id === bet.outcomeId);
    const result = bet.status === PositionStatus.WON ? "✅ WON" : "❌ LOST";
    const amount = bet.amount.toLocaleString();

    return (
      `🎯 <b>Position Result</b>\n\n` +
      `📊 ${market.title}\n` +
      `🎲 Your pick: ${outcome?.label}\n` +
      `💰 Amount: $${amount}\n` +
      `📈 Result: ${result}`
    );
  }

  private formatPortfolioView(user: User, bets: Position[]): string {
    const totalPositions = bets.length;
    const wonPositions = bets.filter((b) => b.status === PositionStatus.WON).length;
    const winRate =
      totalPositions > 0 ? ((wonPositions / totalPositions) * 100).toFixed(1) : "0";
    const streak = user.telegramStreak || 0;

    return (
      `📊 <b>Your Portfolio</b>\n\n` +
      `🔥 Current Streak: ${streak} 🔥\n` +
      `📈 Win Rate: ${winRate}%\n` +
      `💰 Total Positions: ${totalPositions}\n` +
      `✅ Won: ${wonPositions}\n\n` +
      `👇 View more details in the Mini App`
    );
  }

  private createMarketKeyboard(markets: Market[]): TelegramInlineKeyboard {
    const keyboard = markets.map((market) => [
      {
        text: `🎯 ${market.title.substring(0, 30)}...`,
        callback_data: `predict_${market.id}`,
      },
    ]);

    return {
      inline_keyboard: [
        ...keyboard,
        [{ text: "📊 View All Markets", callback_data: "view_markets" }],
        [{ text: "💼 My Portfolio", callback_data: "view_portfolio" }],
      ],
    };
  }

  private createPredictionKeyboard(markets: Market[]): TelegramInlineKeyboard {
    const keyboard = markets.map((market) => {
      const timeUntilClose = new Date(market.closesAt).getTime() - Date.now();
      const hoursLeft = Math.floor(timeUntilClose / (1000 * 60 * 60));
      const urgency = hoursLeft < 2 ? "🔥" : hoursLeft < 6 ? "⚡" : "📊";

      return [
        {
          text: `${urgency} ${market.title.substring(0, 25)}...`,
          callback_data: `predict_${market.id}`,
        },
      ];
    });

    return { inline_keyboard: keyboard };
  }

  async broadcastMessage(
    message: string,
    targetUsers?: string[],
  ): Promise<void> {
    let query = this.userRepository
      .createQueryBuilder("user")
      .where("user.telegramId IS NOT NULL");

    if (targetUsers && targetUsers.length > 0) {
      query = query.andWhere("user.id IN (:...ids)", { ids: targetUsers });
    }

    const users = await query.getMany();
    const batchSize = 30; // Rate limit: 30 messages per second
    const batches = Math.ceil(users.length / batchSize);

    for (let i = 0; i < batches; i++) {
      const batch = users.slice(i * batchSize, (i + 1) * batchSize);

      await Promise.all(
        batch.map((user) =>
          this.sendMessage(Number(user.telegramId), message).catch((error) =>
            this.logger.error(`Failed to send to ${user.id}`, error),
          ),
        ),
      );

      // Rate limiting: wait 1 second between batches
      if (i < batches - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    this.logger.log(
      `Broadcast message sent to ${users.length} users in ${batches} batches`,
    );
  }
}
