const axios = require('axios');
const http = require('http');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const TARGET_PRICE = Number(process.env.TARGET_PRICE) || 26300;

// Extract raw minutes from env configuration and cleanly convert to milliseconds
const MONITOR_INTERVAL_MS = (Number(process.env.MONITOR_INTERVAL_MIN) || 1) * 60 * 1000;       
const SUMMARY_INTERVAL_MS = (Number(process.env.SUMMARY_INTERVAL_MIN) || 10) * 60 * 1000;  

const BINANCE_P2P_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
const FEAR_GREED_URL = 'https://api.alternative.me/fng/';

let lastKnownMarketData = null;

/**
 * Robust fetcher wrapper with Exponential Backoff for 429 Handling
 */
async function fetchWithRetry(url, data, headers, retries = 3, delay = 2000) {
  try {
    return await axios.post(url, data, { headers });
  } catch (error) {
    if (error.response && error.response.status === 429 && retries > 0) {
      console.warn(`⚠️ [429 Throttled] Binance rate limit hit. Retrying in ${delay / 1000}s... (${retries} attempts left)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchWithRetry(url, data, headers, retries - 1, delay * 2);
    }
    throw error;
  }
}

/**
 * Reusable helper to pull top active rate from Binance with targeted merchant filter
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
  };

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };

  try {
    const response = await fetchWithRetry(BINANCE_P2P_URL, payload, headers);
    if (!response?.data?.data || response.data.data.length === 0) return null;

    const topAd = response.data.data[0];
    return {
      price: parseFloat(topAd.adv.price),
      merchant: topAd.advertiser.nickName
    };
  } catch (error) {
    console.error('P2P Fetch Error:', error.message);
    return null;
  }
}

/**
 * Clean data fetcher for Fear & Greed API metrics
 */
async function fetchFearAndGreedData() {
  try {
    const response = await axios.get(FEAR_GREED_URL);
    if (response?.data?.data && response.data.data.length > 0) {
      const currentData = response.data.data[0];
      return {
        value: Number(currentData.value),
        classification: currentData.value_classification
      };
    }
    return null;
  } catch (error) {
    console.error('Fear & Greed API Error:', error.message);
    return null;
  }
}

/**
 * Combined threshold agent evaluating local price targets and macro extreme fear signals
 */
async function monitorThreshold() {
  try {
    const marketData = await fetchCurrentP2PPrice();
    if (marketData) lastKnownMarketData = marketData;

    const fngData = await fetchFearAndGreedData();
    const fngValueText = fngData ? `${fngData.value} (${fngData.classification})` : 'Data Unavailable';

    console.log(`[${new Date().toLocaleTimeString()}] Audit -> P2P: ${marketData?.price || 'ERR'} VND | FnG: ${fngValueText}`);

    // Scenario A: Local Target Triggered
    if (marketData && marketData.price <= TARGET_PRICE) {
      let alertMessage = `⚠️ **P2P TARGET REACHED** @everyone\n> 💰 **Price:** ${marketData.price} VND\n> 👤 **Merchant:** ${marketData.merchant}\n> 🎯 **Target Set:** Under ${TARGET_PRICE} VND`;
      
      // Attach supplementary market health data if available
      if (fngData) {
        alertMessage += `\n> 🎭 **Current Crypto Sentiment:** ${fngValueText}`;
      }
      await sendDiscordNotification(alertMessage);
    }

    // Scenario B: Macro FNG Indicator Target Hit (Under 25 - Extreme Fear)
    if (fngData && fngData.value < 25) {
      const warningMessage = `🚨 **MACRO BUYING ALERT: EXTREME FEAR** @everyone\n` +
                             `> 📉 **Fear & Greed Index dropped to:** **${fngData.value}/100** (${fngData.classification})\n` +
                             `> 💡 *Historical Data Rule: This represents an optimal accumulation window for long-term spot positions.*`;
      await sendDiscordNotification(warningMessage);
    }

  } catch (error) {
    console.error('Threshold Monitor Cycle Error:', error.message);
  }
}

/**
 * Gathers instant stats and sends formatted report
 */
async function sendInstantSummary() {
  console.log(`📊 Compiling snapshot report for Discord...`);
  
  try {
    const fngData = await fetchFearAndGreedData();
    const fngIndexText = fngData ? `${fngData.value} (${fngData.classification})` : 'Data Unavailable';
    const marketData = lastKnownMarketData;

    let p2pText = 'No recent data collected';
    if (marketData) {
      p2pText = `**${marketData.price} VND** (Merchant: ${marketData.merchant})`;
    }

    const summaryMessage = `📊 **MARKET UPDATE SUMMARY**\n` +
                           `==============================\n` +
                           `📉 **Instant Lowest P2P:** ${p2pText}\n` +
                           `🎭 **Crypto Fear & Greed:** ${fngIndexText}\n` +
                           `🎯 **Active Alert Target:** Under ${TARGET_PRICE} VND\n` +
                           `==============================\n` +
                           `⚙️ *Bot Status: Operational*`;

    await sendDiscordNotification(summaryMessage);
  } catch (error) {
    console.error('Failed to compile interval snapshot:', error.message);
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
    await axios.post(DISCORD_WEBHOOK_URL, { content: messageText });
    console.log('✅ Message delivered to Discord.');
  } catch (error) {
    console.error('Failed to route payload to Discord:', error.message);
  }
}

// Render dynamic port binding server
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'online', setup: 'Automated Sentiment & Price Watcher' }));
});

server.listen(PORT, () => {
  console.log(`📡 Production engine live on port ${PORT}`);
  console.log(`🎯 Target Threshold: ${TARGET_PRICE} VND`);
  console.log(`⏱️  Check Loop: Every ${process.env.MONITOR_INTERVAL_MIN || 1} min | Report Loop: Every ${process.env.SUMMARY_INTERVAL_MIN || 10} min`);
  
  // Initiate intervals using computed values
  monitorThreshold(); 
  setInterval(monitorThreshold, MONITOR_INTERVAL_MS);
  setInterval(sendInstantSummary, SUMMARY_INTERVAL_MS);
});
