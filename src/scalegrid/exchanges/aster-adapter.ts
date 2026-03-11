/**
 * ScaleGrid Trading System - Aster Exchange Adapter
 *
 * Wraps the existing AsterTradingClient to implement ExchangeAdapter interface.
 */

import { BaseExchangeAdapter, OrderParams, SymbolInfo } from './adapter.js';
import { ExchangeOrder, ExchangePosition, ExchangeBalance, GridResult } from '../types.js';
import { AsterTradingClient } from '../../aster-trading-client.js';
import { AsterClient } from '../../aster-client.js';

export class AsterAdapter extends BaseExchangeAdapter {
  readonly name = 'aster';

  private tradingClient: AsterTradingClient;
  private publicClient: AsterClient;
  private symbolInfoCache: Map<string, SymbolInfo> = new Map();

  constructor() {
    super();
    this.tradingClient = new AsterTradingClient();
    this.publicClient = new AsterClient();
  }

  /**
   * Set API credentials
   */
  setCredentials(apiKey: string, apiSecret: string): void {
    this.tradingClient.setCredentials(apiKey, apiSecret);
  }

  /**
   * Check if adapter is ready
   */
  async isReady(): Promise<boolean> {
    if (!this.tradingClient.hasCredentials()) {
      return false;
    }

    // Test connection
    const balance = await this.tradingClient.getBalance();
    return balance.success;
  }

  // ============================================================================
  // Market Data
  // ============================================================================

  async getPrice(symbol: string): Promise<GridResult<number>> {
    const normalized = this.normalizeSymbol(symbol);
    const result = await this.tradingClient.getCurrentPrice(normalized);

    if (result.success && result.data !== undefined) {
      return this.success(result.data);
    }
    return this.error(result.error || 'Failed to get price');
  }

  async getSymbolInfo(symbol: string): Promise<GridResult<SymbolInfo>> {
    const normalized = this.normalizeSymbol(symbol);

    // Check cache first
    if (this.symbolInfoCache.has(normalized)) {
      return this.success(this.symbolInfoCache.get(normalized)!);
    }

    // Fetch from exchange info
    const result = await this.publicClient.getExchangeInfo();

    if (!result.success || !result.data?.symbols) {
      return this.error(result.error || 'Failed to get exchange info');
    }

    const symbolData = result.data.symbols.find(
      (s: any) => s.symbol === normalized
    ) as any;

    if (!symbolData) {
      return this.error(`Symbol ${normalized} not found`);
    }

    // Parse filters
    let minQty = 0.001;
    let minNotional = 5;
    let pricePrecision = 2;
    let qtyPrecision = 3;

    for (const filter of symbolData.filters || []) {
      if (filter.filterType === 'LOT_SIZE') {
        minQty = parseFloat(filter.minQty || '0.001');
        qtyPrecision = countDecimals(filter.stepSize || '0.001');
      }
      if (filter.filterType === 'MIN_NOTIONAL') {
        minNotional = parseFloat(filter.notional || '5');
      }
      if (filter.filterType === 'PRICE_FILTER') {
        pricePrecision = countDecimals(filter.tickSize || '0.01');
      }
    }

    const info: SymbolInfo = {
      symbol: normalized,
      baseAsset: symbolData.baseAsset || normalized.replace('USDT', ''),
      quoteAsset: symbolData.quoteAsset || 'USDT',
      pricePrecision,
      quantityPrecision: qtyPrecision,
      minQuantity: minQty,
      minNotional,
      maxLeverage: 125, // Aster default
    };

    // Cache it
    this.symbolInfoCache.set(normalized, info);

    return this.success(info);
  }

  // ============================================================================
  // Account Data
  // ============================================================================

  async getBalance(): Promise<GridResult<ExchangeBalance>> {
    const result = await this.tradingClient.getBalance();

    if (!result.success || !result.data) {
      return this.error(result.error || 'Failed to get balance');
    }

    // Find USDT balance
    const usdtBalance = result.data.find((b: any) => b.asset === 'USDT');

    if (!usdtBalance) {
      return this.error('USDT balance not found');
    }

    return this.success({
      asset: 'USDT',
      available: parseFloat(usdtBalance.availableBalance || '0'),
      total: parseFloat(usdtBalance.balance || '0'),
      unrealizedPnl: parseFloat(usdtBalance.crossUnPnl || '0'),
    });
  }

  async getPosition(symbol: string): Promise<GridResult<ExchangePosition | null>> {
    const normalized = this.normalizeSymbol(symbol);
    const result = await this.tradingClient.getPositions(normalized);

    if (!result.success || !result.data) {
      return this.error(result.error || 'Failed to get position');
    }

    const position = result.data.find((p: any) => p.symbol === normalized);

    if (!position || parseFloat(position.positionAmt) === 0) {
      return this.success(null);
    }

    const positionAmt = parseFloat(position.positionAmt);

    return this.success({
      symbol: normalized,
      side: positionAmt > 0 ? 'LONG' : 'SHORT',
      size: Math.abs(positionAmt),
      entryPrice: parseFloat(position.entryPrice),
      markPrice: parseFloat(position.markPrice),
      unrealizedPnl: parseFloat(position.unRealizedProfit),
      leverage: parseInt(position.leverage),
      liquidationPrice: parseFloat(position.liquidationPrice),
    });
  }

