/**
 * Test Cross-Exchange VPVR Comparison
 * Compares Volume Profiles between Aster and Hyperliquid
 *
 * Usage: node scripts/vpvr-cross.mjs [SYMBOL]
 * Examples:
 *   node scripts/vpvr-cross.mjs BTCUSDT
 *   node scripts/vpvr-cross.mjs ETHUSDT
 *   node scripts/vpvr-cross.mjs BTCUSDT  (Aster-exclusive - shows warning)
 */

import axios from 'axios';

const ASTER_API = 'https://fapi.asterdex.com';
const HL_API = 'https://api.hyperliquid.xyz/info';

const symbol = process.argv[2] || 'BTCUSDT';
const timeframe = '15m';
const periods = 96;
const numBins = 30;

console.log(`\n🔄 Cross-Exchange VPVR Analysis: ${symbol}`);
console.log(`   Timeframe: ${timeframe} | Periods: ${periods} | Bins: ${numBins}`);
console.log('━'.repeat(60));

// Normalize symbols
const asterSymbol = symbol.toUpperCase().replace('PERP', '');
const hlSymbol = asterSymbol.replace('USDT', '').replace('USD', '');

// Calculate interval milliseconds
function intervalToMs(interval) {
  const num = parseInt(interval);
  const unit = interval.replace(/\d+/g, '');
  const multipliers = { m: 60000, h: 3600000, d: 86400000 };
  return num * (multipliers[unit] || 60000);
}

// Fetch Aster klines
async function fetchAsterKlines() {
  try {
    const res = await axios.get(`${ASTER_API}/fapi/v1/klines`, {
      params: { symbol: asterSymbol, interval: timeframe, limit: periods }
    });
    return res.data.map(k => ({
      openTime: k[0], open: k[1], high: k[2], low: k[3], close: k[4],
      volume: k[5], quoteVolume: k[7]
    }));
  } catch (e) {
    console.error('Aster klines error:', e.message);
    return null;
  }
}

// Fetch Hyperliquid klines
async function fetchHLKlines() {
  try {
    const now = Date.now();
    const intervalMs = intervalToMs(timeframe);
    const res = await axios.post(HL_API, {
      type: 'candleSnapshot',
      req: {
        coin: hlSymbol,
        interval: timeframe,
        startTime: now - intervalMs * periods,
        endTime: now
      }
    });
    return res.data.map(k => ({
      openTime: k.t, open: k.o, high: k.h, low: k.l, close: k.c,
      volume: k.v, quoteVolume: k.v
    }));
  } catch (e) {
    console.error('HL klines error:', e.message);
    return null;
  }
}

// Calculate VPVR from klines
function calculateVPVR(klines, exchange) {
  if (!klines || klines.length === 0) return null;

  const allHighs = klines.map(k => parseFloat(k.high));
  const allLows = klines.map(k => parseFloat(k.low));
  const rangeHigh = Math.max(...allHighs);
  const rangeLow = Math.min(...allLows);
  const range = rangeHigh - rangeLow;

  if (range === 0) return null;

  const binSize = range / numBins;
  const volumeProfile = new Array(numBins).fill(0);
  const buyVolume = new Array(numBins).fill(0);
  const sellVolume = new Array(numBins).fill(0);

  let vwapNum = 0, vwapDen = 0, totalBuy = 0, totalSell = 0;

  for (const k of klines) {
    const high = parseFloat(k.high);
    const low = parseFloat(k.low);
    const close = parseFloat(k.close);
    const volume = parseFloat(k.quoteVolume || k.volume);
    const typical = (high + low + close) / 3;

    vwapNum += typical * volume;
    vwapDen += volume;

    const candleRange = high - low;
    const buyRatio = candleRange > 0 ? (close - low) / candleRange : 0.5;
    const bVol = volume * buyRatio;
    const sVol = volume * (1 - buyRatio);
    totalBuy += bVol;
    totalSell += sVol;

    const lowBin = Math.max(0, Math.floor((low - rangeLow) / binSize));
    const highBin = Math.min(Math.floor((high - rangeLow) / binSize), numBins - 1);
    const binsCount = highBin - lowBin + 1;

    for (let i = lowBin; i <= highBin; i++) {
      volumeProfile[i] += volume / binsCount;
      buyVolume[i] += bVol / binsCount;
      sellVolume[i] += sVol / binsCount;
    }
  }

  const vwap = vwapDen > 0 ? vwapNum / vwapDen : 0;
  const totalVolume = volumeProfile.reduce((a, b) => a + b, 0);

  // Find POC
  let pocIndex = 0, maxVol = 0;
  for (let i = 0; i < numBins; i++) {
    if (volumeProfile[i] > maxVol) {
      maxVol = volumeProfile[i];
      pocIndex = i;
    }
  }
  const poc = rangeLow + (pocIndex + 0.5) * binSize;

  // Value Area (70%)
  const vaTarget = totalVolume * 0.70;
  let vaLowIdx = pocIndex, vaHighIdx = pocIndex;
  let vaVol = volumeProfile[pocIndex];

  while (vaVol < vaTarget && (vaLowIdx > 0 || vaHighIdx < numBins - 1)) {
    const lower = vaLowIdx > 0 ? volumeProfile[vaLowIdx - 1] : 0;
    const upper = vaHighIdx < numBins - 1 ? volumeProfile[vaHighIdx + 1] : 0;
    if (lower >= upper && vaLowIdx > 0) { vaLowIdx--; vaVol += volumeProfile[vaLowIdx]; }
    else if (vaHighIdx < numBins - 1) { vaHighIdx++; vaVol += volumeProfile[vaHighIdx]; }
    else if (vaLowIdx > 0) { vaLowIdx--; vaVol += volumeProfile[vaLowIdx]; }
  }

  return {
    exchange, poc, vwap,
    vaHigh: rangeLow + (vaHighIdx + 1) * binSize,
    vaLow: rangeLow + vaLowIdx * binSize,
    totalVolume, buyVolume: totalBuy, sellVolume: totalSell,
    deltaPct: totalVolume > 0 ? (totalBuy - totalSell) / totalVolume * 100 : 0,
    rangeHigh, rangeLow, binSize
  };
}

