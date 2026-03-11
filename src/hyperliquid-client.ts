/**
 * Hyperliquid API Client
 * Public API - No authentication required for market data
 * Matches Aster client interface for pump scanner compatibility
 */

import axios, { AxiosInstance } from 'axios';

export interface HyperliquidApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
}

export interface HLAssetContext {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string;
  oraclePx: string;
  markPx: string;
  midPx: string;
  impactPxs: string[];
}

export interface HLAssetMeta {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
}

export interface HLCandle {
  t: number;      // timestamp
  T: number;      // close timestamp
  s: string;      // symbol
  i: string;      // interval
  o: string;      // open
  c: string;      // close
  h: string;      // high
  l: string;      // low
  v: string;      // volume
  n: number;      // number of trades
}

export interface HLTickerData {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  volume: string;
  quoteVolume: string;
  fundingRate: string;
  openInterest: string;
  markPrice: string;
}

export class HyperliquidClient {
  private readonly httpClient: AxiosInstance;
  private readonly baseURL: string;

  constructor(baseURL: string = 'https://api.hyperliquid.xyz') {
    this.baseURL = baseURL;
    this.httpClient = axios.create({
      baseURL: this.baseURL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Get metadata and asset contexts for all perpetuals
   * Returns both universe (list of assets) and real-time market data
   */
  async getMetaAndAssetCtxs(): Promise<HyperliquidApiResponse<{ meta: HLAssetMeta[]; assetCtxs: HLAssetContext[] }>> {
    try {
      const response = await this.httpClient.post('/info', {
        type: 'metaAndAssetCtxs',
      });

      // Response is [meta, assetCtxs] array
      const [metaData, assetCtxs] = response.data;

      return {
        success: true,
        data: {
          meta: metaData.universe,
          assetCtxs: assetCtxs,
        },
        timestamp: Date.now(),
      };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Get all mid prices
   */
  async getAllMids(): Promise<HyperliquidApiResponse<Record<string, string>>> {
    try {
      const response = await this.httpClient.post('/info', {
        type: 'allMids',
      });

      return {
        success: true,
        data: response.data,
        timestamp: Date.now(),
      };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Get 24h ticker-like data for all assets
   * Combines meta and asset contexts to match Aster's getTicker24h format
   */
  async getTicker24h(symbol?: string): Promise<HyperliquidApiResponse<HLTickerData | HLTickerData[]>> {
    try {
      const metaRes = await this.getMetaAndAssetCtxs();
      if (!metaRes.success || !metaRes.data) {
        return { success: false, error: 'Failed to fetch metadata', timestamp: Date.now() };
      }

      const { meta, assetCtxs } = metaRes.data;

      const tickers: HLTickerData[] = meta.map((asset, index) => {
        const ctx = assetCtxs[index];
        const prevDayPx = parseFloat(ctx.prevDayPx) || 0;
        const markPx = parseFloat(ctx.markPx) || 0;
        const priceChange = prevDayPx > 0 ? ((markPx - prevDayPx) / prevDayPx) * 100 : 0;

        return {
          symbol: asset.name,
          lastPrice: ctx.markPx,
          priceChangePercent: priceChange.toFixed(2),
          volume: ctx.dayNtlVlm,  // Daily notional volume
          quoteVolume: ctx.dayNtlVlm,
          fundingRate: ctx.funding,
          openInterest: ctx.openInterest,
          markPrice: ctx.markPx,
        };
      });

      if (symbol) {
        const ticker = tickers.find(t => t.symbol.toUpperCase() === symbol.toUpperCase());
        if (!ticker) {
          return { success: false, error: `Symbol ${symbol} not found`, timestamp: Date.now() };
        }
        return { success: true, data: ticker, timestamp: Date.now() };
      }

      return { success: true, data: tickers, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Get all trading pair symbols
   */
  async getSymbols(): Promise<HyperliquidApiResponse<string[]>> {
    try {
      const metaRes = await this.getMetaAndAssetCtxs();
      if (!metaRes.success || !metaRes.data) {
        return { success: false, error: 'Failed to fetch metadata', timestamp: Date.now() };
      }

      const symbols = metaRes.data.meta.map(asset => asset.name);
      return { success: true, data: symbols, timestamp: Date.now() };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Get klines/candlestick data
   * Matches Aster client interface
   */
  async getKlines(
    symbol: string,
    interval: string = '1h',
    limit: number = 100,
    startTime?: number,
    endTime?: number
  ): Promise<HyperliquidApiResponse<any[]>> {
    try {
      // Hyperliquid uses coin name without USDT suffix
      const coin = symbol.toUpperCase().replace('USDT', '').replace('USD', '');

      // Calculate time range if not provided
      const now = Date.now();
      const intervalMs = this.intervalToMs(interval);
      const end = endTime || now;
      const start = startTime || (end - intervalMs * limit);

      const response = await this.httpClient.post('/info', {
        type: 'candleSnapshot',
        req: {
          coin: coin,
          interval: interval,
          startTime: start,
          endTime: end,
        },
      });

      // Transform to match Aster kline format
      const klines = response.data.map((k: HLCandle) => ({
        openTime: k.t,
        open: k.o,
        high: k.h,
        low: k.l,
        close: k.c,
        volume: k.v,
        closeTime: k.T,
        quoteVolume: k.v, // HL doesn't separate base/quote volume
        trades: k.n,
      }));

      // Limit results
      return {
        success: true,
        data: klines.slice(-limit),
        timestamp: Date.now(),
      };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Get L2 order book
   */
  async getOrderBook(symbol: string, limit: number = 20): Promise<HyperliquidApiResponse<any>> {
    try {
      const coin = symbol.toUpperCase().replace('USDT', '').replace('USD', '');

      const response = await this.httpClient.post('/info', {
        type: 'l2Book',
        coin: coin,
      });

      return {
        success: true,
        data: {
          symbol: symbol,
          bids: response.data.levels[0].map((l: any) => [l.px, l.sz]),
          asks: response.data.levels[1].map((l: any) => [l.px, l.sz]),
        },
        timestamp: Date.now(),
      };
    } catch (error: any) {
      return this.handleError(error);
    }
  }

  /**
   * Convert interval string to milliseconds
   */
  private intervalToMs(interval: string): number {
    const unit = interval.slice(-1);
    const value = parseInt(interval.slice(0, -1));

    switch (unit) {
      case 'm': return value * 60 * 1000;
      case 'h': return value * 60 * 60 * 1000;
      case 'd': return value * 24 * 60 * 60 * 1000;
      case 'w': return value * 7 * 24 * 60 * 60 * 1000;
      case 'M': return value * 30 * 24 * 60 * 60 * 1000;
      default: return 60 * 60 * 1000; // default 1h
    }
  }

  private handleError(error: any): HyperliquidApiResponse {
    const errorMessage =
      error.response?.data?.error ||
      error.response?.data?.message ||
      error.message ||
      'Unknown error';

    console.error('[Hyperliquid] API Error:', errorMessage);

    return {
      success: false,
      error: errorMessage,
      timestamp: Date.now(),
    };
  }
}
