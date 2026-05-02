import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Market } from "../entities/market.entity";
import { TelegramService } from "./telegram.service";

@Injectable()
export class TelegramChannelService {
  private readonly logger = new Logger(TelegramChannelService.name);
  private readonly botToken: string;
  private readonly channelId: string;

  private readonly miniAppUrl: string;
  private readonly botUsername: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly telegramService: TelegramService,
  ) {
    this.botToken = this.configService.get<string>("TELEGRAM_BOT_TOKEN") || "";
    this.channelId =
      this.configService.get<string>("TELEGRAM_CHANNEL_ID") || "";
    this.miniAppUrl =
      this.configService.get<string>("TELEGRAM_MINI_APP_URL") || "";
    this.botUsername =
      this.configService.get<string>("TELEGRAM_BOT_USERNAME") || "";
  }

  async initializeChannel(): Promise<void> {
    try {
      // Verify bot is admin of the channel
      const botInfo = await this.getBotInfo();
      const channelInfo = await this.getChannelInfo();

      if (botInfo && channelInfo) {
        this.logger.log(`Telegram Channel initialized: ${channelInfo.title}`);
        await this.sendWelcomeMessage();
      } else {
        this.logger.error(
          "Failed to initialize Telegram Channel - check bot permissions and channel ID",
        );
      }
    } catch (error) {
      this.logger.error("Error initializing Telegram Channel", error);
    }
  }
  async sendMarketAnnouncement(market: Market): Promise<void> {
    try {
      const message = this.formatChannelMarketAnnouncement(market);
      const keyboard = this.createChannelKeyboard(market);

      await this.sendChannelMessage(message, keyboard);

      // Also send to individual users who have notifications enabled
      await this.telegramService.sendMarketAnnouncement(market);

      this.logger.log(`Market announcement sent to channel: ${market.title}`);
    } catch (error) {
      this.logger.error("Failed to send market announcement to channel", error);
    }
  }

  async sendMarketResolution(market: Market): Promise<void> {
    try {
      const message = this.formatChannelMarketResolution(market);

      await this.sendChannelMessage(message);

      // Also send individual notifications to bettors
      await this.notifyBettors(market);

      this.logger.log(`Market resolution sent to channel: ${market.title}`);
    } catch (error) {
      this.logger.error("Failed to send market resolution to channel", error);
    }
  }

  async sendEngagementContent(content: {
    title: string;
    message: string;
    imageUrl?: string;
    buttons?: Array<{ text: string; url: string }>;
  }): Promise<void> {
    try {
      const message = this.formatEngagementContent(content);
      const keyboard = content.buttons
        ? this.createEngagementKeyboard(content.buttons)
        : undefined;

      await this.sendChannelMessage(message, keyboard);

      this.logger.log(`Engagement content sent to channel: ${content.title}`);
    } catch (error) {
      this.logger.error("Failed to send engagement content to channel", error);
    }
  }

  async sendDailyDigest(): Promise<void> {
    try {
      const digest = await this.generateDailyDigest();

      await this.sendChannelMessage(digest.message, digest.keyboard);

      this.logger.log("Daily digest sent to channel");
    } catch (error) {
      this.logger.error("Failed to send daily digest to channel", error);
    }
  }

  async sendWeeklyStats(): Promise<void> {
    try {
      const stats = await this.generateWeeklyStats();

      await this.sendChannelMessage(stats.message, stats.keyboard);

      this.logger.log("Weekly stats sent to channel");
    } catch (error) {
      this.logger.error("Failed to send weekly stats to channel", error);
    }
  }

  private async sendChannelMessage(
    text: string,
    keyboard?: any,
  ): Promise<void> {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const payload: Record<string, unknown> = {
        chat_id: this.channelId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      };
      if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    } catch (error: any) {
      this.logger.error("Failed to send channel message", error.message);
      throw error;
    }
  }

  private async getBotInfo(): Promise<any> {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/getMe`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.result;
    } catch (error: any) {
      this.logger.error("Failed to get bot info", error.message);
      return null;
    }
  }

  private async getChannelInfo(): Promise<any> {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/getChat`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.channelId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.result;
    } catch (error: any) {
      this.logger.error("Failed to get channel info", error.message);
      return null;
    }
  }

  private async sendWelcomeMessage(): Promise<void> {
    const welcomeMessage = `
🎯 <b>Welcome to Oro Prediction Markets!</b>

📈 Get real-time market announcements
🏆 Follow resolution results
📊 Track platform statistics
💬 Engage with the community

👇 <b>Quick Actions:</b>
    `.trim();

    const keyboard = [
      [
        {
          text: "🎯 Browse Markets",
          url: `https://t.me/${this.botUsername}?start=browse`,
        },
      ],
      [
        {
          text: "📊 View Stats",
          url: `https://t.me/${this.botUsername}?start=stats`,
        },
      ],
    ];

    await this.sendChannelMessage(welcomeMessage, keyboard);
  }

  private async notifyBettors(market: Market): Promise<void> {
    // This would find all users who bet on this market and send individual notifications
    // Implementation depends on your bet entity structure
    this.logger.log(`Notifying bettors for market: ${market.id}`);
  }

  private async generateDailyDigest(): Promise<{
    message: string;
    keyboard?: any;
  }> {
    const activeMarkets = 5; // Get from database
    const resolvedMarkets = 3; // Get from database
    const totalVolume = "$50,000"; // Calculate from database

    const message = `
📊 <b>Daily Market Digest</b>

🎯 <b>Active Markets:</b> ${activeMarkets}
✅ <b>Resolved Today:</b> ${resolvedMarkets}  
💰 <b>Total Volume:</b> ${totalVolume}

🔥 <b>Top Performers:</b>
1. @winner1 - 85% win rate
2. @winner2 - 78% win rate  
3. @winner3 - 72% win rate

👇 <b>Today's Hot Markets:</b>
    `.trim();

    const keyboard = [
      [
        {
          text: "🎯 View Active Markets",
          url: `https://t.me/${this.botUsername}?start=markets`,
        },
      ],
      [
        {
          text: "📈 Open Oro",
          url: this.miniAppUrl,
        },
      ],
    ];

    return { message, keyboard };
  }

  private async generateWeeklyStats(): Promise<{
    message: string;
    keyboard?: any;
  }> {
    const weeklyMarkets = 25; // Get from database
    const weeklyVolume = "$350,000"; // Calculate from database
    const activeUsers = 1250; // Get from database

    const message = `
📈 <b>Weekly Performance Report</b>

🎯 <b>Markets Created:</b> ${weeklyMarkets}
💰 <b>Trading Volume:</b> ${weeklyVolume}
👥 <b>Active Users:</b> ${activeUsers}

🏆 <b>Weekly Champions:</b>
🥇 @champion1 - $5,230 profit
🥈 @champion2 - $3,890 profit  
🥉 @champion3 - $2,450 profit

📊 <b>Market Categories:</b>
• Sports: 45%
• Politics: 25%
• Crypto: 20%
• Other: 10%

Keep predicting and winning! 🎯
    `.trim();

    const keyboard = [
      [
        {
          text: "🎯 Start Predicting",
          url: `https://t.me/${this.botUsername}?start=predict`,
        },
      ],
      [
        {
          text: "📊 Open Oro",
          url: this.miniAppUrl,
        },
      ],
    ];

    return { message, keyboard };
  }

  private formatChannelMarketAnnouncement(market: Market): string {
    const closesAt = new Date(market.closesAt).toLocaleString();
    const outcomes = market.outcomes.map((o) => o.label).join(" vs ");

    return `
🚀 <b>NEW MARKET AVAILABLE</b> 🚀

📊 <b>${market.title}</b>

🎲 <b>Outcomes:</b>
${outcomes}

⏰ <b>Closes:</b> ${closesAt}

💰 <b>Pool:</b> Nu ${Number(market.totalPool).toLocaleString()}

👇 <b>Predict Now:</b>
• <a href="${this.miniAppUrl}">Open Oro</a>

#PredictionMarkets #Oro
    `.trim();
  }

  private formatChannelMarketResolution(market: Market): string {
    const resolvedAt = new Date().toLocaleString();
    const winningOutcome = market.outcomes.find((o) => o.isWinner);

    return `
✅ <b>MARKET RESOLVED</b> ✅

📊 <b>${market.title}</b>

🏆 <b>Winning Outcome:</b>
${winningOutcome?.label || "Pending"}

💰 <b>Final Pool:</b> Nu ${Number(market.totalPool).toLocaleString()}

⏰ <b>Resolved:</b> ${resolvedAt}

👇 <b>View Details:</b>
• <a href="${this.miniAppUrl}">Open Oro</a>

#MarketResults #OroPredictions
    `.trim();
  }

  private formatEngagementContent(content: any): string {
    let message = `
🎯 <b>${content.title}</b>

${content.message}
    `.trim();

    if (content.imageUrl) {
      message += `\n🖼️ [Image](${content.imageUrl})`;
    }

    return message;
  }

  private createChannelKeyboard(_market: Market): any {
    return [
      [
        {
          text: "🎯 Predict Now",
          url: this.miniAppUrl,
        },
        {
          text: "📈 View All Markets",
          url: `https://t.me/${this.botUsername}?start=markets`,
        },
      ],
    ];
  }

  private createEngagementKeyboard(
    buttons: Array<{ text: string; url: string }>,
  ): any {
    return buttons.map((button) => [button]);
  }
}
