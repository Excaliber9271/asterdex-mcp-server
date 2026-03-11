#!/usr/bin/env node
/**
 * Aster Trader CLI - Full-featured command-line trading interface
 *
 * Usage: npx trader <command> [options]
 *
 * Commands:
 *   pumps           - Scan for pump signals
 *   momentum        - Find coins with active momentum
 *   vpvr <symbol>   - Volume profile analysis
 *   price [symbol]  - Get price (default: BTC)
 *   pos             - View positions
 *   bal             - View balances
 *   fund            - Funding rate opportunities
 *   long <sym> <$>  - Open long position
 *   short <sym> <$> - Open short position
 *   close <sym>     - Close position
 */

import 'dotenv/config';
import { AsterClient } from './aster-client.js';
import { AsterTradingClient } from './aster-trading-client.js';

const client = new AsterClient();
const trading = new AsterTradingClient();
const [,, cmd, ...args] = process.argv;

// ==================== INDICATOR CALCULATIONS ====================

function calculateRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function calculateStochRSI(closes: number[], period = 14): number {
  if (closes.length < period * 2) return 50;
  const rsiValues: number[] = [];
  for (let i = period; i < closes.length; i++) {
    rsiValues.push(calculateRSI(closes.slice(0, i + 1), period));
  }
  const recentRSIs = rsiValues.slice(-period);
  const minRSI = Math.min(...recentRSIs);
  const maxRSI = Math.max(...recentRSIs);
  if (maxRSI === minRSI) return 50;
  return ((recentRSIs[recentRSIs.length - 1] - minRSI) / (maxRSI - minRSI)) * 100;
}

function calculateMFI(candles: any[], period = 14): number {
  if (candles.length < period + 1) return 50;
  let posFlow = 0, negFlow = 0;
  const recent = candles.slice(-period - 1);
  for (let i = 1; i < recent.length; i++) {
    const tp = (parseFloat(recent[i].h || recent[i].high) +
                parseFloat(recent[i].l || recent[i].low) +
                parseFloat(recent[i].c || recent[i].close)) / 3;
    const prevTp = (parseFloat(recent[i-1].h || recent[i-1].high) +
                   parseFloat(recent[i-1].l || recent[i-1].low) +
                   parseFloat(recent[i-1].c || recent[i-1].close)) / 3;
    const mf = tp * parseFloat(recent[i].v || recent[i].volume);
    if (tp > prevTp) posFlow += mf;
    else if (tp < prevTp) negFlow += mf;
  }
  if (negFlow === 0) return 100;
  return 100 - (100 / (1 + posFlow / negFlow));
}

function calculateVolumeRatio(candles: any[]): number {
  if (candles.length < 20) return 1;
  const volumes = candles.map(c => parseFloat(c.v || c.volume));
  const currentVol = volumes[volumes.length - 1];
  const avgVol = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
  return avgVol > 0 ? currentVol / avgVol : 1;
}

// ==================== COMMANDS ====================

