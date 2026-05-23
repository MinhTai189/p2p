const axios = require('axios');
const http = require('http');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const TARGET_PRICE = Number(process.env.TARGET_PRICE) || 26300;

// Filter environment parameters
const MIN_SINGLE_TRANS_AMOUNT = Number(process.env.MIN_SINGLE_TRANS_AMOUNT) || 0;
const MAX_SINGLE_TRANS_AMOUNT = Number(process.env.MAX_SINGLE_TRANS_AMOUNT) || Infinity;

// Dynamic lookback tracking adjustments linked to your .env configuration
const TRACKING_INTERVAL_MIN = Number(process.env.TRACKING_INTERVAL_MIN) || 5; 
const TRACKING_WINDOW_MIN = Number(process.env.TRACKING_WINDOW_MIN) || 30;   

// CRITICAL FIX: Changed back to your strict 1-minute execution interval
const MONITOR_INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MIN) * 60 * 1000;       
const SUMMARY_INTERVAL_MS = (Number(process.env.SUMMARY_INTERVAL_MIN) || 10) * 60 * 1000;  
const MAX_HISTORY_WINDOW_MS = TRACKING_WINDOW_MIN * 60 * 1000; 

const BINANCE_P2P_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
const FEAR_GREED_URL = 'https://api.alternative.me/fng/';
const BINANCE_24HR_TICKER_URL = 'https://api.binance.com/api/v3/ticker/24hr';
const IMPLIED_GLOBAL_USD_VND = Number(process.env.IMPLIED_GLOBAL_USD_VND) || 25420;

// Global memory state
let lastKnownMarketData = null;
const adNotificationTracker = new Map(); 
const MAX_ALERTS_PER_AD = 3;

// Tracker to prevent FnG alert spamming (tracks alerts by date + index value)
const fngAlertTracker = new Set();

// Gating state to prevent rate-limiting on the daily-updating FnG API endpoint
let lastFngFetchDate = '';
let cachedFngData = null;

/**
 * Historical Data Cache Map
 */
const priceHistoryLog = new Map();

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
 */
async function calculateHighestSellPrice() {
  const sellAds = await fetchP2POrderBook("SELL");
  if (!sellAds || sellAds.length === 0) return null;

  const targetBatch = sellAds.slice(0, 5);
  const totalSum = targetBatch.reduce((sum, entry) => sum + parseFloat(entry.adv.price), 0);
  
  return totalSum / targetBatch.length;
}

async function fetchFearAndGreedData() {
  const todayUtc = new Date().toISOString().split('T')[0];
  
  // Only call the external API if the date changed or we don't have cache yet
  if (lastFngFetchDate === todayUtc && cachedFngData) {
    return cachedFngData;
  }

  try {
    const response = await axios.get(FEAR_GREED_URL, { timeout: 5000 });
    const currentData = response?.data?.data?.[0];
    if (currentData) {
      cachedFngData = { 
        value: Number(currentData.value), 
        classification: currentData.value_classification,
        timestamp: currentData.timestamp 
      };
      lastFngFetchDate = todayUtc;
      return cachedFngData;
    }
    return cachedFngData; // Fallback to cache if API errors out
  } catch (error) {
    console.error('❌ Fear & Greed API Error:', error.message);
    return cachedFngData; 
  }
}

/**
 * Dynamically tracks milestone changes matching lookback thresholds
 */
