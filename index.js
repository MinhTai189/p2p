const axios = require('axios');
const http = require('http');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Parse targeted price parameter safely from process variables
const TARGET_PRICE = Number(process.env.TARGET_PRICE) || 26300;

// Execution intervals
const MONITOR_INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS) * 60000;       // Check every 1 minute
const SUMMARY_INTERVAL_MS = Number(process.env.SUMMARY_INTERVAL_MS) * 60000;  // Send interval summary every 10 minutes

const BINANCE_P2P_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
const FEAR_GREED_URL = 'https://api.alternative.me/fng/';

/**
 * Reusable helper to pull top active rate from Binance
 */
async function fetchCurrentP2PPrice() {
  const payload = {
    "asset": "USDT",
    "fiat": "VND",
    "tradeType": "BUY",
    "page": 1,
    "rows": 10,
    "payTypes": [],
    "countries": [],
    "publisherType": "merchant",
    "proMerchantAds": false,
    "shieldMerchantAds": false
  }

  const response = await axios.post(BINANCE_P2P_URL, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  if (!response?.data?.data || response.data.data.length === 0) {
    return null;
  }

  const topAd = response.data.data[0];
  return {
    price: parseFloat(topAd.adv.price),
    merchant: topAd.advertiser.nickName
  };
}

/**
 * Monitors threshold and alerts immediately if condition met (Every 1 minute)
 */
async function monitorThreshold() {
  try {
    const marketData = await fetchCurrentP2PPrice();
    if (!marketData) return;

    console.log(`[${new Date().toLocaleTimeString()}] Price Check: ${marketData.price} VND (Target: ${TARGET_PRICE})`);

    if (marketData.price <= TARGET_PRICE) {
      const alertMessage = `⚠️ **P2P TARGET REACHED** @everyone\n> 💰 **Price:** ${marketData.price} VND\n> 👤 **Merchant:** ${marketData.merchant}\n> 🎯 **Target Set:** Under ${TARGET_PRICE} VND`;
      await sendDiscordNotification(alertMessage);
    }
  } catch (error) {
    console.error('Threshold Monitor Error:', error.message);
  }
}

/**
 * Fetches Fear & Greed Index
 */
async function getFearAndGreedIndex() {
  try {
    const response = await axios.get(FEAR_GREED_URL);
    if (response?.data?.data && response.data.data.length > 0) {
      const currentData = response.data.data[0];
      return `${currentData.value} (${currentData.value_classification})`;
    }
    return 'Data Unavailable';
  } catch (error) {
    console.error('Fear & Greed API Error:', error.message);
    return 'Fetch Failed';
  }
}

/**
 * Gathers instant stats and sends formatted report (Every 10 minutes)
 */
async function sendInstantSummary() {
  console.log(`📊 Compiling 10-minute snapshot for Discord...`);
  
  try {
    const [marketData, fngIndex] = await Promise.all([
      fetchCurrentP2PPrice(),
      getFearAndGreedIndex()
    ]);

    let p2pText = 'No active ads detected';
    if (marketData) {
      p2pText = `**${marketData.price} VND** (Merchant: ${marketData.merchant})`;
    }

    const summaryMessage = `📊 **10-MINUTE MARKET UPDATE**\n` +
                           `==============================\n` +
                           `📉 **Instant Lowest P2P:** ${p2pText}\n` +
                           `🎭 **Crypto Fear & Greed:** ${fngIndex}\n` +
                           `🎯 **Active Alert Target:** Under ${TARGET_PRICE} VND\n` +
                           `==============================\n` +
                           `⚙️ *Bot Status: Operational*`;

    await sendDiscordNotification(summaryMessage);
  } catch (error) {
    console.error('Failed to compile 10-minute snapshot:', error.message);
  }
}

/**
 * Directly posts text data payloads to Discord Webhook channel
 */
async function sendDiscordNotification(messageText) {
  if (!DISCORD_WEBHOOK_URL) {
    console.error('DISCORD_WEBHOOK_URL variable missing.');
    return;
  }

  try {
    await axios.post(DISCORD_WEBHOOK_URL, {
      content: messageText
    });
    console.log('✅ Message delivered to Discord.');
  } catch (error) {
    console.error('Failed to route payload to Discord:', error.response?.data || error.message);
  }
}

// Render dynamic port binding server
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'online', channel: 'Discord Integration' }));
});

server.listen(PORT, () => {
  console.log(`📡 Production engine live on port ${PORT}`);
  console.log(`🎯 Current Target Threshold: ${TARGET_PRICE} VND`);
  
  // Initiate intervals
  monitorThreshold(); 
  setInterval(monitorThreshold, MONITOR_INTERVAL_MS);
  setInterval(sendInstantSummary, SUMMARY_INTERVAL_MS);
});
