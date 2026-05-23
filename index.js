const axios = require('axios');
const http = require('http');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const TARGET_PRICE = Number(process.env.TARGET_PRICE) || 26300;

// Filter environment parameters (Default to 0 and Infinity if omitted)
const MIN_SINGLE_TRANS_AMOUNT = Number(process.env.MIN_SINGLE_TRANS_AMOUNT) || 0;
const MAX_SINGLE_TRANS_AMOUNT = Number(process.env.MAX_SINGLE_TRANS_AMOUNT) || Infinity;

const MONITOR_INTERVAL_MS = (Number(process.env.MONITOR_INTERVAL_MIN) || 1) * 60 * 1000;       
const SUMMARY_INTERVAL_MS = (Number(process.env.SUMMARY_INTERVAL_MIN) || 10) * 60 * 1000;  

const BINANCE_P2P_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
const FEAR_GREED_URL = 'https://api.alternative.me/fng/';
const BINANCE_24HR_TICKER_URL = 'https://api.binance.com/api/v3/ticker/24hr';

// Global memory state
let lastKnownMarketData = null;
const adNotificationTracker = new Map(); 
const MAX_ALERTS_PER_AD = 3;

/**
 * Robust fetcher wrapper with Exponential Backoff
 */
async function fetchWithRetry(url, data, headers, retries = 3, delay = 2000) {
  try {
    return await axios.post(url, data, { headers, timeout: 8000 });
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
 * Fetch ALL active retail and merchant P2P ads
 */
async function fetchP2POrderBook() {
  const payload = {
    "asset": "USDT",
    "fiat": "VND",
    "tradeType": "BUY",
    "page": 1,
    "rows": 10,
    "payTypes": [],
    "countries": [],
    "proMerchantAds": false,
    "shieldMerchantAds": false
  };

  const headers = {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://p2p.binance.com',
    'Referer': 'https://p2p.binance.com/en/trade/all-payments/USDT?fiat=VND',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  };

  try {
    const response = await fetchWithRetry(BINANCE_P2P_URL, payload, headers);
    if (!response?.data?.data || response.data.data.length === 0) return null;
    return response.data.data;
  } catch (error) {
    console.error('P2P Fetch Error:', error.message);
    return null;
  }
}

async function fetchFearAndGreedData() {
  try {
    const response = await axios.get(FEAR_GREED_URL);
    if (response?.data?.data && response.data.data.length > 0) {
      const currentData = response.data.data[0];
      return { value: Number(currentData.value), classification: currentData.value_classification };
    }
    return null;
  } catch (error) {
    console.error('Fear & Greed API Error:', error.message);
    return null;
  }
}

/**
 * Enhanced spot fetcher gathering high/low spreads alongside price changes
 */
async function fetchSpotTickerData(symbol) {
  try {
    const response = await axios.get(`${BINANCE_24HR_TICKER_URL}?symbol=${symbol}`);
    if (response?.data) {
      return {
        rawPrice: parseFloat(response.data.lastPrice),
        rawChange: parseFloat(response.data.priceChangePercent),
        highPrice: parseFloat(response.data.highPrice),
        lowPrice: parseFloat(response.data.lowPrice)
      };
    }
    return null;
  } catch (error) {
    console.error(`Spot Ticker Error (${symbol}):`, error.message);
    return null;
  }
}

/**
 * DYNAMIC QUANT ENGINE (No Hardcoded Text Rules)
 * Generates programmatic strategies using asset velocity spreads & market premium ratios
 */
function runDynamicQuantEngine(fngValue, currentP2PPrice, btc, eth, bnb, sol) {
  let actions = [];
  let marketContext = "Stable Consolidation";

  // P2P Premium/Discount Index vs Global Banking Spot Estimates 
  const IMPLIED_GLOBAL_USD_VND = 25420; 
  if (currentP2PPrice) {
    const premiumRatio = ((currentP2PPrice / IMPLIED_GLOBAL_USD_VND) - 1) * 100;
    
    if (premiumRatio > 2.5) {
      marketContext = "High Domestic Capital Flight";
      actions.push(`⚠️ **P2P OVERPRICED (+${premiumRatio.toFixed(2)}% Premium):** Local demand for stablecoins is heavily decoupled from global rates. High risk of local capital exhaustion. Consider pausing heavy buy orders.`);
    } else if (premiumRatio < -0.5) {
      marketContext = "Domestic Capital Capitulation";
      actions.push(`💎 **P2P UNDERPRICED (${premiumRatio.toFixed(2)}% Discount):** P2P is trading below global spot parity. Excellent cash-to-crypto fiat entry window via localized market mispricings.`);
    }
  }

  // Macro Sentiment Velocity
  if (fngValue <= 20) {
    actions.push(`📉 **MACRO VELOCITY (FnG ${fngValue}):** Deep historical value window. Mathematical data favors immediate Spot dollar-cost averaging (DCA) over momentum tracking.`);
  } else if (fngValue >= 80) {
    actions.push(`🚨 **MACRO SATURATION (FnG ${fngValue}):** Market risks overextension. Velocity exhaustion imminent; protect dollar liquidity.`);
  }

  // Mathematical Rotation Matrix (Relative Strength Coefficients)
  if (btc && eth && sol) {
    const ethVsBtcSpread = eth.rawChange - btc.rawChange;
    const solVsBtcSpread = sol.rawChange - btc.rawChange;

    if (solVsBtcSpread > 4.0) {
      const dailyVolatility = ((sol.highPrice - sol.lowPrice) / sol.lowPrice) * 100;
      actions.push(`🔄 **SOLANA ALPHA ROTATION:** SOL is outperforming BTC by **${solVsBtcSpread.toFixed(2)}%** with a 24h trading spread volatility of **${dailyVolatility.toFixed(2)}%**. Market favor has aggressive capital rotation shifting toward the Solana ecosystem.`);
    } else if (ethVsBtcSpread > 2.5) {
      actions.push(`🔄 **EVM LARGE-CAP EXPANSION:** ETH velocity is outpacing BTC by **${ethVsBtcSpread.toFixed(2)}%**. Capital flows are moving down the risk curve into legacy smart-contract platforms.`);
    } else if (btc.rawChange > eth.rawChange && btc.rawChange > sol.rawChange) {
      actions.push(`🛡️ **LIQUIDITY DRAINDOWN TO CORE:** BTC dominance is crushing major alts (ETH Spread: ${ethVsBtcSpread.toFixed(2)}% | SOL Spread: ${solVsBtcSpread.toFixed(2)}%). Capital is exiting high-risk networks back into core digital gold layers.`);
    }
  }

  if (actions.length === 0) {
    actions.push("⏱️ **EQUILIBRIUM MONITORING:** Variance spreads across asset blocks are minimal. Volatility compression is occurring; hold neutral balance profiles.");
  }

  return {
    context: marketContext,
    bullets: actions.map(act => act).join("\n")
  };
}

/**
 * Cache Pruning Logic
 */
function purgeOldCacheTrackingRecords() {
  if (adNotificationTracker.size > 500) {
    const trackingKeys = Array.from(adNotificationTracker.keys());
    for (let i = 0; i < 150; i++) {
      adNotificationTracker.delete(trackingKeys[i]);
    }
  }
}

/**
 * Threshold Verification Engine Loop with Amount Filters Embedded
 */
async function monitorThreshold() {
  try {
    const adList = await fetchP2POrderBook();
    if (!adList || adList.length === 0) return;

    // Filter ad listings based on single transaction amount specifications 
    const filteredAds = adList.filter(entry => {
      const minTrans = Number(entry.adv.minSingleTransAmount);
      const maxTrans = Number(entry.adv.maxSingleTransAmount);
      
      return minTrans >= MIN_SINGLE_TRANS_AMOUNT && maxTrans <= MAX_SINGLE_TRANS_AMOUNT;
    });

    if (filteredAds.length === 0) {
      console.log(`[${new Date().toLocaleTimeString()}] Audit -> No ads matched the current single transaction filters.`);
      return;
    }

    // Cache the absolute top ad meeting our filtered requirements
    lastKnownMarketData = {
      price: parseFloat(filteredAds[0].adv.price),
      merchant: filteredAds[0].advertiser.nickName,
      minSingleTransAmount: filteredAds[0].adv.minSingleTransAmount,
      maxSingleTransAmount: filteredAds[0].adv.maxSingleTransAmount
    };

    const fngData = await fetchFearAndGreedData();
    const fngValueText = fngData ? `${fngData.value} (${fngData.classification})` : 'Data Unavailable';

    console.log(`[${new Date().toLocaleTimeString()}] Audit -> P2P: ${lastKnownMarketData.price} VND | FnG: ${fngValueText}`);

    for (const entry of filteredAds) {
      const price = parseFloat(entry.adv.price);
      const merchant = entry.advertiser.nickName;
      const advNo = entry.adv.advNo;
      const minSingleTrans = Number(entry.adv.minSingleTransAmount).toLocaleString('en-US');
      const maxSingleTrans = Number(entry.adv.maxSingleTransAmount).toLocaleString('en-US');

      if (price <= TARGET_PRICE) {
        const currentAlertCount = adNotificationTracker.get(advNo) || 0;

        if (currentAlertCount < MAX_ALERTS_PER_AD) {
          adNotificationTracker.set(advNo, currentAlertCount + 1);

          let alertMessage = `⚠️ **P2P TARGET REACHED**\n` + 
                             `> 💰 **Price:** ${price} VND\n` + 
                             `> 👤 **User:** ${merchant}\n` + 
                             `> 🆔 **Ad No:** ${advNo}\n` + 
                             `> 📉 **Min Limits:** ${minSingleTrans} VND\n` + 
                             `> 📈 **Max Limits:** ${maxSingleTrans} VND\n` + 
                             `> 🎯 **Target Set:** Under ${TARGET_PRICE} VND`;
                             
          await sendDiscordNotification(alertMessage);
          break; 
        }
      }
    }

    purgeOldCacheTrackingRecords();
  } catch (error) {
    console.error('Threshold Monitor Cycle Error:', error.message);
  }
}

/**
 * Summary Displayer
 */
async function sendInstantSummary() {
  try {
    const fngData = await fetchFearAndGreedData();
    const fngIndexText = fngData ? `${fngData.value} (${fngData.classification})` : 'Data Unavailable';
    const marketData = lastKnownMarketData;

    const [btc, eth, bnb, sol] = await Promise.all([
      fetchSpotTickerData('BTCUSDT'),
      fetchSpotTickerData('ETHUSDT'),
      fetchSpotTickerData('BNBUSDT'),
      fetchSpotTickerData('SOLUSDT')
    ]);

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
    const solDisplay = formatDisplay(sol, false);

    let p2pPriceRaw = null;
    let p2pText = 'No recent data collected';
    if (marketData) {
      p2pPriceRaw = marketData.price;
      const formattedMin = Number(marketData.minSingleTransAmount).toLocaleString('en-US');
      const formattedMax = Number(marketData.maxSingleTransAmount).toLocaleString('en-US');
      p2pText = `**${p2pPriceRaw} VND** (User: ${marketData.merchant})\n> ⚖️ **Ad Range Limits:** ${formattedMin} - ${formattedMax} VND`;
    }

    const fngValue = fngData ? fngData.value : 50; 
    const advice = runDynamicQuantEngine(fngValue, p2pPriceRaw, btc, eth, bnb, sol);

    const summaryMessage = `📊 **DYNAMIC QUANT REPORT**\n` +
                           `==============================\n` +
                           `📉 **Instant Lowest P2P:** ${p2pText}\n` +
                           `🎭 **Crypto Fear & Greed:** ${fngIndexText}\n` +
                           `🎯 **Active Alert Target:** Under ${TARGET_PRICE} VND\n` +
                           `==============================\n` +
                           `🪙 **Global Spot Market Indexes:**\n` +
                           `> ${btcDisplay.indicator} **BTC:** ${btcDisplay.text}\n` +
                           `> ${ethDisplay.indicator} **ETH:** ${ethDisplay.text}\n` +
                           `> ${bnbDisplay.indicator} **BNB:** ${bnbDisplay.text}\n` +
                           `> ${solDisplay.indicator} **SOL:** ${solDisplay.text}\n` +
                           `==============================\n` +
                           `🧠 **MATHEMATICAL ROTATION METRICS:**\n` +
                           `> 📋 **Macro Phase Context:** *${advice.context}*\n\n` +
                           `${advice.bullets}\n` +
                           `==============================\n` +
                           `⚙️ *Bot Status: Operational*`;

    await sendDiscordNotification(summaryMessage);
  } catch (error) {
    console.error('Failed to compile dynamic summary snapshot:', error.message);
  }
}

async function sendDiscordNotification(messageText) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await axios.post(DISCORD_WEBHOOK_URL, { content: messageText });
  } catch (error) {
    console.error('Discord Delivery Failure:', error.message);
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'online' }));
});

server.listen(PORT, () => {
  console.log(`Server executing tracking workflows on port ${PORT}`);
  monitorThreshold(); 
  setInterval(monitorThreshold, MONITOR_INTERVAL_MS);
  setInterval(sendInstantSummary, SUMMARY_INTERVAL_MS);
});
