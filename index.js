const axios = require('axios');
const http = require('http');
require('dotenv').config();

// --- Configuration Parsing ---
const PORT = process.env.PORT || 3000;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const TARGET_PRICE = Number(process.env.TARGET_PRICE) || 26300;

const MIN_SINGLE_TRANS_AMOUNT = Number(process.env.MIN_SINGLE_TRANS_AMOUNT) || 0;
const MAX_SINGLE_TRANS_AMOUNT = Number(process.env.MAX_SINGLE_TRANS_AMOUNT) || Infinity;

// Dynamic lookback tracking variables
const TRACKING_INTERVAL_MIN = Number(process.env.TRACKING_INTERVAL_MIN) || 5; 
const TRACKING_WINDOW_MIN = Number(process.env.TRACKING_WINDOW_MIN) || 30;   

const MONITOR_INTERVAL_MS = TRACKING_INTERVAL_MIN * 60 * 1000;       
const SUMMARY_INTERVAL_MS = (Number(process.env.SUMMARY_INTERVAL_MIN) || 10) * 60 * 1000;  
const MAX_HISTORY_WINDOW_MS = TRACKING_WINDOW_MIN * 60 * 1000; 

// --- Constants & State Trackers ---
const BINANCE_P2P_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
const FEAR_GREED_URL = 'https://api.alternative.me/fng/';
const BINANCE_24HR_TICKER_URL = 'https://api.binance.com/api/v3/ticker/24hr';

let lastKnownMarketData = null;
const adNotificationTracker = new Map(); 
const MAX_ALERTS_PER_AD = 3;
const fngAlertTracker = new Set();

// Holds historical data points per asset symbol
const priceHistoryLog = new Map();

/**
 * Global utility to fetch resources with retry fallback loops
 */
async function fetchWithRetry(url, options = {}, retries = 3, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await axios({ url, ...options });
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(res => setTimeout(res, delay));
    }
  }
}

/**
 * Crawls Binance P2P Ad Books
 */
async function fetchP2POrderBook() {
  const payload = {
    fiat: 'VND',
    page: 1,
    rows: 10,
    tradeType: 'SELL',
    asset: 'USDT',
    countries: [],
    proMerchantAds: false,
    shieldMerchantAds: false,
    publisherType: null,
    payTypes: []
  };

  try {
    const response = await fetchWithRetry(BINANCE_P2P_URL, {
      method: 'POST',
      data: payload,
      headers: { 'Content-Type': 'application/json' }
    });
    return response.data?.data || [];
  } catch (error) {
    console.error('❌ Binance P2P API Connection Error:', error.message);
    return [];
  }
}

/**
 * Filter valid trading ads out of raw order books
 */
function calculateHighestSellPrice(advs) {
  const validAdvs = advs.filter(item => {
    const price = parseFloat(item.adv.price);
    const minAmount = parseFloat(item.adv.minSingleTransAmount);
    const maxAmount = parseFloat(item.adv.maxSingleTransAmount);

    return (
      price >= TARGET_PRICE &&
      minAmount >= MIN_SINGLE_TRANS_AMOUNT &&
      maxAmount <= MAX_SINGLE_TRANS_AMOUNT
    );
  });

  if (validAdvs.length === 0) return null;

  const highestAd = validAdvs.reduce((max, item) => 
    parseFloat(item.adv.price) > parseFloat(max.adv.price) ? item : max
  , validAdvs[0]);

  return {
    price: parseFloat(highestAd.adv.price),
    merchantName: highestAd.advertiser.nickName,
    advId: highestAd.adv.advNo,
    minAmount: highestAd.adv.minSingleTransAmount,
    maxAmount: highestAd.adv.maxSingleTransAmount
  };
}

/**
 * Dispatches raw content messages directly to Discord Webhooks
 */
