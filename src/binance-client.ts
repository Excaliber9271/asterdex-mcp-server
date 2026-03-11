/**
 * Binance Futures API Client
 * Mirror of AsterClient - same API format, different endpoint
 * Used for cross-exchange validation and leading indicators
 */

import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import Bottleneck from 'bottleneck';

export interface BinanceApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
}

// Separate rate limiter for Binance (don't share with Aster)
const createBinanceLimiter = () => new Bottleneck({
  reservoir: 1200,              // Binance allows 2400/min, use half
  reservoirRefreshAmount: 1200,
  reservoirRefreshInterval: 60 * 1000,
  maxConcurrent: 30,
  minTime: 25,                  // ~40/sec max
});

let sharedBinanceLimiter: Bottleneck | null = null;

function getSharedBinanceLimiter(): Bottleneck {
  if (!sharedBinanceLimiter) {
    sharedBinanceLimiter = createBinanceLimiter();
    sharedBinanceLimiter.on('depleted', () => {
      console.error('[Binance Client] Rate limit reservoir depleted');
    });
  }
  return sharedBinanceLimiter;
}

export interface OrderBook {
  symbol: string;
  lastUpdateId: number;
  bids: [string, string][];
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

export class BinanceClient {
  private readonly httpClient: AxiosInstance;
  private readonly baseURL: string;
  private readonly limiter: Bottleneck;

  constructor(baseURL: string = 'https://fapi.binance.com') {
    this.baseURL = baseURL;
    this.limiter = getSharedBinanceLimiter();
    this.httpClient = axios.create({
      baseURL: this.baseURL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Aster-MCP-Server/1.0',
      },
    });
  }

