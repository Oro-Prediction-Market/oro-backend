console.log('Testing environment variables...');
console.log('Current working directory:', process.cwd());
console.log('TELEGRAM_BOT_TOKEN:', process.env.TELEGRAM_BOT_TOKEN);
console.log('All env vars starting with TELEGRAM:', Object.keys(process.env).filter(k => k.startsWith('TELEGRAM')));

// Test if dotenv is working with explicit path
require('dotenv').config({ path: './.env' });
console.log('After dotenv config with explicit path:');
console.log('TELEGRAM_BOT_TOKEN:', process.env.TELEGRAM_BOT_TOKEN);
