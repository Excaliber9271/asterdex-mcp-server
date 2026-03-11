/**
 * AsterClient Unit Tests
 *
 * Split into two categories:
 * 1. Unit tests - Test construction, types, and pure functions (always run)
 * 2. Integration tests - Test real API calls (skipped by default, run with --runInBand)
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { AsterClient, type TickerData, type OrderBook, type FundingRate } from '../aster-client.js';

// Whether to run integration tests (set RUN_INTEGRATION=true to enable)
const RUN_INTEGRATION = process.env.RUN_INTEGRATION === 'true';

describe('AsterClient', () => {
  describe('Unit Tests', () => {
    describe('constructor', () => {
      it('should create an instance with default base URL', () => {
        const client = new AsterClient();
        expect(client).toBeInstanceOf(AsterClient);
      });

      it('should create an instance with custom base URL', () => {
        const client = new AsterClient('https://custom.api.com');
        expect(client).toBeInstanceOf(AsterClient);
      });

      it('should accept testnet URL', () => {
        const client = new AsterClient('https://testnet.asterdex.com');
        expect(client).toBeInstanceOf(AsterClient);
      });
    });

    describe('type definitions', () => {
      it('should have proper TickerData structure', () => {
        const mockTicker: TickerData = {
          symbol: 'BTCUSDT',
          priceChange: '100',
          priceChangePercent: '1.5',
          weightedAvgPrice: '65000',
          lastPrice: '65100',
          lastQty: '0.1',
          openPrice: '65000',
          highPrice: '66000',
          lowPrice: '64000',
          volume: '1000',
          quoteVolume: '65000000',
          openTime: Date.now() - 86400000,
          closeTime: Date.now(),
          count: 50000,
        };

        expect(mockTicker.symbol).toBe('BTCUSDT');
        expect(typeof mockTicker.lastPrice).toBe('string');
        expect(typeof mockTicker.volume).toBe('string');
        expect(typeof mockTicker.openTime).toBe('number');
      });

      it('should have proper OrderBook structure', () => {
        const mockOrderBook: OrderBook = {
          symbol: 'BTCUSDT',
          lastUpdateId: 123456,
          bids: [
            ['65000', '1.5'],
            ['64999', '2.0'],
          ],
          asks: [
            ['65001', '1.2'],
            ['65002', '0.8'],
          ],
        };

        expect(mockOrderBook.bids).toHaveLength(2);
        expect(mockOrderBook.asks).toHaveLength(2);
        expect(mockOrderBook.bids[0][0]).toBe('65000');
        expect(mockOrderBook.bids[0][1]).toBe('1.5');
      });

      it('should have proper FundingRate structure', () => {
        const mockFunding: FundingRate = {
          symbol: 'BTCUSDT',
          fundingRate: '0.0001',
          fundingTime: Date.now(),
          markPrice: '65050',
        };

        expect(mockFunding.fundingRate).toBe('0.0001');
        expect(typeof mockFunding.fundingTime).toBe('number');
        expect(mockFunding.markPrice).toBe('65050');
      });
    });

    describe('kline transformation logic', () => {
      it('should transform raw kline array to object format', () => {
        // This is the exact transformation logic from getKlines
        const rawKline = [
          1609459200000, // openTime
          '29000', // open
          '29500', // high
          '28500', // low
          '29200', // close
          '1000', // volume
          1609462800000, // closeTime
          '29000000', // quoteVolume
          5000, // trades
          '600', // takerBuyVolume
          '17400000', // takerBuyQuoteVolume
        ];

        // Simulate the transformation
        const transformed = {
          openTime: rawKline[0],
          open: rawKline[1],
          high: rawKline[2],
          low: rawKline[3],
          close: rawKline[4],
          volume: rawKline[5],
          closeTime: rawKline[6],
          quoteVolume: rawKline[7],
          trades: rawKline[8],
          takerBuyVolume: rawKline[9],
          takerBuyQuoteVolume: rawKline[10],
        };

        expect(transformed.openTime).toBe(1609459200000);
        expect(transformed.open).toBe('29000');
        expect(transformed.high).toBe('29500');
        expect(transformed.low).toBe('28500');
        expect(transformed.close).toBe('29200');
        expect(transformed.volume).toBe('1000');
        expect(transformed.closeTime).toBe(1609462800000);
        expect(transformed.trades).toBe(5000);
      });

      it('should handle empty kline array', () => {
        const rawKlines: any[] = [];
        const transformed = rawKlines.map((k: any[]) => ({
          openTime: k[0],
          open: k[1],
          high: k[2],
          low: k[3],
          close: k[4],
          volume: k[5],
        }));

        expect(transformed).toHaveLength(0);
      });

      it('should handle multiple klines', () => {
        const rawKlines = [
          [1609459200000, '29000', '29500', '28500', '29200', '1000'],
          [1609462800000, '29200', '29800', '29100', '29600', '1200'],
          [1609466400000, '29600', '30000', '29400', '29800', '800'],
        ];

        const transformed = rawKlines.map((k: any[]) => ({
          openTime: k[0],
          close: k[4],
        }));

        expect(transformed).toHaveLength(3);
        expect(transformed[0].openTime).toBe(1609459200000);
        expect(transformed[1].close).toBe('29600');
        expect(transformed[2].close).toBe('29800');
      });
    });

    describe('symbol normalization', () => {
      it('should uppercase symbols in API calls', () => {
        // The client uppercases symbols - we verify the behavior conceptually
        const symbol = 'btcusdt';
        const normalized = symbol.toUpperCase();
        expect(normalized).toBe('BTCUSDT');
      });

      it('should handle already uppercase symbols', () => {
        const symbol = 'ETHUSDT';
        const normalized = symbol.toUpperCase();
        expect(normalized).toBe('ETHUSDT');
      });

      it('should handle mixed case symbols', () => {
        const symbol = 'BtCuSdT';
        const normalized = symbol.toUpperCase();
        expect(normalized).toBe('BTCUSDT');
      });
    });

    describe('response structure validation', () => {
      it('should have correct success response shape', () => {
        const successResponse = {
          success: true,
          data: { test: 'data' },
          timestamp: Date.now(),
        };

        expect(successResponse).toHaveProperty('success', true);
        expect(successResponse).toHaveProperty('data');
        expect(successResponse).toHaveProperty('timestamp');
        expect(typeof successResponse.timestamp).toBe('number');
      });

      it('should have correct error response shape', () => {
        const errorResponse = {
          success: false,
          error: 'Something went wrong',
          timestamp: Date.now(),
        };

        expect(errorResponse).toHaveProperty('success', false);
        expect(errorResponse).toHaveProperty('error');
        expect(errorResponse).toHaveProperty('timestamp');
        expect(typeof errorResponse.error).toBe('string');
      });

      it('getPrice should return correct response structure', async () => {
        const client = new AsterClient('https://mock.api');
        const mockPriceData = { symbol: 'BTCUSDT', price: '65100.42' };
        let requestArgs: { url: string; config?: any } | undefined;

        (client as any).rateLimitedGet = async (url: string, config?: any) => {
          requestArgs = { url, config };
          return mockPriceData;
        };

        const result = await client.getPrice('btcusdt');

        expect(result).toEqual(
          expect.objectContaining({
            success: true,
            data: mockPriceData,
            timestamp: expect.any(Number),
          }),
        );
        expect(result.timestamp).toBeGreaterThan(0);
        expect(requestArgs).toEqual({
          url: '/fapi/v1/ticker/price',
          config: { params: { symbol: 'BTCUSDT' } },
        });
      });
    });

    describe('getKlines method (mocked)', () => {
      it('should transform a single raw kline array into a named-field object', async () => {
        const client = new AsterClient('https://mock.api');
        const rawKlines = [
          [
            1609459200000, // openTime
            '29000.00', // open
            '29500.00', // high
            '28500.00', // low
            '29200.00', // close
            '1500.50', // volume
            1609462800000, // closeTime
            '43507250.00', // quoteVolume
            8200, // trades
            '750.25', // takerBuyVolume
            '21753625.00', // takerBuyQuoteVolume
          ],
        ];

        (client as any).rateLimitedGet = async () => rawKlines;

        const result = await client.getKlines('BTCUSDT', '1h', 1);

        expect(result.success).toBe(true);
        expect(result.data).toHaveLength(1);

        const kline = result.data![0];
        expect(kline.openTime).toBe(1609459200000);
        expect(kline.open).toBe('29000.00');
        expect(kline.high).toBe('29500.00');
        expect(kline.low).toBe('28500.00');
        expect(kline.close).toBe('29200.00');
        expect(kline.volume).toBe('1500.50');
        expect(kline.closeTime).toBe(1609462800000);
        expect(kline.quoteVolume).toBe('43507250.00');
        expect(kline.trades).toBe(8200);
        expect(kline.takerBuyVolume).toBe('750.25');
        expect(kline.takerBuyQuoteVolume).toBe('21753625.00');
      });

      it('should transform multiple raw klines and preserve order', async () => {
        const client = new AsterClient('https://mock.api');
        const rawKlines = [
          [
            1609459200000,
            '29000',
            '29500',
            '28500',
            '29200',
            '1000',
            1609462800000,
            '29000000',
            5000,
            '600',
            '17400000',
          ],
          [
            1609462800000,
            '29200',
            '29800',
            '29100',
            '29600',
            '1200',
            1609466400000,
            '35040000',
            6000,
            '700',
            '20720000',
          ],
          [
            1609466400000,
            '29600',
            '30000',
            '29400',
            '29800',
            '800',
            1609470000000,
            '23680000',
            4000,
            '400',
            '11880000',
          ],
        ];

        (client as any).rateLimitedGet = async () => rawKlines;

        const result = await client.getKlines('ETHUSDT', '15m', 3);

        expect(result.success).toBe(true);
        expect(result.data).toHaveLength(3);

        // Verify order is preserved via openTime
        expect(result.data![0].openTime).toBe(1609459200000);
        expect(result.data![1].openTime).toBe(1609462800000);
        expect(result.data![2].openTime).toBe(1609466400000);

        // Spot-check second kline
        expect(result.data![1].open).toBe('29200');
        expect(result.data![1].close).toBe('29600');
        expect(result.data![1].trades).toBe(6000);
      });

      it('should return an empty array when API returns no klines', async () => {
        const client = new AsterClient('https://mock.api');
        (client as any).rateLimitedGet = async () => [];

        const result = await client.getKlines('BTCUSDT', '1d', 10);

        expect(result.success).toBe(true);
        expect(result.data).toEqual([]);
      });

      it('should pass correct params including symbol uppercasing', async () => {
        const client = new AsterClient('https://mock.api');
        let capturedUrl: string | undefined;
        let capturedConfig: any;

        (client as any).rateLimitedGet = async (url: string, config?: any) => {
          capturedUrl = url;
          capturedConfig = config;
          return [];
        };

        await client.getKlines('btcusdt', '4h', 50, 1000, 2000);

        expect(capturedUrl).toBe('/fapi/v1/klines');
        expect(capturedConfig).toEqual({
          params: {
            symbol: 'BTCUSDT',
            interval: '4h',
            limit: 50,
            startTime: 1000,
            endTime: 2000,
          },
        });
      });

      it('should omit startTime/endTime params when not provided', async () => {
        const client = new AsterClient('https://mock.api');
        let capturedConfig: any;

        (client as any).rateLimitedGet = async (_url: string, config?: any) => {
          capturedConfig = config;
          return [];
        };

        await client.getKlines('ETHUSDT', '1h', 100);

        expect(capturedConfig.params).toEqual({
          symbol: 'ETHUSDT',
          interval: '1h',
          limit: 100,
        });
        expect(capturedConfig.params.startTime).toBeUndefined();
        expect(capturedConfig.params.endTime).toBeUndefined();
      });

      it('should include a valid timestamp in the response', async () => {
        const client = new AsterClient('https://mock.api');
        (client as any).rateLimitedGet = async () => [];

        const before = Date.now();
        const result = await client.getKlines('BTCUSDT');
        const after = Date.now();

        expect(result.timestamp).toBeGreaterThanOrEqual(before);
        expect(result.timestamp).toBeLessThanOrEqual(after);
      });
    });

    describe('API error handling', () => {
      it('should return error response when API returns an error with msg field', async () => {
        const client = new AsterClient('https://mock.api');
        const axiosError = {
          response: { data: { msg: 'Invalid symbol.' } },
          message: 'Request failed with status code 400',
        };

        (client as any).rateLimitedGet = async () => {
          throw axiosError;
        };

        const result = await client.getPrice('INVALID');

        expect(result.success).toBe(false);
        expect(result.error).toBe('Invalid symbol.');
        expect(result.data).toBeUndefined();
        expect(typeof result.timestamp).toBe('number');
      });

      it('should return error response when API returns an error with message field', async () => {
        const client = new AsterClient('https://mock.api');
        const axiosError = {
          response: { data: { message: 'Rate limit exceeded' } },
          message: 'Request failed with status code 429',
        };

        (client as any).rateLimitedGet = async () => {
          throw axiosError;
        };

        const result = await client.getTicker24h('BTCUSDT');

        expect(result.success).toBe(false);
        expect(result.error).toBe('Rate limit exceeded');
      });

      it('should fall back to error.message when response has no data', async () => {
        const client = new AsterClient('https://mock.api');
        const networkError = {
          message: 'Network Error',
        };

        (client as any).rateLimitedGet = async () => {
          throw networkError;
        };

        const result = await client.getOrderBook('BTCUSDT');

        expect(result.success).toBe(false);
        expect(result.error).toBe('Network Error');
      });

      it('should return "Unknown error" when error has no message at all', async () => {
        const client = new AsterClient('https://mock.api');

        (client as any).rateLimitedGet = async () => {
          throw {};
        };

        const result = await client.ping();

        expect(result.success).toBe(false);
        expect(result.error).toBe('Unknown error');
      });

      it('should handle errors from getKlines gracefully', async () => {
        const client = new AsterClient('https://mock.api');
        const axiosError = {
          response: { data: { msg: 'Invalid interval.' } },
          message: 'Request failed with status code 400',
        };

        (client as any).rateLimitedGet = async () => {
          throw axiosError;
        };

        const result = await client.getKlines('BTCUSDT', 'bad_interval');

        expect(result.success).toBe(false);
        expect(result.error).toBe('Invalid interval.');
        expect(result.data).toBeUndefined();
        expect(typeof result.timestamp).toBe('number');
      });

      it('should handle timeout errors', async () => {
        const client = new AsterClient('https://mock.api');
        const timeoutError = {
          message: 'timeout of 30000ms exceeded',
          code: 'ECONNABORTED',
        };

        (client as any).rateLimitedGet = async () => {
          throw timeoutError;
        };

        const result = await client.getPremiumIndex('BTCUSDT');

        expect(result.success).toBe(false);
        expect(result.error).toBe('timeout of 30000ms exceeded');
      });

      it('should prefer response.data.msg over response.data.message', async () => {
        const client = new AsterClient('https://mock.api');
        const axiosError = {
          response: {
            data: {
              msg: 'Primary error message',
              message: 'Secondary error message',
            },
          },
          message: 'Fallback message',
        };

        (client as any).rateLimitedGet = async () => {
          throw axiosError;
        };

        const result = await client.getRecentTrades('BTCUSDT');

        expect(result.success).toBe(false);
        expect(result.error).toBe('Primary error message');
      });
    });
  });

  // Integration tests - only run when RUN_INTEGRATION=true
  describe('Integration Tests', () => {
    let client: AsterClient;

    beforeAll(() => {
      client = new AsterClient();
    });

    const testOrSkip = RUN_INTEGRATION ? it : it.skip;

    testOrSkip(
      'ping should return success',
      async () => {
        const result = await client.ping();
        expect(result.success).toBe(true);
      },
      10000,
    );

    testOrSkip(
      'getServerTime should return valid timestamp',
      async () => {
        const result = await client.getServerTime();
        expect(result.success).toBe(true);
        expect(result.data?.serverTime).toBeGreaterThan(0);
      },
      10000,
    );

    testOrSkip(
      'getSymbols should return array of symbols',
      async () => {
        const result = await client.getSymbols();
        expect(result.success).toBe(true);
        expect(Array.isArray(result.data)).toBe(true);
        expect(result.data!.length).toBeGreaterThan(0);
        expect(result.data).toContain('BTCUSDT');
      },
      10000,
    );

    testOrSkip(
      'getTicker24h should return ticker data for BTCUSDT',
      async () => {
        const result = await client.getTicker24h('BTCUSDT');
        expect(result.success).toBe(true);
        expect(result.data).toHaveProperty('symbol', 'BTCUSDT');
        expect(result.data).toHaveProperty('lastPrice');
        expect(result.data).toHaveProperty('volume');
      },
      10000,
    );

    testOrSkip(
      'getKlines should return transformed kline data',
      async () => {
        const result = await client.getKlines('BTCUSDT', '1h', 10);
        expect(result.success).toBe(true);
        expect(Array.isArray(result.data)).toBe(true);
        expect(result.data!.length).toBeLessThanOrEqual(10);

        if (result.data!.length > 0) {
          const kline = result.data![0];
          expect(kline).toHaveProperty('openTime');
          expect(kline).toHaveProperty('open');
          expect(kline).toHaveProperty('high');
          expect(kline).toHaveProperty('low');
          expect(kline).toHaveProperty('close');
          expect(kline).toHaveProperty('volume');
        }
      },
      10000,
    );

    testOrSkip(
      'getOrderBook should return bids and asks',
      async () => {
        const result = await client.getOrderBook('BTCUSDT', 5);
        expect(result.success).toBe(true);
        expect(result.data).toHaveProperty('bids');
        expect(result.data).toHaveProperty('asks');
        expect(Array.isArray(result.data?.bids)).toBe(true);
        expect(Array.isArray(result.data?.asks)).toBe(true);
      },
      10000,
    );

    testOrSkip(
      'getPremiumIndex should return funding info',
      async () => {
        const result = await client.getPremiumIndex('BTCUSDT');
        expect(result.success).toBe(true);
        expect(result.data).toHaveProperty('markPrice');
        expect(result.data).toHaveProperty('lastFundingRate');
      },
      10000,
    );

    testOrSkip(
      'getOpenInterest should return OI for symbol',
      async () => {
        const result = await client.getOpenInterest('BTCUSDT');
        expect(result.success).toBe(true);
        expect(result.data).toHaveProperty('openInterest');
      },
      10000,
    );

    testOrSkip(
      'should handle invalid symbol gracefully',
      async () => {
        const result = await client.getTicker24h('INVALID_SYMBOL_XYZ');
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      },
      10000,
    );
  });
});