function calculateIntervalChanges(history, currentPrice) {
  const results = {};
  const now = Date.now();

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
 * Enhanced spot fetcher gathering high/low spreads alongside price changes
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
 * DYNAMIC QUANT ENGINE
 * Generates programmatic strategies using asset velocity spreads & market premium ratios
 */
function runDynamicQuantEngine(fngValue, currentP2PPrice, btc, eth, bnb, sol) {
  const actions = [];
  const strategyNotes = [];
  let marketContext = "Stable Consolidation";

  if (currentP2PPrice) {
    const premiumRatio = ((currentP2PPrice / IMPLIED_GLOBAL_USD_VND) - 1) * 100;
    
    if (premiumRatio > 2.5) {
      marketContext = "High Domestic Capital Flight";
      actions.push(`⚠️ **P2P OVERPRICED (+${premiumRatio.toFixed(2)}% Premium):** Local demand for stablecoins is heavily decoupled from global rates. High risk of local capital exhaustion. Consider pausing heavy buy orders.`);
      strategyNotes.push(`Avoid adding new P2P buys at this premium. Look for premium contraction or use hedged positions while preserving capital.`);
    } else if (premiumRatio < -0.5) {
      marketContext = "Domestic Capital Capitulation";
      actions.push(`💎 **P2P UNDERPRICED (${premiumRatio.toFixed(2)}% Discount):** P2P is trading below global spot parity. Excellent cash-to-crypto fiat entry window via localized market mispricings.`);
      strategyNotes.push(`Aggressively consider accumulation with small, repeated buys. This is a favorable entry window for structured DCA into risk assets.`);
    } else {
      strategyNotes.push(`P2P price is within a neutral premium band. Favor disciplined position sizing, and treat any trade as tactical rather than directional.`);
    }
  } else {
    strategyNotes.push(`P2P price unavailable. Base decisions on broader spot and sentiment signals only.`);
  }

  if (fngValue < 25) {
    actions.push(`📉 **MACRO VELOCITY (FnG ${fngValue} - EXTREME FEAR):** Deep historical value window. Market sentiment indicates severe panic. Mathematical historical data heavily favors systematic Spot dollar-cost averaging (DCA) over chasing high-velocity breakouts.`);
    strategyNotes.push(`Bias toward accumulation and long-term positions. Use systematic dollar-cost averaging and avoid panic selling.`);
  } else if (fngValue >= 80) {
    actions.push(`🚨 **MACRO SATURATION (FnG ${fngValue} - EXTREME GREED):** Market risks overextension. Dynamic velocity exhaustion is imminent; secure profit targets and protect liquid capital reserves.`);
    strategyNotes.push(`De-risk where possible. Take profits on extended positions, tighten stops, and wait for sentiment to cool before redeploying.`);
  } else if (fngValue <= 40) {
    strategyNotes.push(`Sentiment is cautious. Consider selective entries into high-conviction setups with clear downside protection.`);
  } else if (fngValue >= 60) {
    strategyNotes.push(`Sentiment is exuberant. Favor tactical trades with strict risk management and preset exit targets.`);
  } else {
    strategyNotes.push(`Sentiment is neutral. Maintain a balanced exposure and watch for technical confirmation before accelerating positions.`);
  }

  if (btc && eth && sol) {
    const ethVsBtcSpread = eth.rawChange - btc.rawChange;
    const solVsBtcSpread = sol.rawChange - btc.rawChange;

    if (solVsBtcSpread > 4.0) {
      const dailyVolatility = ((sol.highPrice - sol.lowPrice) / sol.lowPrice) * 100;
      actions.push(`🔄 **SOLANA ALPHA ROTATION:** SOL is outperforming BTC by **${solVsBtcSpread.toFixed(2)}%** with a 24h trading spread volatility of **${dailyVolatility.toFixed(2)}%**. Market favor has aggressive capital rotation shifting toward the Solana ecosystem.`);
      strategyNotes.push(`Consider rotating a portion of exposure into SOL if you want to follow a strong momentum theme, but keep position size limited due to elevated volatility.`);
    } else if (ethVsBtcSpread > 2.5) {
      actions.push(`🔄 **EVM LARGE-CAP EXPANSION:** ETH velocity is outpacing BTC by **${ethVsBtcSpread.toFixed(2)}%**. Capital flows are moving down the risk curve into legacy smart-contract platforms.`);
      strategyNotes.push(`ETH strength may favor selective exposure to EVM assets. Use size discipline and choose high-liquidity entries.`);
    } else if (btc.rawChange > eth.rawChange && btc.rawChange > sol.rawChange) {
      actions.push(`🛡️ **LIQUIDITY DRAINDOWN TO CORE:** BTC dominance is crushing major alts (ETH Spread: ${ethVsBtcSpread.toFixed(2)}% | SOL Spread: ${solVsBtcSpread.toFixed(2)}%). Capital is exiting high-risk networks back into core digital gold layers.`);
      strategyNotes.push(`Favor core BTC exposure when risk appetite is declining. Reduce alt allocations and preserve capital in the market leader.`);
    } else {
      strategyNotes.push(`Market breadth is mixed. Hold a balanced portfolio and allocate only to the most compelling risk-reward opportunities.`);
    }
  }

  if (actions.length === 0) {
    actions.push("⏱️ **EQUILIBRIUM MONITORING:** Variance spreads across asset blocks are minimal. Volatility compression is occurring; hold neutral balance profiles.");
  }

  if (strategyNotes.length === 0) {
    strategyNotes.push("Maintain discipline on sizing, stops, and entry triggers while watching for the next clear market signal.");
  }

  return {
    context: marketContext,
    bullets: actions.join("\n"),
    recommendations: strategyNotes.join("\n")
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
  if (fngAlertTracker.size > 100) {
    const trackingArray = Array.from(fngAlertTracker);
    for (let i = 0; i < 30; i++) {
      fngAlertTracker.delete(trackingArray[i]);
    }
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
      const todayUtc = new Date().toISOString().split('T')[0];
      const fngDailyKey = `${todayUtc}:${fngValue}`;

      if (fngValue < 25 && !fngAlertTracker.has(fngDailyKey)) {
        fngAlertTracker.add(fngDailyKey);
        
        const avgSellPrice = await calculateHighestSellPrice();
        const sellPriceText = avgSellPrice 
          ? `**${avgSellPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })} VND** (Avg of top 5)` 
          : 'Data Unavailable';

        const fngWarningMessage = [
          `🚨 **CRITICAL MACRO WARNING: EXTREME FEAR** @everyone🚨`,
          `==============================`,
          `🎭 **Fear & Greed Index dropped to:** **${fngValue}** (${fngData.classification})`,
          `💰 **Highest Cash-Out Sell Price:** ${sellPriceText}`,
          `📉 *Sentiment threshold (< 25) triggered. High historical variance indicates capitulation patterns.*`,
          `💼 **Strategy Directive:** Look for localized P2P discounts to execute structural fiat-to-crypto value allocations.`
        ].join('\n');

        await sendDiscordNotification(fngWarningMessage);
      }
    }

    await Promise.all([
      fetchSpotTickerData('BTCUSDT'),
      fetchSpotTickerData('ETHUSDT'),
      fetchSpotTickerData('BNBUSDT'),
      fetchSpotTickerData('SOLUSDT')
    ]);

    const adList = await fetchP2POrderBook("BUY");
    if (!adList || adList.length === 0) return;

    const filteredAds = adList.filter(entry => {
      const minTrans = Number(entry.adv.minSingleTransAmount);
      const maxTrans = Number(entry.adv.maxSingleTransAmount);
      return maxTrans >= MAX_SINGLE_TRANS_AMOUNT;
    });

    if (filteredAds.length === 0) {
      console.log(`[${new Date().toLocaleTimeString()}] Audit -> No ads matched the single transaction limits.`);
      return;
    }

    const topAd = filteredAds[0];
    lastKnownMarketData = {
      price: parseFloat(topAd.adv.price),
      merchant: topAd.advertiser.nickName,
      minSingleTransAmount: topAd.adv.minSingleTransAmount,
      maxSingleTransAmount: topAd.adv.maxSingleTransAmount
    };

    const fngValueText = fngData ? `${fngData.value} (${fngData.classification})` : 'Data Unavailable';
    console.log(`[${new Date().toLocaleTimeString()}] Audit -> Best P2P Buy: ${lastKnownMarketData.price} VND | FnG: ${fngValueText}`);

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
            `⚠️ **P2P TARGET REACHED @everyone**`,
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
      if (!data) return { text: 'Fetch Error', indicator: '❌', intervals: '' };
      const formattedPrice = isBtc 
        ? Math.floor(data.rawPrice).toLocaleString('en-US') 
        : data.rawPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const sign = data.rawChange >= 0 ? '+' : '';
      
      const historyStr = Object.entries(data.historyIntervals)
        .map(([time, change]) => `\`${time}: ${change}\``)
        .join(' | ');

      return {
        text: `$${formattedPrice} (${sign}${data.rawChange.toFixed(2)}%)`,
        indicator: data.rawChange >= 0 ? '🟩' : '🟥',
        intervals: historyStr
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
      p2pBuyText = `**${marketData.price} VND** (User: ${marketData.merchant})\n> ⚖ *Ad Range Limits:* ${formattedMin} - ${formattedMax} VND`;
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
      `🪙 **Global Spot Market Indexes & History Matrix:**`,
      `> ${btcDisplay.indicator} **BTC:** ${btcDisplay.text}`,
      `> ⏱️ ${btcDisplay.intervals}`,
      `>`,
      `> ${ethDisplay.indicator} **ETH:** ${ethDisplay.text}`,
      `> ⏱️ ${ethDisplay.intervals}`,
      `>`,
      `> ${bnbDisplay.indicator} **BNB:** ${bnbDisplay.text}`,
      `> ⏱️ ${bnbDisplay.intervals}`,
      `>`,
      `> ${solDisplay.indicator} **SOL:** ${solDisplay.text}`,
      `> ⏱️ ${solDisplay.intervals}`,
      `==============================`,
      `🧠 **MATHEMATICAL ROTATION METRICS:**`,
      `> 📋 **Macro Phase Context:** *${advice.context}*`,
      `> 🧭 **Strategy Guidance:**`,
      `${advice.recommendations}`,
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