  private async rateLimitedGet<T = any>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return this.limiter.schedule(() => this.httpClient.get(url, config).then(r => r.data));
  }

  async ping(): Promise<BinanceApiResponse<object>> {
    try {
      const data = await this.rateLimitedGet('/fapi/v1/ping');
      return { success: true, data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  async getServerTime(): Promise<BinanceApiResponse<{ serverTime: number }>> {
    try {
      const data = await this.rateLimitedGet('/fapi/v1/time');
      return { success: true, data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  async getExchangeInfo(): Promise<BinanceApiResponse<{ symbols: SymbolInfo[] }>> {
    try {
      const data = await this.rateLimitedGet('/fapi/v1/exchangeInfo');
      return { success: true, data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  async getSymbols(): Promise<BinanceApiResponse<string[]>> {
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

  async getOrderBook(symbol: string, limit: number = 100): Promise<BinanceApiResponse<OrderBook>> {
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

  async getTicker24h(symbol?: string): Promise<BinanceApiResponse<TickerData | TickerData[]>> {
    try {
      const params = symbol ? { symbol: symbol.toUpperCase() } : {};
      const data = await this.rateLimitedGet('/fapi/v1/ticker/24hr', { params });
      return { success: true, data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  async getPrice(symbol?: string): Promise<BinanceApiResponse<any>> {
    try {
      const params = symbol ? { symbol: symbol.toUpperCase() } : {};
      const data = await this.rateLimitedGet('/fapi/v1/ticker/price', { params });
      return { success: true, data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  async getBookTicker(symbol?: string): Promise<BinanceApiResponse<any>> {
    try {
      const params = symbol ? { symbol: symbol.toUpperCase() } : {};
      const data = await this.rateLimitedGet('/fapi/v1/ticker/bookTicker', { params });
      return { success: true, data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  async getPremiumIndex(symbol?: string): Promise<BinanceApiResponse<PremiumIndex | PremiumIndex[]>> {
    try {
      const params = symbol ? { symbol: symbol.toUpperCase() } : {};
      const data = await this.rateLimitedGet('/fapi/v1/premiumIndex', { params });
      return { success: true, data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  async getFundingRateHistory(
    symbol: string,
    limit: number = 100,
    startTime?: number,
    endTime?: number
  ): Promise<BinanceApiResponse<FundingRate[]>> {
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

  async getOpenInterest(symbol: string): Promise<BinanceApiResponse<OpenInterest>> {
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

  async getKlines(
    symbol: string,
    interval: string = '1h',
    limit: number = 100,
    startTime?: number,
    endTime?: number
  ): Promise<BinanceApiResponse<any[]>> {
    try {
      const params: any = { symbol: symbol.toUpperCase(), interval, limit };
      if (startTime) params.startTime = startTime;
      if (endTime) params.endTime = endTime;

      const rawKlines = await this.rateLimitedGet('/fapi/v1/klines', { params });

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

  async getRecentTrades(symbol: string, limit: number = 100): Promise<BinanceApiResponse<any[]>> {
    try {
      const data = await this.rateLimitedGet('/fapi/v1/trades', {
        params: { symbol: symbol.toUpperCase(), limit },
      });
      return { success: true, data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  async getAggTrades(
    symbol: string,
    limit: number = 100,
    fromId?: number,
    startTime?: number,
    endTime?: number
  ): Promise<BinanceApiResponse<any[]>> {
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

  /**
   * Get long/short ratio for top traders
   * Binance-specific endpoint not available on Aster
   */
  async getTopLongShortRatio(
    symbol: string,
    period: '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '12h' | '1d' = '1h',
    limit: number = 30
  ): Promise<BinanceApiResponse<any[]>> {
    try {
      const data = await this.rateLimitedGet('/futures/data/topLongShortAccountRatio', {
        params: { symbol: symbol.toUpperCase(), period, limit },
      });
      return { success: true, data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Get global long/short ratio
   * Binance-specific endpoint
   */
  async getGlobalLongShortRatio(
    symbol: string,
    period: '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '12h' | '1d' = '1h',
    limit: number = 30
  ): Promise<BinanceApiResponse<any[]>> {
    try {
      const data = await this.rateLimitedGet('/futures/data/globalLongShortAccountRatio', {
        params: { symbol: symbol.toUpperCase(), period, limit },
      });
      return { success: true, data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Get open interest history
   * Binance-specific endpoint
   */
  async getOpenInterestHist(
    symbol: string,
    period: '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '12h' | '1d' = '1h',
    limit: number = 30
  ): Promise<BinanceApiResponse<any[]>> {
    try {
      const data = await this.rateLimitedGet('/futures/data/openInterestHist', {
        params: { symbol: symbol.toUpperCase(), period, limit },
      });
      return { success: true, data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Get taker buy/sell volume
   * Binance-specific endpoint - crucial for flow analysis
   */
  async getTakerBuySellVolume(
    symbol: string,
    period: '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '12h' | '1d' = '1h',
    limit: number = 30
  ): Promise<BinanceApiResponse<any[]>> {
    try {
      const data = await this.rateLimitedGet('/futures/data/takerlongshortRatio', {
        params: { symbol: symbol.toUpperCase(), period, limit },
      });
      return { success: true, data, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  private handleError(error: any): BinanceApiResponse {
    const status = error.response?.status;
    const rawMsg =
      error.response?.data?.msg ||
      error.response?.data?.message ||
      error.message ||
      'Unknown error';

    let errorMessage: string;

    if (status === 451) {
      errorMessage = `Binance geo-restricted (HTTP 451). VPN may be off or routing through a blocked region. Raw: ${rawMsg}`;
    } else if (status === 403) {
      errorMessage = `Binance access forbidden (HTTP 403). IP may be banned or WAF blocked. Raw: ${rawMsg}`;
    } else if (status === 429) {
      errorMessage = `Binance rate limited (HTTP 429). Too many requests. Raw: ${rawMsg}`;
    } else if (status === 418) {
      errorMessage = `Binance IP auto-banned (HTTP 418). Exceeded rate limits repeatedly. Raw: ${rawMsg}`;
    } else if (status) {
      errorMessage = `Binance API error (HTTP ${status}): ${rawMsg}`;
    } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      errorMessage = `Binance unreachable (${error.code}). Network/DNS issue.`;
    } else if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      errorMessage = `Binance request timed out (${error.code}). Slow connection or endpoint overloaded.`;
    } else {
      errorMessage = rawMsg;
    }

    return {
      success: false,
      error: errorMessage,
      timestamp: Date.now(),
    };
  }
}

// Singleton instance
let binanceClientInstance: BinanceClient | null = null;

export function getBinanceClient(): BinanceClient {
  if (!binanceClientInstance) {
    binanceClientInstance = new BinanceClient();
  }
  return binanceClientInstance;
}
