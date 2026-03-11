/**
 * Aster SDK
 *
 * Unified SDK for Aster DEX perpetual futures trading.
 * Clean programmatic access without MCP overhead.
 *
 * @example
 * ```typescript
 * import { Aster } from './sdk';
 *
 * const aster = new Aster(apiKey, apiSecret);
 *
 * // Market data
 * const price = await aster.market.getPrice('BTCUSDT');
 * const funding = await aster.market.getFunding('BTCUSDT');
 *
 * // Trading
 * await aster.trade.openLong('BTCUSDT', 100, { leverage: 10, stopLoss: 5 });
 * await aster.trade.close('BTCUSDT');
 *
 * // Strategies
 * await aster.strategy.fundingFarm.start({ size: 100 });
 * await aster.strategy.grid.start({ symbol: 'ETHUSDT', lower: 3000, upper: 4000, levels: 10 });
 * ```
 */

import { AsterClient } from './aster-client.js';
import { AsterTradingClient } from './aster-trading-client.js';
import { AsterWebSocket } from './aster-websocket.js';
import { FundingFarmStrategy, GridTradingStrategy } from './strategies/index.js';

// ==================== Market Namespace ====================

export class AsterMarket {
  private client: AsterClient;

  constructor(client: AsterClient) {
    this.client = client;
  }

  /** Get current price for a symbol */
  async getPrice(symbol: string) {
    const res = await this.client.getPrice(symbol);
    if (!res.success) throw new Error(res.error || 'Failed to get price');
    return parseFloat(res.data!.price);
  }

  /** Get prices for all symbols */
  async getAllPrices() {
    const res = await this.client.getPrice();
    if (!res.success) throw new Error(res.error || 'Failed to get prices');
    return res.data;
  }

  /** Get funding rate for a symbol */
  async getFunding(symbol?: string) {
    const res = await this.client.getPremiumIndex(symbol);
    if (!res.success) throw new Error(res.error || 'Failed to get funding');
    return res.data;
  }

  /** Get orderbook */
  async getOrderbook(symbol: string, limit: number = 10) {
    const res = await this.client.getOrderBook(symbol, limit);
    if (!res.success) throw new Error(res.error || 'Failed to get orderbook');
    return res.data;
  }

  /** Get 24h ticker stats */
  async getTicker(symbol?: string) {
    const res = await this.client.getTicker24h(symbol);
    if (!res.success) throw new Error(res.error || 'Failed to get ticker');
    return res.data;
  }

  /** Get klines/candlesticks */
  async getKlines(symbol: string, interval: string = '1h', limit: number = 100) {
    const res = await this.client.getKlines(symbol, interval, limit);
    if (!res.success) throw new Error(res.error || 'Failed to get klines');
    return res.data;
  }

  /** Get open interest */
  async getOpenInterest(symbol: string) {
    const res = await this.client.getOpenInterest(symbol);
    if (!res.success) throw new Error(res.error || 'Failed to get OI');
    return res.data;
  }

  /** Get funding rate history */
  async getFundingHistory(symbol: string, limit: number = 100) {
    const res = await this.client.getFundingRateHistory(symbol, limit);
    if (!res.success) throw new Error(res.error || 'Failed to get funding history');
    return res.data;
  }

  /** Get recent trades */
  async getRecentTrades(symbol: string, limit: number = 100) {
    const res = await this.client.getRecentTrades(symbol, limit);
    if (!res.success) throw new Error(res.error || 'Failed to get trades');
    return res.data;
  }

  /** Get best bid/ask */
  async getBookTicker(symbol?: string) {
    const res = await this.client.getBookTicker(symbol);
    if (!res.success) throw new Error(res.error || 'Failed to get book ticker');
    return res.data;
  }

  /** Get exchange info */
  async getExchangeInfo() {
    const res = await this.client.getExchangeInfo();
    if (!res.success) throw new Error(res.error || 'Failed to get exchange info');
    return res.data;
  }

