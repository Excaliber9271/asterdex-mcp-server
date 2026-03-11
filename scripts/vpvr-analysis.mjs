// Enhanced VPVR Test with VWAP, Intrabar Strength, Dynamic Precision
import { AsterClient } from './dist/aster-client.js';

const aster = new AsterClient();

// ANSI colors
const c = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  bgYellow: '\x1b[43m',
  bgCyan: '\x1b[46m',
  black: '\x1b[30m',
};

// Dynamic price formatter
function formatPrice(price) {
  if (price >= 10000) return price.toFixed(1);
  if (price >= 1000) return price.toFixed(2);
  if (price >= 100) return price.toFixed(3);
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(5);
  return price.toFixed(6);
}

async function testVPVR(symbol) {
  console.log(`\n${c.bold}═══════════════════════════════════════════════════════════════${c.reset}`);
  console.log(`${c.bold}        📊 ENHANCED VPVR: ${symbol}${c.reset}`);
  console.log(`${c.bold}═══════════════════════════════════════════════════════════════${c.reset}`);

  const timeframe = '15m';
  const periods = 96;
  const numBins = 40;

  const klines = await aster.getKlines(symbol, timeframe, periods);
  if (!klines.success || !klines.data?.length) {
    console.log('Failed to fetch klines');
    return;
  }

  const klinesData = klines.data;
  const ticker = await aster.getTicker24h(symbol);
  const currentPrice = ticker.success && ticker.data
    ? parseFloat(Array.isArray(ticker.data) ? ticker.data[0].lastPrice : ticker.data.lastPrice)
    : parseFloat(klinesData[klinesData.length - 1].close);

  // Find range
  const allHighs = klinesData.map(k => parseFloat(k.high));
  const allLows = klinesData.map(k => parseFloat(k.low));
  const rangeHigh = Math.max(...allHighs);
  const rangeLow = Math.min(...allLows);
  const range = rangeHigh - rangeLow;
  const binSize = range / numBins;

  // Build volume profile with INTRABAR STRENGTH
  const volumeProfile = new Array(numBins).fill(0);
  const buyVolume = new Array(numBins).fill(0);
  const sellVolume = new Array(numBins).fill(0);

  // VWAP calculation
  let vwapNumerator = 0;
  let vwapDenominator = 0;

  for (const k of klinesData) {
    const high = parseFloat(k.high);
    const low = parseFloat(k.low);
    const close = parseFloat(k.close);
    const volume = parseFloat(k.quoteVolume);
    const typicalPrice = (high + low + close) / 3;

    // VWAP
    vwapNumerator += typicalPrice * volume;
    vwapDenominator += volume;

    // INTRABAR STRENGTH - the key improvement
    const candleRange = high - low;
    let buyRatio = 0.5;
    if (candleRange > 0) {
      buyRatio = (close - low) / candleRange;
    }
    const buyVol = volume * buyRatio;
    const sellVol = volume * (1 - buyRatio);

    const lowBin = Math.max(0, Math.floor((low - rangeLow) / binSize));
    const highBin = Math.min(Math.floor((high - rangeLow) / binSize), numBins - 1);
    const binsCount = highBin - lowBin + 1;
    const volPerBin = volume / binsCount;
    const buyPerBin = buyVol / binsCount;
    const sellPerBin = sellVol / binsCount;

    for (let i = lowBin; i <= highBin; i++) {
      if (i >= 0 && i < numBins) {
        volumeProfile[i] += volPerBin;
        buyVolume[i] += buyPerBin;
        sellVolume[i] += sellPerBin;
      }
    }
  }

  // VWAP
  const vwap = vwapDenominator > 0 ? vwapNumerator / vwapDenominator : currentPrice;

  // Find POC
  let pocIndex = 0;
  let maxVolume = 0;
  for (let i = 0; i < numBins; i++) {
    if (volumeProfile[i] > maxVolume) {
      maxVolume = volumeProfile[i];
      pocIndex = i;
    }
  }
  const pocPrice = rangeLow + (pocIndex + 0.5) * binSize;

  // Calculate VA
  const totalVolume = volumeProfile.reduce((a, b) => a + b, 0);
  const valueAreaTarget = totalVolume * 0.70;
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

  // Delta with intrabar strength
  const totalBuy = buyVolume.reduce((a, b) => a + b, 0);
  const totalSell = sellVolume.reduce((a, b) => a + b, 0);
  const delta = totalBuy - totalSell;
  const deltaPct = (delta / totalVolume * 100).toFixed(1);

  // POC/VWAP confluence
  const confluence = Math.abs(vwap - pocPrice) / pocPrice < 0.005;

  // Position analysis
  let position = currentPrice > vaHigh ? `${c.green}🟢 ABOVE VA (Bullish Breakout)${c.reset}` :
                 currentPrice < vaLow ? `${c.red}🔴 BELOW VA (Bearish Breakdown)${c.reset}` :
                 currentPrice > pocPrice ? `${c.yellow}🟡 Upper VA (Slight Bull)${c.reset}` :
                 `${c.yellow}🟠 Lower VA (Slight Bear)${c.reset}`;

  let vwapPos = currentPrice > vwap ? `${c.green}Above VWAP${c.reset}` : `${c.red}Below VWAP${c.reset}`;

  // Output
  console.log(`\n${c.cyan}📍 KEY LEVELS:${c.reset}`);
  console.log(`   Current: ${c.bold}$${formatPrice(currentPrice)}${c.reset}`);
  console.log(`   POC:     $${formatPrice(pocPrice)} ${c.dim}(highest volume)${c.reset}`);
  console.log(`   VWAP:    $${formatPrice(vwap)} ${c.dim}(volume-weighted avg)${c.reset}`);
  console.log(`   VA High: $${formatPrice(vaHigh)}`);
  console.log(`   VA Low:  $${formatPrice(vaLow)}`);

  console.log(`\n${c.cyan}📊 POSITION:${c.reset}`);
  console.log(`   ${position}`);
  console.log(`   ${vwapPos}`);
  if (confluence) {
    console.log(`   ${c.bgYellow}${c.black} POC + VWAP CONFLUENCE ${c.reset} ${c.yellow}Strong level!${c.reset}`);
  }

  console.log(`\n${c.cyan}📊 DELTA (Intrabar Strength):${c.reset}`);
  const deltaColor = delta > 0 ? c.green : c.red;
  const deltaStrength = Math.abs(parseFloat(deltaPct)) > 30 ? 'STRONG' :
                        Math.abs(parseFloat(deltaPct)) > 15 ? 'MODERATE' : 'WEAK';
  console.log(`   Buy:  $${(totalBuy/1000).toFixed(0)}k`);
  console.log(`   Sell: $${(totalSell/1000).toFixed(0)}k`);
  console.log(`   Net:  ${deltaColor}${delta > 0 ? '+' : ''}$${(delta/1000).toFixed(0)}k (${deltaPct}%)${c.reset} [${deltaStrength}]`);
  console.log(`   ${delta > 0 ? `${c.green}🟢 Buyers in control${c.reset}` : `${c.red}🔴 Sellers in control${c.reset}`}`);
  console.log(`   ${c.dim}Method: Intrabar Strength (more accurate than binary)${c.reset}`);

  // Visual profile with colors
  console.log(`\n${c.cyan}📈 VOLUME PROFILE:${c.reset}\n`);
  const maxBarLen = 35;
  const normalizer = maxVolume / maxBarLen;

  for (let i = numBins - 1; i >= 0; i -= 2) {
    const price = rangeLow + (i + 0.5) * binSize;
    const barLength = Math.round(volumeProfile[i] / normalizer);
    const buyLen = Math.round(buyVolume[i] / normalizer);
    const sellLen = Math.max(0, barLength - buyLen);
    const binDelta = volumeProfile[i] > 0 ? ((buyVolume[i] - sellVolume[i]) / volumeProfile[i] * 100) : 0;

    // Color-coded bars
    const buyBar = c.green + '█'.repeat(buyLen) + c.reset;
    const sellBar = c.red + '█'.repeat(sellLen) + c.reset;

    let marker = '';
    let rowStyle = '';
    if (i === pocIndex) {
      marker = ` ${c.bgYellow}${c.black}◀═POC${c.reset}`;
      rowStyle = c.bold;
    }
    else if (Math.abs(price - currentPrice) < binSize) {
      marker = ` ${c.bgCyan}${c.black}➤ NOW${c.reset}`;
      rowStyle = c.bold;
    }
    else if (Math.abs(price - vaHigh) < binSize) { marker = ` ${c.yellow}◁─VAH${c.reset}`; }
    else if (Math.abs(price - vaLow) < binSize) { marker = ` ${c.yellow}◁─VAL${c.reset}`; }
    else if (Math.abs(price - vwap) < binSize) { marker = ` ${c.cyan}◁─VWAP${c.reset}`; }

    // Delta indicator for the bin
    const deltaInd = binDelta > 20 ? c.green + '+' + c.reset :
                     binDelta < -20 ? c.red + '-' + c.reset : ' ';

    console.log(`${rowStyle}${deltaInd}$${formatPrice(price).padStart(10)} │${buyBar}${sellBar}│${marker}${c.reset}`);
  }

  console.log(`\n${c.dim}Legend: ${c.green}█${c.reset}${c.dim} Buy volume  ${c.red}█${c.reset}${c.dim} Sell volume  + Strong buying  - Strong selling${c.reset}`);

  console.log(`\n${c.green}✅ Enhanced VPVR Complete!${c.reset}\n`);
}

const symbol = process.argv[2] || 'BTCUSDT';
testVPVR(symbol).catch(console.error);
