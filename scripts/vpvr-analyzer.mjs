// VPVR (Volume Profile Visible Range) Analyzer
// Calculates POC, Value Area, HVN/LVN zones
import { AsterClient } from './dist/aster-client.js';

const aster = new AsterClient();

async function analyzeVPVR(symbol = 'BTCUSDT', timeframe = '15m', periods = 96) {
  console.log('═'.repeat(70));
  console.log(`        📊 VPVR ANALYSIS: ${symbol}`);
  console.log(`        Timeframe: ${timeframe} | Periods: ${periods} (~24h for 15m)`);
  console.log('═'.repeat(70));

  const klines = await aster.getKlines(symbol, timeframe, periods);
  if (!klines.success || !klines.data.length) {
    console.log('Error fetching klines');
    return;
  }

  // Get current price
  const ticker = await aster.getTicker24h(symbol);
  const currentPrice = ticker.success
    ? parseFloat(Array.isArray(ticker.data) ? ticker.data[0].lastPrice : ticker.data.lastPrice)
    : parseFloat(klines.data[klines.data.length - 1].close);

  // Find price range
  const allHighs = klines.data.map(k => parseFloat(k.high));
  const allLows = klines.data.map(k => parseFloat(k.low));
  const rangeHigh = Math.max(...allHighs);
  const rangeLow = Math.min(...allLows);
  const range = rangeHigh - rangeLow;

  // Create price buckets (bins) - more bins = more granular
  const numBins = 50;
  const binSize = range / numBins;
  const volumeProfile = new Array(numBins).fill(0);
  const buyVolume = new Array(numBins).fill(0);
  const sellVolume = new Array(numBins).fill(0);

  // Distribute volume across price levels
  // For each candle, distribute its volume across the price range it covered
  for (const k of klines.data) {
    const high = parseFloat(k.high);
    const low = parseFloat(k.low);
    const open = parseFloat(k.open);
    const close = parseFloat(k.close);
    const volume = parseFloat(k.quoteVolume); // Use quote volume (USDT)

    const isBullish = close > open;

    // Find which bins this candle touched
    const lowBin = Math.floor((low - rangeLow) / binSize);
    const highBin = Math.min(Math.floor((high - rangeLow) / binSize), numBins - 1);

    // Distribute volume evenly across touched bins (simplified)
    const binsCount = highBin - lowBin + 1;
    const volPerBin = volume / binsCount;

    for (let i = lowBin; i <= highBin; i++) {
      if (i >= 0 && i < numBins) {
        volumeProfile[i] += volPerBin;
        if (isBullish) {
          buyVolume[i] += volPerBin;
        } else {
          sellVolume[i] += volPerBin;
        }
      }
    }
  }

  // Find POC (Point of Control) - highest volume bin
  let pocIndex = 0;
  let maxVolume = 0;
  for (let i = 0; i < numBins; i++) {
    if (volumeProfile[i] > maxVolume) {
      maxVolume = volumeProfile[i];
      pocIndex = i;
    }
  }
  const pocPrice = rangeLow + (pocIndex + 0.5) * binSize;

  // Calculate Value Area (70% of total volume)
  const totalVolume = volumeProfile.reduce((a, b) => a + b, 0);
  const valueAreaTarget = totalVolume * 0.70;

  // Expand from POC until we capture 70%
  let vaLowIndex = pocIndex;
  let vaHighIndex = pocIndex;
  let vaVolume = volumeProfile[pocIndex];

  while (vaVolume < valueAreaTarget && (vaLowIndex > 0 || vaHighIndex < numBins - 1)) {
    const lowerVol = vaLowIndex > 0 ? volumeProfile[vaLowIndex - 1] : 0;
    const upperVol = vaHighIndex < numBins - 1 ? volumeProfile[vaHighIndex + 1] : 0;

    if (lowerVol >= upperVol && vaLowIndex > 0) {
      vaLowIndex--;
      vaVolume += volumeProfile[vaLowIndex];
    } else if (vaHighIndex < numBins - 1) {
      vaHighIndex++;
      vaVolume += volumeProfile[vaHighIndex];
    } else if (vaLowIndex > 0) {
      vaLowIndex--;
      vaVolume += volumeProfile[vaLowIndex];
    }
  }

  const vaHigh = rangeLow + (vaHighIndex + 1) * binSize;
  const vaLow = rangeLow + vaLowIndex * binSize;

  // Identify HVN (High Volume Nodes) and LVN (Low Volume Nodes)
  const avgVolume = totalVolume / numBins;
  const hvnThreshold = avgVolume * 1.5;
  const lvnThreshold = avgVolume * 0.5;

  const hvnZones = [];
  const lvnZones = [];

  for (let i = 0; i < numBins; i++) {
    const price = rangeLow + (i + 0.5) * binSize;
    if (volumeProfile[i] > hvnThreshold) {
      hvnZones.push({ price, volume: volumeProfile[i], bin: i });
    }
    if (volumeProfile[i] < lvnThreshold && volumeProfile[i] > 0) {
      lvnZones.push({ price, volume: volumeProfile[i], bin: i });
    }
  }

  // OUTPUT
  console.log('\n### 📍 KEY LEVELS\n');
  console.log(`  🎯 **POC (Point of Control)**: $${pocPrice.toFixed(6)}`);
  console.log(`     └─ Highest traded volume level - major magnet`);
  console.log(`\n  📊 **Value Area (70% of volume)**:`);
  console.log(`     ├─ VA High: $${vaHigh.toFixed(6)}`);
  console.log(`     └─ VA Low:  $${vaLow.toFixed(6)}`);
  console.log(`\n  📈 **Current Price**: $${currentPrice.toFixed(6)}`);

  // Position relative to VA
  let position;
  if (currentPrice > vaHigh) {
    position = 'ABOVE Value Area';
    console.log(`     └─ 🟢 ${position} (Bullish - breakout territory)`);
  } else if (currentPrice < vaLow) {
    position = 'BELOW Value Area';
    console.log(`     └─ 🔴 ${position} (Bearish - breakdown territory)`);
  } else if (currentPrice > pocPrice) {
    position = 'Upper Value Area';
    console.log(`     └─ 🟡 ${position} (Neutral-Bullish)`);
  } else {
    position = 'Lower Value Area';
    console.log(`     └─ 🟠 ${position} (Neutral-Bearish)`);
  }

  // Visual Volume Profile
  console.log('\n### 📊 VOLUME PROFILE VISUALIZATION\n');

  const maxBarLength = 40;
  const normalizer = maxVolume / maxBarLength;

  // Show every 2nd bin for cleaner output
  for (let i = numBins - 1; i >= 0; i -= 2) {
    const price = rangeLow + (i + 0.5) * binSize;
    const vol = volumeProfile[i];
    const barLength = Math.round(vol / normalizer);
    const buyLen = Math.round(buyVolume[i] / normalizer);
    const sellLen = barLength - buyLen;

    // Create bar with buy (green) and sell (red) portions
    const buyBar = '█'.repeat(Math.max(0, buyLen));
    const sellBar = '░'.repeat(Math.max(0, sellLen));

    let marker = '  ';
    if (i === pocIndex) marker = '◄─POC';
    else if (Math.abs(price - currentPrice) < binSize) marker = '◄─NOW';
    else if (Math.abs(price - vaHigh) < binSize) marker = '◄─VAH';
    else if (Math.abs(price - vaLow) < binSize) marker = '◄─VAL';

    // Color coding hint
    const isHVN = volumeProfile[i] > hvnThreshold;
    const isLVN = volumeProfile[i] < lvnThreshold && volumeProfile[i] > 0;
    const nodeType = isHVN ? '■' : isLVN ? '·' : ' ';

    console.log(`${nodeType} $${price.toFixed(5)} │${buyBar}${sellBar}│ ${marker}`);
  }

  console.log('\nLegend: █ = Buy volume, ░ = Sell volume, ■ = HVN, · = LVN');

  // HVN Analysis
  console.log('\n### 🟢 HIGH VOLUME NODES (Support/Resistance)\n');
  if (hvnZones.length > 0) {
    // Sort by volume and show top 5
    hvnZones.sort((a, b) => b.volume - a.volume);
    for (let i = 0; i < Math.min(5, hvnZones.length); i++) {
      const hvn = hvnZones[i];
      const volPct = (hvn.volume / totalVolume * 100).toFixed(1);
      const relToCurrent = ((hvn.price - currentPrice) / currentPrice * 100).toFixed(1);
      const direction = hvn.price > currentPrice ? '↑' : '↓';
      console.log(`  ${i + 1}. $${hvn.price.toFixed(6)} (${volPct}% of volume) ${direction} ${Math.abs(relToCurrent)}% from current`);
    }
    console.log('\n  💡 HVNs act as support/resistance - price tends to consolidate here');
  } else {
    console.log('  No significant HVNs detected');
  }

  // LVN Analysis
  console.log('\n### 🔴 LOW VOLUME NODES (Fast Move Zones)\n');
  if (lvnZones.length > 0) {
    // Sort by price
    lvnZones.sort((a, b) => b.price - a.price);
    for (let i = 0; i < Math.min(5, lvnZones.length); i++) {
      const lvn = lvnZones[i];
      const relToCurrent = ((lvn.price - currentPrice) / currentPrice * 100).toFixed(1);
      const direction = lvn.price > currentPrice ? '↑' : '↓';
      console.log(`  ${i + 1}. $${lvn.price.toFixed(6)} ${direction} ${Math.abs(relToCurrent)}% from current`);
    }
    console.log('\n  💡 LVNs = price moved through quickly - expect fast moves through these zones');
  } else {
    console.log('  No significant LVNs detected');
  }

  // Trading Implications
  console.log('\n### 🎯 TRADING IMPLICATIONS\n');

  if (currentPrice > vaHigh) {
    console.log('  📈 **BULLISH BREAKOUT**');
    console.log(`     - Price broke above Value Area ($${vaHigh.toFixed(6)})`);
    console.log(`     - VAH now acts as SUPPORT on pullbacks`);
    console.log(`     - Next resistance: Look for HVNs above or prior swing highs`);
    console.log(`     - Target: Extension above range`);
  } else if (currentPrice < vaLow) {
    console.log('  📉 **BEARISH BREAKDOWN**');
    console.log(`     - Price broke below Value Area ($${vaLow.toFixed(6)})`);
    console.log(`     - VAL now acts as RESISTANCE on bounces`);
    console.log(`     - Watch for acceptance below VA or failed breakdown`);
  } else if (currentPrice > pocPrice) {
    console.log('  🟡 **UPPER VALUE AREA**');
    console.log(`     - Price above POC = slight bullish bias`);
    console.log(`     - Watch for breakout above VAH ($${vaHigh.toFixed(6)})`);
    console.log(`     - POC ($${pocPrice.toFixed(6)}) acts as support`);
  } else {
    console.log('  🟠 **LOWER VALUE AREA**');
    console.log(`     - Price below POC = slight bearish bias`);
    console.log(`     - Watch for breakdown below VAL ($${vaLow.toFixed(6)})`);
    console.log(`     - POC ($${pocPrice.toFixed(6)}) acts as resistance`);
  }

  // Delta analysis
  const totalBuy = buyVolume.reduce((a, b) => a + b, 0);
  const totalSell = sellVolume.reduce((a, b) => a + b, 0);
  const delta = totalBuy - totalSell;
  const deltaPct = (delta / totalVolume * 100).toFixed(1);

  console.log('\n### 📊 DELTA ANALYSIS (Buy vs Sell Volume)\n');
  console.log(`  Total Buy Volume:  $${(totalBuy/1000).toFixed(0)}k`);
  console.log(`  Total Sell Volume: $${(totalSell/1000).toFixed(0)}k`);
  console.log(`  Net Delta: ${delta > 0 ? '+' : ''}$${(delta/1000).toFixed(0)}k (${deltaPct}%)`);
  console.log(`  ${delta > 0 ? '🟢 Buyers in control' : '🔴 Sellers in control'}`);

  console.log('\n' + '═'.repeat(70));
}

// Run analysis
const symbol = process.argv[2] || 'BTCUSDT';
const timeframe = process.argv[3] || '15m';
const periods = parseInt(process.argv[4]) || 96;

analyzeVPVR(symbol, timeframe, periods).catch(console.error);