async function scanPumps() {
  console.log('\n🔍 Scanning for pump signals...\n');

  const tickerRes = await client.getTicker24h();
  if (!tickerRes.success || !tickerRes.data) {
    console.log('❌ Failed to fetch tickers');
    return;
  }

  const pairs = (Array.isArray(tickerRes.data) ? tickerRes.data : [tickerRes.data])
    .filter((t: any) => parseFloat(t.quoteVolume) >= 10000)
    .map((t: any) => ({
      symbol: t.symbol,
      price: parseFloat(t.lastPrice),
      volume: parseFloat(t.quoteVolume),
      change: parseFloat(t.priceChangePercent),
    }));

  console.log(`Analyzing ${pairs.length} pairs...\n`);

  const signals: any[] = [];
  const BATCH_SIZE = 15;

  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const batch = pairs.slice(i, i + BATCH_SIZE);
    process.stdout.write(`\r  Progress: ${Math.min(i + BATCH_SIZE, pairs.length)}/${pairs.length}`);

    const results = await Promise.all(batch.map(async (pair) => {
      try {
        const klineRes = await client.getKlines(pair.symbol, '15m', 48);
        if (!klineRes.success || !klineRes.data || klineRes.data.length < 20) return null;

        const candles = klineRes.data;
        const closes = candles.map((k: any) => parseFloat(k.close));
        const volumeRatio = calculateVolumeRatio(candles);
        const stochRSI = calculateStochRSI(closes);
        const mfi = calculateMFI(candles);

        if (volumeRatio >= 3 && (stochRSI > 50 || mfi > 50)) {
          return {
            symbol: pair.symbol,
            price: pair.price,
            change: pair.change,
            volumeRatio,
            stochRSI,
            mfi,
            score: (volumeRatio * 0.6) + ((stochRSI / 100) * 2) + ((mfi / 100) * 2),
          };
        }
        return null;
      } catch { return null; }
    }));

    signals.push(...results.filter(s => s !== null));
  }

  console.log('\n');

  if (signals.length === 0) {
    console.log('No pump signals found.\n');
    return;
  }

  signals.sort((a, b) => b.score - a.score);

  console.log('📈 PUMP SIGNALS\n');
  console.log('Symbol          Price        24h%    Vol     StochRSI  MFI     Score');
  console.log('─'.repeat(75));

  for (const s of signals.slice(0, 15)) {
    const chg = s.change >= 0 ? `+${s.change.toFixed(1)}%` : `${s.change.toFixed(1)}%`;
    console.log(
      `${s.symbol.padEnd(15)} $${s.price.toFixed(4).padStart(10)} ${chg.padStart(7)} ` +
      `${s.volumeRatio.toFixed(1)}x`.padStart(6) +
      `${s.stochRSI.toFixed(0)}`.padStart(10) +
      `${s.mfi.toFixed(0)}`.padStart(8) +
      `${s.score.toFixed(2)}`.padStart(8)
    );
  }
  console.log('');
}

async function scanMomentum() {
  console.log('\n🚀 Scanning for momentum...\n');

  const tickerRes = await client.getTicker24h();
  if (!tickerRes.success || !tickerRes.data) {
    console.log('❌ Failed to fetch tickers');
    return;
  }

  const tickers = (Array.isArray(tickerRes.data) ? tickerRes.data : [tickerRes.data])
    .filter((t: any) => parseFloat(t.quoteVolume) >= 50000)
    .map((t: any) => ({
      symbol: t.symbol,
      price: parseFloat(t.lastPrice),
      change: parseFloat(t.priceChangePercent),
      volume: parseFloat(t.quoteVolume),
    }))
    .filter((t: any) => Math.abs(t.change) >= 5);

  const gainers = tickers.filter(t => t.change > 0).sort((a, b) => b.change - a.change).slice(0, 10);
  const losers = tickers.filter(t => t.change < 0).sort((a, b) => a.change - b.change).slice(0, 10);

  console.log('🟢 TOP GAINERS\n');
  console.log('Symbol          Price           24h%        Volume');
  console.log('─'.repeat(55));
  for (const t of gainers) {
    console.log(
      `${t.symbol.padEnd(15)} $${t.price.toFixed(4).padStart(12)} ` +
      `+${t.change.toFixed(2)}%`.padStart(10) +
      `$${(t.volume / 1000).toFixed(0)}k`.padStart(12)
    );
  }

  console.log('\n🔴 TOP LOSERS\n');
  console.log('Symbol          Price           24h%        Volume');
  console.log('─'.repeat(55));
  for (const t of losers) {
    console.log(
      `${t.symbol.padEnd(15)} $${t.price.toFixed(4).padStart(12)} ` +
      `${t.change.toFixed(2)}%`.padStart(10) +
      `$${(t.volume / 1000).toFixed(0)}k`.padStart(12)
    );
  }
  console.log('');
}

