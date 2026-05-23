const axios = require('axios');
const http = require('http');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const TARGET_PRICE = Number(process.env.TARGET_PRICE) || 26300;

const MONITOR_INTERVAL_MS = (Number(process.env.MONITOR_INTERVAL_MIN) || 1) * 60 * 1000;       
const SUMMARY_INTERVAL_MS = (Number(process.env.SUMMARY_INTERVAL_MIN) || 10) * 60 * 1000;  

const BINANCE_P2P_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
const FEAR_GREED_URL = 'https://api.alternative.me/fng/';
const BINANCE_24HR_TICKER_URL = 'https://api.binance.com/api/v3/ticker/24hr';

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
 * Helper to fetch spot market price and 24-hour rate of change metrics
 */
async function fetchSpotTickerData(symbol) {
  try {
    const response = await axios.get(`${BINANCE_24HR_TICKER_URL}?symbol=${symbol}`);
    if (response?.data?.lastPrice && response?.data?.priceChangePercent) {
      return {
        rawPrice: parseFloat(response.data.lastPrice),
        rawChange: parseFloat(response.data.priceChangePercent)
      };
    }
    return null;
  } catch (error) {
    console.error(`Spot Ticker Error (${symbol}):`, error.message);
    return null;
  }
}

/**
 * Algorithmic rule engine determining action items based on market state
 */