  /** Scan all markets sorted by metric */
  async scan(options: {
    sortBy?: 'funding' | 'volume' | 'change' | 'spread';
    limit?: number;
    minVolume?: number;
  } = {}) {
    const [tickerRes, fundingRes] = await Promise.all([
      this.client.getTicker24h(),
      this.client.getPremiumIndex(),
    ]);

    if (!tickerRes.success || !fundingRes.success) {
      throw new Error('Failed to fetch market data');
    }

    const tickers: any[] = Array.isArray(tickerRes.data) ? tickerRes.data : [tickerRes.data];
    const funding: any[] = Array.isArray(fundingRes.data) ? fundingRes.data : [fundingRes.data];
    const fundingMap = new Map(funding.map(f => [f.symbol, f]));

    let results = tickers
      .filter(t => !options.minVolume || parseFloat(t.quoteVolume || '0') >= options.minVolume)
      .map(t => {
        const f = fundingMap.get(t.symbol) || {};
        return {
          symbol: t.symbol,
          price: parseFloat(t.lastPrice || '0'),
          change24h: parseFloat(t.priceChangePercent || '0'),
          volume24h: parseFloat(t.quoteVolume || '0'),
          fundingRate: parseFloat(f.lastFundingRate || '0'),
          markPrice: parseFloat(f.markPrice || '0'),
        };
      });

    // Sort
    const sortKey = {
      funding: (a: any) => Math.abs(a.fundingRate),
      volume: (a: any) => a.volume24h,
      change: (a: any) => Math.abs(a.change24h),
      spread: (a: any) => a.volume24h, // fallback
    }[options.sortBy || 'volume'];

    results.sort((a, b) => sortKey(b) - sortKey(a));

    return results.slice(0, options.limit || 20);
  }
}

// ==================== Trade Namespace ====================

export interface OpenPositionOptions {
  leverage?: number;
  stopLoss?: number;
  takeProfit?: number;
  trailingTP?: boolean;
  trailingCallback?: number;
}

export class AsterTrade {
  private client: AsterTradingClient;

  constructor(client: AsterTradingClient) {
    this.client = client;
  }

  /** Get account balance */
  async getBalance() {
    const res = await this.client.getBalance();
    if (!res.success) throw new Error(res.error || 'Failed to get balance');
    return res.data;
  }

  /** Get open positions */
  async getPositions(symbol?: string) {
    const res = await this.client.getPositions(symbol);
    if (!res.success) throw new Error(res.error || 'Failed to get positions');
    return res.data?.filter((p: any) => parseFloat(p.positionAmt || '0') !== 0) || [];
  }

  /** Get open orders */
  async getOrders(symbol?: string) {
    const res = await this.client.getOpenOrders(symbol);
    if (!res.success) throw new Error(res.error || 'Failed to get orders');
    return res.data || [];
  }

  /** Set leverage for a symbol */
  async setLeverage(symbol: string, leverage: number) {
    const res = await this.client.setLeverage(symbol, leverage);
    if (!res.success) throw new Error(res.error || 'Failed to set leverage');
    return res.data;
  }

  /** Open a LONG position */
  async openLong(symbol: string, usdAmount: number, options: OpenPositionOptions = {}) {
    return this.openPosition(symbol, 'LONG', usdAmount, options);
  }

  /** Open a SHORT position */
  async openShort(symbol: string, usdAmount: number, options: OpenPositionOptions = {}) {
    return this.openPosition(symbol, 'SHORT', usdAmount, options);
  }

  /** Open a position */
  async openPosition(
    symbol: string,
    side: 'LONG' | 'SHORT',
    usdAmount: number,
    options: OpenPositionOptions = {}
  ) {
    const res = await this.client.openPosition({
      symbol,
      side,
      usdAmount,
      leverage: options.leverage || 10,
      stopLossPercent: options.stopLoss || 5,
      takeProfitPercent: options.takeProfit,
      useTrailingTP: options.trailingTP,
      trailingCallbackPercent: options.trailingCallback,
    });
    if (!res.success) throw new Error(res.error || 'Failed to open position');
    return res.data;
  }