async function sendDiscordNotification(content) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log('⚠️ Missing DISCORD_WEBHOOK_URL variable. Output skipped.');
    return;
  }
  try {
    await axios.post(DISCORD_WEBHOOK_URL, { content });
  } catch (error) {
    console.error('❌ Failed delivering notification to Discord payload:', error.message);
  }
}

/**
 * Crawls Alternative.me crypto sentiment data streams
 */
async function fetchFearAndGreedData() {
  try {
    const response = await axios.get(FEAR_GREED_URL, { timeout: 5000 });
    const data = response.data?.data?.[0];
    if (data) {
      return {
        value: data.value,
        classification: data.value_classification
      };
    }
    return null;
  } catch (error) {
    console.error('❌ Fear and Greed Index Connection Error:', error.message);
    return null;
  }
}

/**
 * Dynamic lookback calculation tracking method
 */
function calculateIntervalChanges(history, currentPrice) {
  const results = {};
  const now = Date.now();

  // Automatically scales step loops using whatever values you passed to your ENV file
  const intervals = [];
  for (let i = TRACKING_INTERVAL_MIN; i <= TRACKING_WINDOW_MIN; i += TRACKING_INTERVAL_MIN) {
    intervals.push(i);
  }

  intervals.forEach(minutes => {
    const targetAgeMs = minutes * 60 * 1000;
    const targetTimestamp = now - targetAgeMs;

    let bestMatch = null;
    let smallestDiff = Infinity;

    for (const record of history) {
      const diff = Math.abs(record.timestamp - targetTimestamp);
      const tolerance = (TRACKING_INTERVAL_MIN * 60 * 1000) / 2; 
      
      if (diff < smallestDiff && diff < tolerance) { 
        smallestDiff = diff;
        bestMatch = record;
      }
    }

    if (bestMatch) {
      const percentChange = ((currentPrice - bestMatch.price) / bestMatch.price) * 100;
      const sign = percentChange >= 0 ? '+' : '';
      results[`${minutes}m`] = `${sign}${percentChange.toFixed(2)}%`;
    } else {
      results[`${minutes}m`] = '⏳ Calibrating';
    }
  });

  return results;
}

/**
 * Pulls, stores, and evaluates comparative spot history variations
 */
async function fetchSpotTickerData(symbol) {
  try {
    const response = await axios.get(`${BINANCE_24HR_TICKER_URL}?symbol=${symbol}`, { timeout: 5000 });
    if (response?.data) {
      const currentPrice = parseFloat(response.data.lastPrice);
      const now = Date.now();

      if (!priceHistoryLog.has(symbol)) {
        priceHistoryLog.set(symbol, []);
      }
      const history = priceHistoryLog.get(symbol);
      history.push({ timestamp: now, price: currentPrice });

      // Clean logs dynamically according to maximum evaluation windows
      const boundaryTime = now - MAX_HISTORY_WINDOW_MS;
      while (history.length > 0 && history[0].timestamp < boundaryTime) {
        history.shift();
      }

      return {
        rawPrice: currentPrice,
        rawChange: parseFloat(response.data.priceChangePercent),
        highPrice: parseFloat(response.data.highPrice),
        lowPrice: parseFloat(response.data.lowPrice),
        historyIntervals: calculateIntervalChanges(history, currentPrice)
      };
    }
    return null;
  } catch (error) {
    console.error(`❌ Spot Ticker Error (${symbol}):`, error.message);
    return null;
  }
}

/**
 * Evaluates state updates and packages execution triggers
 */
