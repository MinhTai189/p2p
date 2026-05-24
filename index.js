const axios = require('axios');
const http = require('http');
require('dotenv').config();
const { XMLParser } = require('fast-xml-parser');

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
const MONITOR_INTERVAL_MS = (Number(process.env.MONITOR_INTERVAL_MIN) || 1) * 60 * 1000;
const SUMMARY_INTERVAL_MS = (Number(process.env.SUMMARY_INTERVAL_MIN) || 10) * 60 * 1000;
const MAX_HISTORY_WINDOW_MS = TRACKING_WINDOW_MIN * 60 * 1000; 

const BINANCE_P2P_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
const FEAR_GREED_URL = 'https://api.alternative.me/fng/';
const BINANCE_24HR_TICKER_URL = 'https://api.binance.com/api/v3/ticker/24hr';
const BINANCE_STABLECOIN_PARITY_URL = 'https://api.binance.com/api/v3/ticker/price?symbol=USDCUSDT';
const BINANCE_LONG_SHORT_RATIO_URL_BASE = 'https://fapi.binance.com/futures/data/topLongShortAccountRatio';
const BINANCE_PREMIUM_INDEX_URL = 'https://fapi.binance.com/fapi/v1/premiumIndex';
const BINANCE_KLINES_URL = 'https://api.binance.com/api/v3/klines';
const LIVE_EXCHANGE_RATE_URL = 'https://open.er-api.com/v6/latest/USD';
const IMPLIED_GLOBAL_USD_VND = Number(process.env.IMPLIED_GLOBAL_USD_VND) || 25420;
const STABLECOIN_DEPEG_THRESHOLD = Number(process.env.STABLECOIN_DEPEG_THRESHOLD) || 0.002;
const FUNDING_RATE_WARNING_THRESHOLD = Number(process.env.FUNDING_RATE_WARNING_THRESHOLD) || 0.0005;
const VCB_XML_URL = 'https://portal.vietcombank.com.vn/Usercontrols/TVPortal.TyGia/pXML.aspx';

