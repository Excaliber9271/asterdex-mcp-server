/**
 * Standalone Aster DEX API Client
 * No NestJS dependencies - pure TypeScript
 * Includes rate limiting via Bottleneck
 */

import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import Bottleneck from 'bottleneck';

export interface AsterApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
}

// Rate limiter configuration - moderate limits
// Aster/Binance typically allows 1200 req/min, we'll use 600 to leave headroom
const createRateLimiter = () => new Bottleneck({
  reservoir: 600,              // 600 requests available
  reservoirRefreshAmount: 600, // Refill to 600
  reservoirRefreshInterval: 60 * 1000, // Every minute
  maxConcurrent: 20,           // Max 20 concurrent requests
  minTime: 50,                 // Min 50ms between requests (~20/sec max)
});

// Shared rate limiter instance for all Aster clients
let sharedLimiter: Bottleneck | null = null;

function getSharedLimiter(): Bottleneck {
  if (!sharedLimiter) {
    sharedLimiter = createRateLimiter();

    // Log rate limit events
    sharedLimiter.on('depleted', () => {
      console.error('[Aster Client] ⚠️ Rate limit reservoir depleted, requests will queue');
    });
  }
  return sharedLimiter;
}

export interface OrderBook {
  symbol: string;
  lastUpdateId: number;
  bids: [string, string][]; // [price, quantity]
  asks: [string, string][];
}

export interface TickerData {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  weightedAvgPrice: string;
  lastPrice: string;
  lastQty: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
  openTime: number;
  closeTime: number;
  count: number;
}

export interface FundingRate {
  symbol: string;
  fundingRate: string;
  fundingTime: number;
  markPrice?: string;
}

export interface PremiumIndex {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  estimatedSettlePrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
  interestRate: string;
  time: number;
}

export interface OpenInterest {
  symbol: string;
  openInterest: string;
  time: number;
}

export interface SymbolInfo {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  pricePrecision: number;
  quantityPrecision: number;
  contractType: string;
}

export class AsterClient {
  private readonly httpClient: AxiosInstance;
  private readonly baseURL: string;
  private readonly limiter: Bottleneck;

