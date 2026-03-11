/**
 * Crypto Base Scanner API Client
 * https://api.cryptobasescanner.com/v1
 *
 * Provides QFL (Quickfingersluc) base detection signals
 * for identifying support levels and crack opportunities.
 */

import axios, { AxiosInstance } from 'axios';

export type CBSAlgorithm = 'original' | 'day_trade' | 'conservative' | 'position';
export type CBSExchange = 'BINA' | 'KUCN' | 'BTRX' | 'PLNX' | 'HITB';
export type CBSTimeframe = '5' | '10' | '15' | '30';

export interface CBSResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface CBSBase {
  id: number;
  time: number;
  date: string;
  price: string;
  lowestPrice: string;
  bounce: string;
  drop: string;
  percentage: string;
  createdAt: string;
  respectedAt: string;
  isLowest: boolean;
}

export interface CBSLatestBase {
  id: number;
  time: number;
  date: string;
  price: string;
  lowestPrice: string;
  bounce: string;
  current_drop: string;
  createdAt: string;
  respectedAt: string;
  isLowest: boolean;
}

export interface CBSMarketStat {
  algorithm: CBSAlgorithm;
  ratio: string;        // Success rate e.g. "94.0"
  medianDrop: string;   // Typical drop e.g. "-4.0"
  medianBounce: string; // Typical bounce e.g. "9.52"
  hoursToRespected: number;
  crackedCount: number;
  respectedCount: number;
}

export interface CBSMarket {
  id: number;
  baseCurrency: string;
  quoteCurrency: string;
  exchangeName: string;
  exchangeCode: string;
  longName: string;
  marketName: string;
  symbol: string;
  volume: string;
  quoteVolume: string;
  btcVolume: string;
  usdVolume: string;
  currentPrice: string;
  latestBase?: CBSLatestBase;
  marketStats?: CBSMarketStat[];
}

export interface CBSMarketScan {
  id: number;
  baseCurrency: string;
  quoteCurrency: string;
  exchangeName: string;
  exchangeCode: string;
  exchangeLogo: string;
  longName: string;
  symbol: string;
  volume: string;
  quoteVolume: string;
  btcVolume: string;
  usdVolume: string;
  lastPrice: string;
  bidPrice: string;
  askPrice: string;
  drop: string;
  fatFinger: boolean;
  marketPrices?: { time: number; price: string }[];
}

export class CBSClient {
  private httpClient: AxiosInstance;
  private apiKey: string;