// Format price based on magnitude
function fmt(p) {
  if (p >= 1000) return p.toFixed(1);
  if (p >= 1) return p.toFixed(2);
  if (p >= 0.01) return p.toFixed(4);
  return p.toFixed(6);
}

// ANSI colors
const c = {
  r: '\x1b[0m', g: '\x1b[32m', rd: '\x1b[31m', y: '\x1b[33m',
  c: '\x1b[36m', b: '\x1b[1m', dim: '\x1b[2m'
};

async function main() {
  // Fetch data from both exchanges
  console.log('\nFetching data...');
  const [asterKlines, hlKlines] = await Promise.all([
    fetchAsterKlines(),
    fetchHLKlines()
  ]);

  const asterVPVR = calculateVPVR(asterKlines, 'Aster');
  const hlVPVR = calculateVPVR(hlKlines, 'Hyperliquid');

  // Handle single-exchange scenario
  if (!asterVPVR && !hlVPVR) {
    console.log(`\n${c.rd}ERROR: Symbol not found on either exchange${c.r}`);
    return;
  }

  if (!asterVPVR || !hlVPVR) {
    const avail = asterVPVR || hlVPVR;
    console.log(`\n${c.y}⚠️  Only available on ${avail.exchange}${c.r}`);
    console.log(`   ${!asterVPVR ? 'Aster' : 'Hyperliquid'}: NOT LISTED`);
    console.log(`\n📊 ${avail.exchange} VPVR:`);
    console.log(`   POC:     ${fmt(avail.poc)}`);
    console.log(`   VWAP:    ${fmt(avail.vwap)}`);
    console.log(`   VA:      ${fmt(avail.vaLow)} - ${fmt(avail.vaHigh)}`);
    console.log(`   Delta:   ${avail.deltaPct > 0 ? c.g : c.rd}${avail.deltaPct.toFixed(1)}%${c.r}`);
    console.log(`\n${c.dim}TIP: Aster-exclusive pairs often have extreme funding rates${c.r}`);
    return;
  }

  // Cross-exchange comparison
  const pocDiv = (asterVPVR.poc - hlVPVR.poc) / hlVPVR.poc * 100;
  const vwapDiv = (asterVPVR.vwap - hlVPVR.vwap) / hlVPVR.vwap * 100;
  const volRatio = asterVPVR.totalVolume / hlVPVR.totalVolume;

  console.log(`\n${c.b}📍 PRICE LEVELS COMPARISON${c.r}`);
  console.log('─'.repeat(50));
  console.log(`${''.padEnd(15)} ${'ASTER'.padStart(12)} ${'HYPERLIQUID'.padStart(12)} ${'DIFF'.padStart(10)}`);
  console.log('─'.repeat(50));
  console.log(`${'POC'.padEnd(15)} ${fmt(asterVPVR.poc).padStart(12)} ${fmt(hlVPVR.poc).padStart(12)} ${(pocDiv > 0 ? '+' : '') + pocDiv.toFixed(2) + '%'}`);
  console.log(`${'VWAP'.padEnd(15)} ${fmt(asterVPVR.vwap).padStart(12)} ${fmt(hlVPVR.vwap).padStart(12)} ${(vwapDiv > 0 ? '+' : '') + vwapDiv.toFixed(2) + '%'}`);
  console.log(`${'VA High'.padEnd(15)} ${fmt(asterVPVR.vaHigh).padStart(12)} ${fmt(hlVPVR.vaHigh).padStart(12)}`);
  console.log(`${'VA Low'.padEnd(15)} ${fmt(asterVPVR.vaLow).padStart(12)} ${fmt(hlVPVR.vaLow).padStart(12)}`);

  console.log(`\n${c.b}📊 DELTA ANALYSIS${c.r}`);
  console.log('─'.repeat(50));
  const asterBias = asterVPVR.deltaPct > 5 ? `${c.g}BUYERS${c.r}` : asterVPVR.deltaPct < -5 ? `${c.rd}SELLERS${c.r}` : 'NEUTRAL';
  const hlBias = hlVPVR.deltaPct > 5 ? `${c.g}BUYERS${c.r}` : hlVPVR.deltaPct < -5 ? `${c.rd}SELLERS${c.r}` : 'NEUTRAL';
  console.log(`Aster:      ${asterVPVR.deltaPct > 0 ? c.g : c.rd}${asterVPVR.deltaPct.toFixed(1).padStart(6)}%${c.r}  ${asterBias}`);
  console.log(`Hyperliquid:${hlVPVR.deltaPct > 0 ? c.g : c.rd}${hlVPVR.deltaPct.toFixed(1).padStart(6)}%${c.r}  ${hlBias}`);

  console.log(`\n${c.b}📈 VOLUME COMPARISON${c.r}`);
  console.log('─'.repeat(50));
  console.log(`Aster:       $${(asterVPVR.totalVolume / 1000).toFixed(0)}k`);
  console.log(`Hyperliquid: $${(hlVPVR.totalVolume / 1000).toFixed(0)}k`);
  console.log(`Ratio:       ${volRatio.toFixed(3)}x (${volRatio > 1 ? 'Aster leads' : 'HL leads'})`);

  // Generate signals
  console.log(`\n${c.b}🎯 SIGNALS${c.r}`);
  console.log('─'.repeat(50));

  const signals = [];
  if (Math.abs(pocDiv) > 2) {
    signals.push(`⚠️  POC DIVERGENCE: ${pocDiv > 0 ? 'Aster' : 'HL'} values ${Math.abs(pocDiv).toFixed(1)}% higher`);
  }
  if (asterVPVR.deltaPct > 20 && hlVPVR.deltaPct < -10) {
    signals.push('🔥 BULLISH DIVERGENCE: Aster accumulating, HL distributing');
  } else if (asterVPVR.deltaPct < -20 && hlVPVR.deltaPct > 10) {
    signals.push('❄️  BEARISH DIVERGENCE: Aster distributing, HL accumulating');
  }
  if (asterVPVR.deltaPct * hlVPVR.deltaPct < 0 && Math.abs(asterVPVR.deltaPct) > 10 && Math.abs(hlVPVR.deltaPct) > 10) {
    signals.push('🔀 DELTA CONFLICT: Exchanges disagree on direction');
  }
  if (volRatio < 0.1) {
    signals.push('📉 LOW ASTER LIQUIDITY: HL dominates price discovery');
  }

  if (signals.length === 0) {
    console.log(`${c.g}✅ Exchanges aligned - no major divergence detected${c.r}`);
  } else {
    signals.forEach(s => console.log(s));
  }

  // Trading recommendations
  console.log(`\n${c.b}💡 RECOMMENDATIONS${c.r}`);
  console.log('─'.repeat(50));
  if (pocDiv < -1) {
    console.log(`If BULLISH: Buy on Aster (cheaper POC at ${fmt(asterVPVR.poc)})`);
  } else if (pocDiv > 1) {
    console.log(`If BEARISH: Short on Aster (higher POC at ${fmt(asterVPVR.poc)})`);
  } else {
    console.log('POCs aligned - trade either exchange');
  }
  console.log(`Liquidity: ${volRatio < 0.5 ? 'Use HL for larger orders' : volRatio > 2 ? 'Aster has good depth' : 'Similar on both'}`);
}

main().catch(console.error);
