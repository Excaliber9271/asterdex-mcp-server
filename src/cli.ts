#!/usr/bin/env node
/**
 * Aster CLI - Fast command-line interface
 * Usage: node cli.js <command> [args]
 */

import { Aster } from './sdk.js';

const aster = new Aster(process.env.ASTER_API_KEY, process.env.ASTER_API_SECRET);
const [,, cmd, ...args] = process.argv;

async function main() {
  const start = Date.now();

  switch (cmd?.toLowerCase()) {
    case 'price': {
      const sym = (args[0] || 'BTC').toUpperCase() + 'USDT';
      const price = await aster.market.getPrice(sym);
      console.log(`${sym}: $${price.toLocaleString()}`);
      break;
    }

    case 'bal':
    case 'balance': {
      const bal = await aster.trade.getBalance();
      bal.filter((b: any) => parseFloat(b.balance || b.walletBalance || '0') > 0)
         .forEach((b: any) => console.log(`${b.asset}: ${b.balance || b.walletBalance}`));
      break;
    }

    case 'pos':
    case 'positions': {
      const pos = await aster.trade.getPositions();
      if (pos.length === 0) { console.log('No positions'); break; }
      pos.forEach((p: any) => {
        const pnl = parseFloat(p.unRealizedProfit);
        console.log(`${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | ${p.symbol}: ${p.positionAmt} @ $${parseFloat(p.entryPrice).toFixed(4)}`);
      });
      break;
    }

    case 'orders': {
      const orders = await aster.trade.getOrders(args[0]?.toUpperCase());
      console.log(`${orders.length} open orders`);
      break;
    }

    case 'funding':
    case 'fund': {
      const opps = await aster.strategy.fundingFarm.scan(0.0003);
      opps.slice(0, 5).forEach((o: any) =>
        console.log(`${o.symbol}: ${(o.fundingRate * 100).toFixed(4)}% ${o.recommendedSide}`));
      break;
    }

    case 'scan': {
      const results = await aster.market.scan({ sortBy: (args[0] as any) || 'volume', limit: 5 });
      results.forEach((r: any) =>
        console.log(`${r.symbol}: $${(r.volume24h / 1e6).toFixed(1)}M | ${r.change24h >= 0 ? '+' : ''}${r.change24h.toFixed(2)}%`));
      break;
    }

    case 'long': {
      const [sym, amt, lev] = args;
      if (!sym || !amt) { console.log('Usage: long <symbol> <usd> [leverage]'); break; }
      const r = await aster.trade.openLong(sym.toUpperCase() + 'USDT', parseFloat(amt), { leverage: parseInt(lev || '10') });
      console.log(`LONG ${sym.toUpperCase()}USDT opened`);
      break;
    }

    case 'short': {
      const [sym, amt, lev] = args;
      if (!sym || !amt) { console.log('Usage: short <symbol> <usd> [leverage]'); break; }
      const r = await aster.trade.openShort(sym.toUpperCase() + 'USDT', parseFloat(amt), { leverage: parseInt(lev || '10') });
      console.log(`SHORT ${sym.toUpperCase()}USDT opened`);
      break;
    }

    case 'close': {
      const sym = args[0]?.toUpperCase();
      if (!sym) { console.log('Usage: close <symbol>'); break; }
      await aster.trade.close(sym + 'USDT');
      console.log(`Closed ${sym}USDT`);
      break;
    }

    default:
      console.log(`Aster CLI
  price [sym]      - Get price (default: BTC)
  bal              - Balances
  pos              - Positions
  orders           - Order count
  fund             - Funding opportunities
  scan [metric]    - Market scan
  long <s> <$> [l] - Open long
  short <s> <$> [l]- Open short
  close <symbol>   - Close position`);
  }

  console.log(`(${Date.now() - start}ms)`);
}

main().catch(e => console.error(e.message));
