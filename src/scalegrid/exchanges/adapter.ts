/**
 * ScaleGrid Trading System - Exchange Adapter Interface
 *
 * Abstract interface for exchange interactions.
 * Implementations: AsterAdapter, HyperliquidAdapter
 */

import { ExchangeOrder, ExchangePosition, ExchangeBalance, GridResult } from '../types.js';

export interface OrderParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET' | 'STOP_MARKET';
  quantity: number;
  price?: number;
  stopPrice?: number;
  reduceOnly?: boolean;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
}

export interface ExchangeAdapter {
  /** Exchange name identifier */
  readonly name: string;

  /** Check if adapter is ready (credentials set, connection OK) */
  isReady(): Promise<boolean>;

  // ============================================================================
  // Market Data
  // ============================================================================

  /** Get current price for a symbol */
  getPrice(symbol: string): Promise<GridResult<number>>;

  /** Get symbol info (min qty, price precision, etc.) */
  getSymbolInfo(symbol: string): Promise<GridResult<SymbolInfo>>;

  // ============================================================================
  // Account Data
  // ============================================================================

  /** Get account balance */
  getBalance(): Promise<GridResult<ExchangeBalance>>;

  /** Get position for a symbol */
  getPosition(symbol: string): Promise<GridResult<ExchangePosition | null>>;

  /** Get all open positions */
  getPositions(): Promise<GridResult<ExchangePosition[]>>;

  // ============================================================================
  // Order Management
  // ============================================================================

  /** Place a new order */
  placeOrder(params: OrderParams): Promise<GridResult<ExchangeOrder>>;

  /** Cancel an order */
  cancelOrder(symbol: string, orderId: string): Promise<GridResult<boolean>>;

  /** Cancel all orders for a symbol */
  cancelAllOrders(symbol: string): Promise<GridResult<number>>;

  /** Get open orders for a symbol */
  getOpenOrders(symbol: string): Promise<GridResult<ExchangeOrder[]>>;

  /** Get order by ID */
  getOrder(symbol: string, orderId: string): Promise<GridResult<ExchangeOrder | null>>;

  // ============================================================================
  // Position Management
  // ============================================================================

  /** Set leverage for a symbol */
  setLeverage(symbol: string, leverage: number): Promise<GridResult<boolean>>;

  /** Close position (market order) */
  closePosition(symbol: string): Promise<GridResult<ExchangeOrder>>;
}

export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  pricePrecision: number;
  quantityPrecision: number;
  minQuantity: number;
  minNotional: number;
  maxLeverage: number;
}

/**
 * Base class with common functionality
 */
export abstract class BaseExchangeAdapter implements ExchangeAdapter {
  abstract readonly name: string;

  abstract isReady(): Promise<boolean>;
  abstract getPrice(symbol: string): Promise<GridResult<number>>;
  abstract getSymbolInfo(symbol: string): Promise<GridResult<SymbolInfo>>;
  abstract getBalance(): Promise<GridResult<ExchangeBalance>>;
  abstract getPosition(symbol: string): Promise<GridResult<ExchangePosition | null>>;
  abstract getPositions(): Promise<GridResult<ExchangePosition[]>>;
  abstract placeOrder(params: OrderParams): Promise<GridResult<ExchangeOrder>>;
  abstract cancelOrder(symbol: string, orderId: string): Promise<GridResult<boolean>>;
  abstract cancelAllOrders(symbol: string): Promise<GridResult<number>>;
  abstract getOpenOrders(symbol: string): Promise<GridResult<ExchangeOrder[]>>;
  abstract getOrder(symbol: string, orderId: string): Promise<GridResult<ExchangeOrder | null>>;
  abstract setLeverage(symbol: string, leverage: number): Promise<GridResult<boolean>>;
  abstract closePosition(symbol: string): Promise<GridResult<ExchangeOrder>>;

  /**
   * Helper to create success result
   */
  protected success<T>(data: T): GridResult<T> {
    return { success: true, data, timestamp: Date.now() };
  }

  /**
   * Helper to create error result
   */
  protected error<T>(message: string): GridResult<T> {
    return { success: false, error: message, timestamp: Date.now() };
  }

  /**
   * Normalize symbol to exchange format
   */
  protected normalizeSymbol(symbol: string): string {
    // Default: ensure USDT suffix
    const upper = symbol.toUpperCase();
    return upper.endsWith('USDT') ? upper : `${upper}USDT`;
  }
}
