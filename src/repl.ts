/**
 * Aster SDK REPL - Persistent process for fast interactions
 * Run: node repl.js
 * Then pipe commands or use interactively
 */

import { Aster } from './sdk.js';
import * as readline from 'readline';

const aster = new Aster(process.env.ASTER_API_KEY, process.env.ASTER_API_SECRET);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'aster> '
});

async function execute(cmd: string): Promise<string> {
  const parts = cmd.trim().toLowerCase().split(/\s+/);
  const [action, ...args] = parts;

  try {
    switch (action) {
      case 'price': {
        const symbol = (args[0] || 'BTC').toUpperCase() + 'USDT';
        const price = await aster.market.getPrice(symbol);
        return `${symbol}: $${price.toLocaleString()}`;
      }

      case 'balance':
      case 'bal': {
        const bal = await aster.trade.getBalance();
        const nonZero = bal.filter((b: any) => parseFloat(b.balance || b.walletBalance || '0') > 0);
        return nonZero.map((b: any) => `${b.asset}: ${b.balance || b.walletBalance}`).join('\n');
      }

      case 'positions':
      case 'pos': {
        const pos = await aster.trade.getPositions();
        if (pos.length === 0) return 'No open positions';
        return pos.map((p: any) => {
          const pnl = parseFloat(p.unRealizedProfit);
          const icon = pnl >= 0 ? '+' : '';
          return `${p.symbol}: ${p.positionAmt} @ $${parseFloat(p.entryPrice).toFixed(4)} | PnL: ${icon}$${pnl.toFixed(2)}`;
        }).join('\n');
      }

      case 'orders': {
        const orders = await aster.trade.getOrders();
        if (orders.length === 0) return 'No open orders';
        return `${orders.length} open orders`;
      }

      case 'funding':
      case 'fund': {
        const opps = await aster.strategy.fundingFarm.scan(0.0005);
        return opps.slice(0, 5).map((o: any) =>
          `${o.symbol}: ${(o.fundingRate * 100).toFixed(4)}% (${o.recommendedSide})`
        ).join('\n');
      }

      case 'scan': {
        const metric = args[0] as any || 'volume';
        const results = await aster.market.scan({ sortBy: metric, limit: 5 });
        return results.map((r: any) =>
          `${r.symbol}: $${(r.volume24h / 1e6).toFixed(1)}M vol, ${r.change24h.toFixed(2)}%`
        ).join('\n');
      }

      case 'long': {
        const symbol = (args[0] || '').toUpperCase();
        const amount = parseFloat(args[1] || '0');
        const leverage = parseInt(args[2] || '10');
        if (!symbol || !amount) return 'Usage: long <symbol> <usd> [leverage]';
        const result = await aster.trade.openLong(symbol + 'USDT', amount, { leverage });
        return `Opened LONG ${symbol}USDT: ${JSON.stringify(result.entry)}`;
      }

      case 'short': {
        const symbol = (args[0] || '').toUpperCase();
        const amount = parseFloat(args[1] || '0');
        const leverage = parseInt(args[2] || '10');
        if (!symbol || !amount) return 'Usage: short <symbol> <usd> [leverage]';
        const result = await aster.trade.openShort(symbol + 'USDT', amount, { leverage });
        return `Opened SHORT ${symbol}USDT: ${JSON.stringify(result.entry)}`;
      }

      case 'close': {
        const symbol = (args[0] || '').toUpperCase();
        if (!symbol) return 'Usage: close <symbol>';
        await aster.trade.close(symbol + 'USDT');
        return `Closed ${symbol}USDT`;
      }

      case 'help':
      case '?':
        return `Commands:
  price [symbol]     - Get price (default: BTC)
  bal/balance        - Show balances
  pos/positions      - Show positions
  orders             - Count open orders
  fund/funding       - Top funding opportunities
  scan [metric]      - Scan markets (volume/funding/change)
  long <sym> <usd> [lev]  - Open long
  short <sym> <usd> [lev] - Open short
  close <symbol>     - Close position
  exit/quit          - Exit REPL`;

      case 'exit':
      case 'quit':
        process.exit(0);

      default:
        return `Unknown command: ${action}. Type 'help' for commands.`;
    }
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

console.log('Aster REPL ready. Type "help" for commands.');
rl.prompt();

rl.on('line', async (line) => {
  if (line.trim()) {
    const start = Date.now();
    const result = await execute(line);
    const ms = Date.now() - start;
    console.log(result);
    console.log(`(${ms}ms)`);
  }
  rl.prompt();
});
