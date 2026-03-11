/**
 * Aster DEX Spot API Client
 * Base URL: https://sapi.asterdex.com
 *
 * Supports both public market data and authenticated trading
 */

import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';

export interface SpotResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface SpotBalance {
  asset: string;
  free: string;
  locked: string;
}

export interface SpotOrder {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  price: string;
  origQty: string;
  executedQty: string;
  status: string;
  type: string;
  side: string;
  time: number;
}

export class AsterSpotClient {
  private httpClient: AxiosInstance;
  private apiKey: string;
  private apiSecret: string;

  constructor(baseURL: string = 'https://sapi.asterdex.com') {
    this.httpClient = axios.create({
      baseURL,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
    this.apiKey = process.env.ASTER_API_KEY || '';
    this.apiSecret = process.env.ASTER_API_SECRET || '';
  }

  private sign(params: Record<string, any>): string {
    const queryString = Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');
  }

  private async authGet<T>(endpoint: string, params: Record<string, any> = {}): Promise<SpotResponse<T>> {
    try {
      const timestamp = Date.now();
      const allParams = { ...params, timestamp, recvWindow: 5000 };
      const signature = this.sign(allParams);

      const response = await this.httpClient.get(endpoint, {
        params: { ...allParams, signature },
        headers: { 'X-MBX-APIKEY': this.apiKey },
      });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.response?.data?.msg || error.message };
    }
  }

  private async authPost<T>(endpoint: string, params: Record<string, any> = {}): Promise<SpotResponse<T>> {
    try {
      const timestamp = Date.now();
      const allParams = { ...params, timestamp, recvWindow: 5000 };
      const signature = this.sign(allParams);

      const queryString = Object.entries({ ...allParams, signature })
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');

      const response = await this.httpClient.post(`${endpoint}?${queryString}`, null, {
        headers: { 'X-MBX-APIKEY': this.apiKey },
      });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.response?.data?.msg || error.message };
    }
  }