  constructor(baseURL: string = 'https://api.cryptobasescanner.com') {
    this.httpClient = axios.create({
      baseURL,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
    this.apiKey = process.env.CBS_API_KEY || '';
  }

  /**
   * Check if API key is configured
   */
  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * Get bases that have been cracked in the last 12 hours
   * This is the main signal endpoint - shows active opportunities
   */
  async getCrackedBases(algorithm: CBSAlgorithm = 'original'): Promise<CBSResponse<CBSMarket[]>> {
    if (!this.isConfigured()) {
      return { success: false, error: 'CBS API key not configured. Set CBS_API_KEY in .env' };
    }

    try {
      const response = await this.httpClient.get('/v1/bases', {
        params: {
          api_key: this.apiKey,
          algorithm,
        },
      });
      return { success: true, data: response.data.bases || [] };
    } catch (error: any) {
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get all markets for an exchange with their current drop from base
   * Shows how far each market is from its base level
   */
  async getMarkets(
    exchangeCode: CBSExchange = 'BINA',
    algorithm: CBSAlgorithm = 'original'
  ): Promise<CBSResponse<CBSMarket[]>> {
    if (!this.isConfigured()) {
      return { success: false, error: 'CBS API key not configured. Set CBS_API_KEY in .env' };
    }

    try {
      const response = await this.httpClient.get('/v1/markets', {
        params: {
          api_key: this.apiKey,
          algorithm,
          exchange_code: exchangeCode,
        },
      });
      return { success: true, data: response.data.markets || [] };
    } catch (error: any) {
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Quick scan for recent price drops (5-30 min timeframes)
   * Good for catching fast moves
   */
  async quickScan(
    exchangeCode: CBSExchange = 'BINA',
    timeframe: CBSTimeframe = '15'
  ): Promise<CBSResponse<CBSMarketScan[]>> {
    if (!this.isConfigured()) {
      return { success: false, error: 'CBS API key not configured. Set CBS_API_KEY in .env' };
    }

    try {
      const response = await this.httpClient.get('/v1/markets/quick_scan', {
        params: {
          api_key: this.apiKey,
          timeframe,
          exchange_code: exchangeCode,
        },
      });
      return { success: true, data: response.data.markets || [] };
    } catch (error: any) {
      return { success: false, error: error.response?.data?.message || error.message };
    }
  }

  /**
   * Get cracked bases filtered for pairs that exist on Aster
   * Maps Binance symbols to Aster format and filters
   */
  async getCrackedBasesForAster(
    algorithm: CBSAlgorithm = 'original',
    asterPairs: string[]
  ): Promise<CBSResponse<any[]>> {
    const result = await this.getCrackedBases(algorithm);
    if (!result.success) return result;

    // Normalize Aster pairs for comparison (uppercase, no special chars)
    const asterPairsSet = new Set(asterPairs.map(p => p.toUpperCase().replace(/[^A-Z0-9]/g, '')));

    // Filter and map CBS results to Aster-tradeable pairs
    const filtered = (result.data || []).filter((market: CBSMarket) => {
      // CBS uses baseCurrency + quoteCurrency, we need to match to Aster format
      const symbol = `${market.baseCurrency}${market.quoteCurrency}`.toUpperCase();
      return asterPairsSet.has(symbol);
    }).map((market: CBSMarket) => {
      const symbol = `${market.baseCurrency}${market.quoteCurrency}`.toUpperCase();
      const stats = market.marketStats?.find(s => s.algorithm === algorithm);

      return {
        symbol,
        asterSymbol: symbol, // Already in Aster format
        exchange: market.exchangeName,
        exchangeCode: market.exchangeCode,
        currentPrice: market.currentPrice,
        base: market.latestBase ? {
          price: market.latestBase.price,
          lowestPrice: market.latestBase.lowestPrice,
          currentDrop: market.latestBase.current_drop,
          bounce: market.latestBase.bounce,
          isLowest: market.latestBase.isLowest,
          crackedAt: market.latestBase.date,
        } : null,
        stats: stats ? {
          successRate: stats.ratio,
          medianDrop: stats.medianDrop,
          medianBounce: stats.medianBounce,
          hoursToRecover: stats.hoursToRespected,
          crackedCount: stats.crackedCount,
          respectedCount: stats.respectedCount,
        } : null,
        volume: {
          usd: market.usdVolume,
          btc: market.btcVolume,
        },
      };
    });

    return { success: true, data: filtered };
  }

  /**
   * Get markets near their base (approaching potential crack)
   * Useful for setting up alerts or limit orders
   */
  async getMarketsNearBase(
    exchangeCode: CBSExchange = 'BINA',
    algorithm: CBSAlgorithm = 'original',
    maxDropPercent: number = -5 // Only show markets within X% of base
  ): Promise<CBSResponse<any[]>> {
    const result = await this.getMarkets(exchangeCode, algorithm);
    if (!result.success) return result;

    const nearBase = (result.data || [])
      .filter((market: CBSMarket) => {
        if (!market.latestBase?.current_drop) return false;
        const drop = parseFloat(market.latestBase.current_drop);
        return drop <= 0 && drop >= maxDropPercent;
      })
      .map((market: CBSMarket) => {
        const stats = market.marketStats?.find(s => s.algorithm === algorithm);
        return {
          symbol: `${market.baseCurrency}${market.quoteCurrency}`,
          exchange: market.exchangeName,
          currentPrice: market.currentPrice,
          basePrice: market.latestBase?.price,
          currentDrop: market.latestBase?.current_drop,
          medianDrop: stats?.medianDrop,
          distanceToMedian: stats?.medianDrop
            ? (parseFloat(market.latestBase?.current_drop || '0') - parseFloat(stats.medianDrop)).toFixed(2)
            : null,
          successRate: stats?.ratio,
          medianBounce: stats?.medianBounce,
        };
      })
      .sort((a: any, b: any) => parseFloat(a.currentDrop) - parseFloat(b.currentDrop));

    return { success: true, data: nearBase };
  }

  /**
   * Compare same symbol across different algorithms
   * Shows how each algo views the same market
   */
  async compareAlgorithms(
    symbol: string,
    exchangeCode: CBSExchange = 'BINA'
  ): Promise<CBSResponse<any>> {
    const algorithms: CBSAlgorithm[] = ['original', 'day_trade', 'conservative', 'position'];
    const results: any = { symbol, algorithms: {} };

    for (const algo of algorithms) {
      const marketsRes = await this.getMarkets(exchangeCode, algo);
      if (!marketsRes.success) continue;

      const market = (marketsRes.data || []).find((m: CBSMarket) =>
        `${m.baseCurrency}${m.quoteCurrency}`.toUpperCase() === symbol.toUpperCase()
      );

      if (market) {
        const stats = market.marketStats?.find((s: CBSMarketStat) => s.algorithm === algo);
        results.algorithms[algo] = {
          basePrice: market.latestBase?.price,
          currentDrop: market.latestBase?.current_drop,
          successRate: stats?.ratio,
          medianDrop: stats?.medianDrop,
          medianBounce: stats?.medianBounce,
          hoursToRecover: stats?.hoursToRespected,
        };
      }
    }

    return { success: true, data: results };
  }
}

export default CBSClient;