function generateExpertSuggestion(fngValue, btc, eth, bnb) {
  let actions = [];
  let marketContext = "Neutral/Consolidation";

  // 1. Evaluate Macro Sentiment
  if (fngValue <= 25) {
    marketContext = "Extreme Fear (High Value Buying Zone)";
    actions.push("💎 **BUY ACCUMULATION:** Historically, an FnG below 25 is the optimal window to scale into BTC spot. Avoid leverage, build long-term positions.");
  } else if (fngValue >= 75) {
    marketContext = "Extreme Greed (Overextended Risk Zone)";
    actions.push("🚨 **TAKE PROFIT / HOLD CASH:** Retail FOMO is peaking. Consider scaling out 10-15% of your altcoin positions into USDT using your P2P alert targets.");
  }

  // 2. Relative Strength & Rotation Assessment (BTC vs ETH/BNB)
  if (btc && eth && bnb) {
    const ethBtcRatio = eth.rawPrice / btc.rawPrice;
    
    // Check if Altcoins are showing relative strength or bleeding against BTC
    if (eth.rawChange > btc.rawChange + 1.5) {
      actions.push("🔄 **ALT ROTATION:** ETH is outperforming BTC over 24h. If the ETH/BTC ratio breaks local resistance, short-term momentum favors high-cap layer-1s like ETH and BNB.");
    } else if (btc.rawChange > eth.rawChange + 1.0) {
      actions.push("🛡️ **FLIGHT TO QUALITY:** BTC is absorbing market liquidity while ETH bleeds on the ratio. **Hold or Buy BTC** over alts right now; it remains the preferred corporate asset.");
    }

    // Specific Ecosystem Catalyst Rule (e.g., BNB ETF/AI Narrative speculation)
    if (bnb.rawChange > 5.0) {
      actions.push("🟨 **BNB MOMENTUM:** BNB is showing sudden vertical strength. If you hold short-term trade bags, lock in partial profits or trail your stop-loss closely.");
    }
  }

  // Fallback default action item if market is flat
  if (actions.length === 0) {
    actions.push("⏱️ **PATIENCE:** Market structure shows low-volatility consolidation. Keep your powder dry in USDT. Do not chase minor intra-day movements.");
  }

  return {
    context: marketContext,
    bullets: actions.map(act => `> ${act}`).join("\n")
  };
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

    if (marketData && marketData.price <= TARGET_PRICE) {
      if (TARGET_PRICE > 30000) {
        console.error(`⚠️ [Configuration Alert] Your TARGET_PRICE (${TARGET_PRICE}) configuration exceeds standard thresholds. Skipping notification to prevent spam.`);
        return;
      }

      let alertMessage = `⚠️ **P2P TARGET REACHED** @everyone\n> 💰 **Price:** ${marketData.price} VND\n> 👤 **Merchant:** ${marketData.merchant}\n> 🎯 **Target Set:** Under ${TARGET_PRICE} VND`;
      
      if (fngData) {
        alertMessage += `\n> 🎭 **Current Crypto Sentiment:** ${fngValueText}`;
      }
      await sendDiscordNotification(alertMessage);
    }

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
 * Gathers instant stats and sends formatted report including spot tickers and automated expert advice
 */
async function sendInstantSummary() {
  console.log(`📊 Compiling snapshot report for Discord...`);
  
  try {
    const fngData = await fetchFearAndGreedData();
    const fngIndexText = fngData ? `${fngData.value} (${fngData.classification})` : 'Data Unavailable';
    const marketData = lastKnownMarketData;

    // Fetch spot ticker metrics concurrently
    const [btc, eth, bnb] = await Promise.all([
      fetchSpotTickerData('BTCUSDT'),
      fetchSpotTickerData('ETHUSDT'),
      fetchSpotTickerData('BNBUSDT')
    ]);

    // Format output strings safely
    const formatDisplay = (data, isBtc) => {
      if (!data) return { text: 'Fetch Err', indicator: '❌' };
      const formattedPrice = isBtc 
        ? Math.floor(data.rawPrice).toLocaleString('en-US') 
        : data.rawPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const sign = data.rawChange >= 0 ? '+' : '';
      return {
        text: `$${formattedPrice} (${sign}${data.rawChange.toFixed(2)}%)`,
        indicator: data.rawChange >= 0 ? '🟩' : '🟥'
      };
    };

    const btcDisplay = formatDisplay(btc, true);
    const ethDisplay = formatDisplay(eth, false);
    const bnbDisplay = formatDisplay(bnb, false);

    let p2pText = 'No recent data collected';
    if (marketData) {
      p2pText = `**${marketData.price} VND** (Merchant: ${marketData.merchant})`;
    }

    // Run programmatic data variables through our logic rules engine
    const fngValue = fngData ? fngData.value : 50; 
    const advice = generateExpertSuggestion(fngValue, btc, eth, bnb);

    const summaryMessage = `📊 **MARKET UPDATE SUMMARY**\n` +
                           `==============================\n` +
                           `📉 **Instant Lowest P2P:** ${p2pText}\n` +
                           `🎭 **Crypto Fear & Greed:** ${fngIndexText}\n` +
                           `🎯 **Active Alert Target:** Under ${TARGET_PRICE} VND\n` +
                           `==============================\n` +
                           `🪙 **Global Spot Prices & 24h Change:**\n` +
                           `> ${btcDisplay.indicator} **BTC:** ${btcDisplay.text}\n` +
                           `> ${ethDisplay.indicator} **ETH:** ${ethDisplay.text}\n` +
                           `> ${bnbDisplay.indicator} **BNB:** ${bnbDisplay.text}\n` +
                           `==============================\n` +
                           `🧠 **AI / EXPERT STRATEGY SUGGESTION:**\n` +
                           `> 📋 **Market State Context:** *${advice.context}*\n` +
                           `${advice.bullets}\n` +
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

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'online', setup: 'Automated Sentiment & Price Watcher' }));
});

server.listen(PORT, () => {
  console.log(`📡 Production engine live on port ${PORT}`);
  console.log(`🎯 Target Threshold: ${TARGET_PRICE} VND`);
  console.log(`⏱️  Check Loop: Every ${process.env.MONITOR_INTERVAL_MIN || 1} min | Report Loop: Every ${process.env.SUMMARY_INTERVAL_MIN || 10} min`);
  
  monitorThreshold(); 
  setInterval(monitorThreshold, MONITOR_INTERVAL_MS);
  setInterval(sendInstantSummary, SUMMARY_INTERVAL_MS);
});