  /** Close a position */
  async close(symbol: string) {
    const res = await this.client.closePosition(symbol);
    if (!res.success) throw new Error(res.error || 'Failed to close position');
    return res.data;
  }

  /** Cancel all orders for a symbol */
  async cancelOrders(symbol: string) {
    const res = await this.client.cancelAllOrders(symbol);
    if (!res.success) throw new Error(res.error || 'Failed to cancel orders');
    return res.data;
  }

  /** Place a limit order */
  async limitOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: string,
    price: string,
    options: { postOnly?: boolean; reduceOnly?: boolean } = {}
  ) {
    const res = await this.client.placeLimitOrderAdvanced(symbol, side, quantity, price, {
      timeInForce: options.postOnly ? 'GTX' : 'GTC',
      reduceOnly: options.reduceOnly,
    });
    if (!res.success) throw new Error(res.error || 'Failed to place limit order');
    return res.data;
  }

  /** Place a market order */
  async marketOrder(symbol: string, side: 'BUY' | 'SELL', quantity: string) {
    const res = await this.client.placeMarketOrder(symbol, side, quantity);
    if (!res.success) throw new Error(res.error || 'Failed to place market order');
    return res.data;
  }

  /** Set trailing stop */
  async setTrailingStop(symbol: string, callbackRate: number, activationPrice?: string) {
    const res = await this.client.setTrailingStop(symbol, callbackRate, activationPrice);
    if (!res.success) throw new Error(res.error || 'Failed to set trailing stop');
    return res.data;
  }

  /** Modify stop loss */
  async modifyStopLoss(symbol: string, stopPrice: string) {
    const res = await this.client.modifyStopLoss(symbol, stopPrice);
    if (!res.success) throw new Error(res.error || 'Failed to modify stop loss');
    return res.data;
  }

  /** Place a two-sided spread (market making) */
  async placeSpread(symbol: string, bidPrice: string, askPrice: string, quantity: string) {
    const res = await this.client.placeSpread(symbol, bidPrice, askPrice, quantity);
    if (!res.success) throw new Error(res.error || 'Failed to place spread');
    return res.data;
  }

  /** Test API latency */
  async testLatency(iterations: number = 5) {
    const res = await this.client.testLatencyMultiple(iterations);
    if (!res.success) throw new Error(res.error || 'Failed to test latency');
    return res.data;
  }
}

// ==================== Strategy Namespace ====================

export interface FundingFarmOptions {
  symbol?: string;
  size: number;
  leverage?: number;
  stopLoss?: number;
  minRate?: number;
}

export interface GridOptions {
  symbol: string;
  lower: number;
  upper: number;
  levels: number;
  quantityPerLevel: number;
  leverage?: number;
}

export class AsterFundingFarm {
  private strategy: FundingFarmStrategy;

  constructor(trading: AsterTradingClient, market: AsterClient) {
    this.strategy = new FundingFarmStrategy(trading, market);
  }

  /** Scan for funding opportunities */
  async scan(minRate: number = 0.0003) {
    return this.strategy.scanOpportunities(minRate);
  }

  /** Calculate expected earnings */
  calculate(fundingRate: number, size: number, leverage: number = 5, days: number = 7) {
    return this.strategy.calculateExpectedEarnings(fundingRate, size, leverage, days);
  }

  /** Start funding farm */
  async start(options: FundingFarmOptions) {
    const result = await this.strategy.autoFarm({
      symbol: options.symbol,
      positionSizeUsd: options.size,
      leverage: options.leverage || 5,
      stopLossPercent: options.stopLoss || 3,
      minFundingRate: options.minRate || 0.0003,
    });
    if (!result.success) throw new Error(result.error || result.message);
    return result.data;
  }

  /** Stop funding farm */
  async stop(closePositions: boolean = true) {
    const result = await this.strategy.stop(closePositions);
    if (!result.success) throw new Error(result.error || result.message);
    return result.data;
  }

  /** Get status */
  status() {
    return this.strategy.getStatus();
  }
}

export class AsterGrid {
  private strategy: GridTradingStrategy;