  private async authDelete<T>(endpoint: string, params: Record<string, any> = {}): Promise<SpotResponse<T>> {
    try {
      const timestamp = Date.now();
      const allParams = { ...params, timestamp, recvWindow: 5000 };
      const signature = this.sign(allParams);

      const response = await this.httpClient.delete(endpoint, {
        params: { ...allParams, signature },
        headers: { 'X-MBX-APIKEY': this.apiKey },
      });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.response?.data?.msg || error.message };
    }
  }

  // ==================== PUBLIC MARKET DATA ====================

  /**
   * Get exchange info (all spot pairs and trading rules)
   */
  async getExchangeInfo(): Promise<SpotResponse<any>> {
    try {
      const response = await this.httpClient.get('/api/v1/exchangeInfo');
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get all spot trading pairs
   */
  async getPairs(): Promise<SpotResponse<string[]>> {
    const info = await this.getExchangeInfo();
    if (!info.success) return { success: false, error: info.error };

    const symbols = info.data.symbols?.map((s: any) => s.symbol) || [];
    return { success: true, data: symbols };
  }

  /**
   * Get current price for a symbol or all symbols
   */
  async getPrice(symbol?: string): Promise<SpotResponse<any>> {
    try {
      const params: any = {};
      if (symbol) params.symbol = symbol.toUpperCase();

      const response = await this.httpClient.get('/api/v1/ticker/price', { params });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get 24h ticker statistics
   */
  async getTicker24h(symbol?: string): Promise<SpotResponse<any>> {
    try {
      const params: any = {};
      if (symbol) params.symbol = symbol.toUpperCase();

      const response = await this.httpClient.get('/api/v1/ticker/24hr', { params });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get best bid/ask (book ticker)
   */
  async getBookTicker(symbol?: string): Promise<SpotResponse<any>> {
    try {
      const params: any = {};
      if (symbol) params.symbol = symbol.toUpperCase();

      const response = await this.httpClient.get('/api/v1/ticker/bookTicker', { params });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get order book depth
   */
  async getOrderbook(symbol: string, limit: number = 100): Promise<SpotResponse<any>> {
    try {
      const response = await this.httpClient.get('/api/v1/depth', {
        params: { symbol: symbol.toUpperCase(), limit },
      });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get klines (candlestick data)
   */
  async getKlines(
    symbol: string,
    interval: string = '1h',
    limit: number = 100,
    startTime?: number,
    endTime?: number
  ): Promise<SpotResponse<any>> {
    try {
      const params: any = {
        symbol: symbol.toUpperCase(),
        interval,
        limit,
      };
      if (startTime) params.startTime = startTime;
      if (endTime) params.endTime = endTime;

      const response = await this.httpClient.get('/api/v1/klines', { params });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get recent trades
   */
  async getTrades(symbol: string, limit: number = 100): Promise<SpotResponse<any>> {
    try {
      const response = await this.httpClient.get('/api/v1/trades', {
        params: { symbol: symbol.toUpperCase(), limit },
      });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get aggregated trades
   */
  async getAggTrades(symbol: string, limit: number = 100): Promise<SpotResponse<any>> {
    try {
      const response = await this.httpClient.get('/api/v1/aggTrades', {
        params: { symbol: symbol.toUpperCase(), limit },
      });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  // ==================== ACCOUNT DATA ====================

  /**
   * Get account information including all balances
   */
  async getAccount(): Promise<SpotResponse<any>> {
    return this.authGet('/api/v1/account');
  }

  /**
   * Get spot balances (non-zero only)
   */
  async getBalances(): Promise<SpotResponse<SpotBalance[]>> {
    const account = await this.getAccount();
    if (!account.success) return { success: false, error: account.error };

    const balances = account.data.balances?.filter(
      (b: SpotBalance) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0
    ) || [];

    return { success: true, data: balances };
  }

  /**
   * Get all open orders
   */
  async getOpenOrders(symbol?: string): Promise<SpotResponse<SpotOrder[]>> {
    const params: any = {};
    if (symbol) params.symbol = symbol.toUpperCase();
    return this.authGet('/api/v1/openOrders', params);
  }

  /**
   * Get all orders (including closed)
   */
  async getAllOrders(symbol: string, limit: number = 100): Promise<SpotResponse<SpotOrder[]>> {
    return this.authGet('/api/v1/allOrders', {
      symbol: symbol.toUpperCase(),
      limit,
    });
  }

  /**
   * Get order status
   */
  async getOrder(symbol: string, orderId: number): Promise<SpotResponse<SpotOrder>> {
    return this.authGet('/api/v1/order', {
      symbol: symbol.toUpperCase(),
      orderId,
    });
  }

  /**
   * Get user trade history
   */
  async getUserTrades(symbol: string, limit: number = 100): Promise<SpotResponse<any>> {
    return this.authGet('/api/v1/userTrades', {
      symbol: symbol.toUpperCase(),
      limit,
    });
  }

  // ==================== TRADING ====================

  /**
   * Place a market buy order (specify quote amount, e.g., buy $100 worth)
   */
  async marketBuy(symbol: string, quoteAmount: number): Promise<SpotResponse<any>> {
    return this.authPost('/api/v1/order', {
      symbol: symbol.toUpperCase(),
      side: 'BUY',
      type: 'MARKET',
      quoteOrderQty: quoteAmount.toString(),
    });
  }

  /**
   * Place a market sell order (specify base quantity)
   */
  async marketSell(symbol: string, quantity: number): Promise<SpotResponse<any>> {
    return this.authPost('/api/v1/order', {
      symbol: symbol.toUpperCase(),
      side: 'SELL',
      type: 'MARKET',
      quantity: quantity.toString(),
    });
  }

  /**
   * Place a limit order
   */
  async limitOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    price: number,
    quantity: number,
    timeInForce: 'GTC' | 'IOC' | 'FOK' | 'GTX' = 'GTC'
  ): Promise<SpotResponse<any>> {
    return this.authPost('/api/v1/order', {
      symbol: symbol.toUpperCase(),
      side,
      type: 'LIMIT',
      timeInForce,
      price: price.toString(),
      quantity: quantity.toString(),
    });
  }

  /**
   * Place any order type
   */
  async placeOrder(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'LIMIT' | 'MARKET' | 'STOP' | 'TAKE_PROFIT' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    quantity?: number;
    quoteOrderQty?: number;
    price?: number;
    stopPrice?: number;
    timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'GTX';
  }): Promise<SpotResponse<any>> {
    const orderParams: any = {
      symbol: params.symbol.toUpperCase(),
      side: params.side,
      type: params.type,
    };

    if (params.quantity) orderParams.quantity = params.quantity.toString();
    if (params.quoteOrderQty) orderParams.quoteOrderQty = params.quoteOrderQty.toString();
    if (params.price) orderParams.price = params.price.toString();
    if (params.stopPrice) orderParams.stopPrice = params.stopPrice.toString();
    if (params.timeInForce) orderParams.timeInForce = params.timeInForce;

    return this.authPost('/api/v1/order', orderParams);
  }

  /**
   * Cancel an order
   */
  async cancelOrder(symbol: string, orderId: number): Promise<SpotResponse<any>> {
    return this.authDelete('/api/v1/order', {
      symbol: symbol.toUpperCase(),
      orderId,
    });
  }

  /**
   * Cancel all open orders for a symbol
   */
  async cancelAllOrders(symbol: string): Promise<SpotResponse<any>> {
    return this.authDelete('/api/v1/allOpenOrders', {
      symbol: symbol.toUpperCase(),
    });
  }

  // ==================== ASSET TRANSFER ====================

  /**
   * Transfer between spot and perpetuals wallet
   * @param asset Asset to transfer (e.g., 'USDT')
   * @param amount Amount to transfer
   * @param type 1 = Spot to Perp, 2 = Perp to Spot
   */
  async transfer(asset: string, amount: number, type: 1 | 2): Promise<SpotResponse<any>> {
    return this.authPost('/api/v1/asset/wallet/transfer', {
      asset: asset.toUpperCase(),
      amount: amount.toString(),
      type,
    });
  }

  /**
   * Transfer from spot to perpetuals
   */
  async transferToPerp(asset: string, amount: number): Promise<SpotResponse<any>> {
    return this.transfer(asset, amount, 1);
  }

  /**
   * Transfer from perpetuals to spot
   */
  async transferToSpot(asset: string, amount: number): Promise<SpotResponse<any>> {
    return this.transfer(asset, amount, 2);
  }
}

export default AsterSpotClient;