  async getPositions(): Promise<GridResult<ExchangePosition[]>> {
    const result = await this.tradingClient.getPositions();

    if (!result.success || !result.data) {
      return this.error(result.error || 'Failed to get positions');
    }

    const positions: ExchangePosition[] = result.data
      .filter((p: any) => parseFloat(p.positionAmt) !== 0)
      .map((p: any) => {
        const positionAmt = parseFloat(p.positionAmt);
        return {
          symbol: p.symbol,
          side: positionAmt > 0 ? 'LONG' : 'SHORT' as const,
          size: Math.abs(positionAmt),
          entryPrice: parseFloat(p.entryPrice),
          markPrice: parseFloat(p.markPrice),
          unrealizedPnl: parseFloat(p.unRealizedProfit),
          leverage: parseInt(p.leverage),
          liquidationPrice: parseFloat(p.liquidationPrice),
        };
      });

    return this.success(positions);
  }

  // ============================================================================
  // Order Management
  // ============================================================================

  async placeOrder(params: OrderParams): Promise<GridResult<ExchangeOrder>> {
    const normalized = this.normalizeSymbol(params.symbol);

    // Get symbol info for precision
    const infoResult = await this.getSymbolInfo(normalized);
    if (!infoResult.success || !infoResult.data) {
      return this.error('Failed to get symbol info');
    }

    const info = infoResult.data;

    // Format quantity and price with proper precision
    const quantity = params.quantity.toFixed(info.quantityPrecision);
    const price = params.price?.toFixed(info.pricePrecision);

    const orderParams: any = {
      symbol: normalized,
      side: params.side,
      type: params.type,
      quantity,
    };

    if (price && params.type === 'LIMIT') {
      orderParams.price = price;
      orderParams.timeInForce = params.timeInForce || 'GTC';
    }

    if (params.stopPrice) {
      orderParams.stopPrice = params.stopPrice.toFixed(info.pricePrecision);
    }

    if (params.reduceOnly) {
      orderParams.reduceOnly = true;
    }

    const result = await this.tradingClient.placeOrder(orderParams);

    if (!result.success || !result.data) {
      return this.error(result.error || 'Failed to place order');
    }

    return this.success(this.mapOrder(result.data));
  }

  async cancelOrder(symbol: string, orderId: string): Promise<GridResult<boolean>> {
    const normalized = this.normalizeSymbol(symbol);
    const result = await this.tradingClient.cancelOrder(normalized, orderId);

    if (!result.success) {
      return this.error(result.error || 'Failed to cancel order');
    }

    return this.success(true);
  }

  async cancelAllOrders(symbol: string): Promise<GridResult<number>> {
    const normalized = this.normalizeSymbol(symbol);

    // Get open orders first to count them
    const ordersResult = await this.getOpenOrders(normalized);
    const orderCount = ordersResult.success ? (ordersResult.data?.length || 0) : 0;

    const result = await this.tradingClient.cancelAllOrders(normalized);

    if (!result.success) {
      return this.error(result.error || 'Failed to cancel orders');
    }

    return this.success(orderCount);
  }

  async getOpenOrders(symbol: string): Promise<GridResult<ExchangeOrder[]>> {
    const normalized = this.normalizeSymbol(symbol);
    const result = await this.tradingClient.getOpenOrders(normalized);

    if (!result.success || !result.data) {
      return this.error(result.error || 'Failed to get open orders');
    }

    const orders = result.data.map((o: any) => this.mapOrder(o));
    return this.success(orders);
  }

  async getOrder(symbol: string, orderId: string): Promise<GridResult<ExchangeOrder | null>> {
    const normalized = this.normalizeSymbol(symbol);
    const result = await this.tradingClient.getOrder(normalized, orderId);

    if (!result.success) {
      return this.error(result.error || 'Failed to get order');
    }

    if (!result.data) {
      return this.success(null);
    }

    return this.success(this.mapOrder(result.data));
  }

  // ============================================================================
  // Position Management
  // ============================================================================

  async setLeverage(symbol: string, leverage: number): Promise<GridResult<boolean>> {
    const normalized = this.normalizeSymbol(symbol);
    const result = await this.tradingClient.setLeverage(normalized, leverage);

    if (!result.success) {
      return this.error(result.error || 'Failed to set leverage');
    }

    return this.success(true);
  }

  async closePosition(symbol: string): Promise<GridResult<ExchangeOrder>> {
    const normalized = this.normalizeSymbol(symbol);
    const result = await this.tradingClient.closePosition(normalized);

    if (!result.success || !result.data) {
      return this.error(result.error || 'Failed to close position');
    }

    return this.success(this.mapOrder(result.data));
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private mapOrder(raw: any): ExchangeOrder {
    return {
      orderId: raw.orderId?.toString() || '',
      symbol: raw.symbol || '',
      side: raw.side || 'BUY',
      type: raw.type || 'LIMIT',
      price: parseFloat(raw.price || '0'),
      quantity: parseFloat(raw.origQty || raw.quantity || '0'),
      status: raw.status || 'NEW',
      filledQty: parseFloat(raw.executedQty || '0'),
      avgFillPrice: parseFloat(raw.avgPrice || raw.price || '0'),
      createdAt: raw.time || raw.updateTime || Date.now(),
      updatedAt: raw.updateTime || Date.now(),
    };
  }
}

/**
 * Count decimal places in a number string
 */
function countDecimals(value: string): number {
  const num = parseFloat(value);
  if (Math.floor(num) === num) return 0;
  const str = value.includes('.') ? value : num.toString();
  return str.split('.')[1]?.length || 0;
}
