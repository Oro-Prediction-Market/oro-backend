// Test the exact same way as BotController
const botToken = process.env.TELEGRAM_BOT_TOKEN;
console.log('Bot token (BotController style):', botToken);

if (!botToken) {
  console.log('❌ Bot token not configured');
} else {
  console.log('✅ Bot token found:', botToken.substring(0, 10) + '...');
}
