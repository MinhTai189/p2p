const axios = require('axios');
const http = require('http');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const TARGET_PRICE = Number(process.env.TARGET_PRICE) || 26300;

// Filter environment parameters
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

// Tracker to prevent FnG alert spamming (tracks by daily timestamp provided by the API)
const fngAlertTracker = new Set();

/**
 * Robust fetcher wrapper with Exponential Backoff
 */
async function fetchWithRetry(url, data, headers, retries = 3, delay = 2000) {
  try {
    return await axios.post(url, data, { headers, timeout: 8000 });
  } catch (error) {
    if (error.response?.status === 429 && retries > 0) {
      console.warn(`⚠️ [429 Throttled] Binance rate limit hit. Retrying in ${delay / 1000}s... (${retries} attempts left)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchWithRetry(url, data, headers, retries - 1, delay * 2);
    }
    throw error;
  }
}

/**
 * Fetch active P2P ads (Refactored to accept dynamic tradeType inputs)
 */
async function fetchP2POrderBook(tradeType = "BUY") {
  const payload = {
    "asset": "USDT",
    "fiat": "VND",
    "tradeType": tradeType,
    "page": 1,
    "rows": 20,
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
    'Referer': `https://p2p.binance.com/en/trade/all-payments/USDT?fiat=VND`,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  };

  try {
    const response = await fetchWithRetry(BINANCE_P2P_URL, payload, headers);
    return response?.data?.data || null;
  } catch (error) {
    console.error(`❌ P2P Fetch Error (${tradeType}):`, error.message);
    return null;
  }
}

/**
 * Calculates the average of the 5 highest sell prices matching your wallet limits.
 * Note: When tradeType is "SELL" on Binance P2P, you are looking at ads from buyers 
 * who want to purchase your crypto. The prices are already sorted descending 
 * (highest payout first).
 */
async function calculateHighestSellPrice() {
  const sellAds = await fetchP2POrderBook("SELL");
  if (!sellAds || sellAds.length === 0) return null;

  const filteredSellAds = sellAds.filter(entry => {
    const minTrans = Number(entry.adv.minSingleTransAmount);
    const maxTrans = Number(entry.adv.maxSingleTransAmount);
    return minTrans <= MAX_SINGLE_TRANS_AMOUNT && maxTrans >= MIN_SINGLE_TRANS_AMOUNT;
  });

  if (filteredSellAds.length === 0) return null;

  // Extract prices from the top 5 ads (or fewer if less than 5 match filters)
  const targetBatch = filteredSellAds.slice(0, 5);
  const totalSum = targetBatch.reduce((sum, entry) => sum + parseFloat(entry.adv.price), 0);
  
  return totalSum / targetBatch.length;
}

async function fetchFearAndGreedData() {
  try {
    const response = await axios.get(FEAR_GREED_URL, { timeout: 5000 });
    const currentData = response?.data?.data?.[0];
    if (currentData) {
      return { 
        value: Number(currentData.value), 
        classification: currentData.value_classification,
        timestamp: currentData.timestamp 
      };
    }
    return null;
  } catch (error) {
    console.error('❌ Fear & Greed API Error:', error.message);
    return null;
  }
}

/**
 * Enhanced spot fetcher gathering high/low spreads alongside price changes
 */
async function fetchSpotTickerData(symbol) {
  try {
    const response = await axios.get(`${BINANCE_24HR_TICKER_URL}?symbol=${symbol}`, { timeout: 5000 });
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
    console.error(`❌ Spot Ticker Error (${symbol}):`, error.message);
    return null;
  }
}

/**
 * DYNAMIC QUANT ENGINE
 * Generates programmatic strategies using asset velocity spreads & market premium ratios
 */
function runDynamicQuantEngine(fngValue, currentP2PPrice, btc, eth, bnb, sol) {
  const actions = [];
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
  if (fngValue < 25) {
    actions.push(`📉 **MACRO VELOCITY (FnG ${fngValue} - EXTREME FEAR):** Deep historical value window. Market sentiment indicates severe panic. Mathematical historical data heavily favors systematic Spot dollar-cost averaging (DCA) over chasing high-velocity breakouts.`);
  } else if (fngValue >= 80) {
    actions.push(`🚨 **MACRO SATURATION (FnG ${fngValue} - EXTREME GREED):** Market risks overextension. Dynamic velocity exhaustion is imminent; secure profit targets and protect liquid capital reserves.`);
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
    bullets: actions.join("\n")
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
  if (fngAlertTracker.size > 30) {
    const trackingArray = Array.from(fngAlertTracker);
    fngAlertTracker.delete(trackingArray[0]);
  }
}

/**
 * Threshold Verification Engine Loop
 */
async function monitorThreshold() {
  try {
    const fngData = await fetchFearAndGreedData();
    if (fngData) {
      const fngValue = fngData.value;
      const fngTimestamp = fngData.timestamp;

      if (fngValue < 25 && !fngAlertTracker.has(fngTimestamp)) {
        fngAlertTracker.add(fngTimestamp);
        
        // Fetch and calculate the top 5 sell average
        const avgSellPrice = await calculateHighestSellPrice();
        const sellPriceText = avgSellPrice 
          ? `**${avgSellPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })} VND** (Avg of top 5)` 
          : 'Data Unavailable';

        const fngWarningMessage = [
          `🚨 **CRITICAL MACRO WARNING: EXTREME FEAR** 🚨`,
          `==============================`,
          `🎭 **Fear & Greed Index dropped to:** **${fngValue}** (${fngData.classification})`,
          `💰 **Highest Cash-Out Sell Price:** ${sellPriceText}`,
          `📉 *Sentiment threshold (< 25) triggered. High historical variance indicates capitulation patterns.*`,
          `💼 **Strategy Directive:** Look for localized P2P discounts to execute structural fiat-to-crypto value allocations.`
        ].join('\n');

        await sendDiscordNotification(fngWarningMessage);
      }
    }

    const adList = await fetchP2POrderBook("BUY");
    if (!adList || adList.length === 0) return;

    // Filter ad listings based on single transaction amount specifications
    const filteredAds = adList.filter(entry => {
      const minTrans = Number(entry.adv.minSingleTransAmount);
      const maxTrans = Number(entry.adv.maxSingleTransAmount);
      return maxTrans >= MIN_SINGLE_TRANS_AMOUNT;
    });

    if (filteredAds.length === 0) {
      console.log(`[${new Date().toLocaleTimeString()}] Audit -> No ads matched the single transaction limits.`);
      return;
    }

    // Cache the best matching ad structure
    const topAd = filteredAds[0];
    lastKnownMarketData = {
      price: parseFloat(topAd.adv.price),
      merchant: topAd.advertiser.nickName,
      minSingleTransAmount: topAd.adv.minSingleTransAmount,
      maxSingleTransAmount: topAd.adv.maxSingleTransAmount
    };

    const fngValueText = fngData ? `${fngData.value} (${fngData.classification})` : 'Data Unavailable';
    console.log(`[${new Date().toLocaleTimeString()}] Audit -> Best P2P Buy: ${lastKnownMarketData.price} VND | FnG: ${fngValueText}`);

    // Process price target matches
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

          const alertMessage = [
            `⚠️ **P2P TARGET REACHED**`,
            `> 💰 **Buy Price:** ${price} VND`,
            `> 👤 **Merchant:** ${merchant}`,
            `> 🆔 **Ad No:** ${advNo}`,
            `> 📉 **Min Limit:** ${minSingleTrans} VND`,
            `> 📈 **Max Limit:** ${maxSingleTrans} VND`,
            `> 🎯 **Target Set:** Under ${TARGET_PRICE} VND`
          ].join('\n');
                               
          await sendDiscordNotification(alertMessage);
          break; 
        }
      }
    }

    purgeOldCacheTrackingRecords();
  } catch (error) {
    console.error('❌ Threshold Monitor Cycle Error:', error.message);
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

    const [btc, eth, bnb, sol, avgSellPrice] = await Promise.all([
      fetchSpotTickerData('BTCUSDT'),
      fetchSpotTickerData('ETHUSDT'),
      fetchSpotTickerData('BNBUSDT'),
      fetchSpotTickerData('SOLUSDT'),
      calculateHighestSellPrice()
    ]);

    const formatDisplay = (data, isBtc) => {
      if (!data) return { text: 'Fetch Error', indicator: '❌' };
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

    let p2pBuyText = 'No recent matching data collected';
    if (marketData) {
      const formattedMin = Number(marketData.minSingleTransAmount).toLocaleString('en-US');
      const formattedMax = Number(marketData.maxSingleTransAmount).toLocaleString('en-US');
      p2pBuyText = `**${marketData.price} VND** (User: ${marketData.merchant})\n> ⚖️ **Ad Range Limits:** ${formattedMin} - ${formattedMax} VND`;
    }

    const sellPriceText = avgSellPrice 
      ? `**${avgSellPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })} VND** (Avg of top 5)` 
      : 'Data Unavailable';

    const fngValue = fngData ? fngData.value : 50; 
    const p2pPriceRaw = marketData ? marketData.price : null;
    const advice = runDynamicQuantEngine(fngValue, p2pPriceRaw, btc, eth, bnb, sol);

    const summaryMessage = [
      `📊 **DYNAMIC QUANT REPORT**`,
      `==============================`,
      `📉 **Instant Lowest P2P Buy:** ${p2pBuyText}`,
      `📈 **Highest P2P Sell (Cash-Out):** ${sellPriceText}`,
      `🎭 **Crypto Fear & Greed:** ${fngIndexText}`,
      `🎯 **Active Alert Target:** Under ${TARGET_PRICE} VND`,
      `==============================`,
      `🪙 **Global Spot Market Indexes:**`,
      `> ${btcDisplay.indicator} **BTC:** ${btcDisplay.text}`,
      `> ${ethDisplay.indicator} **ETH:** ${ethDisplay.text}`,
      `> ${bnbDisplay.indicator} **BNB:** ${bnbDisplay.text}`,
      `> ${solDisplay.indicator} **SOL:** ${solDisplay.text}`,
      `==============================`,
      `🧠 **MATHEMATICAL ROTATION METRICS:**`,
      `> 📋 **Macro Phase Context:** *${advice.context}*`,
      ``,
      `${advice.bullets}`,
      `==============================`,
      `⚙️ *Bot Status: Operational*`
    ].join('\n');

    await sendDiscordNotification(summaryMessage);
  } catch (error) {
    console.error('❌ Failed to compile dynamic summary snapshot:', error.message);
  }
}

async function sendDiscordNotification(messageText) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await axios.post(DISCORD_WEBHOOK_URL, { content: messageText }, { timeout: 5000 });
  } catch (error) {
    console.error('❌ Discord Delivery Failure:', error.message);
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'online' }));
});

server.listen(PORT, () => {
  console.log(`🚀 Server executing tracking workflows on port ${PORT}`);
  
  // Initial execution
  monitorThreshold();
  
  const monitorId = setInterval(monitorThreshold, MONITOR_INTERVAL_MS);
  const summaryId = setInterval(sendInstantSummary, SUMMARY_INTERVAL_MS);

  const cleanExit = () => {
    console.log('Stopping active tracking timers...');
    clearInterval(monitorId);
    clearInterval(summaryId);
    server.close(() => {
      console.log('HTTP Server closed cleanly.');
      process.exit(0);
    });
  };

  process.on('SIGINT', cleanExit);
  process.on('SIGTERM', cleanExit);
});
