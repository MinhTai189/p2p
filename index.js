const axios = require('axios');
const http = require('http');
require('dotenv').config();
const { XMLParser } = require('fast-xml-parser');
const cheerio = require('cheerio');

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
const BINANCE_TAKER_LONG_SHORT_RATIO_URL = 'https://fapi.binance.com/futures/data/takerlongshortRatio';
const BINANCE_TOP_LONG_SHORT_POSITION_RATIO_URL = 'https://fapi.binance.com/futures/data/topLongShortPositionRatio';
const BINANCE_GLOBAL_LONG_SHORT_ACCOUNT_RATIO_URL = 'https://fapi.binance.com/futures/data/globalLongShortAccountRatio';
const BINANCE_PREMIUM_INDEX_URL = 'https://fapi.binance.com/fapi/v1/premiumIndex';
const BINANCE_KLINES_URL = 'https://api.binance.com/api/v3/klines';
const LIVE_EXCHANGE_RATE_URL = 'https://open.er-api.com/v6/latest/USD';
const OKX_P2P_BASE_URL = 'https://www.okx.com/v3/c2c';
const OKX_P2P_BOOKS_URL = `${OKX_P2P_BASE_URL}/tradingOrders/books`;
const OKX_P2P_MARKETPLACE_URL = `${OKX_P2P_BASE_URL}/tradingOrders/getMarketplaceAdsPrelogin`;
const BLACK_MARKET_USD_VND_URL = process.env.BLACK_MARKET_USD_VND_URL || 'https://chogia.vn/ngoai-te/usd-cho-den';
const BLACK_MARKET_USD_VND_LABEL = process.env.BLACK_MARKET_USD_VND_LABEL || 'Black Market USD/VND';
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
// Initialize the memory cache structure
const cache = {
  data: null,
  expiresAt: 0
};

// Configurable Cache Duration: 8 hours (8 * 60 * 1000 ms * 60)
const CACHE_TTL = 8 * 60 * 60 * 1000;

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

