const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'index.js');
let content = fs.readFileSync(filePath, 'utf8');

// First, add fetchLiveExchangeRate to extraPromises
// Looking for the exact pattern with proper whitespace
const beforeExtra = "      fetchFundingRate('SOLUSDT')\n    ];";
const afterExtra = "      fetchFundingRate('SOLUSDT'),\n      fetchLiveExchangeRate()\n    ];";

if (content.includes(beforeExtra)) {
  content = content.replace(beforeExtra, afterExtra);
  console.log('✅ Added fetchLiveExchangeRate() to extraPromises');
} else {
  console.log('❌ Could not find extraPromises pattern');
}

// Second, add liveUsdVndRate extraction
const beforeExtract = "    const solFundingRate = allResults[TRACKING_SYMBOLS.length + 4];";
const afterExtract = "    const solFundingRate = allResults[TRACKING_SYMBOLS.length + 4];\n    const liveUsdVndRate = allResults[TRACKING_SYMBOLS.length + 5];";

if (content.includes(beforeExtract)) {
  content = content.replace(beforeExtract, afterExtract);
  console.log('✅ Added liveUsdVndRate extraction');
} else {
  console.log('❌ Could not find solFundingRate pattern');
}

// Third, update the summary message to include the live exchange rate and premium calculation
// Find and replace the section right before the summaryMessage array
const beforeSummary = "    const advice = runDynamicQuantEngine(fngValue, p2pPriceRaw, btc, eth, bnb, sol, stablecoinParity, btcLongShortRatio, btcFundingRate, solFundingRate);\n\n    const summaryMessage = [";
const afterSummary = `    const advice = runDynamicQuantEngine(fngValue, p2pPriceRaw, btc, eth, bnb, sol, stablecoinParity, btcLongShortRatio, btcFundingRate, solFundingRate);

    // Calculate live premium using real exchange rate
    const effectiveRate = liveUsdVndRate || IMPLIED_GLOBAL_USD_VND;
    const livePremium = p2pPriceRaw ? (((p2pPriceRaw / effectiveRate) - 1) * 100) : null;
    const premiumLabel = livePremium !== null && Math.abs(livePremium) < 1.5 ? '(Normal Liquidity Band)' : livePremium !== null && livePremium > 2.5 ? '(⚠️ Capital Flight)' : livePremium !== null && livePremium < -0.5 ? '(💎 Discount Entry)' : '';

    const summaryMessage = [`;

if (content.includes(beforeSummary)) {
  content = content.replace(beforeSummary, afterSummary);
  console.log('✅ Added premium calculation before summaryMessage');
} else {
  console.log('❌ Could not find summaryMessage init pattern');
}

// Fourth, update the summaryMessage array itself to include the new fields
const oldMsgFields = `      \`📈 **Highest P2P Sell (Cash-Out):** \${sellPriceText}\`,
      \`🔗 **USDC/USDT Parity:** \${stablecoinParity ? stablecoinParity.toFixed(4) : 'Fetch Error'}\`,
      \`📈 **BTC Long/Short Ratio:\``;

const newMsgFields = `      \`📈 **Highest P2P Sell (Cash-Out):** \${sellPriceText}\`,
      \`⚖️ **Real USD/VND Spot:** \${liveUsdVndRate ? liveUsdVndRate.toLocaleString('en-US', { maximumFractionDigits: 2 }) : \`\${IMPLIED_GLOBAL_USD_VND} (fallback)\`} VND\`,
      \`💎 **P2P Premium Rate:** \${livePremium !== null ? (livePremium >= 0 ? '+' : '') + livePremium.toFixed(2) + '%' : 'Unavailable'} \${premiumLabel}\`,
      \`🔗 **USDC/USDT Parity:** \${stablecoinParity ? stablecoinParity.toFixed(4) : 'Fetch Error'}\`,
      \`📈 **BTC Long/Short Ratio:\``;

if (content.includes(oldMsgFields)) {
  content = content.replace(oldMsgFields, newMsgFields);
  console.log('✅ Updated summary message with exchange rate and premium');
} else {
  console.log('❌ Could not find summaryMessage fields pattern');
}

fs.writeFileSync(filePath, content);
console.log('✅ All updates applied to index.js');