// Track downtrend warnings to avoid duplicate messages per day: key -> `${date}:${symbol}:${level}`
const downtrendAlertTracker = new Set();
// Symbols tracked by the bot for spot fetching and summary display (comma-separated env)
const TRACKING_SYMBOLS = (process.env.TRACKING_SYMBOLS || 'BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT')
  .split(',')
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);
// Symbols used specifically for downtrend evaluation (can be smaller set)
const DOWNTREND_SYMBOLS = (process.env.DOWNTREND_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT')
  .split(',')
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

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
 * Helper to determine if current time falls within VN quiet hours (23:00 to 06:00 GMT+7)
 */
function isVnQuietHours() {
  const vnTimeString = new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" });
  const vnHour = new Date(vnTimeString).getHours();

  // Returns true if the hour is 23 (11 PM) up to and including 5 (5:59 AM)
  return vnHour >= 23 || vnHour < 6;
}


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

async function fetchStablecoinParity() {
  try {
    const response = await axios.get(BINANCE_STABLECOIN_PARITY_URL, { timeout: 5000 });
    return parseFloat(response.data.price);
  } catch (error) {
    console.error('❌ Stablecoin Parity Fetch Error:', error.message);
    return null;
  }
}

async function fetchLongShortRatio(symbol = 'BTCUSDT') {
  try {
    const response = await axios.get(`${BINANCE_LONG_SHORT_RATIO_URL_BASE}?symbol=${symbol}&period=5m&limit=1`, { timeout: 5000 });
    const ratio = parseFloat(response.data?.[0]?.longShortRatio);
    return Number.isFinite(ratio) ? ratio : null;
  } catch (error) {
    console.error('❌ Long/Short Ratio Fetch Error:', error.message);
    return null;
  }
}

async function fetchFundingRate(symbol = 'BTCUSDT') {
  try {
    const response = await axios.get(`${BINANCE_PREMIUM_INDEX_URL}?symbol=${symbol}`, { timeout: 5000 });
    const lastFundingRate = parseFloat(response.data?.lastFundingRate);
    return Number.isFinite(lastFundingRate) ? lastFundingRate : null;
  } catch (error) {
    console.error(`❌ Funding Rate Fetch Error (${symbol}):`, error.message);
    return null;
  }
}

async function fetchLiveExchangeRate() {
  // --- TRY STRATEGY 1: VIETCOMBANK (Most accurate local retail rate) ---
  try {
    console.log(`[${new Date().toISOString()}] Attempting Vietcombank exchange rate fetch...`);
    
    const response = await axios.get(VCB_XML_URL, { 
      timeout: 5000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    });

    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
    const jsonObj = parser.parse(response.data);
    const rates = jsonObj.ExrateList?.Exrate;

    if (Array.isArray(rates)) {
      const usdData = rates.find(item => item.CurrencyCode === 'USD');
      if (usdData && usdData.Sell) {
        // Strip string commas (e.g., "26,390.00" -> 26390.00)
        const vcbVndRate = parseFloat(usdData.Sell.replace(/,/g, ''));
        
        if (Number.isFinite(vcbVndRate) && vcbVndRate > 0) {
          console.log(`✅ Success: Pulled clean rate from Vietcombank (${vcbVndRate} VND)`);
          return vcbVndRate;
        }
      }
    }
    console.warn('⚠️ Vietcombank parsed payload did not contain valid USD structural fields.');
  } catch (vcbError) {
    console.error('❌ Vietcombank Direct Fetch Failed:', vcbError.message);
  }

  // --- TRY STRATEGY 2: LIVE_EXCHANGE_RATE_URL FALLBACK ---
  try {
    console.log(`[${new Date().toISOString()}] Executing fallback to global macro engine...`);
    
    const response = await axios.get(LIVE_EXCHANGE_RATE_URL, { timeout: 5000 });
    const vndRate = parseFloat(response.data?.rates?.VND);
    
    if (Number.isFinite(vndRate)) {
      console.log(`ℹ️ Fallback Success: Using Global API Baseline (${vndRate} VND)`);
      return vndRate;
    }
    return null;
  } catch (fallbackError) {
    console.error('❌ Fallback Macro Exchange Rate Fetch Error:', fallbackError.message);
    return null;
  }
}

async function fetchKlines(symbol = 'BTCUSDT', interval = '1d', limit = 90) {
  try {
    const response = await axios.get(`${BINANCE_KLINES_URL}?symbol=${symbol}&interval=${interval}&limit=${limit}`, { timeout: 8000 });
    return Array.isArray(response.data) ? response.data : null;
  } catch (error) {
    console.error(`❌ Klines Fetch Error (${symbol} ${interval}):`, error.message);
    return null;
  }
}

/**
 * Evaluate downtrend levels for a given symbol using klines history.
 * Returns an object { level1, level2, level3, sniper30 } where each is boolean and details included.
 */
async function evaluateDowntrend(symbol) {
  // Level 1: 1-2 days (use hourly candles, last 48 hours)
  const klines1h = await fetchKlines(symbol, '1h', 48);
  const nowPriceData = await fetchSpotTickerData(symbol);
  const result = { symbol, level1: null, level2: null, level3: null, sniper30: null };

  if (klines1h && klines1h.length > 0 && nowPriceData) {
    const closes = klines1h.map(k => parseFloat(k[4])); // close price
    const peak = Math.max(...closes);
    const current = nowPriceData.rawPrice;
    const dropPct = ((peak - current) / peak) * 100;
    result.level1 = { dropPct, peakWindowHours: klines1h.length };
  }

  // Level 2: 1-3 months (use daily candles, last 90 days)
  const klines1d = await fetchKlines(symbol, '1d', 90);
  if (klines1d && klines1d.length > 0 && nowPriceData) {
    const closes = klines1d.map(k => parseFloat(k[4]));
    const peak = Math.max(...closes);
    const current = nowPriceData.rawPrice;
    const dropPct = ((peak - current) / peak) * 100;
    result.level2 = { dropPct, peakWindowDays: klines1d.length };
  }

  // Level 3: 1-2 years (use daily candles, last up to 730 days - limit capped at 1000)
  const klinesLong = await fetchKlines(symbol, '1d', 730);
  if (klinesLong && klinesLong.length > 0 && nowPriceData) {
    const closes = klinesLong.map(k => parseFloat(k[4]));
    const peak = Math.max(...closes);
    const current = nowPriceData.rawPrice;
    const dropPct = ((peak - current) / peak) * 100;
    result.level3 = { dropPct, peakWindowDays: klinesLong.length };
  }

  // Sniper 30 rule: 30% drop within the past 30 days
  const klines30d = await fetchKlines(symbol, '1d', 30);
  if (klines30d && klines30d.length > 0 && nowPriceData) {
    const closes = klines30d.map(k => parseFloat(k[4]));
    const peak = Math.max(...closes);
    const current = nowPriceData.rawPrice;
    const dropPct = ((peak - current) / peak) * 100;
    result.sniper30 = { dropPct, peakWindowDays: klines30d.length };
  }

  return result;
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
function runDynamicQuantEngine(fngValue, currentP2PPrice, btc, eth, bnb, sol, stablecoinParity, btcLongShortRatio, btcFundingRate, solFundingRate) {
  const actions = [];
  const strategyNotes = [];
  let marketContext = "Stable Consolidation";
  const stablecoinDeviation = stablecoinParity ? Math.abs(stablecoinParity - 1) : 0;
  const stablecoinStress = stablecoinDeviation >= STABLECOIN_DEPEG_THRESHOLD;

  if (stablecoinParity) {
    actions.push(`🔗 **Stablecoin Parity Check:** USDC/USDT = ${stablecoinParity.toFixed(4)} (${(stablecoinDeviation * 100).toFixed(2)}% from peg)`);
    if (stablecoinStress) {
      strategyNotes.push(`Global crypto capital flight is active. Treat local P2P moves as potentially amplified by stablecoin de-peg risk.`);
    }
  }

  if (btcLongShortRatio !== null) {
    actions.push(`💼 **BTC Whale Long/Short Ratio:** ${btcLongShortRatio.toFixed(2)}`);
    if (btcLongShortRatio > 2.0) {
      strategyNotes.push(`Whales are heavily long-biased. A short-term BTC sell-off is more likely retail panic than structural breakdown.`);
    } else if (btcLongShortRatio < 0.8) {
      strategyNotes.push(`Whales are currently net short. Any local P2P strength may be fragile and could reverse if the macro trend weakens.`);
    }
  }

  const fundingWarnings = [];
  if (btcFundingRate !== null) {
    actions.push(`🔥 **BTC Funding Rate:** ${(btcFundingRate * 100).toFixed(3)}% per 8h`);
    if (btcFundingRate > FUNDING_RATE_WARNING_THRESHOLD) {
      fundingWarnings.push(`BTC funding rate is elevated above ${(FUNDING_RATE_WARNING_THRESHOLD * 100).toFixed(3)}%. This suggests long-side leverage stress and a higher chance of liquidation cascades.`);
    }
  }
  if (solFundingRate !== null) {
    actions.push(`🔥 **SOL Funding Rate:** ${(solFundingRate * 100).toFixed(3)}% per 8h`);
    if (solFundingRate > FUNDING_RATE_WARNING_THRESHOLD) {
      fundingWarnings.push(`SOL funding rate is elevated above ${(FUNDING_RATE_WARNING_THRESHOLD * 100).toFixed(3)}%. High perpetual funding signals risky long-side speculation.`);
    }
  }
  if (fundingWarnings.length > 0) {
    marketContext = 'Funding-Rate Driven Risk';
    strategyNotes.push(`Wait for funding rate decompression before accumulating. High funding means leveraged longs may be flushed and cheaper P2P levels could arrive within hours.`);
    strategyNotes.push(...fundingWarnings);
  }

  if (currentP2PPrice) {
    const premiumRatio = ((currentP2PPrice / IMPLIED_GLOBAL_USD_VND) - 1) * 100;
    
    if (premiumRatio > 2.5) {
      if (stablecoinStress) {
        marketContext = "Global Stablecoin-Driven Stress";
        actions.push(`⚠️ **P2P OVERPRICED (+${premiumRatio.toFixed(2)}% Premium):** Local premium is likely amplified by global stablecoin dislocation rather than only Vietnamese demand.`);
        strategyNotes.push(`Reduce position size and avoid aggressive P2P accumulation until stablecoin parity stabilizes.`);
      } else {
        marketContext = "High Domestic Capital Flight";
        actions.push(`⚠️ **P2P OVERPRICED (+${premiumRatio.toFixed(2)}% Premium):** Local demand for stablecoins is heavily decoupled from global rates. High risk of local capital exhaustion. Consider pausing heavy buy orders.`);
        strategyNotes.push(`Avoid adding new P2P buys at this premium. Look for premium contraction or use hedged positions while preserving capital.`);
      }
    } else if (premiumRatio < -0.5) {
      if (stablecoinStress) {
        marketContext = "Global Stablecoin-Coupled Discount";
        actions.push(`💎 **P2P UNDERPRICED (${premiumRatio.toFixed(2)}% Discount):** Local P2P markets may be reflecting global stablecoin stress rather than purely local supply.`);
        strategyNotes.push(`Carry out selective buys, but keep exposure limited while global stablecoin risk remains elevated.`);
      } else {
        marketContext = "Domestic Capital Capitulation";
        actions.push(`💎 **P2P UNDERPRICED (${premiumRatio.toFixed(2)}% Discount):** P2P is trading below global spot parity. Excellent cash-to-crypto fiat entry window via localized market mispricings.`);
        strategyNotes.push(`Aggressively consider accumulation with small, repeated buys. This is a favorable entry window for structured DCA into risk assets.`);
      }
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
  console.log(`[${new Date().toISOString()}] monitorThreshold() start`);
  try {
    const fngData = await fetchFearAndGreedData();
    if (fngData) {
      const fngValue = fngData.value;
      const todayUtc = new Date().toISOString().split('T')[0];
      const fngDailyKey = `${todayUtc}:${fngValue}`;

      if (fngValue < 25 && !fngAlertTracker.has(fngDailyKey)) {
        fngAlertTracker.add(fngDailyKey);

        // GATED: Only broadcast to Discord if outside quiet VN hour bands
        if (!isVnQuietHours()) {
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
      }}
    }

    // Refresh spot ticker history for configured tracking symbols
    await Promise.all(TRACKING_SYMBOLS.map(s => fetchSpotTickerData(s)));

    // Evaluate downtrend conditions for key symbols and send contextual warnings (once per day per level)
    try {
      const symbolsToCheck = DOWNTREND_SYMBOLS;
      for (const s of symbolsToCheck) {
        evaluateDowntrend(s).then(evt => {
          if (!evt) return;
          const today = new Date().toISOString().split('T')[0];

          // Level 1: 10-20% drop within 48h
          if (evt.level1 && evt.level1.dropPct >= 10 && evt.level1.dropPct <= 20) {
            const key = `${today}:${s}:L1`;
            if (!downtrendAlertTracker.has(key)) {
              downtrendAlertTracker.add(key);
              const msg = [
                `🚨 **Level 1 - Strong Short-Term Crash Detected (${s})**`,
                `> 🔻 Drop: ${evt.level1.dropPct.toFixed(2)}% over last ${evt.level1.peakWindowHours} hours`,
                `> ⏱ Timeframe: 24-48 hours`,
                `**Action:** Consider small DCA buys (10-20% of backup capital). Expect short-term technical bounces of ~3-5% after a sharp 15% drop.`
              ].join('\n');
              sendDiscordNotification(msg);
            }
          }

          // Level 2: 30-50% drop within 1-3 months
          if (evt.level2 && evt.level2.dropPct >= 30 && evt.level2.dropPct <= 50) {
            const key = `${today}:${s}:L2`;
            if (!downtrendAlertTracker.has(key)) {
              downtrendAlertTracker.add(key);
              const msg = [
                `🚨 **Level 2 - Medium-Term Strong Downtrend (${s})**`,
                `> 🔻 Drop: ${evt.level2.dropPct.toFixed(2)}% vs recent peak (last ${evt.level2.peakWindowDays} days)`,
                `> ⏱ Timeframe: 1-3 months`,
                `**Action:** Golden opportunity for larger buys. Consider splitting capital into tranches to accumulate between 30%-50% retracements.`
              ].join('\n');
              sendDiscordNotification(msg);
            }
          }

          // Level 3: Crypto winter style deep drawdown
          if (evt.level3 && ((s === 'BTCUSDT' || s === 'ETHUSDT') ? evt.level3.dropPct >= 75 : evt.level3.dropPct >= 90)) {
            const key = `${today}:${s}:L3`;
            if (!downtrendAlertTracker.has(key)) {
              downtrendAlertTracker.add(key);
              const msg = [
                `🚨 **Level 3 - Crypto Winter Detected (${s})**`,
                `> 🔻 Drop: ${evt.level3.dropPct.toFixed(2)}% vs multi-year peak`,
                `> ⏱ Timeframe: 1-2 years`,
                `**Action:** This is a deep long-term value zone. Only deploy capital if you have 2-3 year horizon.`
              ].join('\n');
              sendDiscordNotification(msg);
            }
          }

          // Sniper 30 rule: notify if 30%+ drop within last 30 days
          if (evt.sniper30 && evt.sniper30.dropPct >= 30) {
            const key = `${today}:${s}:SNIPER30`;
            if (!downtrendAlertTracker.has(key)) {
              downtrendAlertTracker.add(key);
              const msg = [
                `🎯 **SNIPER-30 SIGNAL (${s})**`,
                `> 🔻 Drop: ${evt.sniper30.dropPct.toFixed(2)}% from the 30-day peak`,
                `**Rule:** Consider splitting your USDT into 3 parts and buy at 30% / 40% / 50% drops respectively.`
              ].join('\n');
              sendDiscordNotification(msg);
            }
          }
        }).catch(err => console.error('❌ Downtrend Eval Error:', err.message));
      }
    } catch (e) {
      console.error('❌ Downtrend evaluation loop error:', e.message);
    }

    const adList = await fetchP2POrderBook("BUY");
    if (!adList || adList.length === 0) return;

    // GATED: Exit the function before iterating over individual target matches during quiet hours
    if (isVnQuietHours()) {
      purgeOldCacheTrackingRecords();
      return;
    }

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
    console.log(`[${new Date().toISOString()}] monitorThreshold() end`);
  } catch (error) {
    console.error('❌ Threshold Monitor Cycle Error:', error.message);
  }
}

/**
 * Summary Displayer
 */
async function sendInstantSummary() {
// GATED: Instantly drops scheduled intervals if executed between 23:00 and 06:00
  if (isVnQuietHours()) {
    console.log(`[${new Date().toLocaleTimeString()}] Summary omitted. VN night lock active.`);
    return;
  }
  
  console.log(`[${new Date().toISOString()}] sendInstantSummary() start`);
  try {
    const fngData = await fetchFearAndGreedData();
    const fngIndexText = fngData ? `${fngData.value} (${fngData.classification})` : 'Data Unavailable';
    const marketData = lastKnownMarketData;

    // Fetch spot data for tracking symbols, plus common extras
    const spotPromises = TRACKING_SYMBOLS.map(s => fetchSpotTickerData(s));
    const extraPromises = [
      calculateHighestSellPrice(),
      fetchStablecoinParity(),
      fetchLongShortRatio('BTCUSDT'),
      fetchFundingRate('BTCUSDT'),
      fetchFundingRate('SOLUSDT'),
      fetchLiveExchangeRate()
    ];
    const allResults = await Promise.all([...spotPromises, ...extraPromises]);
    const spotResults = allResults.slice(0, TRACKING_SYMBOLS.length);
    const avgSellPrice = allResults[TRACKING_SYMBOLS.length];
    const stablecoinParity = allResults[TRACKING_SYMBOLS.length + 1];
    const btcLongShortRatio = allResults[TRACKING_SYMBOLS.length + 2];
    const btcFundingRate = allResults[TRACKING_SYMBOLS.length + 3];
    const solFundingRate = allResults[TRACKING_SYMBOLS.length + 4];
    const liveUsdVndRate = allResults[TRACKING_SYMBOLS.length + 5];

    // Map spot results by symbol for easy access
    const spotMap = {};
    TRACKING_SYMBOLS.forEach((sym, idx) => {
      spotMap[sym] = spotResults[idx] || null;
    });

    const btc = spotMap['BTCUSDT'] || null;
    const eth = spotMap['ETHUSDT'] || null;
    const bnb = spotMap['BNBUSDT'] || null;
    const sol = spotMap['SOLUSDT'] || null;

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

    // Build display entries for each tracked symbol
    const displays = TRACKING_SYMBOLS.map(sym => ({
      symbol: sym,
      display: formatDisplay(spotMap[sym], sym === 'BTCUSDT')
    }));

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
    const p2pPriceRaw = marketData ? Number(marketData.price) : null;
    const effectiveRate = liveUsdVndRate || IMPLIED_GLOBAL_USD_VND;
    const livePremium = p2pPriceRaw ? (((p2pPriceRaw / effectiveRate) - 1) * 100) : null;
    const premiumLabel = livePremium !== null && Math.abs(livePremium) < 1.5 ? '(Normal Liquidity Band)' : livePremium !== null && livePremium > 2.5 ? '(⚠️ Capital Flight)' : livePremium !== null && livePremium < -0.5 ? '(💎 Discount Entry)' : '';
    const advice = runDynamicQuantEngine(fngValue, p2pPriceRaw, btc, eth, bnb, sol, stablecoinParity, btcLongShortRatio, btcFundingRate, solFundingRate);

    // ==========================================
    // MESSAGE 1: CORE MARKET STATISTICS (Ordered by Importance)
    // ==========================================
    const statisticMessage = [
      `📊 **DYNAMIC QUANT REPORT: MARKET METRICS**`,
      `==============================`,
      `⚙️ **LOCAL P2P LIQUIDITY ENGINE**`,
      `📉 **Instant Lowest P2P Buy:** ${p2pBuyText}`,
      `📈 **Highest P2P Sell (Cash-Out):** ${sellPriceText}`,
      `💎 **P2P Premium Rate:** ${livePremium !== null ? (livePremium >= 0 ? '+' : '') + livePremium.toFixed(2) + '%' : 'Unavailable'} ${premiumLabel}`,
      `⚖️ **Real USD/VND Spot:** ${liveUsdVndRate ? liveUsdVndRate.toLocaleString('en-US', { maximumFractionDigits: 2 }) : `${IMPLIED_GLOBAL_USD_VND} (fallback)`} VND`,
      ``,
      `🚨 **DERIVATIVES & GLOBAL RISK LEVERS**`,
      `📈 **BTC Long/Short Ratio:** ${btcLongShortRatio !== null ? btcLongShortRatio.toFixed(2) : 'Fetch Error'}`,
      `🔥 **BTC Funding Rate:** ${btcFundingRate !== null ? (btcFundingRate * 100).toFixed(3) + '%' : 'Fetch Error'}`,
      `🔥 **SOL Funding Rate:** ${solFundingRate !== null ? (solFundingRate * 100).toFixed(3) + '%' : 'Fetch Error'}`,
      `🔗 **USDC/USDT Parity:** ${stablecoinParity ? stablecoinParity.toFixed(4) : 'Fetch Error'}`,
      ``,
      `🎭 **MACRO SENTIMENT & TARGETS**`,
      `🎭 **Crypto Fear & Greed:** ${fngIndexText}`,
      `🎯 **Active Alert Target:** Under ${TARGET_PRICE} VND`,
      `==============================`,
      `🪙 **GLOBAL SPOT MARKET INDEXES & VELOCITY**`,
      ...displays.flatMap(({ symbol, display }) => ([
        `> ${display.indicator} **${symbol.replace('USDT','')}**: ${display.text}`,
        `> ⏱️ ${display.intervals}`,
        `>`
      ])).slice(0, -1) // Drops the final trailing empty layout point
    ].join('\n');

    // ==========================================
    // MESSAGE 2: INTERPRETATION & ACTIONABLE STRATEGY
    // ==========================================
    const strategyMessage = [
      `🧠 **DYNAMIC QUANT REPORT: ALGORITHMIC STRATEGY**`,
      `==============================`,
      `📋 **Macro Phase Context:** *${advice.context}*`,
      ``,
      `🧭 **Strategy Guidance:**`,
      `${advice.recommendations}`,
      ``,
      `🎯 **Tactical Execution Directives:**`,
      `${advice.bullets}`,
      `==============================`,
      `⚙️ *Bot Status: Operational*`
    ].join('\n');

    // Fire events sequentially to prevent Discord content interleaving issues
    await sendDiscordNotification(statisticMessage);
    await sendDiscordNotification(strategyMessage);
    
    console.log(`[${new Date().toISOString()}] sendInstantSummary() split payload successfully dispatched.`);
  } catch (error) {
    console.error('❌ Failed to compile dynamic summary snapshot:', error.message);
  }
}

async function sendDiscordNotification(messageText) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log(`[${new Date().toISOString()}] sendDiscordNotification skipped: DISCORD_WEBHOOK_URL not set`);
    return;
  }

  // Sửa lỗi 2: Kiểm tra tin nhắn rỗng
  if (!messageText || String(messageText).trim() === "") {
    console.error(`[${new Date().toISOString()}] sendDiscordNotification error: messageText is empty`);
    return;
  }

  try {
    const ts = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    
    // Sửa lỗi 1: Giới hạn ký tự an toàn dưới 2000
    const maxChars = 1900; 
    let safeText = String(messageText);
    if (safeText.length > maxChars) {
      safeText = safeText.slice(0, maxChars) + "\n...(Tin nhắn quá dài đã bị cắt bớt)...";
    }

    const payload = { content: `[${ts}]\n${safeText}` };
    
    console.log(`[${ts}] sendDiscordNotification -> dispatching (trunc): ${safeText.slice(0,120).replace(/\n/g,' ')}...`);
    
    // Sửa lỗi 3: Thêm Headers tường minh
    const resp = await axios.post(DISCORD_WEBHOOK_URL, payload, { 
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });
    
    console.log(`[${new Date().toISOString()}] sendDiscordNotification -> delivered, status: ${resp.status}`);
  } catch (error) {
    // Đoạn này giúp bạn nhìn rõ Discord đang mắng bạn vì lỗi gì (ví dụ: chi tiết lỗi trong error.response.data)
    if (error.response) {
      console.error('❌ Discord API Error Details:', JSON.stringify(error.response.data));
    } else {
      console.error('❌ Discord Delivery Failure:', error.message);
    }
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'online' }));
});

server.listen(PORT, () => {
  console.log(`🚀 Server executing tracking workflows on port ${PORT}`);

  fetchLiveExchangeRate()
  return
  
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
