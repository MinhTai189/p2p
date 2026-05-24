const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Add fetchLiveExchangeRate to extraPromises
content = content.replace(
  "fetchFundingRate('SOLUSDT')\n    ];",
  "fetchFundingRate('SOLUSDT'),\n      fetchLiveExchangeRate()\n    ];"
);

// Add liveUsdVndRate extraction
content = content.replace(
  "const solFundingRate = allResults[TRACKING_SYMBOLS.length + 4];",
  "const solFundingRate = allResults[TRACKING_SYMBOLS.length + 4];\n    const liveUsdVndRate = allResults[TRACKING_SYMBOLS.length + 5];"
);

// Update summary message to include real-time exchange rate and premium
const oldSummary = `    const summaryMessage = [
      \`📊 **DYNAMIC QUANT REPORT**\`,
      \`==============================\`,
      \`📉 **Instant Lowest P2P Buy:** \${p2pBuyText}\`,
      \`📈 **Highest P2P Sell (Cash-Out):** \${sellPriceText}\`,
      \`🔗 **USDC/USDT Parity:** \${stablecoinParity ? stablecoinParity.toFixed(4) : 'Fetch Error'}\`,`;

const newSummary = `    // Calculate live premium using real exchange rate
    const effectiveRate = liveUsdVndRate || IMPLIED_GLOBAL_USD_VND;
    const livePremium = p2pPriceRaw ? (((p2pPriceRaw / effectiveRate) - 1) * 100) : null;
    const premiumLabel = livePremium !== null && Math.abs(livePremium) < 1.5 ? '(Normal Liquidity Band)' : livePremium !== null && livePremium > 2.5 ? '(⚠️ Capital Flight)' : livePremium !== null && livePremium < -0.5 ? '(💎 Discount Entry)' : '';

    const summaryMessage = [
      \`📊 **DYNAMIC QUANT REPORT**\`,
      \`==============================\`,
      \`📉 **Instant Lowest P2P Buy:** \${p2pBuyText}\`,
      \`📈 **Highest P2P Sell (Cash-Out):** \${sellPriceText}\`,
      \`⚖️ **Real USD/VND Spot:** \${liveUsdVndRate ? liveUsdVndRate.toLocaleString('en-US', { maximumFractionDigits: 2 }) : \`\${IMPLIED_GLOBAL_USD_VND} (fallback)\`} VND\`,
      \`💎 **P2P Premium Rate:** \${livePremium !== null ? (livePremium >= 0 ? '+' : '') + livePremium.toFixed(2) + '%' : 'Unavailable'} \${premiumLabel}\`,
      \`🔗 **USDC/USDT Parity:** \${stablecoinParity ? stablecoinParity.toFixed(4) : 'Fetch Error'}\`,`;

content = content.replace(oldSummary, newSummary);

fs.writeFileSync(filePath, content);
console.log('✅ Updated index.js with live exchange rate integration');