async function vpvrAnalysis(symbol: string) {
  const sym = symbol.toUpperCase().endsWith('USDT') ? symbol.toUpperCase() : symbol.toUpperCase() + 'USDT';
  console.log(`\n📊 VPVR Analysis: ${sym}\n`);

  const klineRes = await client.getKlines(sym, '15m', 96);
  if (!klineRes.success || !klineRes.data || klineRes.data.length < 20) {
    console.log('❌ Failed to fetch klines');
    return;
  }

  const candles = klineRes.data;
  const prices = candles.map((k: any) => parseFloat(k.close));
  const volumes = candles.map((k: any) => parseFloat(k.volume));
  const currentPrice = prices[prices.length - 1];

  // Calculate VWAP
  let cumVolPrice = 0, cumVol = 0;
  for (let i = 0; i < candles.length; i++) {
    const tp = (parseFloat(candles[i].high) + parseFloat(candles[i].low) + parseFloat(candles[i].close)) / 3;
    cumVolPrice += tp * volumes[i];
    cumVol += volumes[i];
  }
  const vwap = cumVolPrice / cumVol;

  // Calculate volume profile
  const high = Math.max(...candles.map((k: any) => parseFloat(k.high)));
  const low = Math.min(...candles.map((k: any) => parseFloat(k.low)));
  const range = high - low;
  const binSize = range / 20;
  const bins: number[] = new Array(20).fill(0);

  for (const candle of candles) {
    const candleHigh = parseFloat(candle.high);
    const candleLow = parseFloat(candle.low);
    const vol = parseFloat(candle.volume);

    for (let i = 0; i < 20; i++) {
      const binLow = low + i * binSize;
      const binHigh = binLow + binSize;
      if (candleLow <= binHigh && candleHigh >= binLow) {
        bins[i] += vol / 20;
      }
    }
  }

  // Find POC (point of control)
  const maxVolIdx = bins.indexOf(Math.max(...bins));
  const poc = low + (maxVolIdx + 0.5) * binSize;

  // Find Value Area (70% of volume)
  const totalVol = bins.reduce((a, b) => a + b, 0);
  const targetVol = totalVol * 0.7;
  let valLowIdx = maxVolIdx, valHighIdx = maxVolIdx;
  let valVol = bins[maxVolIdx];

  while (valVol < targetVol && (valLowIdx > 0 || valHighIdx < 19)) {
    const addLow = valLowIdx > 0 ? bins[valLowIdx - 1] : 0;
    const addHigh = valHighIdx < 19 ? bins[valHighIdx + 1] : 0;
    if (addLow >= addHigh && valLowIdx > 0) {
      valLowIdx--;
      valVol += addLow;
    } else if (valHighIdx < 19) {
      valHighIdx++;
      valVol += addHigh;
    } else {
      valLowIdx--;
      valVol += addLow;
    }
  }

  const vah = low + (valHighIdx + 1) * binSize;
  const val = low + valLowIdx * binSize;

  // Display
  console.log(`Current Price:  $${currentPrice.toFixed(4)}`);
  console.log(`VWAP:           $${vwap.toFixed(4)} ${currentPrice > vwap ? '(price above)' : '(price below)'}`);
  console.log(`POC:            $${poc.toFixed(4)}`);
  console.log(`Value Area:     $${val.toFixed(4)} - $${vah.toFixed(4)}`);
  console.log(`Range:          $${low.toFixed(4)} - $${high.toFixed(4)}`);

  let position = 'IN VALUE AREA';
  if (currentPrice > vah) position = 'ABOVE VALUE AREA (bullish)';
  else if (currentPrice < val) position = 'BELOW VALUE AREA (bearish)';
  console.log(`\nPosition:       ${position}`);

  // Visual profile
  console.log('\n' + '─'.repeat(50));
  const maxBin = Math.max(...bins);
  for (let i = 19; i >= 0; i--) {
    const binPrice = low + (i + 0.5) * binSize;
    const barLen = Math.round((bins[i] / maxBin) * 30);
    let marker = '  ';
    if (Math.abs(binPrice - currentPrice) < binSize / 2) marker = '◄ ';
    else if (Math.abs(binPrice - poc) < binSize / 2) marker = 'P ';
    else if (Math.abs(binPrice - vwap) < binSize / 2) marker = 'V ';
    console.log(`$${binPrice.toFixed(4).padStart(8)} ${'█'.repeat(barLen)}${marker}`);
  }
  console.log('─'.repeat(50));
  console.log('◄ = Current Price  P = POC  V = VWAP\n');
}