  constructor(baseURL: string = 'https://fapi.asterdex.com') {
    this.baseURL = baseURL;
    this.limiter = getSharedLimiter();
    this.httpClient = axios.create({
      baseURL: this.baseURL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Aster-MCP-Server/1.0',
      },
    });
  }

  /**
   * Rate-limited GET request
   */
  private async rateLimitedGet<T = any>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return this.limiter.schedule(() => this.httpClient.get(url, config).then(r => r.data));
  }

  /**
   * Health check - Test Connectivity
   */
  async ping(): Promise<AsterApiResponse<object>> {
    try {
      const data = await this.rateLimitedGet('/fapi/v1/ping');
      return { success: true, data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Get server time
   */
  async getServerTime(): Promise<AsterApiResponse<{ serverTime: number }>> {
    try {
      const data = await this.rateLimitedGet('/fapi/v1/time');
      return { success: true, data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Get all trading pairs/symbols
   */
  async getExchangeInfo(): Promise<AsterApiResponse<{ symbols: SymbolInfo[] }>> {
    try {
      const data = await this.rateLimitedGet('/fapi/v1/exchangeInfo');
      return { success: true, data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Get all trading pair symbols only
   */
  async getSymbols(): Promise<AsterApiResponse<string[]>> {
    try {
      const response = await this.getExchangeInfo();
      if (response.success && response.data?.symbols) {
        const symbols = response.data.symbols
          .filter((s: SymbolInfo) => s.status === 'TRADING')
          .map((s: SymbolInfo) => s.symbol);
        return { success: true, data: symbols, timestamp: Date.now() };
      }
      return { success: false, error: 'Failed to get symbols', timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Get orderbook depth
   */
  async getOrderBook(symbol: string, limit: number = 100): Promise<AsterApiResponse<OrderBook>> {
    try {
      const data = await this.rateLimitedGet('/fapi/v1/depth', {
        params: { symbol: symbol.toUpperCase(), limit },
      });
      return {
        success: true,
        data: { symbol, ...data },
        timestamp: Date.now(),
      };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Get 24h ticker statistics
   */
  async getTicker24h(symbol?: string): Promise<AsterApiResponse<TickerData | TickerData[]>> {
    try {
      const params = symbol ? { symbol: symbol.toUpperCase() } : {};
      const data = await this.rateLimitedGet('/fapi/v1/ticker/24hr', { params });
      return { success: true, data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Get current price
   */
  async getPrice(symbol?: string): Promise<AsterApiResponse<any>> {
    try {
      const params = symbol ? { symbol: symbol.toUpperCase() } : {};
      const data = await this.rateLimitedGet('/fapi/v1/ticker/price', { params });
      return { success: true, data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Get best bid/ask (book ticker)
   */
  async getBookTicker(symbol?: string): Promise<AsterApiResponse<any>> {
    try {
      const params = symbol ? { symbol: symbol.toUpperCase() } : {};
      const data = await this.rateLimitedGet('/fapi/v1/ticker/bookTicker', { params });
      return { success: true, data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Get mark price and funding rate (premium index)
   */
  async getPremiumIndex(symbol?: string): Promise<AsterApiResponse<PremiumIndex | PremiumIndex[]>> {
    try {
      const params = symbol ? { symbol: symbol.toUpperCase() } : {};
      const data = await this.rateLimitedGet('/fapi/v1/premiumIndex', { params });
      return { success: true, data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Get funding rate history
   */
  async getFundingRateHistory(
    symbol: string,
    limit: number = 100,
    startTime?: number,
    endTime?: number
  ): Promise<AsterApiResponse<FundingRate[]>> {
    try {
      const params: any = { symbol: symbol.toUpperCase(), limit };
      if (startTime) params.startTime = startTime;
      if (endTime) params.endTime = endTime;

      const data = await this.rateLimitedGet('/fapi/v1/fundingRate', { params });
      return { success: true, data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Get open interest for a symbol
   */
  async getOpenInterest(symbol: string): Promise<AsterApiResponse<OpenInterest>> {
    try {
      const data = await this.rateLimitedGet('/fapi/v1/openInterest', {
        params: { symbol: symbol.toUpperCase() },
      });
      return {
        success: true,
        data: { symbol, ...data, time: Date.now() },
        timestamp: Date.now(),
      };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Get klines/candlestick data
   */
  async getKlines(
    symbol: string,
    interval: string = '1h',
    limit: number = 100,
    startTime?: number,
    endTime?: number
  ): Promise<AsterApiResponse<any[]>> {
    try {
      const params: any = { symbol: symbol.toUpperCase(), interval, limit };
      if (startTime) params.startTime = startTime;
      if (endTime) params.endTime = endTime;

      const rawKlines = await this.rateLimitedGet('/fapi/v1/klines', { params });

      // Transform klines to more readable format
      const klines = rawKlines.map((k: any[]) => ({
        openTime: k[0],
        open: k[1],
        high: k[2],
        low: k[3],
        close: k[4],
        volume: k[5],
        closeTime: k[6],
        quoteVolume: k[7],
        trades: k[8],
        takerBuyVolume: k[9],
        takerBuyQuoteVolume: k[10],
      }));

      return { success: true, data: klines, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Get recent trades
   */
  async getRecentTrades(symbol: string, limit: number = 100): Promise<AsterApiResponse<any[]>> {
    try {
      const data = await this.rateLimitedGet('/fapi/v1/trades', {
        params: { symbol: symbol.toUpperCase(), limit },
      });
      return { success: true, data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Get aggregated trades
   */
  async getAggTrades(
    symbol: string,
    limit: number = 100,
    fromId?: number,
    startTime?: number,
    endTime?: number
  ): Promise<AsterApiResponse<any[]>> {
    try {
      const params: any = { symbol: symbol.toUpperCase(), limit };
      if (fromId) params.fromId = fromId;
      if (startTime) params.startTime = startTime;
      if (endTime) params.endTime = endTime;

      const data = await this.rateLimitedGet('/fapi/v1/aggTrades', { params });
      return { success: true, data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  private handleError(error: any): AsterApiResponse {
    const errorMessage =
      error.response?.data?.msg ||
      error.response?.data?.message ||
      error.message ||
      'Unknown error';

    return {
      success: false,
      error: errorMessage,
      timestamp: Date.now(),
    };
  }
}
