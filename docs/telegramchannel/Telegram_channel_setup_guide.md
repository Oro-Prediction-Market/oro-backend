# Telegram Channel Setup Guide

## Three-Surface Architecture Setup

### **Telegram Channel Setup**

#### 1. Create Telegram Bot
1. Go to [@BotFather](https://t.me/botfather)
2. Send `/newbot`
3. Choose a name: `Oro Prediction Bot`
4. Choose a username: `Oro_prediction_bot`
5. Save your **Bot Token** (add to `.env`)

#### 2. Create Telegram Channel
1. Create a new channel in Telegram
2. Set channel type: **Public**
3. Choose username: `@Oro_prediction_markets`
4. Add your bot as **Administrator**:
   - Go to Channel Settings → Administrators → Add Admin
   - Select your bot: `@Oro_prediction_bot`
   - Enable: **Post Messages**, **Edit Messages**, **Pin Messages**

#### 3. Get Channel ID
1. Send a message to your channel
2. Use this bot to get channel ID: [@get_id_bot](https://t.me/get_id_bot)
3. Channel ID format: `-1001234567890` (include the `-100` prefix)

#### 4. Environment Configuration
Add to your `.env` file:

```bash
# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_CHANNEL_ID=-1001234567890
TELEGRAM_WEBHOOK_URL=https://your-domain.com/api/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=your-webhook-secret-key
TELEGRAM_MINI_APP_URL=https://your-mini-app-url.com

# Optional: Discussion Group
TELEGRAM_DISCUSSION_GROUP=-1009876543210
```

### **Telegram Bot Features**

#### Bot Commands
```
/start - Welcome message with main menu
/predict - Browse active markets
/portfolio - View your betting history
/streak - Check current winning streak
/help - Show available commands
```

#### Inline Mode
- Type `@Oro_prediction_bot` in any chat
- See quick market previews
- One-click predictions

#### Rate Limiting
- **30 messages/second** global limit
- Batch processing for broadcasts
- Automatic retry on failures

### 🌐 **Telegram Mini App Setup**

#### 1. Create Mini App
1. Go to [@BotFather](https://t.me/botfather)
2. Send `/mybots` → Select your bot
3. Select **Menu Bot** → **Configure**
4. Set **Web App URL**: `https://your-mini-app-url.com`

#### 2. Mini App Features
- **Zero-friction auth** via Telegram initData
- **Real-time updates** with WebSocket
- **Full market browsing** and betting
- **Wallet management** and portfolio
- **Responsive design** for mobile/desktop

### 📊 **Channel Content Strategy**

#### Daily Content Schedule
```
09:00 - Daily Digest (active markets, top performers)
12:00 - New Market Announcements
15:00 - Engagement Content (polls, discussions)
18:00 - Market Reminders (closing soon)
21:00 - Resolution Results
```

#### Content Types
1. **Market Announcements**
   - New markets with inline buttons
   - Quick predict links
   - Estimated volume indicators

2. **Resolution Results**
   - Winning outcomes
   - Pool sizes and statistics
   - Portfolio impact

3. **Engagement Content**
   - Daily/weekly statistics
   - Top performers leaderboard
   - Community polls and discussions

4. **Educational Content**
   - How-to guides
   - Strategy tips
   - Platform updates

### 🔧 **API Integration**

#### Market Creation Flow
```typescript
// When admin creates new market
await telegramChannelService.sendMarketAnnouncement(market)

// Automatic triggers:
// - Market created → Channel announcement
// - Market resolved → Channel notification
// - Bet placed → User notification
```

#### Webhook Setup
```typescript
// Set webhook for real-time updates
POST https://api.telegram.org/bot<TOKEN>/setWebhook
{
  "url": "https://your-domain.com/api/telegram/webhook",
  "allowed_updates": ["message", "callback_query"],
  "secret_token": "your-secret"
}
```

### 📈 **Analytics & Monitoring**

#### Channel Metrics
- **Reach**: Total subscribers
- **Engagement**: Click-through rates
- **Conversions**: Bot → Mini App signups
- **Retention**: Daily active users

#### Performance Tracking
```typescript
// Track channel performance
const metrics = {
  announcementsSent: 150,
  clickThroughRate: 0.23, // 23%
  miniAppSignups: 45,
  dailyActiveUsers: 1250
}
```

### 🛡️ **Security & Compliance**

#### Rate Limiting
- **30 messages/second** global limit
- Batch processing for large broadcasts
- Automatic retry with exponential backoff

#### Webhook Security
- **Secret token** validation
- **IP whitelisting** for webhooks
- **Request signing** verification

#### Data Privacy
- **GDPR compliant** data handling
- **User consent** for notifications
- **Data retention** policies

### 🚀 **Testing & Deployment**

#### Local Testing
1. Use **ngrok** for webhook testing:
   ```bash
   ngrok http 3000
   # Use ngrok URL for webhook
   ```

2. Test bot commands and inline mode
3. Verify channel announcements
4. Test Mini App integration

#### Production Deployment
1. Set **HTTPS** webhook URL
2. Configure **SSL certificates**
3. Set up **monitoring** and alerts
4. Test **rate limiting** under load

### 📞 **Support & Troubleshooting**

#### Common Issues
1. **Bot not receiving messages**
   - Check webhook URL is accessible
   - Verify SSL certificate
   - Check bot permissions

2. **Channel announcements not working**
   - Verify bot is channel admin
   - Check channel ID format
   - Test bot token validity

3. **Mini App not loading**
   - Check Web App URL configuration
   - Verify HTTPS and valid certificate
   - Test initData authentication

#### Debug Commands
```bash
# Check bot info
curl https://api.telegram.org/bot<TOKEN>/getMe

# Check channel info
curl -X POST https://api.telegram.org/bot<TOKEN>/getChat \
  -H "Content-Type: application/json" \
  -d '{"chat_id": "-1001234567890"}'

# Test webhook
curl -X POST https://your-domain.com/api/telegram/webhook \
  -H "Content-Type: application/json" \
  -d '{"message": {"text": "test"}}'
```

### 🎯 **Success Metrics**

#### KPIs to Track
- **Channel Growth**: +20% monthly subscribers
- **Engagement Rate**: >15% click-through
- **Conversion Rate**: >5% bot → Mini App
- **User Retention**: >60% monthly active
- **Revenue Impact**: +30% trading volume

#### Optimization Tips
1. **A/B test** message formats
2. **Optimize send times** for engagement
3. **Personalize** content segments
4. **Monitor** competitor channels
5. **Iterate** based on analytics

---

## 🎉 **You're Ready!**

Your three-surface Telegram architecture is now configured:

✅ **Telegram Channel**: Market announcements and engagement  
✅ **Telegram Bot**: Quick predictions and notifications  
✅ **Telegram Mini App**: Full prediction experience  
✅ **Backend Integration**: Real-time data synchronization  
✅ **Rate Limiting**: 30 messages/second compliance  
✅ **Security**: Webhook validation and user privacy  

Start by creating your first market and watch it appear in the Telegram channel! 🚀