async function executeTrackingRoutine() {
  console.log('🤖 Executing evaluation pipeline routines...');
  
  const p2pAdvs = await fetchP2POrderBook();
  const targetAd = calculateHighestSellPrice(p2pAdvs);
  
  const btcData = await fetchSpotTickerData('BTCUSDT');
  const ethData = await fetchSpotTickerData('ETHUSDT');
  const fngData = await fetchFearAndGreedData();

  if (btcData || ethData || targetAd) {
    lastKnownMarketData = {
      p2p: targetAd,
      btc: btcData,
      eth: ethData,
      fng: fngData,
      updatedAt: new Date().toLocaleTimeString()
    };
  }

  // P2P Alert Processor
  if (targetAd) {
    const alertCount = adNotificationTracker.get(targetAd.advId) || 0;
    if (alertCount < MAX_ALERTS_PER_AD) {
      const message = `🚨 **P2P Target Hit!**\n` +
                      `• **Merchant:** ${targetAd.merchantName}\n` +
                      `• **Price:** ${targetAd.price.toLocaleString()} VND\n` +
                      `• **Limits:** ${Number(targetAd.minAmount).toLocaleString()} - ${Number(targetAd.maxAmount).toLocaleString()} VND`;
      
      await sendDiscordNotification(message);
      adNotificationTracker.set(targetAd.advId, alertCount + 1);
    }
  }

  // Fear & Greed Sentiment Trigger
  if (fngData) {
    const fngScore = parseInt(fngData.value);
    if ((fngScore <= 20 || fngScore >= 80) && !fngAlertTracker.has(fngScore)) {
      const emotionAlert = fngScore <= 20 ? '😨 Extreme Fear' : '🤑 Extreme Greed';
      const fngMessage = `⚠️ **Market Sentiment Warning**\n` +
                         `The Crypto Fear & Greed Index hit **${fngScore}** (${emotionAlert}). Expect high volatility!`;
      await sendDiscordNotification(fngMessage);
      fngAlertTracker.add(fngScore);
    }
  }
}

/**
 * Compiles a visual summary card report out of localized trackers
 */
async function transmitSummaryReport() {
  if (!lastKnownMarketData) {
    console.log('⚠️ Skipping summary sequence: No current data cached yet.');
    return;
  }

  const { p2p, btc, eth, fng, updatedAt } = lastKnownMarketData;

  let summary = `📊 **MARKET SNAPSHOT SUMMARY** (${updatedAt})\n`;
  summary += `───────────────────\n`;

  if (p2p) {
    summary += `💵 **P2P Best Offer:** ${p2p.price.toLocaleString()} VND (${p2p.merchantName})\n\n`;
  } else {
    summary += `💵 **P2P Best Offer:** No ads found matching criteria\n\n`;
  }

  if (btc) {
    const btcChanges = Object.entries(btc.historyIntervals)
      .map(([time, change]) => `**${time}:** ${change}`)
      .join(' | ');

    summary += `🪙 **BTC/USDT:** $${btc.rawPrice.toLocaleString()}\n` +
               `• 24h Change: ${btc.rawChange >= 0 ? '+' : ''}${btc.rawChange.toFixed(2)}%\n` +
               `• Range Log: ${btcChanges}\n\n`;
  }

  if (eth) {
    const ethChanges = Object.entries(eth.historyIntervals)
      .map(([time, change]) => `**${time}:** ${change}`)
      .join(' | ');

    summary += `🔷 **ETH/USDT:** $${eth.rawPrice.toLocaleString()}\n` +
               `• 24h Change: ${eth.rawChange >= 0 ? '+' : ''}${eth.rawChange.toFixed(2)}%\n` +
               `• Range Log: ${ethChanges}\n\n`;
  }

  if (fng) {
    summary += `📈 **Fear & Greed Index:** ${fng.value} (${fng.classification})\n`;
  }
  
  summary += `───────────────────`;

  await sendDiscordNotification(summary);
}

// --- Scheduler Loop Processors ---
executeTrackingRoutine(); 
setInterval(executeTrackingRoutine, MONITOR_INTERVAL_MS);
setInterval(transmitSummaryReport, SUMMARY_INTERVAL_MS);

// Simple Health Check Server Interface
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'healthy', monitoring_interval_ms: MONITOR_INTERVAL_MS }));
});

server.listen(PORT, () => {
  console.log(`🚀 Telemetry runtime service listening on port ${PORT}`);
});