  constructor(trading: AsterTradingClient, market: AsterClient) {
    this.strategy = new GridTradingStrategy(trading, market);
  }

  /** Get suggested grid parameters */
  async suggest(symbol: string, budget: number, leverage: number = 5) {
    return this.strategy.suggestGridParams(symbol, budget, leverage);
  }

  /** Start grid trading */
  async start(options: GridOptions) {
    const result = await this.strategy.start({
      symbol: options.symbol,
      lowerPrice: options.lower,
      upperPrice: options.upper,
      gridLevels: options.levels,
      quantityPerGrid: options.quantityPerLevel,
      leverage: options.leverage || 5,
    });
    if (!result.success) throw new Error(result.error || result.message);
    return result.data;
  }

  /** Refresh grid (check for fills) */
  async refresh() {
    const result = await this.strategy.refresh();
    if (!result.success) throw new Error(result.error || result.message);
    return result.data;
  }

  /** Stop grid */
  async stop(closePositions: boolean = true) {
    const result = await this.strategy.stop(closePositions);
    if (!result.success) throw new Error(result.error || result.message);
    return result.data;
  }

  /** Get status */
  status() {
    return this.strategy.getStatus();
  }
}

export class AsterStrategy {
  public fundingFarm: AsterFundingFarm;
  public grid: AsterGrid;

  constructor(trading: AsterTradingClient, market: AsterClient) {
    this.fundingFarm = new AsterFundingFarm(trading, market);
    this.grid = new AsterGrid(trading, market);
  }
}

// ==================== WebSocket Namespace ====================

export class AsterStream {
  private ws: AsterWebSocket;
  private trading: AsterTradingClient;

  constructor(ws: AsterWebSocket, trading: AsterTradingClient) {
    this.ws = ws;
    this.trading = trading;
  }

  /** Stream orderbook updates */
  async orderbook(symbol: string, levels: number = 10, durationMs: number = 5000) {
    const stream = `${symbol.toLowerCase()}@depth${levels}`;
    return this.ws.streamForDuration([stream], durationMs);
  }

  /** Stream mark prices */
  async markPrices(durationMs: number = 3000) {
    return this.ws.streamForDuration(['!markPrice@arr'], durationMs);
  }

  /** Start user data stream (orders, fills, positions) */
  async startUserStream() {
    const keyRes = await this.trading.createListenKey();
    if (!keyRes.success || !keyRes.data?.listenKey) {
      throw new Error('Failed to create listen key');
    }
    await this.ws.connectUserDataStream(keyRes.data.listenKey);
    return keyRes.data.listenKey;
  }

  /** Stop user data stream */
  stopUserStream() {
    this.ws.disconnectUserDataStream();
  }

  /** Check if user stream is connected */
  isUserStreamConnected() {
    return this.ws.isUserDataStreamConnected();
  }
}

// ==================== Main SDK Class ====================

export class Aster {
  public market: AsterMarket;
  public trade: AsterTrade;
  public strategy: AsterStrategy;
  public stream: AsterStream;

  private marketClient: AsterClient;
  private tradingClient: AsterTradingClient;
  private wsClient: AsterWebSocket;

  constructor(apiKey?: string, apiSecret?: string) {
    this.marketClient = new AsterClient();
    this.tradingClient = new AsterTradingClient();
    this.wsClient = new AsterWebSocket();

    if (apiKey && apiSecret) {
      this.tradingClient.setCredentials(apiKey, apiSecret);
    }

    this.market = new AsterMarket(this.marketClient);
    this.trade = new AsterTrade(this.tradingClient);
    this.strategy = new AsterStrategy(this.tradingClient, this.marketClient);
    this.stream = new AsterStream(this.wsClient, this.tradingClient);
  }

  /** Set API credentials */
  setCredentials(apiKey: string, apiSecret: string) {
    this.tradingClient.setCredentials(apiKey, apiSecret);
  }

  /** Check if credentials are set */
  get hasCredentials(): boolean {
    return this.tradingClient.hasCredentials();
  }
}

// Default export
export default Aster;
