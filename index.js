const axios = require('axios');
const http = require('http');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const webhookUrl = process.env.DISCORD_WEBHOOK_URL
const TARGET_PRICE = process.env.TARGET_PRICE;
const CHECK_INTERVAL_MS = 60000; // 1 minute

const BINANCE_P2P_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';

async function sendDiscordMessage(price, merchant) {
  const alertMessage = `🚨 P2P Alert! USDT/VND rate dropped to ${price} VND (Merchant: ${merchant}).`;

  try {
    const response = await axios.post(webhookUrl, {
      content: alertMessage
    });

    // Discord returns a 204 No Content status on a successful webhook execution
    if (response.status === 204) {
      console.log('Message sent successfully!');
    }
  } catch (error) {
    // Axios wraps errors inside error.response if the server replied with a bad status code
    if (error.response) {
      console.error(`Discord API Error (${error.response.status}):`, error.response.data);
    } else {
      console.error('Error setting up the request:', error.message);
    }
  }
}

async function checkP2PPrice() {
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

  try {
    const response = await axios.post(BINANCE_P2P_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response || !response.data || !response.data.data || response.data.data.length === 0) {
      console.warn(`[${new Date().toLocaleTimeString()}] No P2P ads found.`);
      return;
    }

    const topAd = response.data.data[0];
    const currentPrice = parseFloat(topAd.adv.price);
    const merchantName = topAd.advertiser.nickName;

    console.log(topAd)

    console.log(`[${new Date().toLocaleTimeString()}] P2P Price: ${currentPrice} VND | Merchant: ${merchantName}`);

    if (currentPrice <= TARGET_PRICE) {
      await sendDiscordMessage(currentPrice, merchantName);
    }
  } catch (error) {
    console.error('Binance API Fetch Error:', error.message);
  }
}

async function sendMessengerNotification(price, merchant) {
  if (!MESSENGER_WEBHOOK_URL) {
    console.error('Webhook configuration missing.');
    return;
  }

  const alertMessage = `🚨 P2P Alert! USDT/VND rate dropped to ${price} VND (Merchant: ${merchant}).`;

  try {
    await axios.post(MESSENGER_WEBHOOK_URL, { message: alertMessage });
    console.log('✅ Alert sent successfully.');
  } catch (error) {
    console.error('Webhook trigger failure:', error.message);
  }
}

checkP2PPrice()

// 1. Create Dummy Server to satisfy Render's Port Binding rule
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'active', bot: 'Binance P2P Monitor' }));
});

server.listen(PORT, () => {
  console.log(`📡 Production health-check server listening on port ${PORT}`);

  // 2. Fire daemon loop immediately after successful port binding
  console.log(`🚀 Daemon tracking started: Target < ${TARGET_PRICE} VND`);
  checkP2PPrice();
  setInterval(checkP2PPrice, CHECK_INTERVAL_MS);
});