function logApiCall(apiName, url, summary) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] API CALL | ${apiName} | ${summary} | ${url}`);
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

  const url = BINANCE_P2P_URL;
  logApiCall('Binance P2P Order Book', url, `tradeType=${tradeType} start`);
  try {
    const response = await fetchWithRetry(url, payload, headers);
    const resultCount = Array.isArray(response?.data?.data) ? response.data.data.length : 0;
    logApiCall('Binance P2P Order Book', url, `tradeType=${tradeType} success, ads=${resultCount}`);
    return response?.data?.data || null;
  } catch (error) {
    console.error(`❌ P2P Fetch Error (${tradeType}):`, error.message);
    logApiCall('Binance P2P Order Book', url, `tradeType=${tradeType} failed: ${error.message}`);
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

function extractNumericRate(payload, depth = 0) {
  if (payload == null || depth > 3) return null;
  if (typeof payload === 'number' && Number.isFinite(payload)) return payload;
  if (typeof payload === 'string') {
    const cleaned = payload.replace(/,/g, '').match(/([0-9]+(?:\.[0-9]+)?)/);
    return cleaned ? parseFloat(cleaned[1]) : null;
  }
  if (typeof payload === 'object') {
    const keys = ['rate', 'price', 'exchangeRate', 'result', 'value', 'vnd', 'usdVnd', 'usd_vnd'];
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) {
        const candidate = extractNumericRate(payload[key], depth + 1);
        if (Number.isFinite(candidate)) return candidate;
      }
    }
    for (const value of Object.values(payload)) {
      if (typeof value === 'object') {
        const nested = extractNumericRate(value, depth + 1);
        if (Number.isFinite(nested)) return nested;
      }
    }
  }
  return null;
}

async function fetchOkxP2PAdsFromMarketplace(tradeType = 'BUY') {
  const side = tradeType === 'BUY' ? 'sell' : 'buy';
  const params = new URLSearchParams({
    paymentMethod: 'all',
    side,
    userType: 'all',
    sortType: tradeType === 'BUY' ? 'price_asc' : 'price_desc',
    limit: '20',
    cryptoCurrency: 'USDT',
    fiatCurrency: 'VND',
    currentPage: '1',
    numberPerPage: '20',
    t: `${Date.now()}`
  });

  const url = `${OKX_P2P_MARKETPLACE_URL}?${params.toString()}`;
  logApiCall('OKX P2P Ads Fallback', url, `tradeType=${tradeType} start`);

  try {
    const response = await axios.get(url, {
      timeout: 8000,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://www.okx.com',
        'Referer': 'https://www.okx.com/p2p-markets?currency=USDT&fiat=VND&tradeType=BUY',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });

    const ads = response?.data?.data?.[side];
    const count = Array.isArray(ads) ? ads.length : 0;
    logApiCall('OKX P2P Ads Fallback', url, `success, ads=${count}`);
    return Array.isArray(ads) ? { ads, source: 'Marketplace' } : null;
  } catch (error) {
    console.error(`❌ OKX P2P Fallback Error (${tradeType}):`, error.message);
    logApiCall('OKX P2P Ads Fallback', url, `failed: ${error.message}`);
    return null;
  }
}

async function fetchOkxP2PAds(tradeType = 'BUY') {
  const side = tradeType === 'BUY' ? 'sell' : 'buy';
  const params = new URLSearchParams({
    side,
    cryptoCurrency: 'usdt',
    fiatCurrency: 'vnd',
    userType: 'all',
    showHeader: 'true',
    limit: '10',
    paymentMethod: 'bank',
    quoteCurrency: 'vnd',
    baseCurrency: 'usdt',
    t: `${Date.now()}`
  });

  const url = `${OKX_P2P_BOOKS_URL}?${params.toString()}`;
  logApiCall('OKX P2P Ads', url, `tradeType=${tradeType} start`);

  try {
    const response = await axios.get(url, {
      timeout: 8000,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://www.okx.com',
        'Referer': 'https://www.okx.com/p2p-markets/vnd/buy-usdt',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });

    let ads = response?.data?.data?.[side];
    const count = Array.isArray(ads) ? ads.length : 0;
    logApiCall('OKX P2P Ads', url, `success, ads=${count}`);

    if (!Array.isArray(ads) || ads.length === 0) {
      console.warn('⚠️ OKX P2P /books returned no ads, attempting fallback marketplace endpoint');
      return await fetchOkxP2PAdsFromMarketplace(tradeType);
    }

    return { ads, source: 'Books' };
  } catch (error) {
    console.error(`❌ OKX P2P Fetch Error (${tradeType}):`, error.message);
    logApiCall('OKX P2P Ads', url, `failed: ${error.message}`);
    return await fetchOkxP2PAdsFromMarketplace(tradeType);
  }
}

async function fetchOkxP2PBuyMarketData() {
  const result = await fetchOkxP2PAds('BUY');
  if (!result || !Array.isArray(result.ads) || result.ads.length === 0) return null;

  const topAds = result.ads.slice(0, 5).map(ad => ({
    id: ad.id || ad.merchantId || `okx-${Date.now()}`,
    price: Number(ad.price),
    merchant: ad.nickName || ad.publicUserId || ad.merchantName || 'Unknown',
    min: Number(ad.quoteMinAmount || ad.quoteMinAmountPerOrder || ad.minSellOrderQuantity || 0),
    max: Number(ad.quoteMaxAmountPerOrder || ad.quoteMaxAmount || ad.maxSellOrderQuantity || 0),
    available: Number(ad.availableAmount || ad.availableAmountPerOrder || 0),
    paymentMethods: Array.isArray(ad.paymentMethods) ? ad.paymentMethods : []
  }));

  const avgPrice = topAds.reduce((sum, entry) => sum + entry.price, 0) / topAds.length;
  return { topAd: topAds[0], avgPrice, topAds, source: result.source };
}

function parseVndString(text) {
  if (!text) return 0;
  const clean = text.replace(/[^0-9]/g, '');
  return clean ? parseInt(clean, 10) : 0;
}

/**
 * Validated ChoGia Parser
 */
async function fetchFromChoGia() {
  const url = 'https://chogia.vn/ngoai-te/usd-cho-den/';
  const { data } = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    },
    timeout: 7000
  });

  const $ = cheerio.load(data);
  let buy = 0, sell = 0;

  // STRATEGY 1: Extract from the SEO content paragraph text (Highly stable against structural layout changes)
  const fullText = $('body').text();
  // Matches expressions like: "mua vào là 26.309 và bán ra là 26.429"
  const regexMatch = /mua\s+vào\s+là\s+([\d.,]+)\s+và\s+bán\s+ra\s+là\s+([\d.,]+)/i.exec(fullText);

  if (regexMatch && regexMatch[1] && regexMatch[2]) {
    buy = parseVndString(regexMatch[1]);
    sell = parseVndString(regexMatch[2]);
  }

  // STRATEGY 2: Strict structural mapping fallback if the paragraph structure changes
  if (!buy || !sell) {
    $('table tr').each((_, el) => {
      const rowText = $(el).text().toLowerCase();
      // Safely check if the line contains USD or Dollar specifically within a free-market list
      if (rowText.includes('usd') && (rowText.includes('đô la') || rowText.includes('chợ đen'))) {
        const cols = $(el).find('td');
        if (cols.length >= 3) {
          // Typically: Col 0: Symbol, Col 1: Name, Col 2: Buy Rate, Col 3: Sell Rate
          buy = parseVndString(cols.eq(2).text());
          sell = parseVndString(cols.eq(3).text());
          if (buy > 0) return false; // Break loop if successfully populated
        }
      }
    });
  }

  // Final Validation Range check
  if (buy > 23000 && sell > 23000) {
    return { buy, sell, source: 'ChoGia Content Engine' };
  }

  throw new Error('Could not resolve numeric price blocks from current layout');
}

/**
 * Fallback Engine: Alternate source (TyGiaUsd / WebGia backup layout)
 */
async function fetchFromBackupSource() {
  const url = 'https://webgia.com/ty-gia/usd/cho-den/';
  const { data } = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 6000
  });

  const $ = cheerio.load(data);
  let buy = 0, sell = 0;

  // Search inside explicit layout value indicators
  const buyEl = $('#muavao, .buy-value, [itemprop="price"]').first();
  const sellEl = $('#banra, .sell-value').first();

  if (buyEl.length && sellEl.length) {
    buy = parseVndString(buyEl.text());
    sell = parseVndString(sellEl.text());
  }

  if (buy > 23000 && sell > 23000) {
    return { buy, sell, source: 'WebGia Backup Engine' };
  }
  throw new Error('Backup engine failed validation layout');
}

/**
 * Master Orchestrator
 */
async function fetchBlackMarketExchangeRate(forceRefresh = false) {
  const now = Date.now();

  if (!forceRefresh && cache.data && now < cache.expiresAt) {
    return { ...cache.data, cached: true };
  }

  try {
    const rateData = await fetchFromChoGia();
    cache.data = rateData;
    cache.expiresAt = now + CACHE_TTL;
    console.log(`✅ ChoGia Engine Success: Buy=${rateData.buy}, Sell=${rateData.sell}. Cache updated for 8 hours.`);
    return { ...cache.data, cached: false };
  } catch (err) {
    console.warn(`⚠️ ChoGia engine extraction failed: ${err.message}. Routing to fallback...`);

    try {
      const fallbackData = await fetchFromBackupSource();
      cache.data = fallbackData;
      cache.expiresAt = now + CACHE_TTL;
      console.log(`✅ Backup Engine Success: Buy=${fallbackData.buy}, Sell=${fallbackData.sell}. Cache updated for 8 hours.`);
      return { ...cache.data, cached: false };
    } catch (fallbackErr) {
      console.error('❌ Critical: All active extraction scraping attempts failed.');
      if (cache.data) {
        console.log('⚠️ Returning stale cache block as emergency proxy.');
        return { ...cache.data, cached: true, stale: true };
      }
      return null;
    }
  }
}

async function fetchStablecoinParity() {
  const url = BINANCE_STABLECOIN_PARITY_URL;
  logApiCall('Binance USDC/USDT Parity', url, 'start');
  try {
    const response = await axios.get(url, { timeout: 5000 });
    const parity = parseFloat(response.data.price);
    logApiCall('Binance USDC/USDT Parity', url, `success, parity=${parity}`);
    return parity;
  } catch (error) {
    console.error('❌ Stablecoin Parity Fetch Error:', error.message);
    logApiCall('Binance USDC/USDT Parity', url, `failed: ${error.message}`);
    return null;
  }
}

async function fetchLongShortRatio(symbol = 'BTCUSDT') {
  const url = `${BINANCE_LONG_SHORT_RATIO_URL_BASE}?symbol=${symbol}&period=12h&limit=1`;
  logApiCall('Binance Long/Short Ratio', url, `start (${symbol} 12h)`);
  try {
    const response = await axios.get(url, { timeout: 5000 });
    const ratio = parseFloat(response.data?.[0]?.longShortRatio);
    const summary = Number.isFinite(ratio) ? `success, ratio=${ratio}` : 'success, ratio=invalid';
    logApiCall('Binance Long/Short Ratio', url, summary);
    return Number.isFinite(ratio) ? ratio : null;
  } catch (error) {
    console.error('❌ Long/Short Ratio Fetch Error:', error.message);
    logApiCall('Binance Long/Short Ratio', url, `failed: ${error.message}`);
    return null;
  }
}

async function fetchTakerLongShortRatio(symbol = 'BTCUSDT', period = '12h', limit = 1) {
  const url = BINANCE_TAKER_LONG_SHORT_RATIO_URL;
  logApiCall('Binance Taker Long/Short Ratio', url, `start (${symbol} ${period})`);
  try {
    const response = await axios.get(url, { timeout: 5000, params: { symbol, period, limit } });
    const data = Array.isArray(response.data) ? response.data[0] : null;
    if (!data) throw new Error('Invalid response');
    const result = {
      buySellRatio: Number(data.buySellRatio),
      buyVol: Number(data.buyVol),
      sellVol: Number(data.sellVol)
    };
    logApiCall('Binance Taker Long/Short Ratio', url, `success, ratio=${result.buySellRatio}`);
    return result;
  } catch (error) {
    console.error('❌ Taker Long/Short Ratio Fetch Error:', error.message);
    logApiCall('Binance Taker Long/Short Ratio', url, `failed: ${error.message}`);
    return null;
  }
}

async function fetchTopLongShortPositionRatio(symbol = 'BTCUSDT', period = '12h', limit = 1) {
  const url = BINANCE_TOP_LONG_SHORT_POSITION_RATIO_URL;
  logApiCall('Binance Top Long/Short Position Ratio', url, `start (${symbol} ${period})`);
  try {
    const response = await axios.get(url, { timeout: 5000, params: { symbol, period, limit } });
    const data = Array.isArray(response.data) ? response.data[0] : null;
    if (!data) throw new Error('Invalid response');
    const result = {
      longShortRatio: Number(data.longShortRatio),
      longAccount: Number(data.longAccount),
      shortAccount: Number(data.shortAccount)
    };
    logApiCall('Binance Top Long/Short Position Ratio', url, `success, ratio=${result.longShortRatio}`);
    return result;
  } catch (error) {
    console.error('❌ Top Long/Short Position Ratio Fetch Error:', error.message);
    logApiCall('Binance Top Long/Short Position Ratio', url, `failed: ${error.message}`);
    return null;
  }
}

async function fetchGlobalLongShortAccountRatio(symbol = 'BTCUSDT', period = '12h', limit = 1) {
  const url = BINANCE_GLOBAL_LONG_SHORT_ACCOUNT_RATIO_URL;
  logApiCall('Binance Global Long/Short Account Ratio', url, `start (${symbol} ${period})`);
  try {
    const response = await axios.get(url, { timeout: 5000, params: { symbol, period, limit } });
    const data = Array.isArray(response.data) ? response.data[0] : null;
    if (!data) throw new Error('Invalid response');
    const result = {
      longShortRatio: Number(data.longShortRatio),
      longAccount: Number(data.longAccount),
      shortAccount: Number(data.shortAccount)
    };
    logApiCall('Binance Global Long/Short Account Ratio', url, `success, ratio=${result.longShortRatio}`);
    return result;
  } catch (error) {
    console.error('❌ Global Long/Short Account Ratio Fetch Error:', error.message);
    logApiCall('Binance Global Long/Short Account Ratio', url, `failed: ${error.message}`);
    return null;
  }
}

async function fetchFundingRate(symbol = 'BTCUSDT') {
  const url = `${BINANCE_PREMIUM_INDEX_URL}?symbol=${symbol}`;
  logApiCall('Binance Funding Rate', url, `start (${symbol})`);
  try {
    const response = await axios.get(url, { timeout: 5000 });
    const lastFundingRate = parseFloat(response.data?.lastFundingRate);
    const summary = Number.isFinite(lastFundingRate) ? `success, rate=${lastFundingRate}` : 'success, rate=invalid';
    logApiCall('Binance Funding Rate', url, summary);
    return Number.isFinite(lastFundingRate) ? lastFundingRate : null;
  } catch (error) {
    console.error(`❌ Funding Rate Fetch Error (${symbol}):`, error.message);
    logApiCall('Binance Funding Rate', url, `failed: ${error.message}`);
    return null;
  }
}

async function fetchLiveExchangeRate() {
  const url = LIVE_EXCHANGE_RATE_URL;
  logApiCall('Open ER Live USD/VND Rate', url, 'start');
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
        const vcbVndRate = parseFloat(usdData.Sell.replace(/,/g, ''));

        if (Number.isFinite(vcbVndRate) && vcbVndRate > 0) {
          logApiCall('Vietcombank XML', VCB_XML_URL, `success, rate=${vcbVndRate}`);
          console.log(`✅ Success: Pulled clean rate from Vietcombank (${vcbVndRate} VND)`);
          return vcbVndRate;
        }
      }
    }
    console.warn('⚠️ Vietcombank parsed payload did not contain valid USD structural fields.');
  } catch (vcbError) {
    console.error('❌ Vietcombank Direct Fetch Failed:', vcbError.message);
    logApiCall('Vietcombank XML', VCB_XML_URL, `failed: ${vcbError.message}`);
  }

  // --- TRY STRATEGY 2: LIVE_EXCHANGE_RATE_URL FALLBACK ---
  try {
    console.log(`[${new Date().toISOString()}] Executing fallback to global macro engine...`);

    const response = await axios.get(url, { timeout: 5000 });
    const vndRate = parseFloat(response.data?.rates?.VND);

    if (Number.isFinite(vndRate)) {
      logApiCall('Open ER Live USD/VND Rate', url, `success, rate=${vndRate}`);
      console.log(`ℹ️ Fallback Success: Using Global API Baseline (${vndRate} VND)`);
      return vndRate;
    }
    logApiCall('Open ER Live USD/VND Rate', url, 'success, rate=invalid');
    return null;
  } catch (fallbackError) {
    console.error('❌ Fallback Macro Exchange Rate Fetch Error:', fallbackError.message);
    logApiCall('Open ER Live USD/VND Rate', url, `failed: ${fallbackError.message}`);
    return null;
  }
}

async function fetchKlines(symbol = 'BTCUSDT', interval = '1d', limit = 90) {
  const url = `${BINANCE_KLINES_URL}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  logApiCall('Binance Klines', url, `start, limit=${limit}`);
  try {
    const response = await axios.get(url, { timeout: 8000 });
    const data = Array.isArray(response.data) ? response.data : null;
    logApiCall('Binance Klines', url, `success, candles=${data?.length ?? 0}`);
    return data;
  } catch (error) {
    console.error(`❌ Klines Fetch Error (${symbol} ${interval}):`, error.message);
    logApiCall('Binance Klines', url, `failed: ${error.message}`);
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

  if (lastFngFetchDate === todayUtc && cachedFngData) {
    logApiCall('Fear & Greed Cache', FEAR_GREED_URL, `cache hit for ${todayUtc}`);
    return cachedFngData;
  }

  logApiCall('Fear & Greed API', FEAR_GREED_URL, 'start');
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
      logApiCall('Fear & Greed API', FEAR_GREED_URL, `success, value=${cachedFngData.value}`);
      return cachedFngData;
    }
    logApiCall('Fear & Greed API', FEAR_GREED_URL, 'success, no current data');
    return cachedFngData; // Fallback to cache if API errors out
  } catch (error) {
    console.error('❌ Fear & Greed API Error:', error.message);
    logApiCall('Fear & Greed API', FEAR_GREED_URL, `failed: ${error.message}`);
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
  const url = `${BINANCE_24HR_TICKER_URL}?symbol=${symbol}`;
  logApiCall('Binance Spot Ticker', url, `start, symbol=${symbol}`);
  try {
    const response = await axios.get(url, { timeout: 5000 });
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
function runDynamicQuantEngine(fngValue, currentP2PPrice, btc, eth, bnb, sol, stablecoinParity, btcLongShortRatio, btcFundingRate, ethFundingRate, solFundingRate, liveExchangeRate) {
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
  if (ethFundingRate !== null) {
    actions.push(`🔥 **ETH Funding Rate:** ${(ethFundingRate * 100).toFixed(3)}% per 8h`);
    if (ethFundingRate > FUNDING_RATE_WARNING_THRESHOLD) {
      fundingWarnings.push(`ETH funding rate is elevated above ${(FUNDING_RATE_WARNING_THRESHOLD * 100).toFixed(3)}%. High perpetual funding signals risky long-side speculation.`);
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
    const effectiveExchangeRate = liveExchangeRate || IMPLIED_GLOBAL_USD_VND;
    const premiumRatio = ((currentP2PPrice / effectiveExchangeRate) - 1) * 100;

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
        }
      }
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

    const [adList, okxP2PData] = await Promise.all([
      fetchP2POrderBook("BUY"),
      fetchOkxP2PBuyMarketData()
    ]);

    const okxPrice = okxP2PData?.topAd?.price ?? null;
    const okxMerchant = okxP2PData?.topAd?.merchant || 'Unknown';
    const okxMaxTrans = Number(okxP2PData?.topAd?.max ?? 0);
    const okxAlertKey = okxP2PData?.topAd?.id ? `okx:${okxP2PData.topAd.id}` : null;

    if (Number.isFinite(okxPrice)) {
      console.log(`[${new Date().toLocaleTimeString()}] Audit -> OKX P2P Lowest Buy: ${okxPrice} VND | Merchant: ${okxMerchant} | MaxTx: ${okxMaxTrans} | Source: ${okxP2PData.source || 'Unknown'}`);
      if (okxPrice <= TARGET_PRICE && !isVnQuietHours() && okxMaxTrans >= MAX_SINGLE_TRANS_AMOUNT) {
        const currentAlertCount = okxAlertKey ? adNotificationTracker.get(okxAlertKey) || 0 : 0;
        if (currentAlertCount < MAX_ALERTS_PER_AD) {
          if (okxAlertKey) adNotificationTracker.set(okxAlertKey, currentAlertCount + 1);
          const okxAlertMessage = [
            `⚠️ **OKX P2P TARGET REACHED @everyone**`,
            `> 💰 **Buy Price:** ${okxPrice} VND`,
            `> 👤 **Merchant:** ${okxMerchant}`,
            `> 🟦 **Source:** OKX P2P`,
            `> 🎯 **Target Set:** Under ${TARGET_PRICE} VND`
          ].join('\n');
          await sendDiscordNotification(okxAlertMessage);
        }
      }
    }

    if ((!adList || adList.length === 0) && !Number.isFinite(okxPrice)) return;

    // GATED: Exit the function before iterating over individual target matches during quiet hours
    if (isVnQuietHours()) {
      purgeOldCacheTrackingRecords();
      return;
    }

    const filteredAds = (adList || []).filter(entry => {
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
      fetchTakerLongShortRatio('BTCUSDT'),
      fetchTopLongShortPositionRatio('BTCUSDT'),
      fetchGlobalLongShortAccountRatio('BTCUSDT'),
      fetchFundingRate('BTCUSDT'),
      fetchFundingRate('ETHUSDT'),
      fetchFundingRate('SOLUSDT'),
      fetchLiveExchangeRate(),
      fetchOkxP2PBuyMarketData(),
      fetchBlackMarketExchangeRate()
    ];

    const allResults = await Promise.all([...spotPromises, ...extraPromises]);
    const spotResults = allResults.slice(0, TRACKING_SYMBOLS.length);
    const avgSellPrice = allResults[TRACKING_SYMBOLS.length];
    const stablecoinParity = allResults[TRACKING_SYMBOLS.length + 1];
    const btcLongShortRatio = allResults[TRACKING_SYMBOLS.length + 2];
    const btcTakerRatio = allResults[TRACKING_SYMBOLS.length + 3];
    const btcTopPositionRatio = allResults[TRACKING_SYMBOLS.length + 4];
    const btcGlobalAccountRatio = allResults[TRACKING_SYMBOLS.length + 5];
    const btcFundingRate = allResults[TRACKING_SYMBOLS.length + 6];
    const ethFundingRate = allResults[TRACKING_SYMBOLS.length + 7];
    const solFundingRate = allResults[TRACKING_SYMBOLS.length + 8];
    const liveUsdVndRate = allResults[TRACKING_SYMBOLS.length + 9];
    const okxP2PData = allResults[TRACKING_SYMBOLS.length + 10];
    const blackMarketRate = allResults[TRACKING_SYMBOLS.length + 11];

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
    const okxP2PText = okxP2PData && okxP2PData.topAd
      ? `**${okxP2PData.topAd.price.toLocaleString('en-US', { maximumFractionDigits: 0 })} VND** (${okxP2PData.topAd.merchant})`
      : 'Unavailable';
    const okxAvgText = okxP2PData && okxP2PData.avgPrice
      ? `**${okxP2PData.avgPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })} VND**`
      : 'Unavailable';
    const okxSourceLabel = okxP2PData && okxP2PData.source ? ` [OKX source: ${okxP2PData.source}]` : '';
    const okxFallbackNotice = okxP2PData?.source === 'Marketplace'
      ? '⚠️ **OKX fallback active:** Marketplace endpoint used'
      : '';
    const blackMarketUsdVnd = blackMarketRate ? blackMarketRate.sell.toLocaleString('en-US', { maximumFractionDigits: 0 }) : null;

    const advice = runDynamicQuantEngine(fngValue, p2pPriceRaw, btc, eth, bnb, sol, stablecoinParity, btcLongShortRatio, btcFundingRate, ethFundingRate, solFundingRate, liveUsdVndRate);
    // ==========================================
    // METRIC RISK-LEVEL ICON MAP HELPERS
    // 🔴 = High Danger/Anomalous Heat
    // 🟡 = Medium/Transition Alert
    // 🟢 = Low Risk/Calm Baseline
    // ==========================================
    const getPremiumIcon = (p) => {
      if (p === null) return '⚪';
      const absP = Math.abs(p);
      if (absP > 2.0) return '🔴';
      if (absP >= 0.5) return '🟡';
      return '🟢';
    };

    const getLSRatioIcon = (r) => {
      if (r === null) return '⚪';
      if (r > 1.8 || r < 0.8) return '🔴';
      if (r >= 1.4 || r <= 1.0) return '🟡';
      return '🟢';
    };

    const getLongShortSentiment = (r) => {
      if (r === null) return '⚪ Neutral/Unknown';
      if (r > 1.05) return '🟢 Bullish';
      if (r >= 0.95) return '🟡 Neutral';
      return '🔴 Bearish';
    };

    const getTakerSentiment = (r) => {
      if (r === null) return '⚪ Neutral/Unknown';
      if (r > 1.02) return '🟢 Taker Buying';
      if (r >= 0.98) return '🟡 Neutral';
      return '🔴 Taker Selling';
    };

    const getFundingIcon = (f) => {
      if (f === null) return '⚪';
      const absFundingPercentage = Math.abs(f * 100);
      if (absFundingPercentage > 0.04) return '🔴';
      if (absFundingPercentage >= 0.01) return '🟡';
      return '🟢';
    };

    const getParityIcon = (p) => {
      if (!p) return '⚪';
      const deviation = Math.abs(p - 1.0);
      if (deviation > 0.008) return '🔴';
      if (deviation >= 0.002) return '🟡';
      return '🟢';
    };

    const getFngIcon = (v) => {
      if (v > 75 || v < 25) return '🔴';
      if (v >= 60 || v <= 40) return '🟡';
      return '🟢';
    };

    // ==========================================
    // MESSAGE 1: CORE MARKET STATISTICS (Ordered by Importance)
    // ==========================================
    const statisticMessage = [
      `📊 **DYNAMIC QUANT REPORT: MARKET METRICS**`,
      `==============================`,
      `⚙️ **LOCAL P2P LIQUIDITY ENGINE**`,
      `📉 **Instant Lowest P2P Buy:** ${p2pBuyText}`,
      `📈 **Highest P2P Sell (Cash-Out):** ${sellPriceText}`,
      `💎 **P2P Premium Rate:** ${livePremium !== null ? (livePremium >= 0 ? '+' : '') + livePremium.toFixed(2) + '%' : 'Unavailable'} ${premiumLabel} ${getPremiumIcon(livePremium)}`,
      `⚖️ **Real USD/VND Spot:** ${liveUsdVndRate ? liveUsdVndRate.toLocaleString('en-US', { maximumFractionDigits: 2 }) : `${IMPLIED_GLOBAL_USD_VND} (fallback)`} VND`,
      `💱 **${BLACK_MARKET_USD_VND_LABEL}:** ${blackMarketUsdVnd ? blackMarketUsdVnd + ' VND' : 'Unavailable'}`,
      `🟦 **OKX P2P Lowest Buy:** ${okxP2PText}${okxSourceLabel}`,
      `🟦 **OKX P2P Top 5 Avg:** ${okxAvgText}`,
      ...(okxFallbackNotice ? [okxFallbackNotice] : []),
      ``,
      `🚨 **DERIVATIVES & GLOBAL RISK LEVERS**`,
      `📊 **BTC Taker Buy/Sell Volume (12h):** ${btcTakerRatio ? btcTakerRatio.buySellRatio.toFixed(4) : 'Fetch Error'} ${getTakerSentiment(btcTakerRatio?.buySellRatio)} (Buy ${btcTakerRatio ? btcTakerRatio.buyVol.toLocaleString('en-US', { maximumFractionDigits: 2 }) : 'N/A'}, Sell ${btcTakerRatio ? btcTakerRatio.sellVol.toLocaleString('en-US', { maximumFractionDigits: 2 }) : 'N/A'})`,
      `🐋 **BTC Whale Account L/S (12h):** ${btcLongShortRatio !== null ? btcLongShortRatio.toFixed(2) : 'Fetch Error'} ${getLongShortSentiment(btcLongShortRatio)} ${getLSRatioIcon(btcLongShortRatio)}`,
      `🐋 **BTC Whale Position L/S (12h):** ${btcTopPositionRatio && btcTopPositionRatio.longShortRatio ? btcTopPositionRatio.longShortRatio.toFixed(2) : 'Fetch Error'} ${getLongShortSentiment(btcTopPositionRatio?.longShortRatio)} ${getLSRatioIcon(btcTopPositionRatio?.longShortRatio || null)} (${btcTopPositionRatio ? `Long ${btcTopPositionRatio.longAccount.toFixed(4)} / Short ${btcTopPositionRatio.shortAccount.toFixed(4)}` : 'N/A'})`,
      `🧠 **BTC Smart Money Account L/S (12h):** ${btcGlobalAccountRatio && btcGlobalAccountRatio.longShortRatio ? btcGlobalAccountRatio.longShortRatio.toFixed(2) : 'Fetch Error'} ${getLongShortSentiment(btcGlobalAccountRatio?.longShortRatio)} ${getLSRatioIcon(btcGlobalAccountRatio?.longShortRatio || null)} (${btcGlobalAccountRatio ? `Long ${btcGlobalAccountRatio.longAccount.toFixed(4)} / Short ${btcGlobalAccountRatio.shortAccount.toFixed(4)}` : 'N/A'})`,
      ``,
      `🔥 **BTC Funding Rate:** ${btcFundingRate !== null ? (btcFundingRate * 100).toFixed(3) + '%' : 'Fetch Error'} ${getFundingIcon(btcFundingRate)}`,
      `🔥 **SOL Funding Rate:** ${solFundingRate !== null ? (solFundingRate * 100).toFixed(3) + '%' : 'Fetch Error'} ${getFundingIcon(solFundingRate)}`,
      `🔗 **USDC/USDT Parity:** ${stablecoinParity ? stablecoinParity.toFixed(4) : 'Fetch Error'} ${getParityIcon(stablecoinParity)}`,
      ``,
      `🎭 **MACRO SENTIMENT & TARGETS**`,
      `🎭 **Crypto Fear & Greed:** ${fngIndexText} ${getFngIcon(fngValue)}`,
      `🎯 **Active Alert Target:** Under ${TARGET_PRICE} VND`,
      `==============================`,
      `🪙 **GLOBAL SPOT MARKET INDEXES & VELOCITY**`,
      ...displays.flatMap(({ symbol, display }) => ([
        `> ${display.indicator} **${symbol.replace('USDT', '')}**: ${display.text}`,
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

    console.log(`[${ts}] sendDiscordNotification -> dispatching (trunc): ${safeText.slice(0, 120).replace(/\n/g, ' ')}...`);

    // Sửa lỗi 3: Thêm Headers tường minh
    const resp = await axios.post(DISCORD_WEBHOOK_URL, payload, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });

    logApiCall('Discord Webhook', DISCORD_WEBHOOK_URL, `delivered, status=${resp.status}, chars=${safeText.length}`);
    console.log(`[${new Date().toISOString()}] sendDiscordNotification -> delivered, status: ${resp.status}`);
  } catch (error) {
    const errorSummary = error.response ? JSON.stringify(error.response.data) : error.message;
    logApiCall('Discord Webhook', DISCORD_WEBHOOK_URL, `failed: ${errorSummary}`);
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