async function getPrice(symbol?: string) {
  const sym = symbol ? (symbol.toUpperCase().endsWith('USDT') ? symbol.toUpperCase() : symbol.toUpperCase() + 'USDT') : 'BTCUSDT';
  const res = await client.getPrice(sym);
  if (!res.success) {
    console.log(`❌ ${res.error}`);
    return;
  }
  console.log(`${sym}: $${parseFloat(res.data!.price).toLocaleString()}`);
}

async function getPositions() {
  const res = await trading.getPositions();
  if (!res.success || !res.data) {
    console.log('❌ Failed to fetch positions');
    return;
  }

  const positions = (Array.isArray(res.data) ? res.data : [res.data])
    .filter((p: any) => parseFloat(p.positionAmt) !== 0);

  if (positions.length === 0) {
    console.log('No open positions.');
    return;
  }

  console.log('\n📊 POSITIONS\n');
  for (const p of positions) {
    const pnl = parseFloat(p.unRealizedProfit);
    const emoji = pnl >= 0 ? '🟢' : '🔴';
    console.log(`${emoji} ${p.symbol}: ${p.positionAmt} @ $${parseFloat(p.entryPrice).toFixed(4)} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
  }
  console.log('');
}

async function getBalances() {
  const res = await trading.getBalance();
  if (!res.success || !res.data) {
    console.log('❌ Failed to fetch balances');
    return;
  }

  const balances = (Array.isArray(res.data) ? res.data : [res.data])
    .filter((b: any) => parseFloat(b.balance || b.walletBalance || '0') > 0);

  console.log('\n💰 BALANCES\n');
  for (const b of balances) {
    const bal = parseFloat(b.balance || b.walletBalance);
    console.log(`${b.asset}: ${bal.toFixed(2)}`);
  }
  console.log('');
}

async function getFunding() {
  const res = await client.getPremiumIndex();
  if (!res.success || !res.data) {
    console.log('❌ Failed to fetch funding');
    return;
  }

  const funding = (Array.isArray(res.data) ? res.data : [res.data])
    .map((f: any) => ({
      symbol: f.symbol,
      rate: parseFloat(f.lastFundingRate || '0'),
    }))
    .filter((f: any) => Math.abs(f.rate) > 0.0003)
    .sort((a: any, b: any) => Math.abs(b.rate) - Math.abs(a.rate))
    .slice(0, 15);

  console.log('\n💸 FUNDING OPPORTUNITIES\n');
  console.log('Symbol          Rate         Play');
  console.log('─'.repeat(45));
  for (const f of funding) {
    const play = f.rate > 0 ? 'SHORT (get paid)' : 'LONG (get paid)';
    console.log(`${f.symbol.padEnd(15)} ${(f.rate * 100).toFixed(4)}%`.padEnd(20) + play);
  }
  console.log('');
}

async function openLong(symbol: string, usd: string, leverage = '10') {
  const sym = symbol.toUpperCase().endsWith('USDT') ? symbol.toUpperCase() : symbol.toUpperCase() + 'USDT';
  const priceRes = await client.getPrice(sym);
  if (!priceRes.success) {
    console.log(`❌ ${priceRes.error}`);
    return;
  }

  const price = parseFloat(priceRes.data!.price);
  const lev = parseInt(leverage);
  const qty = ((parseFloat(usd) * lev) / price).toFixed(8);

  await trading.setLeverage(sym, lev);
  const res = await trading.placeMarketOrder(sym, 'BUY', qty);

  if (res.success) {
    console.log(`✅ LONG ${sym} opened: ${qty} @ ~$${price.toFixed(4)}`);
  } else {
    console.log(`❌ ${res.error}`);
  }
}

async function openShort(symbol: string, usd: string, leverage = '10') {
  const sym = symbol.toUpperCase().endsWith('USDT') ? symbol.toUpperCase() : symbol.toUpperCase() + 'USDT';
  const priceRes = await client.getPrice(sym);
  if (!priceRes.success) {
    console.log(`❌ ${priceRes.error}`);
    return;
  }

  const price = parseFloat(priceRes.data!.price);
  const lev = parseInt(leverage);
  const qty = ((parseFloat(usd) * lev) / price).toFixed(8);

  await trading.setLeverage(sym, lev);
  const res = await trading.placeMarketOrder(sym, 'SELL', qty);

  if (res.success) {
    console.log(`✅ SHORT ${sym} opened: ${qty} @ ~$${price.toFixed(4)}`);
  } else {
    console.log(`❌ ${res.error}`);
  }
}

async function closePosition(symbol: string) {
  const sym = symbol.toUpperCase().endsWith('USDT') ? symbol.toUpperCase() : symbol.toUpperCase() + 'USDT';
  const res = await trading.closePosition(sym);

  if (res.success) {
    console.log(`✅ Closed ${sym}`);
  } else {
    console.log(`❌ ${res.error}`);
  }
}

function showHelp() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    ASTER TRADER CLI                           ║
╚═══════════════════════════════════════════════════════════════╝

ANALYSIS
  pumps             Scan for pump signals (volume + momentum)
  momentum          Find top gainers and losers
  vpvr <symbol>     Volume profile analysis (POC, VAH, VAL, VWAP)
  fund              Funding rate opportunities

MARKET DATA
  price [symbol]    Get price (default: BTC)

ACCOUNT
  pos               View open positions
  bal               View balances

TRADING
  long <sym> <$> [lev]   Open long (default 10x leverage)
  short <sym> <$> [lev]  Open short
  close <sym>            Close position

EXAMPLES
  trader pumps
  trader vpvr SOL
  trader price ETH
  trader long SOL 50 20
  trader close SOL

`);
}

// ==================== MAIN ====================

async function main() {
  const start = Date.now();

  try {
    switch (cmd?.toLowerCase()) {
      case 'pumps':
      case 'pump':
        await scanPumps();
        break;
      case 'momentum':
      case 'mom':
        await scanMomentum();
        break;
      case 'vpvr':
      case 'vp':
        if (!args[0]) { console.log('Usage: trader vpvr <symbol>'); break; }
        await vpvrAnalysis(args[0]);
        break;
      case 'price':
      case 'p':
        await getPrice(args[0]);
        break;
      case 'pos':
      case 'positions':
        await getPositions();
        break;
      case 'bal':
      case 'balance':
        await getBalances();
        break;
      case 'fund':
      case 'funding':
        await getFunding();
        break;
      case 'long':
        if (!args[0] || !args[1]) { console.log('Usage: trader long <symbol> <usd> [leverage]'); break; }
        await openLong(args[0], args[1], args[2]);
        break;
      case 'short':
        if (!args[0] || !args[1]) { console.log('Usage: trader short <symbol> <usd> [leverage]'); break; }
        await openShort(args[0], args[1], args[2]);
        break;
      case 'close':
        if (!args[0]) { console.log('Usage: trader close <symbol>'); break; }
        await closePosition(args[0]);
        break;
      case 'help':
      case '-h':
      case '--help':
      default:
        showHelp();
    }
  } catch (err: any) {
    console.log(`❌ Error: ${err.message}`);
  }

  if (cmd && !['help', '-h', '--help', undefined].includes(cmd?.toLowerCase())) {
    console.log(`(${Date.now() - start}ms)`);
  }
}

main();
