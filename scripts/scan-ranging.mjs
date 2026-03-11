import { AsterClient } from './dist/aster-client.js';

const client = new AsterClient();

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return 0;
  
  let gains = 0;
  let losses = 0;
  
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  
  let avgGain = gains / period;
  let avgLoss = losses / period;
  
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
    }
  }
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

async function scanForRanging() {
  console.log('🔍 SCANNING FOR RANGING MARKETS (GRID CANDIDATES)\n');

  // Get all tickers
  const allTickers = await client.getTicker24h();
  if (!allTickers.success) {
    console.log('Error fetching tickers');
    return;
  }

  // Filter for liquid pairs with low daily change
  const candidates = allTickers.data.filter(t => {
    const vol = parseFloat(t.quoteVolume);
    const change = Math.abs(parseFloat(t.priceChangePercent));
    const symbol = t.symbol;
    
    // Ignore likely stocks or weird pairs
    if (symbol.length > 8 && !symbol.includes('1000')) return false; 
    
    return vol > 50000 && change < 5.0; // Volume > 50k and Change < 5%
  });

  console.log(`Found ${candidates.length} potential candidates based on volume and 24h change.\n`);
  console.log('Analyzing RSI and volatility for top candidates...\n');

  // Sort by volume to prioritize liquid pairs
  candidates.sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
  
  // Limit to top 20 checks to avoid rate limits/time
  const topCandidates = candidates.slice(0, 20);
  
  const results = [];

  for (const t of topCandidates) {
    const symbol = t.symbol;
    
    // Get klines for RSI and range analysis (4h candles for swing grid, or 1h for tighter grid)
    // Using 1h candles for better granularity on recent ranging
    const klines = await client.getKlines(symbol, '1h', 50);
    
    if (klines.success && klines.data.length > 20) {
      const closes = klines.data.map(k => parseFloat(k.close));
      const highs = klines.data.map(k => parseFloat(k.high));
      const lows = klines.data.map(k => parseFloat(k.low));
      
      const currentPrice = closes[closes.length - 1];
      const rsi = calculateRSI(closes);
      
      // Calculate recent volatility (Standard Deviation / Mean)
      const period = 20;
      const slice = closes.slice(-period);
      const mean = slice.reduce((a, b) => a + b, 0) / period;
      const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
      const stdDev = Math.sqrt(variance);
      const volatility = (stdDev / mean) * 100;
      
      // Check if price is within recent high/low (Channel check)
      const recentHigh = Math.max(...highs.slice(-24)); // 24h high from candles
      const recentLow = Math.min(...lows.slice(-24)); // 24h low from candles
      const positionInRange = ((currentPrice - recentLow) / (recentHigh - recentLow)) * 100;

      // Filter for RSI neutral and low volatility
      if (rsi > 40 && rsi < 60 && volatility < 2.5) {
         results.push({
            symbol,
            price: currentPrice,
            change: parseFloat(t.priceChangePercent).toFixed(2),
            volume: (parseFloat(t.quoteVolume) / 1000).toFixed(0) + 'k',
            rsi: rsi.toFixed(1),
            volatility: volatility.toFixed(2),
            posInRange: positionInRange.toFixed(0) + '%'
         });
      }
    }
  }
  
  console.log('Symbol'.padEnd(12) + ' | Change'.padEnd(10) + ' | RSI'.padEnd(6) + ' | Volat.'.padEnd(8) + ' | Range Pos'.padEnd(12) + ' | Volume');
  console.log('-'.repeat(70));
  
  results.sort((a, b) => parseFloat(a.volatility) - parseFloat(b.volatility));
  
  results.forEach(r => {
     console.log(
        `${r.symbol.padEnd(12)} | ${r.change.padStart(6)}% | ${r.rsi.padStart(4)} | ${r.volatility.padStart(6)}% | ${r.posInRange.padStart(10)} | $${r.volume}`
     );
  });
  
  if (results.length === 0) {
     console.log('No perfect candidates found with strict criteria. Try widening range.');
  }

  console.log('\n✅ Scan complete!');
}

scanForRanging().catch(console.error);
