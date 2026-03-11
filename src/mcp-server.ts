#!/usr/bin/env node
/**
 * Aster Trading Suite - MCP Server
 *
 * Intelligent perpetual futures trading tools for Aster DEX
 * with VPVR analysis, pump scanning, and strategy automation.
 *
 * Features:
 * - Volume Profile (VPVR) with POC, VAH, VAL, VWAP, Delta
 * - Cross-exchange comparison (Aster vs Hyperliquid)
 * - Pump & breakout detection with scoring
 * - Automated strategies (funding farm, grid, pump)
 * - Multi-agent AI orchestration support
 *
 * @see https://github.com/yourusername/aster-trading-suite
 */

import 'dotenv/config'; // Auto-load .env file
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { AsterClient } from './aster-client.js';
import { AsterWebSocket } from './aster-websocket.js';
import { AsterTradingClient } from './aster-trading-client.js';
import { AsterSpotClient } from './aster-spot-client.js';
import { HyperliquidClient } from './hyperliquid-client.js';
import { getBinanceClient, BinanceClient } from './binance-client.js';
import { CBSClient, CBSAlgorithm, CBSExchange, CBSTimeframe } from './cbs-client.js';
import { credentialManager } from './credential-manager.js';
import { FundingFarmStrategy, GridTradingStrategy } from './strategies/index.js';
import {
  StrategyEngine,
  DEFAULT_PUMP_STRATEGY,
  AGGRESSIVE_PUMP_STRATEGY,
  CONSERVATIVE_PUMP_STRATEGY,
} from './strategy-engine.js';
import {
  ScaleGridEngine,
  calculateGridLevels,
  mergeConfig,
  formatGridCalculation,
  GridConfig,
  GridState,
} from './scalegrid/index.js';
import { getRegimeDetector, RegimeState } from './regime-detector.js';
import * as fs from 'fs';
import * as path from 'path';

// Initialize clients
const asterClient = new AsterClient();
const asterWs = new AsterWebSocket();
const asterTrading = new AsterTradingClient();
const asterSpot = new AsterSpotClient();
const hyperliquidClient = new HyperliquidClient();
const binanceClient = getBinanceClient();
const cbsClient = new CBSClient();

// Trading credentials can be set via tool or loaded from environment
let tradingEnabled = false;
let credentialsSource: 'none' | 'manual' | 'environment' = 'none';

// User data stream state
let currentListenKey: string | null = null;
let listenKeyKeepAliveInterval: NodeJS.Timeout | null = null;

// Strategy instances (lazy initialized after credentials are set)
let fundingFarm: FundingFarmStrategy | null = null;
let gridTrading: GridTradingStrategy | null = null;
let strategyEngine: StrategyEngine | null = null;
let scaleGridEngine: ScaleGridEngine | null = null;

// ==================== CACHE LAYER ====================
interface CacheEntry {
  data: any;
  timestamp: number;
  source: string;
}

const cache: Map<string, CacheEntry> = new Map();
const CACHE_FILE = path.join(process.cwd(), '.aster-cache.json');
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes default TTL

function setCache(key: string, data: any, source: string): void {
  cache.set(key, { data, timestamp: Date.now(), source });
}

function getCache(key: string, maxAge?: number): CacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  const ttl = maxAge ?? CACHE_TTL_MS;
  if (Date.now() - entry.timestamp > ttl) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function saveCacheToFile(): void {
  const entries: Record<string, CacheEntry> = {};
  cache.forEach((v, k) => {
    entries[k] = v;
  });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(entries, null, 2));
}

function loadCacheFromFile(): boolean {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      Object.entries(data).forEach(([k, v]) => cache.set(k, v as CacheEntry));
      return true;
    }
  } catch (e) {
    /* ignore */
  }
  return false;
}

// ==================== KLINE CACHE (Pump Scanner Optimization) ====================
interface KlineCacheEntry {
  candles: any[];
  timestamp: number;
}

const klineCache: Map<string, KlineCacheEntry> = new Map();

// TTL varies by interval - shorter intervals need fresher data
const KLINE_CACHE_TTL: Record<string, number> = {
  '15m': 60_000, // 1 minute for 15m candles
  '1h': 300_000, // 5 minutes for 1h candles
  '4h': 900_000, // 15 minutes for 4h candles
};

function getKlineCacheKey(symbol: string, interval: string, periods: number): string {
  return `kline:${symbol}:${interval}:${periods}`;
}

function getCachedKlines(symbol: string, interval: string, periods: number): any[] | null {
  const key = getKlineCacheKey(symbol, interval, periods);
  const entry = klineCache.get(key);
  if (!entry) return null;

  const ttl = KLINE_CACHE_TTL[interval] || 60_000;
  if (Date.now() - entry.timestamp > ttl) {
    klineCache.delete(key);
    return null;
  }
  return entry.candles;
}

function setCachedKlines(symbol: string, interval: string, periods: number, candles: any[]): void {
  const key = getKlineCacheKey(symbol, interval, periods);
  klineCache.set(key, { candles, timestamp: Date.now() });
}

// Helper to fetch klines with caching
async function fetchKlinesWithCache(
  client: typeof asterClient | typeof hyperliquidClient,
  symbol: string,
  interval: string,
  periods: number,
  exchange: 'aster' | 'hyperliquid' = 'aster',
): Promise<any[] | null> {
  const cacheKey = `${exchange}:${symbol}:${interval}:${periods}`;
  const cached = klineCache.get(cacheKey);
  const ttl = KLINE_CACHE_TTL[interval] || 60_000;

  if (cached && Date.now() - cached.timestamp < ttl) {
    return cached.candles;
  }

  const res = await client.getKlines(symbol, interval, periods);
  if (!res.success || !res.data || res.data.length < 20) {
    return null;
  }

  klineCache.set(cacheKey, { candles: res.data, timestamp: Date.now() });
  return res.data;
}

// ==================== TRADEABLE SYMBOLS CACHE ====================
// Filters out SETTLING, DELISTED, and non-TRADING pairs from scan results
// This prevents phantom pairs like PORT3USDT from appearing in scans

interface TradeableSymbolsCache {
  symbols: Set<string>;
  timestamp: number;
}

let tradeableSymbolsCache: TradeableSymbolsCache | null = null;
const TRADEABLE_SYMBOLS_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get the set of tradeable symbols (status === 'TRADING')
 * Uses a cached set that's refreshed every 5 minutes
 */
async function getTradeableSymbols(): Promise<Set<string>> {
  // Return cached if fresh
  if (
    tradeableSymbolsCache &&
    Date.now() - tradeableSymbolsCache.timestamp < TRADEABLE_SYMBOLS_TTL
  ) {
    return tradeableSymbolsCache.symbols;
  }

  // Fetch fresh exchange info
  const res = await asterClient.getExchangeInfo();
  if (!res.success || !res.data?.symbols) {
    console.error('[TradeableSymbols] Failed to fetch exchange info, using empty set');
    return tradeableSymbolsCache?.symbols || new Set();
  }

  // Filter to only TRADING status
  const tradeable = new Set<string>(
    res.data.symbols.filter((s: any) => s.status === 'TRADING').map((s: any) => s.symbol),
  );

  const total = res.data.symbols.length;
  const excluded = total - tradeable.size;
  if (excluded > 0) {
    console.error(
      `[TradeableSymbols] Cached ${tradeable.size} tradeable pairs (excluded ${excluded} non-TRADING pairs)`,
    );
  }

  tradeableSymbolsCache = { symbols: tradeable, timestamp: Date.now() };
  return tradeable;
}

/**
 * Filter an array of ticker data to only include tradeable symbols
 */
async function filterTradeableTickers<T extends { symbol: string }>(tickers: T[]): Promise<T[]> {
  const tradeable = await getTradeableSymbols();
  const filtered = tickers.filter(t => tradeable.has(t.symbol));

  const excluded = tickers.length - filtered.length;
  if (excluded > 0) {
    console.error(`[TradeableSymbols] Filtered out ${excluded} non-tradeable pairs from results`);
  }

  return filtered;
}

// Batch processor for parallel API calls
async function processBatches<T, R>(
  items: T[],
  processor: (item: T) => Promise<R | null>,
  batchSize: number = 15,
): Promise<(R | null)[]> {
  const results: (R | null)[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
  }

  return results;
}

/**
 * Get interval duration in milliseconds
 */
function getIntervalMs(interval: string): number {
  const units: Record<string, number> = {
    'm': 60 * 1000,
    'h': 60 * 60 * 1000,
    'd': 24 * 60 * 60 * 1000,
  };
  const match = interval.match(/^(\d+)([mhd])$/);
  if (!match) return 60 * 60 * 1000; // Default to 1h
  const value = parseInt(match[1]);
  const unit = match[2];
  return value * (units[unit] || units['m']);
}

/**
 * Calculate volume run-rate (projected volume) for an incomplete candle
 * Returns raw volume if candle is likely closed or duration is unknown
 */
function calculateProjectedVolume(candle: { t: number, v: string }, interval: string): number {
  const currentVol = parseFloat(candle.v);
  const intervalMs = getIntervalMs(interval);
  const elapsed = Date.now() - candle.t;
  
  // If candle just started (< 30s) or is from the past, don't project aggressively
  if (elapsed < 30000 || elapsed >= intervalMs) return currentVol;
  
  // Projection factor: how many 'elapsed' chunks fit in a full interval
  const projectionFactor = intervalMs / elapsed;
  
  // Cap projection to 10x to avoid extreme noise at the very start of a candle
  const cappedFactor = Math.min(projectionFactor, 10);
  
  // Use a weighted projection (blend of raw and projected) to reduce volatility in signals
  // Early in the candle (elapsed < 20%), we lean more on raw volume
  // Late in the candle, we trust the projection more
  const weight = Math.min(elapsed / intervalMs, 0.8);
  const projectedVol = currentVol * cappedFactor;
  
  return (currentVol * (1 - weight)) + (projectedVol * weight);
}

// Calculate volume acceleration using proper velocity/acceleration physics
// FIX: Use projected volume for the current candle to avoid "volume crash" false negatives
function calculateVolumeAcceleration(candles: any[], interval?: string): { acceleration: number; trend: string } {
  if (candles.length < 4) return { acceleration: 0, trend: 'unknown' };

  const lastIdx = candles.length - 1;
  const recentVols = candles.slice(-4).map((c, i) => {
    const isCurrentCandle = (i === 3); // The last one in our slice of 4
    if (isCurrentCandle && interval) {
      const volStr = c.volume || c.v || "0";
      const time = c.openTime || c.t || Date.now();
      return calculateProjectedVolume({ t: time, v: volStr }, interval);
    }
    return parseFloat(c.volume || c.v);
  });
  
  const [v1, v2, v3, v4] = recentVols;

  // Calculate velocity (% change between consecutive candles)
  const vel1 = v1 > 0 ? (v2 - v1) / v1 : 0;
  const vel2 = v2 > 0 ? (v3 - v2) / v2 : 0;
  const vel3 = v3 > 0 ? (v4 - v3) / v4 : 0;

  // Acceleration = change in velocity (is the growth rate increasing?)
  const accel1 = vel2 - vel1;
  const accel2 = vel3 - vel2;
  const acceleration = (accel1 + accel2) / 2; // Average acceleration

  // Classify the trend based on acceleration
  let trend = 'stable';
  if (acceleration > 0.5)
    trend = 'accelerating'; // Growth is speeding up rapidly
  else if (acceleration > 0.1)
    trend = 'increasing'; // Growth is speeding up
  else if (acceleration < -0.5)
    trend = 'declining'; // Growth is slowing rapidly
  else if (acceleration < -0.1) trend = 'slowing'; // Growth is slowing down

  return { acceleration, trend };
}

function initializeStrategies() {
  if (!fundingFarm) fundingFarm = new FundingFarmStrategy(asterTrading, asterClient);
  if (!gridTrading) gridTrading = new GridTradingStrategy(asterTrading, asterClient);
}

async function initializeCredentials(): Promise<void> {
  try {
    const stored = await credentialManager.getCredentials();
    if (stored) {
      asterTrading.setCredentials(stored.apiKey, stored.apiSecret);
      tradingEnabled = true;
      credentialsSource = 'environment';
      console.error('[Aster MCP] Credentials loaded from environment variables');
    }
  } catch (error: any) {
    console.error('[Aster MCP] Could not load credentials:', error.message);
  }
}

// ==================== CONSOLIDATED TOOLS ====================

const tools: Tool[] = [
  // 1. Data Retrieval (The "Swiss Army Knife")
  {
    name: 'get_market_data',
    description:
      'Get various types of market data. Use this for price, orderbook, funding rates, or 24h stats.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['price', 'ticker', 'orderbook', 'funding', 'info', 'summary'],
          description: 'Data type to fetch. "summary" returns top movers/volume/funding.',
        },
        symbol: {
          type: 'string',
          description:
            'Trading pair (e.g., BTCUSDT). Required for orderbook. Optional for others (returns top list if omitted).',
        },
        limit: {
          type: 'number',
          description: 'Limit results (depth for orderbook, count for lists). Default: 10.',
        },
      },
      required: ['type'],
    },
  },
  // 2. Historical Data
  {
    name: 'get_klines',
    description: 'Get historical candlestick (kline) data.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair (e.g., BTCUSDT)' },
        interval: { type: 'string', description: '1m, 5m, 15m, 1h, 4h, 1d. Default: 1h' },
        limit: { type: 'number', description: 'Number of candles (max 100). Default: 20' },
      },
      required: ['symbol'],
    },
  },
  // 3. Recent Trades
  {
    name: 'get_recent_trades',
    description: 'Get recent public trades for a symbol.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        limit: { type: 'number', description: 'Max 100. Default: 20' },
      },
      required: ['symbol'],
    },
  },
  // 4. Market Scanner
  {
    name: 'scan_markets',
    description: 'Scan ALL markets to find opportunities based on specific metrics.',
    inputSchema: {
      type: 'object',
      properties: {
        sort_by: {
          type: 'string',
          enum: ['funding', 'volume', 'change', 'oi', 'spread', 'deviation'],
          description: 'Metric to sort by. Default: funding',
        },
        direction: { type: 'string', enum: ['desc', 'asc'], description: 'Default: desc' },
        limit: { type: 'number', description: 'Default: 15' },
        min_volume: { type: 'number', description: 'Filter low volume pairs (USD amount)' },
      },
      required: [],
    },
  },
  // 5. Account Info
  {
    name: 'get_account_info',
    description:
      'Get account details: balances, positions, orders, ADL risk, liquidation history, or PnL.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: [
            'balance',
            'positions',
            'open_orders',
            'position_mode',
            'adl_risk',
            'liquidations',
            'pnl_history',
            'leverage_brackets',
          ],
          description:
            'Information to retrieve. adl_risk=ADL quantile (1-5 risk). liquidations=forced liquidation history. pnl_history=realized PnL, funding, commissions.',
        },
        symbol: { type: 'string', description: 'Filter by symbol (optional)' },
        limit: {
          type: 'number',
          description: 'Limit results (for liquidations/pnl_history, default 50)',
        },
        income_type: {
          type: 'string',
          description: 'For pnl_history: REALIZED_PNL, FUNDING_FEE, COMMISSION, TRANSFER',
        },
      },
      required: ['type'],
    },
  },
  // 6. Execute Order
  {
    name: 'execute_order',
    description: 'Place a new order or modify a position.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['market_open', 'market_close', 'limit', 'stop_loss', 'trailing_stop'],
          description: 'Type of order action',
        },
        symbol: { type: 'string' },
        side: { type: 'string', enum: ['LONG', 'SHORT', 'BUY', 'SELL'] },
        amount: { type: 'number', description: 'Quantity or USD value (for market_open)' },
        price: { type: 'string', description: 'Limit price or Stop price' },
        leverage: { type: 'number', description: 'Leverage to use (default 10)' },
        params: {
          type: 'object',
          description:
            'Extra params: { stopLossPercent, takeProfitPercent, callbackRate, timeInForce, reduceOnly }',
        },
      },
      required: ['action', 'symbol'],
    },
  },
  // 7. Manage Orders
  {
    name: 'manage_orders',
    description: 'Cancel orders or manage bulk operations.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['cancel_all', 'cancel_single', 'batch_place', 'set_auto_cancel'],
        },
        symbol: { type: 'string' },
        order_id: { type: 'string', description: 'For cancel_single' },
        orders: {
          type: 'array',
          items: { type: 'object' },
          description: 'For batch_place',
        },
        seconds: { type: 'number', description: 'For set_auto_cancel' },
      },
      required: ['action', 'symbol'],
    },
  },
  // 8. Strategy Management
  {
    name: 'manage_strategy',
    description: 'Control automated strategies (Funding Farm, Grid).',
    inputSchema: {
      type: 'object',
      properties: {
        strategy: { type: 'string', enum: ['funding_farm', 'grid'] },
        action: { type: 'string', enum: ['start', 'stop', 'status', 'suggest_params'] },
        config: {
          type: 'object',
          description:
            'Strategy config (e.g. { symbol, usdBudget, minFundingRate, gridLevels... })',
        },
      },
      required: ['strategy', 'action'],
    },
  },
  // 9. Stream Management
  {
    name: 'manage_stream',
    description: 'Manage WebSocket streams for real-time data.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop', 'status', 'collect_events', 'stream_orderbook', 'stream_prices'],
        },
        type: {
          type: 'string',
          enum: ['user', 'market'],
          description: 'Stream type (default: user)',
        },
        symbol: { type: 'string', description: 'Required for orderbook stream' },
        duration: {
          type: 'number',
          description: 'Duration in seconds (for collect/stream actions)',
        },
      },
      required: ['action'],
    },
  },
  // 10. Cache Management
  {
    name: 'manage_cache',
    description: 'Interact with the local data cache.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['scan_all', 'get', 'clear', 'status', 'load'] },
        key: {
          type: 'string',
          description: 'Cache key to retrieve (e.g., "all_markets", "funding")',
        },
      },
      required: ['action'],
    },
  },
  // 11. Credentials
  {
    name: 'manage_credentials',
    description: 'Set or clear API credentials.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'clear', 'status'] },
        api_key: { type: 'string' },
        api_secret: { type: 'string' },
      },
      required: ['action'],
    },
  },
  // 12. Utilities
  {
    name: 'calculate_position_size',
    description: 'Calculate position size based on risk percentage.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        risk_percent: { type: 'number' },
        entry_price: { type: 'number' },
        stop_loss_price: { type: 'number' },
      },
      required: ['symbol', 'risk_percent', 'entry_price', 'stop_loss_price'],
    },
  },
  // 13. Intelligence
  {
    name: 'get_market_intelligence',
    description: 'Get comprehensive market report: Gainers, Losers, Volume, Funding Opps.',
    inputSchema: {
      type: 'object',
      properties: {
        min_volume: { type: 'number', description: 'Volume filter (USD)' },
      },
      required: [],
    },
  },
  // 14. Panic Button
  {
    name: 'panic_button',
    description: 'EMERGENCY: Close ALL positions and cancel ALL orders immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Must be true to execute' },
      },
      required: ['confirm'],
    },
  },
  // 15. Pump Scanner
  {
    name: 'scan_for_pumps',
    description:
      'Scan all Aster pairs for early pump OR dump signals using volume analysis and technical indicators. Use mode "long" for pumps, "short" for dumps, "both" for full market view.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['long', 'short', 'both'],
          description:
            'Scan mode: "long" for pump signals (default), "short" for dump/short signals, "both" for complete market view',
          default: 'long',
        },
        volume_multiple: {
          type: 'number',
          description: 'Alert if current volume > X times average (default 5)',
          default: 5,
        },
        min_stoch_rsi: {
          type: 'number',
          description: 'Minimum StochRSI value (0-100, default 50 - neutral threshold)',
          default: 50,
        },
        min_mfi: {
          type: 'number',
          description: 'Minimum MFI value (0-100, default 50 - neutral threshold)',
          default: 50,
        },
        interval: {
          type: 'string',
          enum: ['15m', '1h', '4h'],
          description: 'Candle interval for analysis (default: 15m)',
          default: '15m',
        },
        lookback_periods: {
          type: 'number',
          description: 'Number of candles to analyze (default: 96)',
          default: 48,
        },
        limit: {
          type: 'number',
          description: 'Return top N signals (default: 10)',
          default: 10,
        },
        min_volume: {
          type: 'number',
          description: 'Filter out pairs with 24h volume below this USD amount (default: 1000)',
          default: 1000,
        },
        output_format: {
          type: 'string',
          enum: ['json', 'csv', 'compact'],
          description:
            'Output format: "json" (full details), "csv" (minimal tabular), "compact" (essential fields only). CSV reduces token usage by ~80%.',
          default: 'json',
        },
      },
      required: [],
    },
  },
  // 16. Strategy Engine Control
  {
    name: 'start_strategy',
    description: 'Start automated strategy engine that scans and trades automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        strategy_type: {
          type: 'string',
          enum: ['default', 'aggressive', 'conservative', 'custom'],
          description: 'Strategy preset to use (default: default)',
          default: 'default',
        },
        custom_config: {
          type: 'object',
          description: 'Custom config (only if strategy_type is "custom")',
        },
      },
      required: [],
    },
  },
  {
    name: 'stop_strategy',
    description: 'Stop the running strategy engine.',
    inputSchema: {
      type: 'object',
      properties: {
        close_positions: {
          type: 'boolean',
          description: 'Close all positions when stopping (default: false)',
          default: false,
        },
      },
      required: [],
    },
  },
  {
    name: 'get_strategy_status',
    description: 'Get current status of the strategy engine.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'update_strategy_config',
    description: 'Update strategy engine configuration while running.',
    inputSchema: {
      type: 'object',
      properties: {
        updates: {
          type: 'object',
          description: 'Config updates (e.g., { positionSizeUsd: 100, maxPositions: 5 })',
        },
      },
      required: ['updates'],
    },
  },
  {
    name: 'close_strategy_position',
    description: 'Manually close a specific position opened by the strategy engine.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol to close' },
      },
      required: ['symbol'],
    },
  },
  // 17. Hyperliquid Pump Scanner
  {
    name: 'scan_for_pumps_hl',
    description:
      'Scan Hyperliquid perps for early pump signals. Identical to scan_for_pumps but for Hyperliquid exchange.',
    inputSchema: {
      type: 'object',
      properties: {
        volume_multiple: {
          type: 'number',
          description: 'Alert if current volume > X times average (default 5)',
          default: 5,
        },
        min_stoch_rsi: {
          type: 'number',
          description: 'Minimum StochRSI value (0-100, default 50 - neutral threshold)',
          default: 50,
        },
        min_mfi: {
          type: 'number',
          description: 'Minimum MFI value (0-100, default 50 - neutral threshold)',
          default: 50,
        },
        interval: {
          type: 'string',
          enum: ['15m', '1h', '4h'],
          description: 'Candle interval for analysis (default: 15m)',
          default: '15m',
        },
        lookback_periods: {
          type: 'number',
          description: 'Number of candles to analyze (default: 96)',
          default: 48,
        },
        limit: {
          type: 'number',
          description: 'Return top N signals (default: 10)',
          default: 10,
        },
        min_volume: {
          type: 'number',
          description: 'Filter out pairs with 24h volume below this USD amount (default: 1000)',
          default: 1000,
        },
      },
      required: [],
    },
  },
  // 18. Cross-Exchange Pump Scanner
  {
    name: 'scan_for_pumps_cross',
    description:
      'Scan BOTH Aster and Hyperliquid for pump signals and compare results. Finds pairs flagged on both exchanges (highest conviction), Aster-only, and Hyperliquid-only.',
    inputSchema: {
      type: 'object',
      properties: {
        volume_multiple: {
          type: 'number',
          description: 'Alert if current volume > X times average (default 5)',
          default: 5,
        },
        min_stoch_rsi: {
          type: 'number',
          description: 'Minimum StochRSI value (0-100, default 50 - neutral threshold)',
          default: 50,
        },
        min_mfi: {
          type: 'number',
          description: 'Minimum MFI value (0-100, default 50 - neutral threshold)',
          default: 50,
        },
        interval: {
          type: 'string',
          enum: ['15m', '1h', '4h'],
          description: 'Candle interval for analysis (default: 15m)',
          default: '15m',
        },
        lookback_periods: {
          type: 'number',
          description: 'Number of candles to analyze (default: 96)',
          default: 48,
        },
        limit: {
          type: 'number',
          description: 'Return top N signals per exchange (default: 15)',
          default: 15,
        },
        min_volume: {
          type: 'number',
          description: 'Filter out pairs with 24h volume below this USD amount (default: 1000)',
          default: 1000,
        },
      },
      required: [],
    },
  },
  // 19. VPVR (Volume Profile Visible Range) Analysis
  {
    name: 'vpvr_analysis',
    description:
      'Volume Profile Visible Range analysis. Returns POC (Point of Control), Value Area (70% volume), High/Low Volume Nodes, and delta analysis. Essential for identifying support/resistance and likely price targets.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Trading pair symbol (e.g., BTCUSDT, NIGHTUSDT)',
        },
        timeframe: {
          type: 'string',
          enum: ['5m', '15m', '1h', '4h'],
          description: 'Candle timeframe (default: 15m)',
          default: '15m',
        },
        periods: {
          type: 'number',
          description: 'Number of candles to analyze. 96 periods of 15m = 24h (default: 96)',
          default: 96,
        },
        num_bins: {
          type: 'number',
          description: 'Number of price bins for granularity (default: 40)',
          default: 40,
        },
      },
      required: ['symbol'],
    },
  },

  // 20. Cross-Exchange VPVR Comparison
  {
    name: 'vpvr_cross',
    description:
      'Compare Volume Profiles between Aster and Hyperliquid. Identifies divergent POCs, liquidity imbalances, and which exchange is leading. Critical for finding institutional flow differences and arbitrage signals.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description:
            'Trading pair symbol (e.g., BTCUSDT, ETHUSDT). Must exist on both exchanges.',
        },
        timeframe: {
          type: 'string',
          enum: ['5m', '15m', '1h', '4h'],
          description: 'Candle timeframe (default: 15m)',
          default: '15m',
        },
        periods: {
          type: 'number',
          description: 'Number of candles to analyze. 96 periods of 15m = 24h (default: 96)',
          default: 96,
        },
        num_bins: {
          type: 'number',
          description: 'Number of price bins for granularity (default: 30)',
          default: 30,
        },
      },
      required: ['symbol'],
    },
  },
  // 21. Structure-Based Breakout Scanner
  {
    name: 'scan_breakouts',
    description:
      'Scan ALL pairs for structural breakout setups using VPVR analysis. No filtering - scores every pair. Returns ranked list with insights, key levels, and multi-timeframe (5m/15m) confirmation. Much better signal quality than scan_for_pumps.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['long', 'short', 'both'],
          description: 'Scan for bullish breakouts, bearish breakdowns, or both (default: both)',
          default: 'both',
        },
        min_score: {
          type: 'number',
          description: 'Minimum score to include in results (default: 30, lower = more noise)',
          default: 30,
        },
        limit: {
          type: 'number',
          description: 'Max signals to return per tier (default: 20)',
          default: 20,
        },
        lookback_5m: {
          type: 'number',
          description:
            'Number of 5m candles to fetch. 144 = 12 hours, aggregates to 48x 15m (default: 144)',
          default: 144,
        },
        output_format: {
          type: 'string',
          enum: ['json', 'csv', 'compact'],
          description:
            'Output format: "json" (full details), "csv" (minimal tabular), "compact" (essential fields only)',
          default: 'json',
        },
      },
      required: [],
    },
  },
  // 22. Cross-Exchange Funding Rate Spread
  {
    name: 'get_funding_spread',
    description:
      'Compare funding rates between Aster and Hyperliquid for the same symbols. Identifies arbitrage opportunities when funding diverges significantly (e.g., long on exchange paying you, short on exchange charging you). Returns spread, direction, and APR potential.',
    inputSchema: {
      type: 'object',
      properties: {
        min_spread_bps: {
          type: 'number',
          description: 'Minimum spread in basis points to include (default: 10 = 0.1%)',
          default: 10,
        },
        limit: {
          type: 'number',
          description: 'Max pairs to return (default: 20)',
          default: 20,
        },
        include_single_exchange: {
          type: 'boolean',
          description: 'Include symbols only on one exchange (for context, not arbitrage)',
          default: false,
        },
      },
      required: [],
    },
  },
  // 23. Open Interest Divergence Scanner
  {
    name: 'scan_oi_divergence',
    description:
      'Scan for price vs open interest divergence - a leading indicator. Detects: OI rising + price flat (accumulation), OI falling + price rising (weak rally), OI rising + price falling (distribution). These divergences often precede significant moves.',
    inputSchema: {
      type: 'object',
      properties: {
        lookback_periods: {
          type: 'number',
          description: 'Number of periods to analyze for divergence (default: 24)',
          default: 24,
        },
        min_oi_change_pct: {
          type: 'number',
          description: 'Minimum OI change % to consider significant (default: 5)',
          default: 5,
        },
        min_volume: {
          type: 'number',
          description: 'Minimum 24h volume to include (default: 50000)',
          default: 50000,
        },
        limit: {
          type: 'number',
          description: 'Max signals to return (default: 15)',
          default: 15,
        },
      },
      required: [],
    },
  },
  // ==================== SPOT MARKET TOOLS ====================
  // 22. Spot Market Data
  {
    name: 'get_spot_market_data',
    description: 'Get spot market data: prices, 24h stats, orderbook, or all trading pairs.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['price', 'ticker', 'orderbook', 'book_ticker', 'pairs', 'exchange_info'],
          description:
            'Data type: price (current price), ticker (24h stats), orderbook (depth), book_ticker (best bid/ask), pairs (all symbols), exchange_info (trading rules)',
        },
        symbol: {
          type: 'string',
          description:
            'Trading pair (e.g., BTCUSDT). Optional for price/ticker (returns all if omitted). Required for orderbook.',
        },
        limit: {
          type: 'number',
          description: 'Orderbook depth (default: 20, max: 100)',
        },
      },
      required: ['type'],
    },
  },
  // 23. Spot Klines
  {
    name: 'get_spot_klines',
    description: 'Get spot candlestick (kline) data.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair (e.g., BTCUSDT)' },
        interval: { type: 'string', description: '1m, 5m, 15m, 1h, 4h, 1d. Default: 1h' },
        limit: { type: 'number', description: 'Number of candles (max 100). Default: 100' },
      },
      required: ['symbol'],
    },
  },
  // 24. Spot Trades
  {
    name: 'get_spot_trades',
    description: 'Get recent public trades for a spot pair.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Trading pair (e.g., BTCUSDT)' },
        limit: { type: 'number', description: 'Max 100. Default: 100' },
      },
      required: ['symbol'],
    },
  },
  // 25. Spot Account
  {
    name: 'get_spot_account',
    description: 'Get spot account info: balances, open orders, order history, or trade history.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['balances', 'open_orders', 'all_orders', 'order_status', 'trades'],
          description:
            'balances=non-zero balances, open_orders=pending orders, all_orders=order history, order_status=specific order, trades=trade history',
        },
        symbol: { type: 'string', description: 'Required for all_orders, order_status, trades' },
        order_id: { type: 'number', description: 'Required for order_status' },
        limit: { type: 'number', description: 'Results limit (default: 100)' },
      },
      required: ['type'],
    },
  },
  // 26. Spot Order
  {
    name: 'execute_spot_order',
    description: 'Place a spot order: market buy/sell or limit order.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['market_buy', 'market_sell', 'limit_buy', 'limit_sell'],
          description: 'Order type. Market buy uses quote amount (USDT), others use base quantity.',
        },
        symbol: { type: 'string', description: 'Trading pair (e.g., BTCUSDT)' },
        amount: {
          type: 'number',
          description:
            'Quote amount for market_buy (e.g., 100 USDT), or base quantity for sell/limit orders',
        },
        price: { type: 'number', description: 'Limit price (required for limit orders)' },
        time_in_force: {
          type: 'string',
          enum: ['GTC', 'IOC', 'FOK', 'GTX'],
          description: 'Time in force for limit orders (default: GTC)',
        },
      },
      required: ['action', 'symbol', 'amount'],
    },
  },
  // 27. Cancel Spot Order
  {
    name: 'cancel_spot_order',
    description: 'Cancel spot order(s): single order or all orders for a symbol.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['single', 'all'],
          description: 'Cancel single order or all orders for symbol',
        },
        symbol: { type: 'string', description: 'Trading pair (e.g., BTCUSDT)' },
        order_id: { type: 'number', description: 'Order ID (required for single cancel)' },
      },
      required: ['action', 'symbol'],
    },
  },
  // 28. Spot-Perp Transfer
  {
    name: 'spot_transfer',
    description: 'Transfer assets between spot and perpetuals wallet.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['spot_to_perp', 'perp_to_spot'],
          description: 'Transfer direction',
        },
        asset: { type: 'string', description: 'Asset to transfer (e.g., USDT)' },
        amount: { type: 'number', description: 'Amount to transfer' },
      },
      required: ['direction', 'asset', 'amount'],
    },
  },
  // ==================== CRYPTO BASE SCANNER (QFL) TOOLS ====================
  // 29. CBS Cracked Bases
  {
    name: 'get_cbs_signals',
    description:
      'Get QFL base crack signals from Crypto Base Scanner. Shows bases that have been broken in the last 12 hours - prime buying opportunities. Returns top signals sorted by score (success rate * bounce potential).',
    inputSchema: {
      type: 'object',
      properties: {
        algorithm: {
          type: 'string',
          enum: ['original', 'day_trade', 'conservative', 'position'],
          description:
            'Trading algorithm: original (standard QFL), day_trade (quick scalps), conservative (strict filters), position (longer holds). Default: original',
        },
        limit: {
          type: 'number',
          description: 'Max signals to return (default: 15, max: 50). Sorted by quality score.',
        },
        min_volume_usd: {
          type: 'number',
          description: 'Minimum 24h volume in USD. Default: 1000',
        },
        min_success_rate: {
          type: 'number',
          description: 'Minimum success rate % (0-100). Default: 60',
        },
      },
      required: [],
    },
  },
  // 30. CBS Markets Near Base
  {
    name: 'get_cbs_markets',
    description:
      'Get markets approaching their base level - potential crack setups. Sorted by proximity to base.',
    inputSchema: {
      type: 'object',
      properties: {
        algorithm: {
          type: 'string',
          enum: ['original', 'day_trade', 'conservative', 'position'],
          description: 'Trading algorithm. Default: original',
        },
        exchange: {
          type: 'string',
          enum: ['BINA', 'KUCN', 'BTRX', 'PLNX', 'HITB'],
          description: 'Exchange to scan. Default: BINA (Binance)',
        },
        max_drop: {
          type: 'number',
          description:
            'Only show markets within X% of base (e.g., -5 = within 5% of base). Default: -10',
        },
        limit: {
          type: 'number',
          description: 'Max markets to return (default: 15, max: 50)',
        },
      },
      required: [],
    },
  },
  // 31. CBS Quick Scan
  {
    name: 'get_cbs_quick_scan',
    description:
      'Quick scan for recent price drops (5-30 min). Good for catching fast moves and fat finger opportunities.',
    inputSchema: {
      type: 'object',
      properties: {
        timeframe: {
          type: 'string',
          enum: ['5', '10', '15', '30'],
          description: 'Timeframe in minutes. Default: 15',
        },
        exchange: {
          type: 'string',
          enum: ['BINA', 'KUCN', 'BTRX', 'PLNX', 'HITB'],
          description: 'Exchange to scan. Default: BINA',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default: 15, max: 50)',
        },
      },
      required: [],
    },
  },
  // 32. CBS Algorithm Comparison
  {
    name: 'compare_cbs_algorithms',
    description:
      'Compare how different CBS algorithms view the same symbol. Shows base levels, success rates, and expected bounces for each algorithm.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Symbol to analyze (e.g., BTCUSDT)',
        },
        exchange: {
          type: 'string',
          enum: ['BINA', 'KUCN', 'BTRX', 'PLNX', 'HITB'],
          description: 'Exchange. Default: BINA',
        },
      },
      required: ['symbol'],
    },
  },
  // 33. Momentum Scanner - Find active pumps/dumps in progress
  {
    name: 'scan_momentum',
    description:
      'Find coins with ACTIVE momentum - already pumping or dumping with force. Unlike scan_for_pumps which catches early signals, this finds moves in progress. Great for momentum plays and squeeze detection.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['long', 'short', 'both'],
          description: 'long=pumping, short=dumping, both=all momentum (default: both)',
          default: 'both',
        },
        min_change: {
          type: 'number',
          description: 'Minimum absolute 24h change % to include (default: 5)',
          default: 5,
        },
        min_volume: {
          type: 'number',
          description: 'Minimum 24h volume in USD (default: 50000)',
          default: 50000,
        },
        limit: {
          type: 'number',
          description: 'Max results per category (default: 10)',
          default: 10,
        },
        output_format: {
          type: 'string',
          enum: ['json', 'csv', 'compact'],
          description:
            'Output format: "json" (full details), "csv" (minimal tabular), "compact" (essential fields only)',
          default: 'json',
        },
      },
      required: [],
    },
  },
  // 34. Liquidity Scanner - Analyze trade tape health for multiple symbols
  {
    name: 'scan_liquidity',
    description:
      'Scan trade tapes for liquidity health, bot patterns, and tradeability. Returns permissive scoring - flags issues but shows all results. Use to filter pump/breakout signals or evaluate new coins.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description:
            'List of symbols to analyze (e.g., ["BTCUSDT", "ETHUSDT"]). If not provided, scans top volume pairs.',
        },
        limit: {
          type: 'number',
          description: 'If no symbols provided, scan top N volume pairs (default: 20, max: 50)',
          default: 20,
        },
        min_score: {
          type: 'number',
          description: 'Only show results with score >= this value (default: 0 = show all)',
          default: 0,
        },
        sort_by: {
          type: 'string',
          enum: ['score', 'volume', 'bot_likelihood'],
          description: 'Sort results by this metric (default: score descending)',
          default: 'score',
        },
      },
      required: [],
    },
  },
  // 36. OBV (On-Balance Volume) Analysis
  {
    name: 'obv_analysis',
    description:
      'Multi-timeframe On-Balance Volume analysis. Detects accumulation/distribution through OBV trends and price/OBV divergences. Essential for confirming pump/dump signals - catches hidden accumulation (like BTR) or distribution masquerading as pumps. Returns OBV values, trends, and divergence alerts across 5m, 15m, 1h, 4h timeframes.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Trading pair symbol (e.g., BTCUSDT, MONUSDT)',
        },
        periods: {
          type: 'number',
          description: 'Number of candles per timeframe to analyze (default: 50)',
          default: 50,
        },
      },
      required: ['symbol'],
    },
  },
  // ==================== SCALEGRID TOOLS (Legacy - Hidden) ====================
  // 44. Deep Analysis - Comprehensive context for trading decisions
  {
    name: 'deep_analysis',
    description:
      'Comprehensive analysis combining VPVR, orderbook depth at key levels, trading session context, and BTC correlation. Use this for high-conviction trade decisions. Returns everything needed to assess a short/long setup.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Trading pair symbol (e.g., WETUSDT, FOLKSUSDT)',
        },
        timeframe: {
          type: 'string',
          enum: ['5m', '15m', '1h', '4h'],
          description: 'Candle timeframe for VPVR (default: 15m)',
          default: '15m',
        },
        periods: {
          type: 'number',
          description: 'Number of candles to analyze (default: 96 = 24h for 15m)',
          default: 96,
        },
      },
      required: ['symbol'],
    },
  },
  // 45. Market Regime Detection - BTC macro regime from Binance
  {
    name: 'get_market_regime',
    description:
      'Detect the current BTC market regime (bullish/bearish/neutral) using EMA crossovers and RSI momentum from Binance data. Returns regime with confidence score, suggested direction, panic detection, and reasoning. Use this to align your trades with macro conditions - trading against the regime significantly reduces edge.',
    inputSchema: {
      type: 'object',
      properties: {
        reset: {
          type: 'boolean',
          description:
            'Reset detector state and invalidate cache. Use after extended breaks or regime confusion.',
          default: false,
        },
        format: {
          type: 'string',
          enum: ['formatted', 'raw'],
          description:
            'Output format: "formatted" (default, human-readable with labels/emojis) or "raw" (exact RegimeState from evaluate(), machine-consumable)',
          default: 'formatted',
        },
      },
      required: [],
    },
  },
  // ==================== BINANCE CROSS-EXCHANGE TOOLS ====================
  // 46. Binance Sentiment - Top trader positioning and taker flow
  {
    name: 'get_binance_sentiment',
    description:
      'Get Binance-specific sentiment data: top trader long/short ratio, global L/S ratio, and taker buy/sell volume. Binance is the leading indicator - moves here often precede other exchanges. Use this to validate Aster signals.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Trading pair (e.g., BTCUSDT, ETHUSDT). Must be listed on Binance Futures.',
        },
        period: {
          type: 'string',
          enum: ['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'],
          description: 'Time period for ratio data. Default: 1h',
          default: '1h',
        },
        limit: {
          type: 'number',
          description: 'Number of data points to return. Default: 12',
          default: 12,
        },
      },
      required: ['symbol'],
    },
  },
  // 46. Cross-Exchange Volume Compare
  {
    name: 'compare_exchange_volume',
    description:
      'Compare volume, price, and open interest between Aster and Binance for the same pair. Identifies when Aster is lagging (opportunity) or leading (caution). Critical for pairs that look "dead" on Aster but active on Binance.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Trading pair (e.g., BTCUSDT). Must exist on both exchanges.',
        },
      },
      required: ['symbol'],
    },
  },
  // 47. Binance OI History - Open Interest trend over time
  {
    name: 'get_binance_oi_history',
    description:
      'Get Binance open interest history. Shows money flowing in/out over time. Rising OI + rising price = trend confirmation. Rising OI + falling price = short accumulation.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Trading pair (e.g., BTCUSDT)',
        },
        period: {
          type: 'string',
          enum: ['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'],
          description: 'Time period. Default: 1h',
          default: '1h',
        },
        limit: {
          type: 'number',
          description: 'Number of data points. Default: 24',
          default: 24,
        },
      },
      required: ['symbol'],
    },
  },
  // 48. Binance Funding Rate
  {
    name: 'get_binance_funding',
    description:
      'Get Binance funding rate and mark price. Compare with Aster funding for arbitrage opportunities.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Trading pair (e.g., BTCUSDT). Optional - returns all if omitted.',
        },
      },
      required: [],
    },
  },
  // 49. Cross-Exchange Scan - Find divergences
  {
    name: 'scan_exchange_divergence',
    description:
      'Scan for pairs where Binance and Aster show significant divergence in volume, OI, or funding. Finds opportunities where one exchange is leading.',
    inputSchema: {
      type: 'object',
      properties: {
        min_volume_ratio: {
          type: 'number',
          description:
            'Minimum Binance/Aster volume ratio to flag. Default: 10 (Binance 10x more volume)',
          default: 10,
        },
        limit: {
          type: 'number',
          description: 'Max pairs to return. Default: 15',
          default: 15,
        },
      },
      required: [],
    },
  },
  // 50. Accumulation Scanner - LEADING indicators using Binance as primary data source
  {
    name: 'scan_accumulation',
    description:
      'Detect early accumulation/distribution BEFORE price moves using Binance as primary data source. Uses LEADING indicators: OI change (real historical data), funding rate velocity, cross-exchange funding divergence, smart money positioning (top traders L/S), and taker flow. Much more predictive than lagging oscillators.',
    inputSchema: {
      type: 'object',
      properties: {
        min_score: {
          type: 'number',
          description: 'Minimum accumulation score to include (0-100). Default: 20',
          default: 20,
        },
        limit: {
          type: 'number',
          description: 'Max signals to return. Default: 15',
          default: 15,
        },
        lookback_hours: {
          type: 'number',
          description: 'Hours of history to analyze. Default: 24',
          default: 24,
        },
        mode: {
          type: 'string',
          enum: ['long', 'short', 'both'],
          description:
            'Signal direction: long (accumulation), short (distribution), both. Default: both',
          default: 'both',
        },
      },
      required: [],
    },
  },
  // 51. Funding Extremes Scanner - Find extreme single-exchange funding
  {
    name: 'scan_funding_extremes',
    description:
      'Find pairs with extreme funding rates on Aster that could indicate squeeze potential. Cross-references with Binance to identify divergence opportunities. Extreme negative funding = long squeeze potential, extreme positive = short squeeze.',
    inputSchema: {
      type: 'object',
      properties: {
        min_funding_bps: {
          type: 'number',
          description:
            'Minimum absolute funding rate in basis points (100 bps = 1%). Default: 50 (0.5%)',
          default: 50,
        },
        limit: {
          type: 'number',
          description: 'Max signals to return. Default: 15',
          default: 15,
        },
        include_binance_comparison: {
          type: 'boolean',
          description: 'Include Binance funding for comparison. Default: true',
          default: true,
        },
      },
      required: [],
    },
  },
  // 52. Binance Oracle Scanner - Comprehensive market scan using Binance as truth source
  {
    name: 'scan_binance_signals',
    description:
      'Scan ALL Aster-tradeable pairs using Binance as the data oracle. Combines institutional-grade signals: top trader positioning, real OI history, taker buy/sell flow, funding rates, and Binance kline volume analysis. Returns ranked, tiered signals you can execute on Aster. This is the primary scanner for finding high-conviction setups.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['long', 'short', 'both'],
          description:
            'Signal direction: long (buy setups), short (sell setups), both. Default: both',
          default: 'both',
        },
        min_score: {
          type: 'number',
          description: 'Minimum signal score to include (0-100). Default: 15',
          default: 15,
        },
        limit: {
          type: 'number',
          description: 'Max signals to return. Default: 20',
          default: 20,
        },
        min_volume: {
          type: 'number',
          description: 'Minimum Binance 24h volume in USD to consider. Default: 500000',
          default: 500000,
        },
        lookback_hours: {
          type: 'number',
          description: 'Hours of history to analyze for OI/flow trends. Default: 24',
          default: 24,
        },
        output_format: {
          type: 'string',
          enum: ['json', 'compact'],
          description: 'Output format: json (full) or compact (reduced tokens). Default: json',
          default: 'json',
        },
      },
      required: [],
    },
  },
];

// ==================== TECHNICAL INDICATORS ====================

interface Candle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

// Calculate RSI
function calculateRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Calculate Stochastic RSI
function calculateStochRSI(
  closes: number[],
  rsiPeriod: number = 14,
  stochPeriod: number = 14,
): number {
  if (closes.length < rsiPeriod + stochPeriod) return 50;

  const rsiValues: number[] = [];
  for (let i = rsiPeriod; i < closes.length; i++) {
    const slice = closes.slice(i - rsiPeriod, i + 1);
    rsiValues.push(calculateRSI(slice, rsiPeriod));
  }

  if (rsiValues.length < stochPeriod) return 50;

  const recentRSI = rsiValues.slice(-stochPeriod);
  const maxRSI = Math.max(...recentRSI);
  const minRSI = Math.min(...recentRSI);

  if (maxRSI === minRSI) return 50;

  const currentRSI = rsiValues[rsiValues.length - 1];
  return ((currentRSI - minRSI) / (maxRSI - minRSI)) * 100;
}

// Calculate MFI (Money Flow Index)
function calculateMFI(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 50;

  const typicalPrices: number[] = [];
  const moneyFlows: number[] = [];

  for (const candle of candles) {
    const high = parseFloat(candle.h);
    const low = parseFloat(candle.l);
    const close = parseFloat(candle.c);
    const volume = parseFloat(candle.v);
    const tp = (high + low + close) / 3;
    typicalPrices.push(tp);
    moneyFlows.push(tp * volume);
  }

  let posFlow = 0;
  let negFlow = 0;

  for (let i = candles.length - period; i < candles.length; i++) {
    if (i < 1) continue;
    if (typicalPrices[i] > typicalPrices[i - 1]) {
      posFlow += moneyFlows[i];
    } else {
      negFlow += moneyFlows[i];
    }
  }

  if (negFlow === 0) return 100;
  const moneyRatio = posFlow / negFlow;
  return 100 - 100 / (1 + moneyRatio);
}

// Calculate CMF (Chaikin Money Flow) - ranges from -1 to +1
// Positive = accumulation (buying pressure), Negative = distribution (selling pressure)
function calculateCMF(candles: Candle[], period: number = 20): number {
  if (candles.length < period) return 0;

  const recentCandles = candles.slice(-period);
  let mfvSum = 0;
  let volumeSum = 0;

  for (const c of recentCandles) {
    const high = parseFloat(c.h);
    const low = parseFloat(c.l);
    const close = parseFloat(c.c);
    const volume = parseFloat(c.v);

    // Money Flow Multiplier: ((Close - Low) - (High - Close)) / (High - Low)
    // Ranges from -1 (close at low) to +1 (close at high)
    const mfMultiplier = high !== low ? (close - low - (high - close)) / (high - low) : 0;

    // Money Flow Volume = MF Multiplier * Volume
    mfvSum += mfMultiplier * volume;
    volumeSum += volume;
  }

  // CMF = Sum(MFV) / Sum(Volume)
  return volumeSum > 0 ? mfvSum / volumeSum : 0;
}

/**
 * Calculate OBV (On-Balance Volume) with trend and divergence detection
 * OBV accumulates volume: +volume if close > prev close, -volume if close < prev close
 *
 * Returns:
 * - obvValues: Raw OBV time series
 * - trend: 'bullish' | 'bearish' | 'neutral' based on OBV slope
 * - divergence: Detects price/OBV divergence (hidden accumulation/distribution)
 */
function calculateOBV(candles: Candle[]): {
  obvValues: number[];
  currentOBV: number;
  trend: 'bullish' | 'bearish' | 'neutral';
  trendStrength: number; // 0-100
  divergence: 'bullish_divergence' | 'bearish_divergence' | 'none';
  divergenceNote: string;
  priceChange: number; // % change over period
  obvChange: number; // % change over period (normalized)
} {
  if (candles.length < 2) {
    return {
      obvValues: [],
      currentOBV: 0,
      trend: 'neutral',
      trendStrength: 0,
      divergence: 'none',
      divergenceNote: 'Insufficient data',
      priceChange: 0,
      obvChange: 0,
    };
  }

  // Calculate OBV series - start from 0 (standard approach)
  // This makes OBV values comparable across different time windows
  const obvValues: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    const prevClose = parseFloat(candles[i - 1].c);
    const currClose = parseFloat(candles[i].c);
    const volume = parseFloat(candles[i].v);

    if (currClose > prevClose) {
      obvValues.push(obvValues[i - 1] + volume);
    } else if (currClose < prevClose) {
      obvValues.push(obvValues[i - 1] - volume);
    } else {
      obvValues.push(obvValues[i - 1]);
    }
  }

  const currentOBV = obvValues[obvValues.length - 1];

  // Calculate trend using PROPER LINEAR REGRESSION on last 20 candles
  // Linear regression gives us slope AND R² (goodness of fit = trend strength)
  const trendPeriod = Math.min(20, obvValues.length);
  const recentOBV = obvValues.slice(-trendPeriod);

  // Linear regression: y = mx + b, where m = slope
  // slope = (n * Σxy - Σx * Σy) / (n * Σx² - (Σx)²)
  // R² = 1 - (SS_res / SS_tot) measures how well the line fits
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumX2 = 0;
  for (let i = 0; i < recentOBV.length; i++) {
    sumX += i;
    sumY += recentOBV[i];
    sumXY += i * recentOBV[i];
    sumX2 += i * i;
  }
  const n = recentOBV.length;
  const denominator = n * sumX2 - sumX * sumX;
  const obvSlope = denominator !== 0 ? (n * sumXY - sumX * sumY) / denominator : 0;

  // Calculate R² for trend strength (how consistent is the trend?)
  const yMean = sumY / n;
  const intercept = (sumY - obvSlope * sumX) / n;
  let ssTot = 0,
    ssRes = 0;
  for (let i = 0; i < recentOBV.length; i++) {
    const yPred = obvSlope * i + intercept;
    ssTot += Math.pow(recentOBV[i] - yMean, 2);
    ssRes += Math.pow(recentOBV[i] - yPred, 2);
  }
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

  // Trend strength is R² scaled to 0-100 (how clean is the trend line)
  const trendStrength = Math.min(100, r2 * 100);

  // Normalize slope for trend classification (scales with volume)
  const avgVolume = candles.reduce((sum, c) => sum + parseFloat(c.v), 0) / candles.length;
  const normalizedSlope = avgVolume > 0 ? obvSlope / avgVolume : 0;

  // Dynamic threshold based on trend strength: strong trends need less slope
  // Weak trends (low R²) need steeper slope to be classified
  const slopeThreshold = r2 > 0.5 ? 0.01 : 0.02;
  let trend: 'bullish' | 'bearish' | 'neutral';
  if (normalizedSlope > slopeThreshold) trend = 'bullish';
  else if (normalizedSlope < -slopeThreshold) trend = 'bearish';
  else trend = 'neutral';

  // Calculate price change using SAME window as OBV (trendPeriod)
  // This ensures we're comparing apples to apples for divergence detection
  const recentCandles = candles.slice(-trendPeriod);
  const startPrice = parseFloat(recentCandles[0].c);
  const endPrice = parseFloat(recentCandles[recentCandles.length - 1].c);
  const priceChange = startPrice > 0 ? ((endPrice - startPrice) / startPrice) * 100 : 0;

  // Calculate OBV change (normalized) - uses same trendPeriod window
  // This ensures price and OBV are looking at the same time period
  const recentStartOBV = recentOBV[0];
  const recentEndOBV = recentOBV[recentOBV.length - 1];
  const obvChange = avgVolume > 0 ? (recentEndOBV - recentStartOBV) / avgVolume : 0;

  // Calculate ATR for volatility-adjusted thresholds
  // True Range = max(high - low, abs(high - prevClose), abs(low - prevClose))
  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const high = parseFloat(candles[i].h);
    const low = parseFloat(candles[i].l);
    const prevClose = parseFloat(candles[i - 1].c);
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }

  // ATR as percentage of current price
  const atr =
    trueRanges.length > 0 ? trueRanges.reduce((sum, tr) => sum + tr, 0) / trueRanges.length : 0;
  const atrPct = endPrice > 0 ? (atr / endPrice) * 100 : 3; // Fallback to 3% if no price

  // Dynamic threshold: 1.5x ATR is a significant move
  // This means a 30% daily volatility coin needs ~4.5% move to trigger
  // While a 3% daily volatility coin needs ~0.45% move
  // Floor at 1% to avoid noise on very stable assets
  const significantMovePct = Math.max(1, atrPct * 1.5);

  // OBV threshold also scales - higher volatility = need stronger OBV signal
  const significantObvChange = Math.max(1.5, atrPct * 0.8);

  // Detect divergence using volatility-adjusted thresholds
  let divergence: 'bullish_divergence' | 'bearish_divergence' | 'none' = 'none';
  let divergenceNote = '';

  // Bullish divergence: Price down significantly, OBV up (hidden accumulation)
  if (priceChange < -significantMovePct && obvChange > significantObvChange) {
    divergence = 'bullish_divergence';
    divergenceNote = `HIDDEN ACCUMULATION: Price down ${priceChange.toFixed(1)}% (>${significantMovePct.toFixed(1)}% threshold) but OBV rising. Someone is buying the dip.`;
  }
  // Bearish divergence: Price up significantly, OBV down (hidden distribution)
  else if (priceChange > significantMovePct && obvChange < -significantObvChange) {
    divergence = 'bearish_divergence';
    divergenceNote = `HIDDEN DISTRIBUTION: Price up ${priceChange.toFixed(1)}% (>${significantMovePct.toFixed(1)}% threshold) but OBV falling. Smart money exiting.`;
  } else {
    divergenceNote = `No significant divergence (threshold: ${significantMovePct.toFixed(1)}% based on ${atrPct.toFixed(1)}% ATR)`;
  }

  return {
    obvValues,
    currentOBV,
    trend,
    trendStrength,
    divergence,
    divergenceNote,
    priceChange,
    obvChange,
  };
}

/**
 * Calculate Orderbook Imbalance from bid/ask data
 * @param bids Array of [price, quantity] bid levels
 * @param asks Array of [price, quantity] ask levels
 * @param levels Number of levels to analyze (default: 10 for top 10 levels)
 * @returns Imbalance object with ratio, pressure, and interpretation
 */
function calculateOrderbookImbalance(
  bids: [string, string][],
  asks: [string, string][],
  levels: number = 10,
): {
  imbalance: number; // -1 (all sell) to +1 (all buy)
  bidVolume: number; // Total bid volume in analyzed levels
  askVolume: number; // Total ask volume in analyzed levels
  pressure: 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell';
  spreadPct: number; // Bid-ask spread as percentage
} {
  const topBids = bids.slice(0, levels);
  const topAsks = asks.slice(0, levels);

  const bidVolume = topBids.reduce((sum, [_, qty]) => sum + parseFloat(qty), 0);
  const askVolume = topAsks.reduce((sum, [_, qty]) => sum + parseFloat(qty), 0);
  const totalVolume = bidVolume + askVolume;

  // Imbalance: (bids - asks) / (bids + asks) => -1 to +1
  const imbalance = totalVolume > 0 ? (bidVolume - askVolume) / totalVolume : 0;

  // Interpret pressure
  let pressure: 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell';
  if (imbalance > 0.4) pressure = 'strong_buy';
  else if (imbalance > 0.15) pressure = 'buy';
  else if (imbalance < -0.4) pressure = 'strong_sell';
  else if (imbalance < -0.15) pressure = 'sell';
  else pressure = 'neutral';

  // Calculate spread
  const bestBid = topBids.length > 0 ? parseFloat(topBids[0][0]) : 0;
  const bestAsk = topAsks.length > 0 ? parseFloat(topAsks[0][0]) : 0;
  const midPrice = (bestBid + bestAsk) / 2;
  const spreadPct = midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 100 : 0;

  return { imbalance, bidVolume, askVolume, pressure, spreadPct };
}

// Calculate Volume Ratio (current vs average)
// FIX #3: Require minimum baseline volume to avoid dead-pair edge cases returning 999x
// FIX #4: Use projected volume for current candle if interval provided
function calculateVolumeRatio(candles: Candle[], interval?: string): number {
  if (candles.length < 2) return 1;

  const lastCandle = candles[candles.length - 1];
  let currentVol = parseFloat(lastCandle.v);
  
  if (interval) {
    currentVol = calculateProjectedVolume({ t: lastCandle.t, v: lastCandle.v }, interval);
  }

  const volumes = candles.slice(0, -1).map(c => parseFloat(c.v));
  const avgVol = volumes.reduce((sum, v) => sum + v, 0) / volumes.length;

  // Require minimum baseline volume - dead pairs with near-zero history shouldn't spike to 999x
  const MIN_BASELINE_VOL = 100; // $100 minimum average volume baseline
  if (avgVol < MIN_BASELINE_VOL) return 0; // Mark as insufficient data instead of 999

  return currentVol / avgVol;
}

// Detect consolidation pattern
function isConsolidating(closes: number[], threshold: number = 0.03): boolean {
  if (closes.length < 10) return false;
  const recent = closes.slice(-10);
  const max = Math.max(...recent);
  const min = Math.min(...recent);
  const range = (max - min) / min;
  return range < threshold;
}

// Calculate VWAP (Volume Weighted Average Price)
function calculateVWAP(candles: Candle[]): number {
  if (candles.length === 0) return 0;

  let vwapNumerator = 0;
  let vwapDenominator = 0;

  for (const c of candles) {
    const high = parseFloat(c.h);
    const low = parseFloat(c.l);
    const close = parseFloat(c.c);
    const volume = parseFloat(c.v);
    const typicalPrice = (high + low + close) / 3;

    vwapNumerator += typicalPrice * volume;
    vwapDenominator += volume;
  }

  return vwapDenominator > 0 ? vwapNumerator / vwapDenominator : 0;
}

// Calculate Delta (Buy vs Sell pressure using intrabar strength)
function calculateDelta(candles: Candle[]): {
  delta: number;
  deltaPct: number;
  bias: 'buyers' | 'sellers' | 'neutral';
} {
  if (candles.length === 0) return { delta: 0, deltaPct: 0, bias: 'neutral' };

  let totalBuy = 0;
  let totalSell = 0;

  for (const c of candles) {
    const high = parseFloat(c.h);
    const low = parseFloat(c.l);
    const close = parseFloat(c.c);
    const volume = parseFloat(c.v);

    const candleRange = high - low;
    const buyRatio = candleRange > 0 ? (close - low) / candleRange : 0.5;

    totalBuy += volume * buyRatio;
    totalSell += volume * (1 - buyRatio);
  }

  const totalVolume = totalBuy + totalSell;
  const delta = totalBuy - totalSell;
  const deltaPct = totalVolume > 0 ? (delta / totalVolume) * 100 : 0;

  const bias = deltaPct > 10 ? 'buyers' : deltaPct < -10 ? 'sellers' : 'neutral';

  return { delta, deltaPct, bias };
}

/**
 * Calculate ADX (Average Directional Index) - measures trend strength
 * ADX < 20 = weak/no trend (choppy market)
 * ADX 20-40 = trending
 * ADX > 40 = strong trend
 * Used to filter out trend signals during choppy conditions
 */
function calculateADX(
  candles: Candle[],
  period: number = 14,
): {
  adx: number;
  plusDI: number;
  minusDI: number;
  trend: 'STRONG_TREND' | 'TRENDING' | 'WEAK' | 'NO_TREND';
} {
  if (candles.length < period + 1) {
    return { adx: 0, plusDI: 0, minusDI: 0, trend: 'NO_TREND' };
  }

  const trueRanges: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const high = parseFloat(candles[i].h);
    const low = parseFloat(candles[i].l);
    const prevHigh = parseFloat(candles[i - 1].h);
    const prevLow = parseFloat(candles[i - 1].l);
    const prevClose = parseFloat(candles[i - 1].c);

    // True Range
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);

    // Directional Movement
    const upMove = high - prevHigh;
    const downMove = prevLow - low;

    const plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;

    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
  }

  // Smooth using Wilder's smoothing (like RSI)
  let smoothedTR = trueRanges.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothedPlusDM = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothedMinusDM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);

  const dxValues: number[] = [];

  for (let i = period; i < trueRanges.length; i++) {
    smoothedTR = smoothedTR - smoothedTR / period + trueRanges[i];
    smoothedPlusDM = smoothedPlusDM - smoothedPlusDM / period + plusDMs[i];
    smoothedMinusDM = smoothedMinusDM - smoothedMinusDM / period + minusDMs[i];

    const plusDI = smoothedTR > 0 ? (smoothedPlusDM / smoothedTR) * 100 : 0;
    const minusDI = smoothedTR > 0 ? (smoothedMinusDM / smoothedTR) * 100 : 0;

    const diSum = plusDI + minusDI;
    const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
    dxValues.push(dx);
  }

  // ADX is smoothed DX
  if (dxValues.length < period) {
    return { adx: 0, plusDI: 0, minusDI: 0, trend: 'NO_TREND' };
  }

  let adx = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]) / period;
  }

  // Get current DI values
  const currentPlusDI = smoothedTR > 0 ? (smoothedPlusDM / smoothedTR) * 100 : 0;
  const currentMinusDI = smoothedTR > 0 ? (smoothedMinusDM / smoothedTR) * 100 : 0;

  // Classify trend strength
  let trend: 'STRONG_TREND' | 'TRENDING' | 'WEAK' | 'NO_TREND';
  if (adx >= 40) trend = 'STRONG_TREND';
  else if (adx >= 25) trend = 'TRENDING';
  else if (adx >= 15) trend = 'WEAK';
  else trend = 'NO_TREND';

  return { adx, plusDI: currentPlusDI, minusDI: currentMinusDI, trend };
}

/**
 * Calculate Z-Score for price change normalization
 * Answers: "Is this 5% move significant for THIS asset?"
 * A 5% move in SHIB is noise, 5% in BTC is massive
 *
 * @param changes Array of historical % changes (e.g., last 30 days of daily changes)
 * @param currentChange The current % change to evaluate
 * @returns Z-score and significance classification
 */
function calculateZScore(
  changes: number[],
  currentChange: number,
): {
  zScore: number;
  significance: 'EXTREME' | 'SIGNIFICANT' | 'NOTABLE' | 'NORMAL' | 'QUIET';
  description: string;
} {
  if (changes.length < 5) {
    return { zScore: 0, significance: 'NORMAL', description: 'Insufficient data' };
  }

  const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
  const squaredDiffs = changes.map(c => Math.pow(c - mean, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / changes.length;
  const stdDev = Math.sqrt(variance);

  // Avoid division by zero for stable assets
  if (stdDev < 0.1) {
    return {
      zScore: currentChange > mean ? 2 : -2,
      significance: Math.abs(currentChange) > 1 ? 'SIGNIFICANT' : 'NORMAL',
      description: 'Very stable asset',
    };
  }

  const zScore = (currentChange - mean) / stdDev;

  // Classify significance
  let significance: 'EXTREME' | 'SIGNIFICANT' | 'NOTABLE' | 'NORMAL' | 'QUIET';
  let description: string;

  const absZ = Math.abs(zScore);
  if (absZ >= 3) {
    significance = 'EXTREME';
    description = `${absZ.toFixed(1)}σ move - rare event (top 0.3%)`;
  } else if (absZ >= 2) {
    significance = 'SIGNIFICANT';
    description = `${absZ.toFixed(1)}σ move - unusual (top 5%)`;
  } else if (absZ >= 1.5) {
    significance = 'NOTABLE';
    description = `${absZ.toFixed(1)}σ move - above average`;
  } else if (absZ >= 0.5) {
    significance = 'NORMAL';
    description = 'Normal range movement';
  } else {
    significance = 'QUIET';
    description = 'Unusually quiet';
  }

  return { zScore, significance, description };
}

/**
 * Calculate rolling statistics for Z-score normalization
 * Returns array of historical % changes from candles
 */
function calculateHistoricalChanges(candles: Candle[]): number[] {
  if (candles.length < 2) return [];

  const changes: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prevClose = parseFloat(candles[i - 1].c);
    const currClose = parseFloat(candles[i].c);
    if (prevClose > 0) {
      changes.push(((currClose - prevClose) / prevClose) * 100);
    }
  }
  return changes;
}

// Determine price structure relative to VWAP
interface PriceStructure {
  vwap: number;
  priceVsVwap: 'above' | 'below' | 'at';
  vwapDistance: number; // percentage distance from VWAP
  deltaBias: 'buyers' | 'sellers' | 'neutral';
  deltaPct: number;
  structuralBias: 'bullish' | 'bearish' | 'neutral';
}

function analyzePriceStructure(candles: Candle[], currentPrice: number): PriceStructure {
  const vwap = calculateVWAP(candles);
  const { deltaPct, bias: deltaBias } = calculateDelta(candles);

  const vwapDistance = vwap > 0 ? ((currentPrice - vwap) / vwap) * 100 : 0;
  const priceVsVwap = vwapDistance > 0.5 ? 'above' : vwapDistance < -0.5 ? 'below' : 'at';

  // Structural bias: combines price position and delta
  let structuralBias: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  if (priceVsVwap === 'above' && deltaBias === 'buyers') structuralBias = 'bullish';
  else if (priceVsVwap === 'below' && deltaBias === 'sellers') structuralBias = 'bearish';
  else if (priceVsVwap === 'above' || deltaBias === 'buyers') structuralBias = 'bullish';
  else if (priceVsVwap === 'below' || deltaBias === 'sellers') structuralBias = 'bearish';

  return { vwap, priceVsVwap, vwapDistance, deltaBias, deltaPct, structuralBias };
}

// ==================== LIQUIDITY HEALTH ANALYSIS ====================

interface Trade {
  price: string;
  qty: string;
  isBuyerMaker: boolean;
  time: number;
}

interface LiquidityHealth {
  score: number; // 0-100, higher = healthier
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  flags: string[]; // Warning flags
  metrics: {
    trade_frequency: number; // trades per minute
    avg_trade_size: number; // average quantity
    size_variance: number; // coefficient of variation (0-1+)
    bot_likelihood: number; // 0-100
    dominant_lot_size: number | null; // if bot pattern detected
    side_imbalance: number; // -100 to +100 (negative = sell heavy)
    price_spread_pct: number; // estimated spread from trade prices
    time_span_minutes: number; // how much time the trades cover
  };
  tradeable: boolean;
  summary: string;
}

/**
 * Analyze liquidity health from recent trades
 * Returns permissive scoring - flags issues but doesn't hard filter
 */
function analyzeLiquidityHealth(trades: Trade[]): LiquidityHealth {
  const flags: string[] = [];
  let score = 100;

  // Handle empty/minimal trades
  if (!trades || trades.length < 5) {
    return {
      score: 10,
      grade: 'F',
      flags: ['⚠️ GHOST_TOWN: Insufficient trades (<5)'],
      metrics: {
        trade_frequency: 0,
        avg_trade_size: 0,
        size_variance: 0,
        bot_likelihood: 0,
        dominant_lot_size: null,
        side_imbalance: 0,
        price_spread_pct: 0,
        time_span_minutes: 0,
      },
      tradeable: false,
      summary: 'Ghost town - virtually no trading activity',
    };
  }

  // Parse trades
  const parsedTrades = trades.map(t => ({
    price: parseFloat(t.price),
    qty: parseFloat(t.qty),
    isSell: t.isBuyerMaker,
    time: t.time,
  }));

  // Time analysis
  const times = parsedTrades.map(t => t.time).sort((a, b) => a - b);
  const timeSpanMs = times[times.length - 1] - times[0];
  const timeSpanMinutes = Math.max(timeSpanMs / 60000, 0.1); // avoid division by 0
  const tradeFrequency = trades.length / timeSpanMinutes;

  // Size analysis
  const sizes = parsedTrades.map(t => t.qty);
  const avgSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  const sizeStdDev = Math.sqrt(
    sizes.reduce((sum, s) => sum + Math.pow(s - avgSize, 2), 0) / sizes.length,
  );
  const sizeVariance = avgSize > 0 ? sizeStdDev / avgSize : 0; // coefficient of variation

  // Bot pattern detection - look for repeated exact quantities
  const sizeCounts = new Map<string, number>();
  sizes.forEach(s => {
    const key = s.toFixed(4);
    sizeCounts.set(key, (sizeCounts.get(key) || 0) + 1);
  });

  // Find most common lot size
  let maxCount = 0;
  let dominantLotSize: number | null = null;
  sizeCounts.forEach((count, sizeStr) => {
    if (count > maxCount) {
      maxCount = count;
      dominantLotSize = parseFloat(sizeStr);
    }
  });

  const dominantLotPct = (maxCount / trades.length) * 100;

  // Bot likelihood calculation
  let botLikelihood = 0;

  // Factor 1: Same lot size repeated (strongest signal)
  if (dominantLotPct > 80) {
    botLikelihood += 60;
    flags.push(`🤖 BOT_PATTERN: ${dominantLotPct.toFixed(0)}% trades are ${dominantLotSize} lots`);
  } else if (dominantLotPct > 50) {
    botLikelihood += 30;
    flags.push(`⚙️ SYSTEMATIC: ${dominantLotPct.toFixed(0)}% trades are ${dominantLotSize} lots`);
  }

  // Factor 2: Low size variance (bots are consistent)
  if (sizeVariance < 0.1 && trades.length > 10) {
    botLikelihood += 25;
    if (dominantLotPct <= 50) flags.push('⚙️ LOW_VARIANCE: Suspiciously consistent trade sizes');
  } else if (sizeVariance < 0.3 && trades.length > 10) {
    botLikelihood += 10;
  }

  // Factor 3: Very regular timing (trades at exact intervals)
  if (trades.length >= 10) {
    const intervals: number[] = [];
    for (let i = 1; i < times.length; i++) {
      intervals.push(times[i] - times[i - 1]);
    }
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const intervalStdDev = Math.sqrt(
      intervals.reduce((sum, i) => sum + Math.pow(i - avgInterval, 2), 0) / intervals.length,
    );
    const intervalVariance = avgInterval > 0 ? intervalStdDev / avgInterval : 1;

    if (intervalVariance < 0.15 && avgInterval < 1000) {
      botLikelihood += 15;
      flags.push(`⏱️ CLOCK_PATTERN: Trades every ~${avgInterval.toFixed(0)}ms`);
    }
  }

  botLikelihood = Math.min(botLikelihood, 100);

  // Side imbalance
  const buyVolume = parsedTrades.filter(t => !t.isSell).reduce((sum, t) => sum + t.qty, 0);
  const sellVolume = parsedTrades.filter(t => t.isSell).reduce((sum, t) => sum + t.qty, 0);
  const totalVolume = buyVolume + sellVolume;
  const sideImbalance = totalVolume > 0 ? ((buyVolume - sellVolume) / totalVolume) * 100 : 0;

  // Price spread estimation
  const prices = parsedTrades.map(t => t.price);
  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
  const priceRange = Math.max(...prices) - Math.min(...prices);
  const priceSpreadPct = avgPrice > 0 ? (priceRange / avgPrice) * 100 : 0;

  // === SCORING (permissive - deduct but don't destroy) ===

  // Trade frequency scoring (lower = worse, but don't over-penalize)
  if (tradeFrequency < 0.1) {
    score -= 40;
    flags.push('🐌 VERY_SLOW: <0.1 trades/min');
  } else if (tradeFrequency < 0.5) {
    score -= 20;
    flags.push('🐢 SLOW: <0.5 trades/min');
  } else if (tradeFrequency < 1) {
    score -= 10;
  }

  // Bot likelihood penalty (mild - bots can still be tradeable)
  if (botLikelihood >= 70) {
    score -= 20;
  } else if (botLikelihood >= 40) {
    score -= 10;
  }

  // Time span penalty (if trades span hours, market is dead)
  if (timeSpanMinutes > 60) {
    score -= 30;
    flags.push(`💀 DEAD_MARKET: Trades span ${timeSpanMinutes.toFixed(0)} minutes`);
  } else if (timeSpanMinutes > 30) {
    score -= 15;
    flags.push(`😴 SLEEPY: Trades span ${timeSpanMinutes.toFixed(0)} minutes`);
  }

  // Wide spread penalty
  if (priceSpreadPct > 2) {
    score -= 15;
    flags.push(`📏 WIDE_SPREAD: ${priceSpreadPct.toFixed(2)}% price range`);
  } else if (priceSpreadPct > 1) {
    score -= 5;
  }

  // Extreme side imbalance
  if (Math.abs(sideImbalance) > 80) {
    score -= 5;
    flags.push(
      `⚖️ IMBALANCED: ${sideImbalance > 0 ? 'Buy' : 'Sell'} heavy (${Math.abs(sideImbalance).toFixed(0)}%)`,
    );
  }

  // Ensure score stays in bounds
  score = Math.max(0, Math.min(100, score));

  // Grade assignment
  let grade: 'A' | 'B' | 'C' | 'D' | 'F';
  if (score >= 80) grade = 'A';
  else if (score >= 60) grade = 'B';
  else if (score >= 40) grade = 'C';
  else if (score >= 20) grade = 'D';
  else grade = 'F';

  // Tradeable determination (permissive)
  const tradeable = score >= 20 && tradeFrequency >= 0.05;

  // Summary generation
  let summary: string;
  if (score >= 80) {
    summary = 'Healthy liquidity - organic flow detected';
  } else if (score >= 60) {
    summary = 'Decent liquidity - some concerns but tradeable';
  } else if (score >= 40) {
    summary = 'Thin liquidity - use limit orders, expect slippage';
  } else if (score >= 20) {
    summary = 'Poor liquidity - high risk, consider avoiding';
  } else {
    summary = 'Untradeable - ghost town or pure bot market';
  }

  if (botLikelihood >= 70) {
    summary += ' | Bot-dominated';
  }

  return {
    score,
    grade,
    flags,
    metrics: {
      trade_frequency: parseFloat(tradeFrequency.toFixed(2)),
      avg_trade_size: parseFloat(avgSize.toFixed(4)),
      size_variance: parseFloat(sizeVariance.toFixed(3)),
      bot_likelihood: parseFloat(botLikelihood.toFixed(0)),
      dominant_lot_size: dominantLotSize,
      side_imbalance: parseFloat(sideImbalance.toFixed(1)),
      price_spread_pct: parseFloat(priceSpreadPct.toFixed(3)),
      time_span_minutes: parseFloat(timeSpanMinutes.toFixed(1)),
    },
    tradeable,
    summary,
  };
}

// ==================== HANDLERS ====================

// --- 1. get_market_data ---
async function handleGetMarketData(
  type: string,
  symbol?: string,
  limit: number = 10,
): Promise<string> {
  if (type === 'price') {
    const res = await asterClient.getPrice(symbol);
    if (!res.success) return JSON.stringify({ error: res.error });
    if (symbol) return JSON.stringify({ s: res.data.symbol, p: res.data.price });
    return JSON.stringify({
      prices: (res.data as any[]).slice(0, limit).map(d => ({ s: d.symbol, p: d.price })),
    });
  }

  if (type === 'ticker') {
    const res = await asterClient.getTicker24h(symbol);
    if (!res.success) return JSON.stringify({ error: res.error });
    const fmt = (d: any) => ({
      s: d.symbol,
      p: d.lastPrice,
      chg: d.priceChangePercent,
      v: d.quoteVolume,
    });
    if (symbol) return JSON.stringify(fmt(res.data));
    return JSON.stringify({
      tickers: (res.data as any[])
        .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .slice(0, limit)
        .map(fmt),
    });
  }

  if (type === 'funding') {
    const res = await asterClient.getPremiumIndex(symbol);
    if (!res.success) return JSON.stringify({ error: res.error });
    const fmt = (d: any) => ({
      s: d.symbol,
      fr: d.lastFundingRate,
      mp: d.markPrice,
      next: d.nextFundingTime,
    });
    if (symbol) return JSON.stringify(fmt(res.data));
    // Sort by absolute funding rate descending
    const sorted = (res.data as any[]).sort(
      (a, b) => Math.abs(parseFloat(b.lastFundingRate)) - Math.abs(parseFloat(a.lastFundingRate)),
    );
    return JSON.stringify({ funding: sorted.slice(0, limit).map(fmt) });
  }

  if (type === 'orderbook') {
    if (!symbol) return JSON.stringify({ error: 'Symbol required for orderbook' });
    const res = await asterClient.getOrderBook(symbol, limit);
    if (!res.success || !res.data) return JSON.stringify({ error: res.error || 'No data' });
    return JSON.stringify({
      s: symbol,
      bids: res.data.bids?.slice(0, limit),
      asks: res.data.asks?.slice(0, limit),
    });
  }

  if (type === 'info') {
    const res = await asterClient.getExchangeInfo();
    if (!res.success || !res.data) return JSON.stringify({ error: res.error || 'No data' });
    return JSON.stringify({
      symbols: res.data.symbols.map((s: any) => s.symbol),
      count: res.data.symbols.length,
    });
  }

  if (type === 'summary') {
    // Reusing the logic from old get_market_summary
    const [tickerRes, fundRes] = await Promise.all([
      asterClient.getTicker24h(),
      asterClient.getPremiumIndex(),
    ]);
    if (!tickerRes.success) return JSON.stringify({ error: tickerRes.error });

    // Filter to tradeable symbols only (exclude SETTLING pairs like PORT3)
    const rawTickers = (tickerRes.data as any[]).filter(x => x);
    const t = await filterTradeableTickers(rawTickers);
    const f = Array.isArray(fundRes.data) ? fundRes.data : [fundRes.data];

    const topVol = [...t]
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 5)
      .map(x => ({ s: x.symbol, v: x.quoteVolume }));
    const topGain = [...t]
      .sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent))
      .slice(0, 3)
      .map(x => ({ s: x.symbol, chg: x.priceChangePercent }));

    return JSON.stringify({ top_volume: topVol, top_gainers: topGain, total_pairs: t.length });
  }

  return JSON.stringify({ error: 'Invalid type' });
}

// --- 2. get_klines ---
async function handleGetKlines(symbol: string, interval: string, limit: number): Promise<string> {
  const res = await asterClient.getKlines(symbol, interval, limit);
  if (!res.success || !res.data) return JSON.stringify({ error: res.error || 'No data' });
  return JSON.stringify({
    symbol,
    interval,
    klines: res.data.map((k: any) => ({
      t: k.openTime,
      o: k.open,
      h: k.high,
      l: k.low,
      c: k.close,
      v: k.volume,
    })),
  });
}

// --- 3. get_recent_trades ---
async function handleGetRecentTrades(symbol: string, limit: number): Promise<string> {
  const res = await asterClient.getRecentTrades(symbol, limit);
  if (!res.success || !res.data) return JSON.stringify({ error: res.error || 'No data' });
  return JSON.stringify({
    symbol,
    trades: res.data.map((t: any) => ({
      p: t.price,
      q: t.qty,
      side: t.isBuyerMaker ? 'SELL' : 'BUY',
      t: t.time,
    })),
  });
}

// --- 4. scan_markets ---
async function handleScanMarkets(
  sortBy: string,
  direction: string,
  limit: number,
  minVolume: number,
): Promise<string> {
  // Logic from old handleScanMarkets
  const [tickerRes, fundRes] = await Promise.all([
    asterClient.getTicker24h(),
    asterClient.getPremiumIndex(),
  ]);
  if (!tickerRes.success || !tickerRes.data)
    return JSON.stringify({ error: tickerRes.error || 'No ticker data' });

  // Filter to tradeable symbols only (exclude SETTLING pairs like PORT3)
  const rawTickers = tickerRes.data as any[];
  const tradeableTickers = await filterTradeableTickers(rawTickers);

  let items = tradeableTickers.map(t => {
    const f =
      (Array.isArray(fundRes.data) ? fundRes.data : []).find((x: any) => x.symbol === t.symbol) ||
      {};
    return {
      s: t.symbol,
      p: parseFloat(t.lastPrice),
      chg: parseFloat(t.priceChangePercent),
      vol: parseFloat(t.quoteVolume),
      fr: parseFloat((f as any).lastFundingRate || '0'),
      mp: parseFloat((f as any).markPrice || '0'),
    };
  });

  if (minVolume > 0) items = items.filter(x => x.vol >= minVolume);

  items.sort((a, b) => {
    let valA = 0,
      valB = 0;
    if (sortBy === 'funding') {
      valA = Math.abs(a.fr);
      valB = Math.abs(b.fr);
    } else if (sortBy === 'volume') {
      valA = a.vol;
      valB = b.vol;
    } else if (sortBy === 'change') {
      valA = Math.abs(a.chg);
      valB = Math.abs(b.chg);
    }
    return direction === 'asc' ? valA - valB : valB - valA;
  });

  return JSON.stringify({
    sort: sortBy,
    results: items.slice(0, limit).map(x => ({
      symbol: x.s,
      price: x.p,
      change: x.chg.toFixed(2) + '%',
      volume: (x.vol / 1000).toFixed(0) + 'k',
      funding: (x.fr * 100).toFixed(4) + '%',
    })),
  });
}

// --- 5. get_account_info ---
async function handleGetAccountInfo(
  type: string,
  symbol?: string,
  limit?: number,
  incomeType?: string,
): Promise<string> {
  if (!tradingEnabled) return JSON.stringify({ error: 'Trading not enabled' });

  if (type === 'balance') {
    const res = await asterTrading.getBalance();
    if (!res.success || !res.data) return JSON.stringify({ error: res.error || 'No data' });
    const bals = (Array.isArray(res.data) ? res.data : [res.data])
      .filter((b: any) => parseFloat(b.walletBalance) > 0)
      .map((b: any) => ({
        asset: b.asset,
        balance: b.walletBalance,
        available: b.crossWalletBalance,
      }));
    return JSON.stringify({ balances: bals });
  }

  if (type === 'positions') {
    const res = await asterTrading.getPositions(symbol);
    if (!res.success || !res.data) return JSON.stringify({ error: res.error || 'No data' });
    const pos = (res.data as any[])
      .filter((p: any) => parseFloat(p.positionAmt) !== 0)
      .map((p: any) => ({
        s: p.symbol,
        amt: p.positionAmt,
        entry: p.entryPrice,
        pnl: p.unRealizedProfit,
        lev: p.leverage,
      }));
    return JSON.stringify({ positions: pos });
  }

  if (type === 'open_orders') {
    const res = await asterTrading.getOpenOrders(symbol);
    if (!res.success || !res.data) return JSON.stringify({ error: res.error || 'No data' });
    return JSON.stringify({
      orders: (res.data as any[]).map((o: any) => ({
        id: o.orderId,
        s: o.symbol,
        side: o.side,
        type: o.type,
        q: o.origQty,
        p: o.price,
      })),
    });
  }

  if (type === 'position_mode') {
    const res = await asterTrading.getPositionMode();
    return JSON.stringify(res.data);
  }

  if (type === 'adl_risk') {
    const res = await asterTrading.getAdlQuantile(symbol);
    if (!res.success || !res.data) return JSON.stringify({ error: res.error || 'No data' });
    // ADL quantile: 1-5 where 5 = highest risk of auto-deleveraging
    const data = Array.isArray(res.data) ? res.data : [res.data];
    const formatted = data.map((d: any) => ({
      symbol: d.symbol,
      adl_long: d.adlQuantile?.LONG || d.LONG || 'N/A',
      adl_short: d.adlQuantile?.SHORT || d.SHORT || 'N/A',
      adl_hedge: d.adlQuantile?.HEDGE || d.HEDGE || 'N/A',
      adl_both: d.adlQuantile?.BOTH || d.BOTH || 'N/A',
      risk_note: 'ADL Quantile 1-5 (5=highest risk of auto-deleveraging)',
    }));
    return JSON.stringify({ adl_risk: formatted });
  }

  if (type === 'liquidations') {
    const res = await asterTrading.getForceOrders(symbol, limit || 50);
    if (!res.success) return JSON.stringify({ error: res.error || 'No data' });
    const data = res.data || [];
    const formatted = (Array.isArray(data) ? data : []).map((o: any) => ({
      symbol: o.symbol,
      side: o.side,
      type: o.autoCloseType, // LIQUIDATION or ADL
      qty: o.origQty,
      price: o.avgPrice,
      time: new Date(o.time).toISOString(),
      pnl: o.realizedPnl || 'N/A',
    }));
    return JSON.stringify({ liquidations: formatted, count: formatted.length });
  }

  if (type === 'pnl_history') {
    const res = await asterTrading.getIncomeHistory(symbol, incomeType, limit || 100);
    if (!res.success) return JSON.stringify({ error: res.error || 'No data' });
    const data = res.data || [];
    const formatted = (Array.isArray(data) ? data : []).map((i: any) => ({
      symbol: i.symbol,
      type: i.incomeType, // REALIZED_PNL, FUNDING_FEE, COMMISSION, TRANSFER
      income: i.income,
      asset: i.asset,
      time: new Date(i.time).toISOString(),
      info: i.info || '',
    }));
    // Calculate totals by type
    const totals: Record<string, number> = {};
    formatted.forEach((i: any) => {
      if (!totals[i.type]) totals[i.type] = 0;
      totals[i.type] += parseFloat(i.income) || 0;
    });
    return JSON.stringify({ pnl_history: formatted, totals, count: formatted.length });
  }

  if (type === 'leverage_brackets') {
    const res = await asterTrading.getLeverageBrackets(symbol);
    if (!res.success || !res.data) return JSON.stringify({ error: res.error || 'No data' });
    return JSON.stringify({ leverage_brackets: res.data });
  }

  return JSON.stringify({ error: 'Invalid type' });
}

// --- 6. execute_order ---
async function handleExecuteOrder(
  action: string,
  symbol: string,
  side: string,
  amount: number,
  price: string,
  leverage: number,
  params: any = {},
): Promise<string> {
  if (!tradingEnabled) return JSON.stringify({ error: 'Trading not enabled' });

  // Ensure leverage is set first if opening
  if (action === 'market_open' || action === 'limit') {
    await asterTrading.setLeverage(symbol, leverage);
  }

  if (action === 'market_open') {
    // Legacy openPosition handler
    const res = await asterTrading.openPosition({
      symbol,
      side: side as 'LONG' | 'SHORT',
      usdAmount: amount,
      leverage,
      stopLossPercent: params.stopLossPercent || 5,
      takeProfitPercent: params.takeProfitPercent,
      useTrailingTP: params.useTrailingTP,
      trailingCallbackPercent: params.callbackRate,
    });
    return JSON.stringify(res);
  }

  if (action === 'market_close') {
    const res = await asterTrading.closePosition(symbol);
    return JSON.stringify(res);
  }

  if (action === 'limit') {
    // Map side LONG/SHORT to BUY/SELL for limit orders if needed, or assume caller provides BUY/SELL
    // Typically limit orders need strictly BUY/SELL
    const orderSide = side === 'LONG' ? 'BUY' : side === 'SHORT' ? 'SELL' : side;
    const res = await asterTrading.placeLimitOrderAdvanced(
      symbol,
      orderSide as 'BUY' | 'SELL',
      amount.toString(),
      price,
      {
        timeInForce: params.timeInForce,
        reduceOnly: params.reduceOnly,
      },
    );
    return JSON.stringify(res);
  }

  if (action === 'stop_loss') {
    const res = await asterTrading.modifyStopLoss(symbol, price);
    return JSON.stringify(res);
  }

  if (action === 'trailing_stop') {
    const res = await asterTrading.setTrailingStop(symbol, params.callbackRate || 1, price);
    return JSON.stringify(res);
  }

  return JSON.stringify({ error: 'Invalid action' });
}

// --- 7. manage_orders ---
async function handleManageOrders(
  action: string,
  symbol: string,
  orderId?: string,
  orders?: any[],
  seconds?: number,
): Promise<string> {
  if (!tradingEnabled) return JSON.stringify({ error: 'Trading not enabled' });

  if (action === 'cancel_all') {
    const res = await asterTrading.cancelAllOrders(symbol);
    return JSON.stringify(res);
  }

  if (action === 'batch_place' && orders) {
    const res = await asterTrading.placeBatchOrders(orders);
    return JSON.stringify(res);
  }

  if (action === 'set_auto_cancel' && seconds !== undefined) {
    const res = await asterTrading.setAutoCancelCountdown(symbol, seconds * 1000);
    return JSON.stringify(res);
  }

  return JSON.stringify({ error: 'Invalid action or missing params' });
}

// --- 8. manage_strategy ---
async function handleManageStrategy(
  strategy: string,
  action: string,
  config: any,
): Promise<string> {
  if (!tradingEnabled && action === 'start')
    return JSON.stringify({ error: 'Trading not enabled' });
  initializeStrategies();

  if (strategy === 'funding_farm') {
    if (action === 'start') {
      return JSON.stringify(
        await fundingFarm!.autoFarm({
          symbol: config.symbol,
          positionSizeUsd: config.positionSizeUsd,
          leverage: config.leverage || 5,
          stopLossPercent: config.stopLossPercent || 3,
          minFundingRate: config.minFundingRate || 0.0003,
        }),
      );
    }
    if (action === 'stop')
      return JSON.stringify(await fundingFarm!.stop(config.closePositions !== false));
    if (action === 'status') {
      const s = fundingFarm!.getStatus();
      return JSON.stringify({ status: s.state.status, positions: s.activePositions.length });
    }
  }

  if (strategy === 'grid') {
    if (action === 'suggest_params') {
      return JSON.stringify(
        await gridTrading!.suggestGridParams(config.symbol, config.usdBudget, config.leverage || 5),
      );
    }
    if (action === 'start') {
      return JSON.stringify(
        await gridTrading!.start({
          symbol: config.symbol,
          lowerPrice: config.lowerPrice,
          upperPrice: config.upperPrice,
          gridLevels: config.gridLevels,
          quantityPerGrid: config.quantityPerGrid,
          leverage: config.leverage || 5,
        }),
      );
    }
    if (action === 'stop')
      return JSON.stringify(await gridTrading!.stop(config.closePositions !== false));
    if (action === 'status') {
      const s = gridTrading!.getStatus();
      return JSON.stringify({ status: s.state.status, active: !!s.grid });
    }
  }

  return JSON.stringify({ error: 'Unknown strategy or action' });
}

// --- 9. manage_stream ---
async function handleManageStream(
  action: string,
  type: string,
  symbol?: string,
  duration?: number,
): Promise<string> {
  // Logic from old stream handlers
  if (type === 'user') {
    if (!tradingEnabled) return JSON.stringify({ error: 'Trading not enabled' });
    if (action === 'start') {
      const k = await asterTrading.createListenKey();
      if (k.success && k.data?.listenKey) {
        currentListenKey = k.data.listenKey;
        await asterWs.connectUserDataStream(currentListenKey);
        // Setup keepalive
        if (listenKeyKeepAliveInterval) clearInterval(listenKeyKeepAliveInterval);
        listenKeyKeepAliveInterval = setInterval(
          () => asterTrading.keepAliveListenKey(currentListenKey!),
          30 * 60 * 1000,
        );
        return JSON.stringify({ success: true, msg: 'Stream started' });
      }
      return JSON.stringify({ error: 'Failed to create listen key' });
    }
    if (action === 'stop') {
      asterWs.disconnectUserDataStream();
      if (currentListenKey) await asterTrading.deleteListenKey(currentListenKey);
      currentListenKey = null;
      return JSON.stringify({ success: true, msg: 'Stream stopped' });
    }
    if (action === 'status') {
      return JSON.stringify({ connected: asterWs.isUserDataStreamConnected() });
    }
    if (action === 'collect_events' && duration) {
      if (!currentListenKey) return JSON.stringify({ error: 'Stream not running' });
      const events = await asterWs.collectUserDataEvents(currentListenKey, duration * 1000);
      return JSON.stringify({ events });
    }
  }

  if (type === 'market') {
    if (action === 'stream_orderbook' && symbol) {
      const msgs = await asterWs.streamForDuration(
        [`${symbol.toLowerCase()}@depth10`],
        (duration || 5) * 1000,
      );
      return JSON.stringify({ messages: msgs.length, last: msgs[msgs.length - 1] });
    }
    if (action === 'stream_prices') {
      const msgs = await asterWs.streamForDuration(['!markPrice@arr'], (duration || 3) * 1000);
      return JSON.stringify({ messages: msgs.length });
    }
  }

  return JSON.stringify({ error: 'Invalid stream params' });
}

// --- 10. manage_cache ---
function handleManageCache(action: string, key?: string): string {
  if (action === 'clear') {
    cache.clear();
    if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
    return JSON.stringify({ success: true, msg: 'Cache cleared' });
  }
  if (action === 'status') {
    return JSON.stringify({ size: cache.size, file: fs.existsSync(CACHE_FILE) });
  }
  if (action === 'get' && key) {
    const entry = getCache(key);
    return JSON.stringify(entry ? entry.data : null);
  }
  if (action === 'load') {
    return JSON.stringify({ success: loadCacheFromFile() });
  }
  return JSON.stringify({ error: 'Invalid action' });
}

// --- 11. manage_credentials ---
async function handleManageCredentials(
  action: string,
  key?: string,
  secret?: string,
): Promise<string> {
  if (action === 'set' && key && secret) {
    asterTrading.setCredentials(key, secret);
    tradingEnabled = true;
    credentialsSource = 'manual';
    return JSON.stringify({ success: true });
  }
  if (action === 'clear') {
    tradingEnabled = false;
    credentialManager.clearCache();
    return JSON.stringify({ success: true });
  }
  if (action === 'status') {
    return JSON.stringify({ tradingEnabled, source: credentialsSource });
  }
  return JSON.stringify({ error: 'Invalid action' });
}

// --- 12. calculate_position_size ---
// (Reusing logic from previous implementation, compacted)
async function handleCalculatePositionSize(
  symbol: string,
  riskPct: number,
  entry: number,
  stop: number,
): Promise<string> {
  if (!tradingEnabled) return JSON.stringify({ error: 'Trading not enabled' });
  const balRes = await asterTrading.getBalance();
  if (!balRes.success) return JSON.stringify({ error: 'Failed balance' });

  const usdt = (Array.isArray(balRes.data) ? balRes.data : [balRes.data]).find(
    (b: any) => b.asset === 'USDT',
  );
  const bal = parseFloat(usdt?.walletBalance || '0');
  if (bal <= 0) return JSON.stringify({ error: 'No balance' });

  const riskAmt = bal * (riskPct / 100);
  const priceDiff = Math.abs(entry - stop);
  const slPct = priceDiff / entry;
  if (slPct === 0) return JSON.stringify({ error: 'Invalid SL' });

  const posValue = riskAmt / slPct;
  const qty = posValue / entry;
  const lev = Math.ceil(posValue / bal);

  return JSON.stringify({ symbol, risk_usd: riskAmt, pos_value: posValue, qty, leverage_req: lev });
}

// --- 13. get_market_intelligence ---
async function handleGetMarketIntelligence(minVol: number = 0): Promise<string> {
  // Reusing logic (fetch tickers + funding + balance)
  const [tRes, fRes, bRes] = await Promise.all([
    asterClient.getTicker24h(),
    asterClient.getPremiumIndex(),
    tradingEnabled ? asterTrading.getBalance() : { success: false, data: null },
  ]);

  if (!tRes.success) return JSON.stringify({ error: 'Failed fetch' });

  // Filter to tradeable symbols only (exclude SETTLING pairs like PORT3)
  const rawTickers = (Array.isArray(tRes.data) ? tRes.data : [tRes.data]).filter(
    (x): x is any => !!x,
  );
  const tradeableTickers = await filterTradeableTickers(rawTickers);

  const fMap = new Map(
    (Array.isArray(fRes.data) ? fRes.data : [fRes.data]).map((x: any) => [x.symbol, x]),
  );
  let data = tradeableTickers.map((t: any) => {
    const f: any = fMap.get(t.symbol) || {};
    return {
      s: t.symbol,
      p: parseFloat(t.lastPrice),
      chg: parseFloat(t.priceChangePercent),
      v: parseFloat(t.quoteVolume),
      fr: parseFloat(f.lastFundingRate || '0'),
    };
  });

  if (minVol > 0) data = data.filter(d => d.v >= minVol);

  const gainers = [...data].sort((a, b) => b.chg - a.chg).slice(0, 5);
  const vol = [...data].sort((a, b) => b.v - a.v).slice(0, 5);
  const fundOpp = [...data]
    .filter(x => Math.abs(x.fr) > 0.0005)
    .sort((a, b) => Math.abs(b.fr) - Math.abs(a.fr))
    .slice(0, 5);

  let acct = null;
  if (bRes.success && bRes.data) {
    const b = (Array.isArray(bRes.data) ? bRes.data : [bRes.data]).find(
      (x: any) => x.asset === 'USDT',
    );
    acct = { balance: b?.walletBalance };
  }

  return JSON.stringify({ gainers, high_volume: vol, funding_opps: fundOpp, account: acct });
}

// --- 14. scan_for_pumps (with mode: long/short/both) ---
// OPTIMIZED: Parallel fetching, caching, pre-filtering, volume acceleration
async function handleScanForPumps(
  mode: 'long' | 'short' | 'both' = 'long',
  volumeMultiple: number = 5,
  minStochRSI: number = 50, // Lowered from 80 - neutral threshold, OR logic gate
  minMFI: number = 50, // Lowered from 60 - neutral threshold, OR logic gate
  interval: string = '15m',
  lookbackPeriods: number = 96, // Changed from 48 to match deep_analysis (24h vs 12h)
  limit: number = 10,
  minVolume: number = 1000,
  outputFormat: 'json' | 'csv' | 'compact' = 'json',
): Promise<string> {
  const scanStart = Date.now();
  const scanType = mode === 'both' ? 'PUMP+DUMP' : mode === 'short' ? 'DUMP' : 'PUMP';
  console.error(
    `[${scanType} Scanner] Starting optimized scan with ${volumeMultiple}x volume threshold...`,
  );

  // 1. Get all tickers with 24h volume AND funding rates (parallel)
  const [tickerRes, fundingRes] = await Promise.all([
    asterClient.getTicker24h(),
    asterClient.getPremiumIndex(),
  ]);

  if (!tickerRes.success || !tickerRes.data) {
    return JSON.stringify({ error: 'Failed to fetch tickers' });
  }

  // Build funding rate map
  const fundingMap = new Map<string, number>();
  if (fundingRes.success && fundingRes.data) {
    const fundingData = Array.isArray(fundingRes.data) ? fundingRes.data : [fundingRes.data];
    fundingData.forEach((f: any) => {
      fundingMap.set(f.symbol, parseFloat(f.lastFundingRate) || 0);
    });
  }

  // Filter by minimum volume and build pairs list - exclude non-tradeable pairs
  const rawTickers = Array.isArray(tickerRes.data) ? tickerRes.data : [tickerRes.data];
  const tradeableTickers = await filterTradeableTickers(rawTickers);
  let allPairs = tradeableTickers
    .filter((t: any) => parseFloat(t.quoteVolume) >= minVolume)
    .map((t: any) => ({
      symbol: t.symbol,
      price: parseFloat(t.lastPrice),
      volume24h: parseFloat(t.quoteVolume),
      change24h: parseFloat(t.priceChangePercent),
      fundingRate: fundingMap.get(t.symbol) || 0,
    }));

  // OPTIMIZATION: Pre-filter candidates to reduce API calls
  // Only fetch detailed klines for pairs showing some activity
  const avgChange = allPairs.reduce((sum, p) => sum + Math.abs(p.change24h), 0) / allPairs.length;
  const avgVolume = allPairs.reduce((sum, p) => sum + p.volume24h, 0) / allPairs.length;

  // Pre-filter: prioritize pairs with price movement OR above-average volume
  // This typically reduces pairs by 40-60% while keeping all interesting ones
  const pairs = allPairs.filter(
    p =>
      Math.abs(p.change24h) > avgChange * 0.3 || // Some price movement
      p.volume24h > avgVolume * 0.5 || // Above-average volume
      Math.abs(p.fundingRate) > 0.0003, // Significant funding rate
  );

  const filtered = allPairs.length - pairs.length;
  console.error(
    `[${scanType} Scanner] Pre-filtered ${filtered} inactive pairs, analyzing ${pairs.length}/${allPairs.length}...`,
  );

  // 2. OPTIMIZATION: Parallel kline fetching with batching
  const BATCH_SIZE = 15; // Optimal for rate limits
  let longSignals: any[] = [];
  let shortSignals: any[] = [];
  let analyzed = 0;
  let cacheHits = 0;

  // Process in batches
  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const batch = pairs.slice(i, i + BATCH_SIZE);

    // Fetch all klines for this batch in parallel
    const batchResults = await Promise.all(
      batch.map(async pair => {
        // Check cache first
        const cacheKey = `aster:${pair.symbol}:${interval}:${lookbackPeriods}`;
        const cached = klineCache.get(cacheKey);
        const ttl = KLINE_CACHE_TTL[interval] || 60_000;

        if (cached && Date.now() - cached.timestamp < ttl) {
          cacheHits++;
          return { pair, candles: cached.candles };
        }

        // Fetch from API
        const klineRes = await asterClient.getKlines(pair.symbol, interval, lookbackPeriods);
        if (!klineRes.success || !klineRes.data || klineRes.data.length < 20) {
          return { pair, candles: null };
        }

        // Cache the result
        klineCache.set(cacheKey, { candles: klineRes.data, timestamp: Date.now() });
        return { pair, candles: klineRes.data };
      }),
    );

    // Process batch results
    for (const { pair, candles: rawCandles } of batchResults) {
      if (!rawCandles) continue;

      try {
        const candles: Candle[] = rawCandles.map((k: any) => ({
          t: k.openTime,
          o: k.open,
          h: k.high,
          l: k.low,
          c: k.close,
          v: k.volume,
        }));

        // Calculate indicators
        const closes = candles.map(c => parseFloat(c.c));
        const volumeRatio = calculateVolumeRatio(candles, interval);
        const stochRSI = calculateStochRSI(closes);
        const mfi = calculateMFI(candles);
        const cmf = calculateCMF(candles); // Chaikin Money Flow (-1 to +1)
        const rsi = calculateRSI(closes);
        const consolidating = isConsolidating(closes);

        // NEW: ADX trend strength filter
        const adxData = calculateADX(candles);
        const isChoppy = adxData.trend === 'NO_TREND' || adxData.trend === 'WEAK';

        // NEW: Z-score for move significance
        const historicalChanges = calculateHistoricalChanges(candles);
        const zScoreData = calculateZScore(historicalChanges, pair.change24h);

        // OPTIMIZATION: Calculate volume acceleration
        const volAccel = calculateVolumeAcceleration(candles, interval);

        // NEW: Calculate price structure (VWAP, delta)
        const structure = analyzePriceStructure(candles, pair.price);

        // Calculate baseline volume
        const volumes = candles.slice(0, -1).map(c => parseFloat(c.v));
        const baselineVol = volumes.reduce((sum, v) => sum + v, 0) / volumes.length;
        const currentVol = parseFloat(candles[candles.length - 1].v);

        // Base signal data (with structure info)
        const signalBase = {
          symbol: pair.symbol,
          price: pair.price,
          volume_ratio: volumeRatio,
          volume_24h: pair.volume24h,
          baseline_vol: baselineVol,
          current_vol: currentVol,
          stoch_rsi: stochRSI,
          mfi: mfi,
          cmf: cmf, // Chaikin Money Flow: -1 to +1 (>0 = accumulation, <0 = distribution)
          rsi: rsi,
          change_24h: pair.change24h,
          funding_rate: pair.fundingRate,
          consolidating: consolidating,
          vol_acceleration: volAccel.acceleration,
          vol_trend: volAccel.trend,
          // NEW: Structure fields
          vwap: structure.vwap,
          price_vs_vwap: structure.priceVsVwap,
          delta_pct: structure.deltaPct,
          delta_bias: structure.deltaBias,
          structural_bias: structure.structuralBias,
          // NEW: ADX trend strength
          adx: adxData.adx,
          adx_trend: adxData.trend,
          plus_di: adxData.plusDI,
          minus_di: adxData.minusDI,
          is_choppy: isChoppy,
          // NEW: Z-score move significance
          z_score: zScoreData.zScore,
          move_significance: zScoreData.significance,
        };

        // Determine which signal type this pair should be (prevents duplicates)
        let primarySignal: 'long' | 'short' | 'none' = 'none';

        // IMPROVED LONG SIGNAL LOGIC (v2 - CMF GATING + WEIGHTED MOMENTUM):
        // Requirements for LONG:
        // 1. Volume spike (required)
        // 2. NOT dumping hard (change_24h > -5%)
        // 3. MFI not extremely low (MFI > 30 - low MFI = selling pressure)
        // 4. vol_trend not "declining"
        // 5. Structural bias not "bearish" OR very strong volume (10x+)
        // 6. NEW: CMF not negative (distribution = exit liquidity, not accumulation)
        if (mode === 'long' || mode === 'both') {
          const isHardDump = pair.change24h < -5;
          const mfiTooLow = mfi < 30; // MFI < 30 = strong selling pressure
          const volumeDeclining = volAccel.trend === 'declining';
          const structureBearish = structure.structuralBias === 'bearish';
          const hasVolumeSpike = volumeRatio >= volumeMultiple;
          const hasVeryStrongVolume = volumeRatio >= 10;

          // NEW: Significant mover gate - include pairs with big 24h gains even without current volume spike
          // This catches pumps IN PROGRESS, not just early signals
          const isSignificantMover = pair.change24h >= 10; // 10%+ gain = significant
          const isMajorMover = pair.change24h >= 20; // 20%+ gain = major (include even with weaker indicators)

          // CMF GATE: Negative CMF = distribution (sellers using volume spike as exit liquidity)
          // This is THE key filter for false pump signals - NO EXCEPTIONS for high volume
          // High volume + distribution = exit liquidity trap (whales dumping into retail FOMO)
          const isDistributing = cmf < -0.1;
          const isAccumulating = cmf > 0.1;

          // Disqualifiers for long signals - CMF gate with SMART OVERRIDE
          // Distribution is usually bad, BUT extreme volume + positive delta = institutional accumulation
          // The key insight: CMF can be negative short-term during accumulation phases
          // What matters is: Are buyers absorbing the selling? (positive delta confirms this)

          // FIX: Allow CMF override when we have MULTIPLE confirmations of buying pressure
          // 1. Extreme volume (10x+) = something significant happening
          // 2. Positive delta (>5%) = buyers are winning despite CMF
          // 3. OR major mover (20%+) = price action confirms direction
          const hasDeltaConfirmation = structure.deltaPct > 5; // Buyers dominating flow
          const hasExtremeVolume = volumeRatio >= 10;
          const cmfOverride = (hasExtremeVolume && hasDeltaConfirmation) || isMajorMover;

          const longDisqualified =
            isHardDump ||
            mfiTooLow ||
            (volumeDeclining && !isMajorMover) || // Relaxed for 20%+ movers
            (structureBearish && !hasVeryStrongVolume && !isMajorMover) ||
            (isDistributing && !cmfOverride); // Allow override for confirmed signals

          // EXPANDED GATE: Volume spike OR significant 24h move
          // This ensures we see big movers even if the current candle volume is normal
          const meetsEntryGate = (hasVolumeSpike || isSignificantMover) && !longDisqualified;

          if (meetsEntryGate) {
            // Determine signal phase - EARLY (volume spike) or IN_PROGRESS (already moving)
            const signalPhase = hasVolumeSpike ? 'EARLY' : 'IN_PROGRESS';
            // FIXED v2: Weighted average with ADAPTIVE threshold for big movers
            // For early signals (volume spike), we want confirmation: avg >= 50
            // For big movers (already +10-20%), oscillators LAG - they reset during consolidation
            // A coin up 30% with StochRSI 35 and MFI 40 is NOT bearish - it's consolidating mid-move
            const momentumScore = (stochRSI + mfi) / 2;

            // Adaptive threshold: stricter for early signals, relaxed for confirmed movers
            const momentumThreshold = isMajorMover
              ? 35 // 20%+ movers: oscillators lag badly
              : isSignificantMover
                ? 42 // 10%+ movers: some lag
                : 50; // Early signals: need confirmation
            const hasPositiveMomentum = momentumScore >= momentumThreshold;

            // Detect momentum divergence (one bullish, one bearish = warning)
            const momentumDiverging =
              (stochRSI >= 60 && mfi <= 40) || (stochRSI <= 40 && mfi >= 60);

            // Score bonuses/penalties
            const accelBonus =
              volAccel.trend === 'accelerating' ? 1.5 : volAccel.trend === 'increasing' ? 0.5 : 0;
            const structureBonus =
              structure.structuralBias === 'bullish'
                ? 1.5
                : structure.structuralBias === 'neutral'
                  ? 0
                  : -1;
            const changeBonus = pair.change24h > 0 ? 1 : pair.change24h > -2 ? 0 : -0.5;

            // CMF bonus is now LARGER when accumulating (gate already filtered distribution)
            const cmfBonus = isAccumulating ? 3.0 : cmf > 0 ? 1.5 : 0;

            // Funding bonus - negative funding (shorts paying longs) = bullish
            const fundingBonus = pair.fundingRate < -0.0001 ? 1.0 : 0;

            // Alignment bonus: reward when BOTH momentum indicators confirm
            const alignmentBonus = stochRSI >= 50 && mfi >= 50 ? 1.5 : 0;

            // NEW: Divergence penalty - momentum indicators disagreeing is a red flag
            const divergencePenalty = momentumDiverging ? -3.0 : 0;

            // NEW: ADX trend strength bonus/penalty
            // Strong trend (ADX > 25) = bonus, choppy market (ADX < 20) = penalty
            const adxBonus =
              adxData.adx >= 40
                ? 2.5
                : adxData.adx >= 25
                  ? 1.5
                  : adxData.adx >= 20
                    ? 0.5
                    : isChoppy
                      ? -2.0
                      : 0;

            // NEW: Z-score significance bonus - reward statistically significant moves
            const zScoreBonus =
              zScoreData.significance === 'EXTREME'
                ? 3.0
                : zScoreData.significance === 'SIGNIFICANT'
                  ? 2.0
                  : zScoreData.significance === 'NOTABLE'
                    ? 1.0
                    : 0;

            // NEW: Significant mover bonus - reward pairs with big moves
            // This makes IN_PROGRESS signals score comparably to EARLY signals
            const moverBonus = isMajorMover ? 4.0 : isSignificantMover ? 2.0 : 0;

            // REBALANCED SCORING: Momentum indicators now carry more weight than raw volume
            // Volume spike without momentum confirmation is often distribution (exit liquidity)
            // OLD: volumeRatio * 0.6 + momentum * 2 (volume dominated)
            // NEW: volumeRatio * 0.3 + momentum * 3 (momentum confirms volume)
            const longScore =
              volumeRatio * 0.3 +
              (stochRSI / 100) * 3 +
              (mfi / 100) * 3 +
              accelBonus +
              structureBonus +
              changeBonus +
              cmfBonus +
              fundingBonus +
              alignmentBonus +
              divergencePenalty +
              adxBonus +
              zScoreBonus +
              moverBonus;

            // Trigger requires: (volume spike OR significant move) + momentum + structure + NOT choppy
            // FIXED: Big movers can have low ADX during consolidation phases - don't filter them out
            const choppyOk = isMajorMover || isSignificantMover; // Price action > ADX for movers
            const wouldTriggerLong =
              (hasVolumeSpike || isSignificantMover) &&
              hasPositiveMomentum &&
              structure.structuralBias !== 'bearish' &&
              !momentumDiverging &&
              (choppyOk || !isChoppy);

            longSignals.push({
              ...signalBase,
              score: longScore,
              has_momentum: hasPositiveMomentum,
              momentum_threshold: momentumThreshold, // Track adaptive threshold used
              momentum_diverging: momentumDiverging,
              cmf_status: isAccumulating
                ? 'ACCUMULATING'
                : cmf > 0
                  ? 'NEUTRAL_BULLISH'
                  : cmfOverride
                    ? 'OVERRIDE_DELTA'
                    : 'NEUTRAL',
              cmf_override_used: cmfOverride && isDistributing, // Track when override saved a signal
              would_trigger: wouldTriggerLong,
              signal_type: 'LONG',
              signal_phase: signalPhase, // NEW: EARLY (volume spike) or IN_PROGRESS (24h gain)
              // Explain why this is a long
              long_reason: isMajorMover
                ? 'major_mover_20pct'
                : isSignificantMover
                  ? 'significant_mover_10pct'
                  : hasVeryStrongVolume
                    ? 'extreme_volume'
                    : isAccumulating
                      ? 'cmf_accumulation'
                      : pair.change24h > 0
                        ? 'price_rising'
                        : structure.structuralBias === 'bullish'
                          ? 'bullish_structure'
                          : 'volume_spike',
              // Warnings for lower conviction signals
              warning: isChoppy
                ? `CHOPPY_MARKET: ADX ${adxData.adx.toFixed(0)} - no clear trend`
                : momentumDiverging
                  ? 'MOMENTUM_DIVERGING: StochRSI and MFI disagree'
                  : undefined,
            });

            primarySignal = 'long';
          }
        }

        // IMPROVED SHORT SIGNAL LOGIC (v2 - CMF GATING + WEIGHTED MOMENTUM):
        // Only add to short if NOT already added to long
        if ((mode === 'short' || mode === 'both') && primarySignal !== 'long') {
          const isOversold = rsi < 30;
          const isDumping = pair.change24h < -5;
          const hasPositiveFunding = pair.fundingRate > 0.0001;
          const structureBearish = structure.structuralBias === 'bearish';
          const mfiWeak = mfi < 40;

          // CMF GATE for shorts: Accumulation (CMF > 0.1) invalidates short signals
          // Someone is buying despite price weakness = don't short into demand
          const isAccumulating = cmf > 0.1;
          const isDistributing = cmf < -0.1;

          // FIXED: Use weighted average instead of OR gate
          const momentumScore = (stochRSI + mfi) / 2;
          const hasNegativeMomentum = momentumScore <= 50;

          // Detect momentum divergence
          const momentumDiverging = (stochRSI >= 60 && mfi <= 40) || (stochRSI <= 40 && mfi >= 60);

          // Short score: volume + inverse momentum + funding squeeze + structure
          const structureBonus = structureBearish
            ? 1.5
            : structure.structuralBias === 'neutral'
              ? 0
              : -1;

          // Penalize oversold conditions - shorting at bottoms = bounce risk
          const oversoldPenalty = isOversold ? -2 : 0;

          // CMF bonus for shorts - distribution = bearish confirmation (gate filtered accumulation)
          const cmfBonus = isDistributing ? 3.0 : cmf < 0 ? 1.5 : 0;

          // Alignment bonus for shorts: reward when BOTH momentum indicators confirm weakness
          const alignmentBonus = stochRSI <= 50 && mfi <= 50 ? 1.5 : 0;

          // Divergence penalty
          const divergencePenalty = momentumDiverging ? -3.0 : 0;

          // NEW: ADX trend strength bonus/penalty (same as longs)
          const adxBonus =
            adxData.adx >= 40
              ? 2.5
              : adxData.adx >= 25
                ? 1.5
                : adxData.adx >= 20
                  ? 0.5
                  : isChoppy
                    ? -2.0
                    : 0;

          // NEW: Z-score significance bonus
          const zScoreBonus =
            zScoreData.significance === 'EXTREME'
              ? 3.0
              : zScoreData.significance === 'SIGNIFICANT'
                ? 2.0
                : zScoreData.significance === 'NOTABLE'
                  ? 1.0
                  : 0;

          const shortScore =
            volumeRatio * 0.4 +
            ((100 - stochRSI) / 100) * 2 +
            ((100 - mfi) / 100) * 2 +
            (hasPositiveFunding ? 1 : 0) +
            structureBonus +
            oversoldPenalty +
            cmfBonus +
            alignmentBonus +
            divergencePenalty +
            adxBonus +
            zScoreBonus;

          // Would trigger short: bearish structure + volume OR dump with crowded longs
          // NEW: Also require NOT choppy market (ADX filter)
          const wouldTriggerShort =
            !isAccumulating &&
            !momentumDiverging &&
            !isChoppy &&
            ((volumeRatio >= volumeMultiple && structureBearish && hasNegativeMomentum) ||
              (isDumping && hasPositiveFunding && volumeRatio >= 2));

          // Include if: volume spike + bearish indicators, OR dump + funding squeeze
          // NEW: CMF gate - don't include if accumulation detected
          const includeShort =
            !isAccumulating &&
            ((volumeRatio >= volumeMultiple && (structureBearish || mfiWeak)) ||
              (isDumping && hasPositiveFunding));

          if (includeShort) {
            shortSignals.push({
              ...signalBase,
              score: shortScore,
              has_momentum: hasNegativeMomentum,
              momentum_diverging: momentumDiverging,
              cmf_status: isDistributing ? 'DISTRIBUTING' : cmf < 0 ? 'NEUTRAL_BEARISH' : 'NEUTRAL',
              is_oversold: isOversold,
              is_dumping: isDumping,
              longs_crowded: hasPositiveFunding,
              would_trigger: wouldTriggerShort,
              signal_type: 'SHORT',
              // Explain why this is a short
              short_reason:
                hasPositiveFunding && isDumping
                  ? 'long_squeeze'
                  : isDistributing
                    ? 'cmf_distribution'
                    : structureBearish
                      ? 'bearish_structure'
                      : mfiWeak
                        ? 'weak_mfi'
                        : 'volume_distribution',
              // Warnings for lower conviction signals
              warning: isChoppy
                ? `CHOPPY_MARKET: ADX ${adxData.adx.toFixed(0)} - no clear trend`
                : momentumDiverging
                  ? 'MOMENTUM_DIVERGING: StochRSI and MFI disagree'
                  : undefined,
            });

            primarySignal = 'short';
          }
        }

        analyzed++;
      } catch (err) {
        continue;
      }
    }

    // Progress update per batch
    console.error(
      `[${scanType} Scanner] Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${analyzed} analyzed (${cacheHits} cache hits)...`,
    );
  }

  const scanDuration = Date.now() - scanStart;
  console.error(
    `[${scanType} Scanner] Complete in ${scanDuration}ms: ${longSignals.length} long + ${shortSignals.length} short from ${analyzed} pairs (${cacheHits} cached)`,
  );

  // ORDERBOOK DEPTH ENHANCEMENT PHASE
  // Fetch orderbook depth for top candidates to add liquidity context
  // This catches thin books that look good on indicators but can't be traded
  const TOP_CANDIDATES = Math.min(limit * 3, 30); // Check more than we need
  const OB_BATCH_SIZE = 5; // Reduced batch size to avoid rate limits
  const OB_BATCH_DELAY_MS = 200; // Delay between batches
  const OB_MAX_RETRIES = 2; // Retry failed calls

  // Helper: fetch orderbook with retry logic
  const fetchOrderbookWithRetry = async (
    symbol: string,
    retries: number = OB_MAX_RETRIES,
  ): Promise<{ symbol: string; data: any; error?: string }> => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const obRes = await asterClient.getOrderBook(symbol, 20);
        if (obRes.success && obRes.data) {
          return { symbol, data: obRes.data };
        }
        // API returned error
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 100 * (attempt + 1))); // Backoff
          continue;
        }
        return { symbol, data: null, error: obRes.error || 'API returned no data' };
      } catch (err: any) {
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 100 * (attempt + 1))); // Backoff
          continue;
        }
        return { symbol, data: null, error: err.message || 'Exception thrown' };
      }
    }
    return { symbol, data: null, error: 'Max retries exceeded' };
  };

  // Combine and sort all signals to pick top candidates
  const allSignalsForOB = [...longSignals, ...shortSignals]
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_CANDIDATES);

  let obSuccessCount = 0;
  let obFailCount = 0;
  const obErrors: string[] = [];

  if (allSignalsForOB.length > 0) {
    console.error(
      `[${scanType} Scanner] Enhancing top ${allSignalsForOB.length} signals with orderbook depth (batch=${OB_BATCH_SIZE}, delay=${OB_BATCH_DELAY_MS}ms)...`,
    );

    // Process in batches to respect rate limits
    for (let i = 0; i < allSignalsForOB.length; i += OB_BATCH_SIZE) {
      const batch = allSignalsForOB.slice(i, i + OB_BATCH_SIZE);

      // Add delay between batches (except first)
      if (i > 0) {
        await new Promise(r => setTimeout(r, OB_BATCH_DELAY_MS));
      }

      const obResults = await Promise.all(
        batch.map(signal => fetchOrderbookWithRetry(signal.symbol)),
      );

      // Process results and update signals
      for (const result of obResults) {
        if (!result.data) {
          obFailCount++;
          if (result.error) {
            obErrors.push(`${result.symbol}: ${result.error}`);
          }
          continue;
        }
        obSuccessCount++;

        const bids = result.data.bids || [];
        const asks = result.data.asks || [];

        if (bids.length === 0 || asks.length === 0) continue;

        // Calculate depth in USD (top 10 levels)
        const bidDepthUsd = bids
          .slice(0, 10)
          .reduce(
            (sum: number, [price, qty]: [string, string]) =>
              sum + parseFloat(price) * parseFloat(qty),
            0,
          );
        const askDepthUsd = asks
          .slice(0, 10)
          .reduce(
            (sum: number, [price, qty]: [string, string]) =>
              sum + parseFloat(price) * parseFloat(qty),
            0,
          );

        // Calculate spread
        const bestBid = parseFloat(bids[0][0]);
        const bestAsk = parseFloat(asks[0][0]);
        const midPrice = (bestBid + bestAsk) / 2;
        const spreadPct = ((bestAsk - bestBid) / midPrice) * 100;

        // Calculate imbalance: -1 (all asks) to +1 (all bids)
        const totalDepth = bidDepthUsd + askDepthUsd;
        const rawImbalance = totalDepth > 0 ? (bidDepthUsd - askDepthUsd) / totalDepth : 0;

        // Determine pressure direction
        const pressure = rawImbalance > 0.2 ? 'BUY' : rawImbalance < -0.2 ? 'SELL' : 'NEUTRAL';

        // Find all matching signals (could be in longSignals or shortSignals)
        const updateSignal = (signals: any[]) => {
          const signal = signals.find(s => s.symbol === result.symbol);
          if (!signal) return;

          // Store orderbook metrics
          signal.ob_imbalance = rawImbalance;
          signal.ob_spread_pct = spreadPct;
          signal.ob_pressure = pressure;
          signal.ob_bid_depth = bidDepthUsd;
          signal.ob_ask_depth = askDepthUsd;

          // Check if orderbook aligns with signal direction
          const isLong = signal.signal_type === 'LONG';
          signal.ob_aligned = isLong ? rawImbalance > -0.1 : rawImbalance < 0.1;

          // Score adjustments based on orderbook
          let obBonus = 0;

          // Alignment bonus/penalty
          if (isLong) {
            if (rawImbalance > 0.3)
              obBonus += 2; // Strong bid support for long
            else if (rawImbalance < -0.3) obBonus -= 2; // Heavy asks = resistance
          } else {
            if (rawImbalance < -0.3)
              obBonus += 2; // Heavy asks support short
            else if (rawImbalance > 0.3) obBonus -= 2; // Strong bids = support
          }

          // Thin orderbook penalty (critical for tradeability)
          if (totalDepth < 5000) {
            obBonus -= 4; // Very thin - likely untradeable
            signal.ob_warning = 'VERY_THIN_BOOK';
          } else if (totalDepth < 20000) {
            obBonus -= 2; // Thin - high slippage expected
            signal.ob_warning = 'THIN_BOOK';
          } else if (totalDepth < 50000) {
            obBonus -= 1; // Below average depth
          } else if (totalDepth > 200000) {
            obBonus += 1; // Deep book - good liquidity
          }

          // Wide spread penalty
          if (spreadPct > 0.5) {
            obBonus -= 2; // Spread > 0.5% = significant cost
            signal.ob_warning = signal.ob_warning
              ? signal.ob_warning + '_WIDE_SPREAD'
              : 'WIDE_SPREAD';
          } else if (spreadPct > 0.2) {
            obBonus -= 1;
          }

          signal.ob_score_adj = obBonus;
          signal.score += obBonus;
        };

        updateSignal(longSignals);
        updateSignal(shortSignals);
      }
    }

    // Log detailed results
    console.error(
      `[${scanType} Scanner] Orderbook enhancement complete: ${obSuccessCount}/${allSignalsForOB.length} success, ${obFailCount} failed`,
    );
    if (obErrors.length > 0) {
      console.error(
        `[${scanType} Scanner] Orderbook errors (first 5): ${obErrors.slice(0, 5).join(' | ')}`,
      );
    }
  }

  // BINANCE VALIDATION PHASE
  // For top signals, cross-reference with Binance institutional data to filter false positives
  // This catches wash trading on Aster and validates real demand
  const BV_CANDIDATES = Math.min(limit * 2, 20);
  const allSignalsForBV = [...longSignals, ...shortSignals]
    .sort((a, b) => b.score - a.score)
    .slice(0, BV_CANDIDATES);

  // Get Binance symbols for intersection check
  let binanceSymbolSetForPumps: Set<string> | null = null;
  try {
    const bSymRes = await binanceClient.getSymbols();
    if (bSymRes.success && bSymRes.data) {
      binanceSymbolSetForPumps = new Set(bSymRes.data);
    }
  } catch {
    /* graceful fallback */
  }

  if (binanceSymbolSetForPumps && allSignalsForBV.length > 0) {
    const binanceValidatable = allSignalsForBV.filter(s => binanceSymbolSetForPumps!.has(s.symbol));
    console.error(
      `[${scanType} Scanner] Binance validation: ${binanceValidatable.length}/${allSignalsForBV.length} signals on Binance`,
    );

    const BV_BATCH_SIZE = 5;
    for (let i = 0; i < binanceValidatable.length; i += BV_BATCH_SIZE) {
      const batch = binanceValidatable.slice(i, i + BV_BATCH_SIZE);

      const bvResults = await Promise.all(
        batch.map(async signal => {
          try {
            const [bTakerRes, bTopLSRes] = await Promise.all([
              binanceClient.getTakerBuySellVolume(signal.symbol, '15m' as any, 6),
              binanceClient.getTopLongShortRatio(signal.symbol, '1h' as any, 6),
            ]);

            let takerBuyRatio = 0.5;
            if (bTakerRes.success && bTakerRes.data && bTakerRes.data.length > 0) {
              const recentTaker = bTakerRes.data.slice(-4);
              const buyVol = recentTaker.reduce(
                (s: number, d: any) => s + parseFloat(d.buyVol || '0'),
                0,
              );
              const sellVol = recentTaker.reduce(
                (s: number, d: any) => s + parseFloat(d.sellVol || '0'),
                0,
              );
              const total = buyVol + sellVol;
              takerBuyRatio = total > 0 ? buyVol / total : 0.5;
            }

            let topTraderLS = 1;
            if (bTopLSRes.success && bTopLSRes.data && bTopLSRes.data.length > 0) {
              topTraderLS = parseFloat(
                bTopLSRes.data[bTopLSRes.data.length - 1].longShortRatio || '1',
              );
            }

            return { symbol: signal.symbol, takerBuyRatio, topTraderLS };
          } catch {
            return null;
          }
        }),
      );

      for (const bv of bvResults) {
        if (!bv) continue;

        // Find and update the signal in both arrays
        const updateWithBinance = (signals: any[]) => {
          const signal = signals.find(s => s.symbol === bv.symbol);
          if (!signal) return;

          const isLong = signal.signal_type === 'LONG';
          signal.binance_taker_buy = bv.takerBuyRatio;
          signal.binance_top_ls = bv.topTraderLS;

          let bvAdj = 0;

          // Validation 1: Pump signal but Binance takers are net selling = EXIT LIQUIDITY
          if (isLong && bv.takerBuyRatio < 0.44) {
            bvAdj -= 4;
            signal.binance_warning = 'EXIT_LIQUIDITY';
          } else if (!isLong && bv.takerBuyRatio > 0.56) {
            bvAdj -= 4;
            signal.binance_warning = 'BUYING_INTO_SHORT';
          }

          // Validation 2: Pump signal confirmed by Binance taker flow
          if (isLong && bv.takerBuyRatio > 0.56) {
            bvAdj += 3;
            signal.binance_confirmed = 'INSTITUTIONAL_FLOW';
          } else if (!isLong && bv.takerBuyRatio < 0.44) {
            bvAdj += 3;
            signal.binance_confirmed = 'INSTITUTIONAL_FLOW';
          }

          // Validation 3: Top traders aligned or opposing
          if (isLong && bv.topTraderLS > 1.4) {
            bvAdj += 2;
            signal.binance_smart_money = 'ALIGNED';
          } else if (isLong && bv.topTraderLS < 0.7) {
            bvAdj -= 3;
            signal.binance_smart_money = 'OPPOSING';
          } else if (!isLong && bv.topTraderLS < 0.7) {
            bvAdj += 2;
            signal.binance_smart_money = 'ALIGNED';
          } else if (!isLong && bv.topTraderLS > 1.4) {
            bvAdj -= 3;
            signal.binance_smart_money = 'OPPOSING';
          }

          signal.binance_score_adj = bvAdj;
          signal.score += bvAdj;
        };

        updateWithBinance(longSignals);
        updateWithBinance(shortSignals);
      }
    }
  }

  // Format signals for output (Lean/Raw Format)
  const formatSignalLean = (s: any) => ({
    symbol: s.symbol,
    price: s.price,
    score: Number(s.score.toFixed(2)),
    side: s.signal_type,
    reason: s.long_reason || s.short_reason,
    trigger: s.would_trigger,
    metrics: {
      volume_ratio: Number(s.volume_ratio.toFixed(2)),
      volume_24h: s.volume_24h,
      change_24h: s.change_24h,
      funding: s.funding_rate,
      stoch_rsi: Number(s.stoch_rsi.toFixed(1)),
      mfi: Number(s.mfi.toFixed(1)),
      cmf: Number(s.cmf.toFixed(3)),
      rsi: Number(s.rsi.toFixed(1)),
      adx: s.adx ? Number(s.adx.toFixed(0)) : null,
    },
    structure: {
      trend: s.structural_bias,
      vwap_pos: s.price_vs_vwap,
      delta_bias: s.delta_bias,
    },
    flags: {
      is_choppy: s.is_choppy,
      momentum_diverging: s.momentum_diverging,
      is_oversold: s.is_oversold,
      longs_crowded: s.longs_crowded,
    },
    // Orderbook depth analysis
    orderbook:
      s.ob_imbalance !== undefined
        ? {
            imbalance: Number(s.ob_imbalance.toFixed(2)),
            spread: Number(s.ob_spread_pct.toFixed(3)),
            pressure: s.ob_pressure,
            aligned: s.ob_aligned,
            bid_depth_usd: s.ob_bid_depth ? Math.round(s.ob_bid_depth) : null,
            ask_depth_usd: s.ob_ask_depth ? Math.round(s.ob_ask_depth) : null,
            warning: s.ob_warning || null,
          }
        : null,
    // Binance validation (when available)
    binance_validation:
      s.binance_taker_buy !== undefined
        ? {
            taker_buy_pct: `${(s.binance_taker_buy * 100).toFixed(1)}%`,
            top_trader_ls: s.binance_top_ls?.toFixed(2),
            smart_money: s.binance_smart_money || null,
            flow_confirmed: s.binance_confirmed || null,
            warning: s.binance_warning || null,
            score_adj: s.binance_score_adj || 0,
          }
        : null,
    // Liquidity health
    liquidity: s.liquidity_grade
      ? {
          grade: s.liquidity_grade,
          score: s.liquidity_score,
        }
      : undefined,
  });

  // Re-sort after score adjustment
  longSignals.sort((a, b) => b.score - a.score);
  shortSignals.sort((a, b) => b.score - a.score);

  // HARD FILTER 1: Remove bot-washed pairs
  const filterBotWash = (signals: any[]) =>
    signals.filter(s => {
      if (s.liquidity_grade === 'F') return false;
      if (s.bot_likelihood >= 80) return false;
      return true;
    });
  longSignals = filterBotWash(longSignals);
  shortSignals = filterBotWash(shortSignals);

  // HARD FILTER 2: Remove signals with strongly opposing orderbook
  const filterOpposingOrderbook = (signals: any[], direction: 'LONG' | 'SHORT') =>
    signals.filter(s => {
      if (s.ob_imbalance === undefined) return true;
      if (direction === 'LONG' && s.ob_imbalance < -0.5) return false;
      if (direction === 'SHORT' && s.ob_imbalance > 0.5) return false;
      return true;
    });
  longSignals = filterOpposingOrderbook(longSignals, 'LONG');
  shortSignals = filterOpposingOrderbook(shortSignals, 'SHORT');

  // Build combined signals list
  let signals: any[] = [];
  if (mode === 'long' || mode === 'both') signals = signals.concat(longSignals.slice(0, limit));
  if (mode === 'short' || mode === 'both') signals = signals.concat(shortSignals.slice(0, limit));

  // JSON FORMAT (Lean)
  const regimeBlock = await getCompactRegimeBlock();
  return JSON.stringify(
    {
      market_regime: regimeBlock,
      signals: signals.map(formatSignalLean),
    },
    null,
    2,
  );
}

// --- 15. scan_for_pumps_hl (Hyperliquid) ---
// OPTIMIZED: Parallel fetching, caching, pre-filtering, volume acceleration
async function handleScanForPumpsHL(
  volumeMultiple: number = 5,
  minStochRSI: number = 50, // Lowered to match Aster scanner
  minMFI: number = 50, // Lowered to match Aster scanner
  interval: string = '15m',
  lookbackPeriods: number = 48,
  limit: number = 10,
  minVolume: number = 1000,
): Promise<string> {
  const scanStart = Date.now();
  console.error(
    `[Hyperliquid Scanner] Starting optimized scan with ${volumeMultiple}x volume threshold...`,
  );

  // 1. Get all tickers with 24h volume from Hyperliquid
  const tickerRes = await hyperliquidClient.getTicker24h();
  if (!tickerRes.success || !tickerRes.data) {
    return JSON.stringify({
      error: 'Failed to fetch Hyperliquid tickers',
      details: tickerRes.error,
    });
  }

  // Filter by minimum volume and build pairs list
  let allPairs = (Array.isArray(tickerRes.data) ? tickerRes.data : [tickerRes.data])
    .filter((t: any) => parseFloat(t.volume) >= minVolume)
    .map((t: any) => ({
      symbol: t.symbol,
      price: parseFloat(t.lastPrice),
      volume24h: parseFloat(t.volume),
      change24h: parseFloat(t.priceChangePercent),
      fundingRate: t.fundingRate,
      openInterest: parseFloat(t.openInterest || '0'), // OI comes free with HL market data
    }));

  // OPTIMIZATION: Pre-filter candidates
  const avgChange = allPairs.reduce((sum, p) => sum + Math.abs(p.change24h), 0) / allPairs.length;
  const avgVolume = allPairs.reduce((sum, p) => sum + p.volume24h, 0) / allPairs.length;

  const pairs = allPairs.filter(
    p =>
      Math.abs(p.change24h) > avgChange * 0.3 ||
      p.volume24h > avgVolume * 0.5 ||
      (p.fundingRate && Math.abs(parseFloat(p.fundingRate) || 0) > 0.0003),
  );

  const filtered = allPairs.length - pairs.length;
  console.error(
    `[Hyperliquid Scanner] Pre-filtered ${filtered} inactive pairs, analyzing ${pairs.length}/${allPairs.length}...`,
  );

  // 2. OPTIMIZATION: Parallel kline fetching with batching
  const BATCH_SIZE = 15;
  const signals: any[] = [];
  let analyzed = 0;
  let cacheHits = 0;

  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const batch = pairs.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async pair => {
        const cacheKey = `hyperliquid:${pair.symbol}:${interval}:${lookbackPeriods}`;
        const cached = klineCache.get(cacheKey);
        const ttl = KLINE_CACHE_TTL[interval] || 60_000;

        if (cached && Date.now() - cached.timestamp < ttl) {
          cacheHits++;
          return { pair, candles: cached.candles };
        }

        const klineRes = await hyperliquidClient.getKlines(pair.symbol, interval, lookbackPeriods);
        if (!klineRes.success || !klineRes.data || klineRes.data.length < 20) {
          return { pair, candles: null };
        }

        klineCache.set(cacheKey, { candles: klineRes.data, timestamp: Date.now() });
        return { pair, candles: klineRes.data };
      }),
    );

    for (const { pair, candles: rawCandles } of batchResults) {
      if (!rawCandles) continue;

      try {
        const candles: Candle[] = rawCandles.map((k: any) => ({
          t: k.openTime,
          o: k.open,
          h: k.high,
          l: k.low,
          c: k.close,
          v: k.volume,
        }));

        const closes = candles.map(c => parseFloat(c.c));
        const volumeRatio = calculateVolumeRatio(candles, interval);
        const stochRSI = calculateStochRSI(closes);
        const mfi = calculateMFI(candles);
        const cmf = calculateCMF(candles); // Chaikin Money Flow
        const rsi = calculateRSI(closes);
        const consolidating = isConsolidating(closes);
        const volAccel = calculateVolumeAcceleration(candles, interval);

        const volumes = candles.slice(0, -1).map(c => parseFloat(c.v));
        const baselineVol = volumes.reduce((sum, v) => sum + v, 0) / volumes.length;
        const currentVol = parseFloat(candles[candles.length - 1].v);

        // Use WEIGHTED AVERAGE instead of OR gate (matches Aster scanner logic)
        // OR gate is too permissive: StochRSI 80 + MFI 25 would pass (but MFI 25 = selling pressure!)
        const momentumScore = (stochRSI + mfi) / 2;
        const hasPositiveMomentum = momentumScore >= 50;
        const accelBonus =
          volAccel.trend === 'accelerating' ? 1.5 : volAccel.trend === 'increasing' ? 0.5 : 0;
        // REBALANCED: Match Aster scanner weights (momentum > volume)
        const score = volumeRatio * 0.3 + (stochRSI / 100) * 3 + (mfi / 100) * 3 + accelBonus;
        const wouldTrigger = volumeRatio >= volumeMultiple && hasPositiveMomentum;

        if (volumeRatio >= volumeMultiple) {
          // Calculate OI metrics for cross-exchange analysis
          const oiToVolume =
            pair.openInterest > 0 && pair.volume24h > 0 ? pair.openInterest / pair.volume24h : 0;

          signals.push({
            symbol: pair.symbol,
            price: pair.price,
            volume_ratio: volumeRatio,
            volume_24h: pair.volume24h,
            baseline_vol: baselineVol,
            current_vol: currentVol,
            stoch_rsi: stochRSI,
            mfi: mfi,
            cmf: cmf,
            rsi: rsi,
            change_24h: pair.change24h,
            funding_rate: pair.fundingRate,
            open_interest: pair.openInterest,
            oi_to_volume: oiToVolume,
            consolidating: consolidating,
            vol_trend: volAccel.trend,
            score: score,
            has_momentum: hasPositiveMomentum,
            would_trigger: wouldTrigger,
          });
        }

        analyzed++;
      } catch (err) {
        continue;
      }
    }

    console.error(
      `[Hyperliquid Scanner] Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${analyzed} analyzed (${cacheHits} cache hits)...`,
    );
  }

  const scanDuration = Date.now() - scanStart;
  console.error(
    `[Hyperliquid Scanner] Complete in ${scanDuration}ms: ${signals.length} signals from ${analyzed} pairs (${cacheHits} cached)`,
  );

  // ORDERBOOK DEPTH ENHANCEMENT (same as Aster scanner)
  const TOP_CANDIDATES_HL = Math.min(limit * 2, 20);
  const OB_BATCH_SIZE_HL = 5; // Reduced batch size
  const OB_BATCH_DELAY_HL = 150; // Delay between batches
  const OB_MAX_RETRIES_HL = 2;

  // Helper: fetch orderbook with retry logic for Hyperliquid
  const fetchHLOrderbookWithRetry = async (
    symbol: string,
    retries: number = OB_MAX_RETRIES_HL,
  ): Promise<{ symbol: string; data: any; error?: string }> => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const obRes = await hyperliquidClient.getOrderBook(symbol, 20);
        if (obRes.success && obRes.data) {
          return { symbol, data: obRes.data };
        }
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 80 * (attempt + 1)));
          continue;
        }
        return { symbol, data: null, error: obRes.error || 'API returned no data' };
      } catch (err: any) {
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 80 * (attempt + 1)));
          continue;
        }
        return { symbol, data: null, error: err.message || 'Exception thrown' };
      }
    }
    return { symbol, data: null, error: 'Max retries exceeded' };
  };

  // Sort by score first to pick best candidates
  signals.sort((a, b) => b.score - a.score);
  const signalsForOB = signals.slice(0, TOP_CANDIDATES_HL);

  let hlObSuccessCount = 0;
  let hlObFailCount = 0;
  const hlObErrors: string[] = [];

  if (signalsForOB.length > 0) {
    console.error(
      `[Hyperliquid Scanner] Enhancing top ${signalsForOB.length} signals with orderbook depth (batch=${OB_BATCH_SIZE_HL}, delay=${OB_BATCH_DELAY_HL}ms)...`,
    );

    for (let i = 0; i < signalsForOB.length; i += OB_BATCH_SIZE_HL) {
      const batch = signalsForOB.slice(i, i + OB_BATCH_SIZE_HL);

      // Add delay between batches (except first)
      if (i > 0) {
        await new Promise(r => setTimeout(r, OB_BATCH_DELAY_HL));
      }

      const obResults = await Promise.all(
        batch.map(signal => fetchHLOrderbookWithRetry(signal.symbol)),
      );

      for (const result of obResults) {
        if (!result.data) {
          hlObFailCount++;
          if (result.error) {
            hlObErrors.push(`${result.symbol}: ${result.error}`);
          }
          continue;
        }
        hlObSuccessCount++;

        const bids = result.data.bids || [];
        const asks = result.data.asks || [];
        if (bids.length === 0 || asks.length === 0) continue;

        const bidDepthUsd = bids
          .slice(0, 10)
          .reduce(
            (sum: number, [price, qty]: [string, string]) =>
              sum + parseFloat(price) * parseFloat(qty),
            0,
          );
        const askDepthUsd = asks
          .slice(0, 10)
          .reduce(
            (sum: number, [price, qty]: [string, string]) =>
              sum + parseFloat(price) * parseFloat(qty),
            0,
          );

        const bestBid = parseFloat(bids[0][0]);
        const bestAsk = parseFloat(asks[0][0]);
        const midPrice = (bestBid + bestAsk) / 2;
        const spreadPct = ((bestAsk - bestBid) / midPrice) * 100;
        const totalDepth = bidDepthUsd + askDepthUsd;
        const rawImbalance = totalDepth > 0 ? (bidDepthUsd - askDepthUsd) / totalDepth : 0;
        const pressure = rawImbalance > 0.2 ? 'BUY' : rawImbalance < -0.2 ? 'SELL' : 'NEUTRAL';

        const signal = signals.find(s => s.symbol === result.symbol);
        if (!signal) continue;

        signal.ob_imbalance = rawImbalance;
        signal.ob_spread_pct = spreadPct;
        signal.ob_pressure = pressure;
        signal.ob_bid_depth = bidDepthUsd;
        signal.ob_ask_depth = askDepthUsd;
        signal.ob_aligned = rawImbalance > -0.1; // Assume long bias for pump scanner

        // Score adjustments
        let obBonus = 0;
        if (rawImbalance > 0.3) obBonus += 2;
        else if (rawImbalance < -0.3) obBonus -= 2;

        if (totalDepth < 10000) {
          obBonus -= 3;
          signal.ob_warning = 'THIN_BOOK';
        } else if (totalDepth < 50000) {
          obBonus -= 1;
        } else if (totalDepth > 500000) {
          obBonus += 1;
        }

        if (spreadPct > 0.3) {
          obBonus -= 1;
          signal.ob_warning = signal.ob_warning
            ? signal.ob_warning + '_WIDE_SPREAD'
            : 'WIDE_SPREAD';
        }

        signal.score += obBonus;
      }
    }
    // Log detailed results
    console.error(
      `[Hyperliquid Scanner] Orderbook enhancement complete: ${hlObSuccessCount}/${signalsForOB.length} success, ${hlObFailCount} failed`,
    );
    if (hlObErrors.length > 0) {
      console.error(
        `[Hyperliquid Scanner] Orderbook errors (first 5): ${hlObErrors.slice(0, 5).join(' | ')}`,
      );
    }
  }

  // Re-sort after orderbook adjustments
  signals.sort((a, b) => b.score - a.score);

  const topSignals = signals.slice(0, limit).map(s => ({
    symbol: s.symbol,
    price: s.price,
    volume_ratio: `${s.volume_ratio.toFixed(1)}x`,
    volume_24h: `$${(s.volume_24h / 1000).toFixed(0)}k`,
    baseline_vol: Math.round(s.baseline_vol),
    current_vol: Math.round(s.current_vol),
    stoch_rsi: s.stoch_rsi.toFixed(1),
    mfi: s.mfi.toFixed(1),
    cmf: s.cmf.toFixed(3),
    rsi: s.rsi.toFixed(1),
    change_24h: `${s.change_24h.toFixed(2)}%`,
    funding_rate: s.funding_rate,
    open_interest: s.open_interest > 0 ? `$${(s.open_interest / 1000000).toFixed(2)}M` : 'N/A',
    oi_to_volume: s.oi_to_volume > 0 ? s.oi_to_volume.toFixed(2) : 'N/A',
    consolidating: s.consolidating,
    vol_trend: s.vol_trend,
    score: s.score.toFixed(2),
    has_momentum: s.has_momentum,
    would_trigger: s.would_trigger,
    // Orderbook depth (if available)
    orderbook:
      s.ob_imbalance !== undefined
        ? {
            imbalance: s.ob_imbalance.toFixed(2),
            spread_pct: s.ob_spread_pct.toFixed(3),
            pressure: s.ob_pressure,
            bid_depth: s.ob_bid_depth ? `$${Math.round(s.ob_bid_depth / 1000)}k` : null,
            ask_depth: s.ob_ask_depth ? `$${Math.round(s.ob_ask_depth / 1000)}k` : null,
            warning: s.ob_warning || null,
          }
        : null,
    alert: s.would_trigger
      ? s.ob_warning
        ? '⚠️ TRIGGER (thin book)'
        : s.volume_ratio >= 10
          ? '🚨 STRONG TRIGGER'
          : '✅ WOULD TRIGGER'
      : s.volume_ratio >= 10
        ? '⚠️ HIGH VOL (no momentum)'
        : '👀 VOL SPIKE (no momentum)',
  }));

  return JSON.stringify(
    {
      exchange: 'Hyperliquid',
      scan_time: new Date().toISOString(),
      scan_duration_ms: scanDuration,
      pairs_scanned: analyzed,
      pairs_prefiltered: filtered,
      cache_hits: cacheHits,
      signals_found: signals.length,
      volume_threshold: `${volumeMultiple}x`,
      interval: interval,
      top_signals: topSignals,
    },
    null,
    2,
  );
}

// --- 16. scan_for_pumps_cross (Cross-Exchange) ---
async function handleScanForPumpsCross(
  volumeMultiple: number = 5,
  minStochRSI: number = 50, // Lowered to match other scanners
  minMFI: number = 50, // Lowered to match other scanners
  interval: string = '15m',
  lookbackPeriods: number = 48,
  limit: number = 15,
  minVolume: number = 1000,
): Promise<string> {
  console.error(`[Cross-Exchange Scanner] Starting parallel scan on Aster + Hyperliquid...`);

  // Run both scans in parallel (long mode for cross-exchange)
  const [asterResult, hlResult] = await Promise.all([
    handleScanForPumps(
      'long',
      volumeMultiple,
      minStochRSI,
      minMFI,
      interval,
      lookbackPeriods,
      limit * 2,
      minVolume,
    ),
    handleScanForPumpsHL(
      volumeMultiple,
      minStochRSI,
      minMFI,
      interval,
      lookbackPeriods,
      limit * 2,
      minVolume,
    ),
  ]);

  const asterData = JSON.parse(asterResult);
  const hlData = JSON.parse(hlResult);

  // DEBUG: Track what we're getting from each scanner
  const debugInfo = {
    aster_has_signals: !!(asterData.signals || asterData.top_signals),
    aster_signal_count: (asterData.signals || asterData.top_signals || []).length,
    aster_keys: Object.keys(asterData),
    hl_has_signals: !!(hlData.signals || hlData.top_signals),
    hl_signal_count: (hlData.signals || hlData.top_signals || []).length,
  };
  console.error('[Cross Scanner Debug]', JSON.stringify(debugInfo));

  if (asterData.error || hlData.error) {
    return JSON.stringify({
      error: 'One or both exchanges failed',
      aster_error: asterData.error,
      hyperliquid_error: hlData.error,
    });
  }

  // Normalize symbol names for comparison
  // Aster uses BTCUSDT, Hyperliquid uses BTC
  const normalizeSymbol = (s: string) =>
    s.toUpperCase().replace('USDT', '').replace('USD', '').replace('PERP', '');

  // Create maps for quick lookup
  const asterSignals = new Map<string, any>();
  const hlSignals = new Map<string, any>();

  // FIX: Aster returns 'signals' with nested 'metrics' structure
  // Hyperliquid returns 'top_signals' with flat structure
  // Normalize both to flat structure for comparison
  for (const sig of asterData.signals || asterData.top_signals || []) {
    // Flatten Aster's nested metrics structure for cross-scanner compatibility
    const flattened = {
      ...sig,
      exchange: 'Aster',
      original_symbol: sig.symbol,
      // Flatten metrics if they exist
      volume_ratio: sig.metrics?.volume_ratio ?? sig.volume_ratio,
      volume_24h: sig.metrics?.volume_24h ?? sig.volume_24h,
      change_24h: sig.metrics?.change_24h ?? sig.change_24h,
      funding_rate: sig.metrics?.funding ?? sig.funding_rate,
      stoch_rsi: sig.metrics?.stoch_rsi ?? sig.stoch_rsi,
      mfi: sig.metrics?.mfi ?? sig.mfi,
      cmf: sig.metrics?.cmf ?? sig.cmf,
      rsi: sig.metrics?.rsi ?? sig.rsi,
      would_trigger: sig.trigger ?? sig.would_trigger,
      structural_bias: sig.structure?.trend ?? sig.structural_bias,
    };
    asterSignals.set(normalizeSymbol(sig.symbol), flattened);
  }

  for (const sig of hlData.top_signals || hlData.signals || []) {
    hlSignals.set(normalizeSymbol(sig.symbol), {
      ...sig,
      exchange: 'Hyperliquid',
      original_symbol: sig.symbol,
    });
  }

  // Find overlapping signals (HIGHEST CONVICTION)
  const bothExchanges: any[] = [];
  const asterOnly: any[] = [];
  const hlOnly: any[] = [];

  // Helper: Detect OI divergence
  // Bullish divergence: Price flat/down but OI rising (accumulation)
  // Bearish divergence: Price up but OI falling (distribution)
  const detectOIDivergence = (priceChange: number, oiLevel: number, oiToVolume: number) => {
    // oiToVolume > 2 suggests significant positioning relative to volume
    const hasSignificantOI = oiToVolume > 1.5;

    if (priceChange > 5 && hasSignificantOI && oiToVolume > 3) {
      return {
        type: 'CROWDED_LONG',
        warning: '⚠️ High OI + price up = crowded trade, reversal risk',
      };
    }
    if (priceChange < -5 && hasSignificantOI && oiToVolume > 3) {
      return {
        type: 'CROWDED_SHORT',
        warning: '⚠️ High OI + price down = potential short squeeze',
      };
    }
    if (priceChange < 2 && priceChange > -2 && hasSignificantOI) {
      return {
        type: 'ACCUMULATION',
        signal: '🔍 Flat price with high OI = accumulation or distribution',
      };
    }
    return { type: 'NORMAL', signal: null };
  };

  // Check Aster signals
  for (const [normalized, sig] of asterSignals) {
    if (hlSignals.has(normalized)) {
      const hlSig = hlSignals.get(normalized);

      // Extract OI data from Hyperliquid signal
      const hlOI = parseFloat(hlSig.open_interest?.replace(/[^\d.]/g, '') || '0') * 1000000; // Convert from $XM format
      const hlOIToVol = parseFloat(hlSig.oi_to_volume) || 0;
      // Handle both number and string formats for change_24h
      const asterChange =
        typeof sig.change_24h === 'number'
          ? sig.change_24h
          : parseFloat(String(sig.change_24h).replace('%', '') || '0');
      const hlChange =
        typeof hlSig.change_24h === 'number'
          ? hlSig.change_24h
          : parseFloat(String(hlSig.change_24h).replace('%', '') || '0');

      // Detect OI divergence
      const oiDivergence = detectOIDivergence(hlChange, hlOI, hlOIToVol);

      // Crowded trade detection: OI > 2x daily volume
      const isCrowded = hlOIToVol > 2;

      bothExchanges.push({
        symbol: normalized,
        confluence: '🔥 BOTH EXCHANGES',
        conviction: isCrowded ? 'MEDIUM (crowded)' : 'HIGH',
        aster: {
          symbol: sig.original_symbol,
          volume_ratio: sig.volume_ratio,
          mfi: sig.mfi,
          cmf: sig.cmf,
          stoch_rsi: sig.stoch_rsi,
          change_24h: sig.change_24h,
          would_trigger: sig.would_trigger,
        },
        hyperliquid: {
          symbol: hlSig.original_symbol,
          volume_ratio: hlSig.volume_ratio,
          mfi: hlSig.mfi,
          cmf: hlSig.cmf,
          stoch_rsi: hlSig.stoch_rsi,
          change_24h: hlSig.change_24h,
          would_trigger: hlSig.would_trigger,
          funding_rate: hlSig.funding_rate,
          open_interest: hlSig.open_interest || 'N/A',
          oi_to_volume: hlSig.oi_to_volume || 'N/A',
        },
        oi_analysis: {
          open_interest: hlSig.open_interest || 'N/A',
          oi_to_volume: hlOIToVol > 0 ? hlOIToVol.toFixed(2) : 'N/A',
          is_crowded: isCrowded,
          divergence: oiDivergence.type,
          warning: oiDivergence.warning || oiDivergence.signal || null,
        },
      });
    } else {
      asterOnly.push({
        symbol: normalized,
        ...sig,
        note: 'Aster only - check if listed on HL',
      });
    }
  }

  // Check HL-only signals (include OI data since it's available)
  for (const [normalized, sig] of hlSignals) {
    if (!asterSignals.has(normalized)) {
      const hlOIToVol = parseFloat(sig.oi_to_volume) || 0;
      const hlChange =
        typeof sig.change_24h === 'number'
          ? sig.change_24h
          : parseFloat(String(sig.change_24h).replace('%', '') || '0');
      const oiDivergence = detectOIDivergence(hlChange, 0, hlOIToVol);
      const isCrowded = hlOIToVol > 2;

      hlOnly.push({
        symbol: normalized,
        ...sig,
        oi_analysis: {
          open_interest: sig.open_interest || 'N/A',
          oi_to_volume: hlOIToVol > 0 ? hlOIToVol.toFixed(2) : 'N/A',
          is_crowded: isCrowded,
          divergence: oiDivergence.type,
          warning: oiDivergence.warning || oiDivergence.signal || null,
        },
        note: 'Hyperliquid only - check if listed on Aster',
      });
    }
  }

  // Sort by combined volume ratio for both exchanges
  bothExchanges.sort((a, b) => {
    const aRatio = parseFloat(a.aster.volume_ratio) + parseFloat(a.hyperliquid.volume_ratio);
    const bRatio = parseFloat(b.aster.volume_ratio) + parseFloat(b.hyperliquid.volume_ratio);
    return bRatio - aRatio;
  });

  // OI Intelligence Summary
  const crowdedSignals = bothExchanges.filter(s => s.oi_analysis?.is_crowded);
  const divergenceSignals = bothExchanges.filter(
    s => s.oi_analysis?.divergence && s.oi_analysis.divergence !== 'NORMAL',
  );
  const hlCrowdedSignals = hlOnly.filter(s => s.oi_analysis?.is_crowded);

  const regimeBlock = await getCompactRegimeBlock();
  return JSON.stringify(
    {
      market_regime: regimeBlock,
      scan_time: new Date().toISOString(),
      summary: {
        both_exchanges: bothExchanges.length,
        aster_only: asterOnly.length,
        hyperliquid_only: hlOnly.length,
        total_signals: bothExchanges.length + asterOnly.length + hlOnly.length,
        highest_conviction: bothExchanges
          .filter(s => !s.oi_analysis?.is_crowded) // Exclude crowded trades from highest conviction
          .slice(0, 3)
          .map(s => s.symbol),
      },
      oi_intelligence: {
        crowded_trades: crowdedSignals.length,
        crowded_symbols: crowdedSignals.map(s => ({
          symbol: s.symbol,
          oi_to_volume: s.oi_analysis.oi_to_volume,
          warning: s.oi_analysis.warning,
        })),
        divergence_signals: divergenceSignals.length,
        divergence_details: divergenceSignals.map(s => ({
          symbol: s.symbol,
          type: s.oi_analysis.divergence,
          warning: s.oi_analysis.warning,
        })),
        risk_summary:
          crowdedSignals.length > 0
            ? `⚠️ ${crowdedSignals.length} crowded trades detected - watch for reversals`
            : '✅ No crowded trades detected',
      },
      cross_exchange_signals: bothExchanges.slice(0, limit),
      aster_only_signals: asterOnly.slice(0, Math.min(5, limit)),
      hyperliquid_only_signals: hlOnly.slice(0, Math.min(5, limit)),
      raw_counts: {
        aster_pairs_scanned: asterData.pairs_scanned,
        hyperliquid_pairs_scanned: hlData.pairs_scanned,
        // DEBUG: Signal counts to trace pipeline
        _debug_aster_signals_received: (asterData.signals || asterData.top_signals || []).length,
        _debug_hl_signals_received: (hlData.signals || hlData.top_signals || []).length,
        _debug_aster_map_size: asterSignals.size,
        _debug_hl_map_size: hlSignals.size,
      },
    },
    null,
    2,
  );
}

// --- 18.5 Momentum Scanner v2 - Enhanced with OI, depth, acceleration ---
async function handleScanMomentum(
  mode: 'long' | 'short' | 'both' = 'both',
  minChange: number = 5,
  minVolume: number = 50000,
  limit: number = 10,
  outputFormat: 'json' | 'csv' | 'compact' = 'json',
): Promise<string> {
  const startTime = Date.now();

  // Fetch market data in parallel
  const [tickerRes, fundingRes, bookTickerRes] = await Promise.all([
    asterClient.getTicker24h(),
    asterClient.getPremiumIndex(),
    asterClient.getBookTicker(),
  ]);

  if (!tickerRes.success || !tickerRes.data) {
    return JSON.stringify({ error: 'Failed to fetch ticker data' });
  }

  // Build funding map and calculate adaptive thresholds
  const fundingMap = new Map<string, number>();
  const allFundingRates: number[] = [];
  if (fundingRes.success && fundingRes.data) {
    const fundingData = Array.isArray(fundingRes.data) ? fundingRes.data : [fundingRes.data];
    for (const f of fundingData) {
      const rate = parseFloat(f.lastFundingRate) * 100;
      fundingMap.set(f.symbol, rate);
      allFundingRates.push(rate);
    }
  }

  // Adaptive funding thresholds based on market-wide distribution
  allFundingRates.sort((a, b) => a - b);
  const fundingP25 = allFundingRates[Math.floor(allFundingRates.length * 0.25)] || -0.02;
  const fundingP75 = allFundingRates[Math.floor(allFundingRates.length * 0.75)] || 0.02;
  const fundingP90 = allFundingRates[Math.floor(allFundingRates.length * 0.9)] || 0.05;
  const fundingP10 = allFundingRates[Math.floor(allFundingRates.length * 0.1)] || -0.05;

  // Build spread map from book tickers
  const spreadMap = new Map<string, number>();
  if (bookTickerRes.success && bookTickerRes.data) {
    const bookData = Array.isArray(bookTickerRes.data) ? bookTickerRes.data : [bookTickerRes.data];
    for (const b of bookData) {
      const bid = parseFloat(b.bidPrice || '0');
      const ask = parseFloat(b.askPrice || '0');
      if (bid > 0 && ask > 0) {
        const spreadPct = ((ask - bid) / ((bid + ask) / 2)) * 100;
        spreadMap.set(b.symbol, spreadPct);
      }
    }
  }

  // Process all pairs - filter to tradeable symbols only
  const rawTickers = Array.isArray(tickerRes.data) ? tickerRes.data : [tickerRes.data];
  const tickers = await filterTradeableTickers(rawTickers);

  // Calculate MEDIAN volume for meaningful comparison
  const volumes = tickers.map((t: any) => parseFloat(t.quoteVolume || '0')).sort((a, b) => a - b);
  const medianVolume = volumes[Math.floor(volumes.length / 2)];
  const avgVolume =
    tickers.reduce((sum: number, t: any) => sum + parseFloat(t.quoteVolume || '0'), 0) /
    tickers.length;

  interface MomentumSignal {
    symbol: string;
    price: number;
    change_24h: number;
    volume_24h: number;
    volume_vs_avg: number;
    volume_vs_median: number;
    funding_rate: number;
    score: number;
    base_score: number; // Pre-enhancement score for comparison
    classification: string;
    alert: string;
    direction: 'long' | 'short';
    reversal_risk: string;
    squeeze_potential: string;
    spread_pct: number;
    recent_alignment: boolean;
    // Enhanced fields
    oi_ratio?: number; // OI / 24h Volume - crowding indicator
    bid_depth_usd?: number; // Orderbook bid depth
    ask_depth_usd?: number; // Orderbook ask depth
    depth_imbalance?: number; // bid/ask ratio
    vol_acceleration?: number;
    vol_trend?: string;
    recency_4h?: number; // 4h change
    recency_15m?: number; // 15m change
    crowding_confirmed?: boolean; // OI backs up funding signal
  }

  const signals: MomentumSignal[] = [];

  for (const ticker of tickers) {
    const symbol = ticker.symbol;
    const price = parseFloat(ticker.lastPrice || '0');
    const change24h = parseFloat(ticker.priceChangePercent || '0');
    const volume24h = parseFloat(ticker.quoteVolume || '0');
    const fundingRate = fundingMap.get(symbol) || 0;

    if (volume24h < minVolume) continue;

    const absChange = Math.abs(change24h);
    if (absChange < minChange) continue;

    const direction: 'long' | 'short' = change24h > 0 ? 'long' : 'short';
    if (mode === 'long' && direction === 'short') continue;
    if (mode === 'short' && direction === 'long') continue;

    const volumeVsAvg = volume24h / avgVolume;
    const volumeVsMedian = volume24h / medianVolume;
    const spreadPct = spreadMap.get(symbol) || 0;

    // Adaptive funding-based reversal risk (using percentile thresholds)
    let reversalRisk = 'LOW';
    if (direction === 'long' && fundingRate > fundingP90) reversalRisk = 'HIGH';
    else if (direction === 'long' && fundingRate > fundingP75) reversalRisk = 'MEDIUM';
    else if (direction === 'short' && fundingRate < fundingP10) reversalRisk = 'HIGH';
    else if (direction === 'short' && fundingRate < fundingP25) reversalRisk = 'MEDIUM';

    // Squeeze potential (opposite side crowded)
    let squeezePotential = 'LOW';
    if (direction === 'long' && fundingRate < fundingP10) squeezePotential = 'HIGH';
    else if (direction === 'long' && fundingRate < fundingP25) squeezePotential = 'MEDIUM';
    else if (direction === 'short' && fundingRate > fundingP90) squeezePotential = 'HIGH';
    else if (direction === 'short' && fundingRate > fundingP75) squeezePotential = 'MEDIUM';

    // IMPROVED SCORING v2:
    // - Price change: 30% (slightly reduced)
    // - Volume confirmation: 20%
    // - Squeeze potential: 10% (reduced - funding alone is weak signal)
    // - Magnitude bonus: 10%
    // - Spread penalty: PROPORTIONAL (not flat)
    const changeScore = absChange * 0.3;
    const squeezePotentialScore =
      squeezePotential === 'HIGH' ? 5 : squeezePotential === 'MEDIUM' ? 2.5 : 0;
    const volumeScore = Math.min(volumeVsMedian, 10) * 2 * 0.2;
    const magnitudeBonus = absChange > 50 ? 5 : absChange > 20 ? 3 : absChange > 10 ? 1 : 0;

    // PROPORTIONAL spread penalty (not flat -3/-1)
    // 0.3% spread = -1, 0.5% = -2.5, 1% = -5, 2%+ = -10
    const spreadPenalty =
      spreadPct > 2.0
        ? -10
        : spreadPct > 1.0
          ? -5
          : spreadPct > 0.5
            ? -2.5
            : spreadPct > 0.3
              ? -1
              : 0;

    const baseScore = Math.max(
      0,
      changeScore + squeezePotentialScore + volumeScore + magnitudeBonus + spreadPenalty,
    );

    let classification: string;
    let alert: string;

    if (absChange >= 50) {
      classification = 'PARABOLIC';
      alert = direction === 'long' ? '🚀 PARABOLIC PUMP' : '💥 PARABOLIC DUMP';
    } else if (absChange >= 20) {
      classification = 'STRONG_MOMENTUM';
      alert = direction === 'long' ? '🔥 STRONG PUMP' : '🔻 STRONG DUMP';
    } else if (absChange >= 10) {
      classification = 'MOMENTUM';
      alert = direction === 'long' ? '📈 PUMPING' : '📉 DUMPING';
    } else {
      classification = 'BUILDING';
      alert = direction === 'long' ? '👀 BUILDING UP' : '👀 BUILDING DOWN';
    }

    if (squeezePotential === 'HIGH') {
      alert += direction === 'long' ? ' (SHORT SQUEEZE!)' : ' (LONG SQUEEZE!)';
    }
    if (reversalRisk === 'HIGH') {
      alert += ' ⚠️ CROWDED';
    }
    if (spreadPct > 0.5) {
      alert += ' 💧 LOW LIQ';
    }

    signals.push({
      symbol,
      price,
      change_24h: change24h,
      volume_24h: volume24h,
      volume_vs_avg: volumeVsAvg,
      volume_vs_median: volumeVsMedian,
      funding_rate: fundingRate,
      score: baseScore,
      base_score: baseScore,
      classification,
      alert,
      direction,
      reversal_risk: reversalRisk,
      squeeze_potential: squeezePotential,
      spread_pct: spreadPct,
      recent_alignment: true,
    });
  }

  // Sort by score descending
  signals.sort((a, b) => b.score - a.score);

  // ENHANCED ANALYSIS - Check MORE candidates (fix race condition)
  // Was: limit * 3 (too few, missed good signals after penalties)
  // Now: limit * 5 (ensures fresh signals have chance to surface)
  const TOP_TO_CHECK = Math.min(signals.length, limit * 5);

  // Helper: fetch orderbook with retry logic (matches pump scanner fix)
  const MOMENTUM_OB_MAX_RETRIES = 2;
  const fetchMomentumOrderbookWithRetry = async (
    symbol: string,
    retries: number = MOMENTUM_OB_MAX_RETRIES,
  ): Promise<{ success: boolean; data?: any; error?: string }> => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const obRes = await asterClient.getOrderBook(symbol, 20);
        if (obRes.success && obRes.data) {
          return obRes;
        }
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
          continue;
        }
        return { success: false, error: obRes.error || 'API returned no data' };
      } catch (err: any) {
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
          continue;
        }
        return { success: false, error: err.message || 'Exception thrown' };
      }
    }
    return { success: false, error: 'Max retries exceeded' };
  };

  // Parallel enhancement: recency (4h + 15m), OI, orderbook depth, volume acceleration
  const enhancementPromises: Promise<void>[] = [];

  for (let i = 0; i < TOP_TO_CHECK; i++) {
    const signal = signals[i];

    enhancementPromises.push(
      (async () => {
        try {
          // Parallel fetch: 4h candles, 15m candles, OI, orderbook (with retry)
          const [kline4hRes, kline15mRes, oiRes, obRes] = await Promise.all([
            asterClient.getKlines(signal.symbol, '4h', 6),
            asterClient.getKlines(signal.symbol, '15m', 8),
            asterClient.getOpenInterest(signal.symbol),
            fetchMomentumOrderbookWithRetry(signal.symbol),
          ]);

          let recencyPenalty = 0;
          let oiBonus = 0;
          let depthBonus = 0;
          let accelBonus = 0;

          // --- RECENCY CHECK: 4h ---
          if (kline4hRes.success && kline4hRes.data && kline4hRes.data.length >= 2) {
            const klines = kline4hRes.data;
            const recentOpen = parseFloat(klines[klines.length - 2].open);
            const recentClose = parseFloat(klines[klines.length - 1].close);
            const recentChange = ((recentClose - recentOpen) / recentOpen) * 100;
            signal.recency_4h = recentChange;

            const aligns4h = Math.sign(signal.change_24h) === Math.sign(recentChange);
            
            // Volume acceleration from 4h candles - FIXED: pass '4h' interval
            const volAccel = calculateVolumeAcceleration(klines, '4h');
            signal.vol_acceleration = volAccel.acceleration;
            signal.vol_trend = volAccel.trend;

            // Phase detection logic
            let phase = 'ACTIVE';
            const absChange4h = Math.abs(recentChange);
            const isReversing = !aligns4h && absChange4h > 1.5;
            const isConsolidating = absChange4h < 1.0;

            if (isReversing) {
              phase = 'COOLING_OFF';
              recencyPenalty += 0.20;
              signal.alert += ' 🔄 COOL-OFF';
            } else if (isConsolidating) {
              phase = 'CONSOLIDATING';
              signal.alert += ' ⏸️ BASE-BUILDING';
            } else if (absChange4h > 5 && aligns4h) {
              phase = 'PARABOLIC_EXTENDED';
            }
            
            (signal as any).momentum_phase = phase;

            // Bonus for accelerating volume (move is gaining steam)
            if (volAccel.trend === 'accelerating') accelBonus = 3;
            else if (volAccel.trend === 'increasing') accelBonus = 1.5;
            else if (volAccel.trend === 'declining') accelBonus = -2;
            else if (volAccel.trend === 'slowing') accelBonus = -1;
          }

          // --- RECENCY CHECK: 15m (catches real-time acceleration) ---
          if (kline15mRes.success && kline15mRes.data && kline15mRes.data.length >= 4) {
            const klines15m = kline15mRes.data;
            const k1 = klines15m[klines15m.length - 4];
            const k2 = klines15m[klines15m.length - 1];
            const recentChange15m =
              ((parseFloat(k2.close) - parseFloat(k1.open)) / parseFloat(k1.open)) * 100;
            signal.recency_15m = recentChange15m;

            const aligns15m = Math.sign(signal.change_24h) === Math.sign(recentChange15m);
            
            // Real-time volume ratio for 15m - FIXED: pass '15m' interval
            const volRatio15m = calculateVolumeRatio(klines15m, '15m');
            (signal as any).vol_ratio_15m = volRatio15m;

            if (!aligns15m && Math.abs(recentChange15m) > 1) {
              recencyPenalty += 0.10;
              if (!(signal as any).momentum_phase?.includes('COOL')) {
                (signal as any).momentum_phase = 'REVERSING_ST';
                signal.alert += ' 🔄 ST-REVERSAL';
              }
            }
            
            // INITIAL PHASE DETECTION: Low 24h change but high 15m volume/price action
            if (Math.abs(signal.change_24h) < 5 && volRatio15m > 3 && Math.abs(recentChange15m) > 2) {
              (signal as any).momentum_phase = 'INITIAL_BREAKOUT';
              signal.alert = '🚨 INITIAL BREAKOUT' + (signal.direction === 'long' ? ' 📈' : ' 📉');
              accelBonus += 4; // Massive bonus for early catching
            }
          }

          // --- OI/VOLUME RATIO (crowding confirmation) ---
          if (oiRes.success && oiRes.data) {
            const oi = parseFloat(oiRes.data.openInterest || '0');
            const oiNotional = oi * signal.price;
            signal.oi_ratio = signal.volume_24h > 0 ? oiNotional / signal.volume_24h : 0;

            // OI/Vol > 2 means positions are large relative to daily volume (crowded)
            // This CONFIRMS the funding-based crowding signal
            if (signal.oi_ratio > 2) {
              signal.crowding_confirmed = true;
              if (signal.reversal_risk === 'HIGH') {
                signal.alert += ' 📊 OI-CONFIRMS-CROWD';
                oiBonus = -2; // Actually a penalty - makes reversal more likely
              } else if (signal.squeeze_potential === 'HIGH') {
                signal.alert += ' 📊 SQUEEZE-CONFIRMED';
                oiBonus = 3; // Bonus - squeeze is more likely
              }
            } else {
              signal.crowding_confirmed = false;
            }
          }

          // --- ORDERBOOK DEPTH ANALYSIS ---
          if (obRes.success && obRes.data) {
            const bids = obRes.data.bids || [];
            const asks = obRes.data.asks || [];

            // Calculate depth in USD (sum of top 10 levels)
            const bidDepthUsd = bids
              .slice(0, 10)
              .reduce(
                (sum: number, [price, qty]: [string, string]) =>
                  sum + parseFloat(price) * parseFloat(qty),
                0,
              );
            const askDepthUsd = asks
              .slice(0, 10)
              .reduce(
                (sum: number, [price, qty]: [string, string]) =>
                  sum + parseFloat(price) * parseFloat(qty),
                0,
              );

            signal.bid_depth_usd = bidDepthUsd;
            signal.ask_depth_usd = askDepthUsd;
            signal.depth_imbalance = askDepthUsd > 0 ? bidDepthUsd / askDepthUsd : 1;

            // Depth imbalance bonus/penalty
            // For longs: more bids than asks = support = good
            // For shorts: more asks than bids = resistance = good
            if (signal.direction === 'long') {
              if (signal.depth_imbalance > 1.5)
                depthBonus = 2; // Strong bid support
              else if (signal.depth_imbalance < 0.5) depthBonus = -2; // No support, risky
            } else {
              if (signal.depth_imbalance < 0.67)
                depthBonus = 2; // Heavy asks = continuation
              else if (signal.depth_imbalance > 2) depthBonus = -2; // Bids stacking, reversal risk
            }

            // Thin orderbook penalty (regardless of direction)
            const totalDepth = bidDepthUsd + askDepthUsd;
            if (totalDepth < 10000)
              depthBonus -= 3; // Less than $10k depth = very thin
            else if (totalDepth < 50000) depthBonus -= 1;
          }

          // Apply all score adjustments
          signal.recent_alignment = recencyPenalty === 0;
          const adjustedScore =
            signal.base_score * (1 - recencyPenalty) + oiBonus + depthBonus + accelBonus;
          signal.score = Math.max(0, adjustedScore);
        } catch (e) {
          // On error, keep base score (don't penalize)
          console.error(`[Momentum] Enhancement failed for ${signal.symbol}:`, e);
        }
      })(),
    );
  }

  await Promise.all(enhancementPromises);

  // Re-sort after all enhancements
  signals.sort((a, b) => b.score - a.score);

  // Categorize signals
  const parabolic = signals.filter(s => s.classification === 'PARABOLIC');
  const strongMomentum = signals.filter(s => s.classification === 'STRONG_MOMENTUM');
  const momentum = signals.filter(s => s.classification === 'MOMENTUM');
  const building = signals.filter(s => s.classification === 'BUILDING');

  // Get top longs and shorts
  const topLongs = signals.filter(s => s.direction === 'long').slice(0, limit);
  const topShorts = signals.filter(s => s.direction === 'short').slice(0, limit);

  // Format output - enhanced with new fields (Lean/Raw Format)
  const formatSignal = (s: MomentumSignal) => ({
    symbol: s.symbol,
    price: s.price,
    change_24h: s.change_24h,
    volume_24h: s.volume_24h,
    volume_vs_median: s.volume_vs_median,
    spread_pct: s.spread_pct,
    funding_rate: s.funding_rate,
    score: Number(s.score.toFixed(2)),
    base_score: Number(s.base_score.toFixed(2)),
    classification: s.classification,
    phase: (s as any).momentum_phase || 'UNKNOWN',
    direction: s.direction,
    reversal_risk: s.reversal_risk,
    squeeze_potential: s.squeeze_potential,
    recent_momentum: s.recent_alignment,
    // Enhanced fields
    oi_ratio: s.oi_ratio ?? null,
    vol_ratio_15m: (s as any).vol_ratio_15m ?? null,
    crowding_confirmed: s.crowding_confirmed ?? null,
    orderbook:
      s.bid_depth_usd !== undefined
        ? {
            bid_depth: s.bid_depth_usd,
            ask_depth: s.ask_depth_usd,
            imbalance: s.depth_imbalance,
          }
        : null,
    vol_acceleration:
      s.vol_acceleration !== undefined
        ? {
            value: s.vol_acceleration,
            trend: s.vol_trend,
          }
        : null,
    recency: {
      r4h: s.recency_4h ?? null,
      r15m: s.recency_15m ?? null,
    },
  });

  // Fetch regime once for all format branches
  const regimeBlock = await getCompactRegimeBlock();

  // CSV FORMAT - enhanced with new columns
  if (outputFormat === 'csv') {
    return JSON.stringify(
      {
        market_regime: regimeBlock,
        scan_type: 'momentum_v2',
        mode,
        duration_ms: Date.now() - startTime,
        signals_found: signals.length,
        summary: {
          parabolic: parabolic.length,
          strong: strongMomentum.length,
          momentum: momentum.length,
          high_reversal_risk: signals.filter(s => s.reversal_risk === 'HIGH').length,
          crowding_confirmed: signals.filter(s => s.crowding_confirmed).length,
          accelerating: signals.filter(s => s.vol_trend === 'accelerating').length,
          stale_signals: signals.filter(s => !s.recent_alignment).length,
        },
        columns: [
          'rank',
          'symbol',
          'dir',
          'chg24h',
          'vol_med',
          'spread',
          'fund',
          'score',
          'class',
          'risk',
          'sqz',
          'oi',
          'accel',
          'fresh',
        ],
        data: signals
          .slice(0, limit * 2)
          .map((s, i) => [
            i + 1,
            s.symbol,
            s.direction[0].toUpperCase(),
            `${s.change_24h >= 0 ? '+' : ''}${s.change_24h.toFixed(1)}%`,
            `${s.volume_vs_median.toFixed(1)}x`,
            `${s.spread_pct.toFixed(2)}%`,
            `${s.funding_rate >= 0 ? '+' : ''}${s.funding_rate.toFixed(3)}%`,
            s.score.toFixed(1),
            s.classification[0],
            s.reversal_risk[0],
            s.squeeze_potential[0],
            s.oi_ratio ? s.oi_ratio.toFixed(1) : '-',
            s.vol_trend ? s.vol_trend[0].toUpperCase() : '-',
            s.recent_alignment ? 'Y' : 'N',
          ]),
      },
      null,
      2,
    );
  }

  // COMPACT FORMAT - enhanced with new fields
  if (outputFormat === 'compact') {
    const formatCompact = (s: MomentumSignal) => ({
      s: s.symbol,
      d: s.direction[0].toUpperCase(),
      c: `${s.change_24h >= 0 ? '+' : ''}${s.change_24h.toFixed(1)}%`,
      v: `${s.volume_vs_median.toFixed(1)}x`,
      sp: `${s.spread_pct.toFixed(2)}%`,
      f: `${s.funding_rate >= 0 ? '+' : ''}${s.funding_rate.toFixed(3)}%`,
      sc: Math.round(s.score),
      cl: s.classification[0],
      rr: s.reversal_risk[0],
      sq: s.squeeze_potential[0],
      oi: s.oi_ratio ? s.oi_ratio.toFixed(1) : null,
      ac: s.vol_trend ? s.vol_trend[0] : null,
      fr: s.recent_alignment ? 1 : 0,
    });

    return JSON.stringify({
      market_regime: regimeBlock,
      t: Date.now() - startTime,
      n: signals.length,
      sum: {
        par: parabolic.length,
        str: strongMomentum.length,
        mom: momentum.length,
        crowd: signals.filter(s => s.crowding_confirmed).length,
        accel: signals.filter(s => s.vol_trend === 'accelerating').length,
        stale: signals.filter(s => !s.recent_alignment).length,
      },
      top: signals.slice(0, limit).map(formatCompact),
    });
  }

  // Build response - Lean/Raw Format
  const response: Record<string, unknown> = {
    market_regime: regimeBlock,
    signals: signals.slice(0, limit).map(formatSignal),
  };

  return JSON.stringify(response, null, 2);
}

// --- 34. Liquidity Scanner (Trade Tape Health Analysis) ---
async function handleScanLiquidity(
  symbols?: string[],
  limit: number = 20,
  minScore: number = 0,
  sortBy: 'score' | 'volume' | 'bot_likelihood' = 'score',
): Promise<string> {
  const startTime = Date.now();
  const BATCH_SIZE = 10;

  // If no symbols provided, get top volume pairs
  let symbolsToScan: string[] = [];
  let volumeMap = new Map<string, number>();

  if (!symbols || symbols.length === 0) {
    const tickerRes = await asterClient.getTicker24h();
    if (!tickerRes.success || !tickerRes.data) {
      return JSON.stringify({ error: 'Failed to fetch tickers' });
    }

    // Filter to tradeable symbols only (exclude SETTLING pairs like PORT3)
    const rawTickers = Array.isArray(tickerRes.data) ? tickerRes.data : [tickerRes.data];
    const tickers = await filterTradeableTickers(rawTickers);
    const sorted = tickers
      .map((t: any) => ({ symbol: t.symbol, volume: parseFloat(t.quoteVolume || '0') }))
      .sort((a, b) => b.volume - a.volume);

    symbolsToScan = sorted.slice(0, Math.min(limit, 50)).map(t => t.symbol);
    sorted.forEach(t => volumeMap.set(t.symbol, t.volume));
  } else {
    symbolsToScan = symbols.map(s =>
      s.toUpperCase().endsWith('USDT') ? s.toUpperCase() : s.toUpperCase() + 'USDT',
    );

    // Fetch volumes for provided symbols - filter to tradeable only
    const tickerRes = await asterClient.getTicker24h();
    if (tickerRes.success && tickerRes.data) {
      const rawTickers = Array.isArray(tickerRes.data) ? tickerRes.data : [tickerRes.data];
      const tickers = await filterTradeableTickers(rawTickers);
      tickers.forEach((t: any) => volumeMap.set(t.symbol, parseFloat(t.quoteVolume || '0')));
    }
  }

  console.error(`[Liquidity Scanner] Analyzing ${symbolsToScan.length} symbols...`);

  interface LiquidityResult {
    symbol: string;
    volume_24h: number;
    liquidity: LiquidityHealth;
  }

  const results: LiquidityResult[] = [];

  // Batch process to avoid rate limits
  for (let i = 0; i < symbolsToScan.length; i += BATCH_SIZE) {
    const batch = symbolsToScan.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async symbol => {
        try {
          const tradesRes = await asterClient.getRecentTrades(symbol, 100);
          if (!tradesRes.success || !tradesRes.data) {
            return {
              symbol,
              volume_24h: volumeMap.get(symbol) || 0,
              liquidity: analyzeLiquidityHealth([]),
            };
          }

          const liquidity = analyzeLiquidityHealth(tradesRes.data);
          return {
            symbol,
            volume_24h: volumeMap.get(symbol) || 0,
            liquidity,
          };
        } catch (err) {
          return {
            symbol,
            volume_24h: volumeMap.get(symbol) || 0,
            liquidity: analyzeLiquidityHealth([]),
          };
        }
      }),
    );

    results.push(...batchResults);
    console.error(
      `[Liquidity Scanner] Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${results.length}/${symbolsToScan.length} analyzed...`,
    );
  }

  // Filter by min score
  const filtered = results.filter(r => r.liquidity.score >= minScore);

  // Sort results
  if (sortBy === 'score') {
    filtered.sort((a, b) => b.liquidity.score - a.liquidity.score);
  } else if (sortBy === 'volume') {
    filtered.sort((a, b) => b.volume_24h - a.volume_24h);
  } else if (sortBy === 'bot_likelihood') {
    filtered.sort(
      (a, b) => b.liquidity.metrics.bot_likelihood - a.liquidity.metrics.bot_likelihood,
    );
  }

  // Format output
  const formatResult = (r: LiquidityResult) => ({
    symbol: r.symbol,
    grade: r.liquidity.grade,
    score: r.liquidity.score,
    volume_24h: `$${(r.volume_24h / 1000).toFixed(0)}k`,
    tradeable: r.liquidity.tradeable,
    trade_frequency: `${r.liquidity.metrics.trade_frequency}/min`,
    bot_likelihood: `${r.liquidity.metrics.bot_likelihood}%`,
    flags: r.liquidity.flags,
    summary: r.liquidity.summary,
  });

  // Categorize by grade
  const gradeA = filtered.filter(r => r.liquidity.grade === 'A');
  const gradeB = filtered.filter(r => r.liquidity.grade === 'B');
  const gradeC = filtered.filter(r => r.liquidity.grade === 'C');
  const gradeD = filtered.filter(r => r.liquidity.grade === 'D');
  const gradeF = filtered.filter(r => r.liquidity.grade === 'F');

  // Bot detection summary
  const highBotLikelihood = filtered.filter(r => r.liquidity.metrics.bot_likelihood >= 70);
  const ghostTowns = filtered.filter(r => r.liquidity.metrics.trade_frequency < 0.1);

  return JSON.stringify(
    {
      scan_time: new Date().toISOString(),
      scan_duration_ms: Date.now() - startTime,
      symbols_scanned: symbolsToScan.length,
      min_score_filter: minScore,
      sort_by: sortBy,
      summary: {
        grade_A: gradeA.length,
        grade_B: gradeB.length,
        grade_C: gradeC.length,
        grade_D: gradeD.length,
        grade_F: gradeF.length,
        bot_dominated: highBotLikelihood.length,
        ghost_towns: ghostTowns.length,
        tradeable: filtered.filter(r => r.liquidity.tradeable).length,
      },
      warnings: {
        bot_dominated: highBotLikelihood.map(r => ({
          symbol: r.symbol,
          bot_likelihood: `${r.liquidity.metrics.bot_likelihood}%`,
          flags: r.liquidity.flags.filter(
            f => f.includes('BOT') || f.includes('CLOCK') || f.includes('SYSTEMATIC'),
          ),
        })),
        ghost_towns: ghostTowns.map(r => ({
          symbol: r.symbol,
          trade_frequency: `${r.liquidity.metrics.trade_frequency}/min`,
          time_span: `${r.liquidity.metrics.time_span_minutes} min`,
        })),
      },
      results_by_grade: {
        A: gradeA.map(formatResult),
        B: gradeB.map(formatResult),
        C: gradeC.map(formatResult),
        D: gradeD.map(formatResult),
        F: gradeF.map(formatResult),
      },
    },
    null,
    2,
  );
}

// --- 35. Grid Scanner - Find pairs suitable for grid/trailing grid strategies ---
async function handleScanGrid(
  minVolume: number = 100000,
  minScore: number = 50,
  limit: number = 15,
  timeframe: string = '1h',
  periods: number = 48,
  preferFunding: 'positive' | 'negative' | 'any' = 'any',
  minAtr: number = 1.0,
): Promise<string> {
  const startTime = Date.now();
  const BATCH_SIZE = 5; // Smaller batches since we fetch klines per symbol

  console.error(`[Grid Scanner] Starting scan for grid-friendly pairs (min ATR: ${minAtr}%)...`);

  // Fetch market data in parallel
  const [tickerRes, fundingRes] = await Promise.all([
    asterClient.getTicker24h(),
    asterClient.getPremiumIndex(),
  ]);

  if (!tickerRes.success || !tickerRes.data) {
    return JSON.stringify({ error: 'Failed to fetch ticker data' });
  }

  // Filter to tradeable symbols only (exclude SETTLING pairs like PORT3)
  const rawTickers = Array.isArray(tickerRes.data) ? tickerRes.data : [tickerRes.data];
  const tradeableTickers = await filterTradeableTickers(rawTickers);

  // Build funding map
  const fundingMap = new Map<string, number>();
  if (fundingRes.success && fundingRes.data) {
    const fundingData = Array.isArray(fundingRes.data) ? fundingRes.data : [fundingRes.data];
    for (const f of fundingData) {
      fundingMap.set(f.symbol, parseFloat(f.lastFundingRate) * 100);
    }
  }

  // Filter by volume first
  const volumeFiltered = tradeableTickers
    .filter((t: any) => parseFloat(t.quoteVolume || '0') >= minVolume)
    .map((t: any) => ({
      symbol: t.symbol,
      price: parseFloat(t.lastPrice || '0'),
      volume24h: parseFloat(t.quoteVolume || '0'),
      change24h: parseFloat(t.priceChangePercent || '0'),
      highPrice: parseFloat(t.highPrice || '0'),
      lowPrice: parseFloat(t.lowPrice || '0'),
      fundingRate: fundingMap.get(t.symbol) || 0,
    }));

  // Apply funding filter
  const fundingFiltered = volumeFiltered.filter(t => {
    if (preferFunding === 'positive') return t.fundingRate > 0;
    if (preferFunding === 'negative') return t.fundingRate < 0;
    return true;
  });

  console.error(
    `[Grid Scanner] ${fundingFiltered.length} pairs pass volume/funding filters, analyzing...`,
  );

  interface GridSignal {
    symbol: string;
    price: number;
    score: number;
    grade: string;
    volume_24h: number;
    funding_rate: number;
    metrics: {
      volatility_score: number;
      atr_pct: number;
      range_24h_pct: number;
      mean_reversion_score: number;
      poc_distance_pct: number;
      vwap_distance_pct: number;
      delta_balance_score: number;
      delta_pct: number;
      funding_score: number;
      volume_score: number;
    };
    levels: {
      poc: number;
      vwap: number;
      va_high: number;
      va_low: number;
      range_high: number;
      range_low: number;
    };
    grid_params: {
      suggested_range_pct: number;
      suggested_grids: number;
      grid_spacing_pct: number;
      entry_zone: string;
    };
    rationale: string[];
  }

  const signals: GridSignal[] = [];

  // Process in batches (klines fetch is heavy)
  for (let i = 0; i < fundingFiltered.length; i += BATCH_SIZE) {
    const batch = fundingFiltered.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async pair => {
        try {
          // Fetch klines for volatility and VPVR analysis
          const klines = await asterClient.getKlines(pair.symbol, timeframe, periods);
          if (!klines.success || !klines.data || klines.data.length < 10) {
            return null;
          }

          const klinesData = klines.data;

          // Calculate ATR (Average True Range)
          let atrSum = 0;
          for (let j = 1; j < klinesData.length; j++) {
            const high = parseFloat(klinesData[j].high);
            const low = parseFloat(klinesData[j].low);
            const prevClose = parseFloat(klinesData[j - 1].close);
            const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
            atrSum += tr;
          }
          const atr = atrSum / (klinesData.length - 1);
          const atrPct = (atr / pair.price) * 100;

          // Filter by minimum ATR - skip dead/stable pairs
          if (atrPct < minAtr) {
            return null;
          }

          // 24h range percentage
          const range24hPct =
            pair.highPrice > 0 ? ((pair.highPrice - pair.lowPrice) / pair.lowPrice) * 100 : 0;

          // VPVR-lite calculation (simplified for speed)
          const allHighs = klinesData.map((k: any) => parseFloat(k.high));
          const allLows = klinesData.map((k: any) => parseFloat(k.low));
          const rangeHigh = Math.max(...allHighs);
          const rangeLow = Math.min(...allLows);
          const range = rangeHigh - rangeLow;

          if (range === 0) return null;

          // Create 20 price bins for quick VPVR
          const numBins = 20;
          const binSize = range / numBins;
          const volumeProfile: number[] = new Array(numBins).fill(0);
          const buyVolume: number[] = new Array(numBins).fill(0);
          const sellVolume: number[] = new Array(numBins).fill(0);

          let vwapNumerator = 0;
          let vwapDenominator = 0;

          for (const k of klinesData) {
            const high = parseFloat(k.high);
            const low = parseFloat(k.low);
            const open = parseFloat(k.open);
            const close = parseFloat(k.close);
            const volume = parseFloat(k.quoteVolume);
            const typicalPrice = (high + low + close) / 3;

            vwapNumerator += typicalPrice * volume;
            vwapDenominator += volume;

            // Use actual taker buy volume if available
            const takerBuyVol = parseFloat(k.takerBuyQuoteVolume || '0');
            const buyVol = takerBuyVol > 0 ? takerBuyVol : volume * 0.5;
            const sellVol = volume - buyVol;

            // WEIGHTED VOLUME DISTRIBUTION (body 70%, wicks 30%)
            const bodyHigh = Math.max(open, close);
            const bodyLow = Math.min(open, close);
            const candleRange = high - low;

            if (candleRange === 0) {
              const singleBin = Math.min(
                Math.max(0, Math.floor((close - rangeLow) / binSize)),
                numBins - 1,
              );
              volumeProfile[singleBin] += volume;
              buyVolume[singleBin] += buyVol;
              sellVolume[singleBin] += sellVol;
              continue;
            }

            const bodyWeight = 0.7;
            const wickWeight = 0.3;
            const upperWickSize = high - bodyHigh;
            const lowerWickSize = bodyLow - low;
            const totalWickSize = upperWickSize + lowerWickSize;

            const lowBin = Math.max(0, Math.floor((low - rangeLow) / binSize));
            const highBin = Math.min(Math.floor((high - rangeLow) / binSize), numBins - 1);
            const bodyLowBin = Math.max(0, Math.floor((bodyLow - rangeLow) / binSize));
            const bodyHighBin = Math.min(Math.floor((bodyHigh - rangeLow) / binSize), numBins - 1);

            // Body bins (70%)
            const bodyBinsCount = Math.max(1, bodyHighBin - bodyLowBin + 1);
            for (let b = bodyLowBin; b <= bodyHighBin; b++) {
              if (b >= 0 && b < numBins) {
                volumeProfile[b] += (volume * bodyWeight) / bodyBinsCount;
                buyVolume[b] += (buyVol * bodyWeight) / bodyBinsCount;
                sellVolume[b] += (sellVol * bodyWeight) / bodyBinsCount;
              }
            }

            // Wick bins (30%)
            if (totalWickSize > 0) {
              if (upperWickSize > 0 && bodyHighBin < highBin) {
                const prop = upperWickSize / totalWickSize;
                const cnt = highBin - bodyHighBin;
                for (let b = bodyHighBin + 1; b <= highBin; b++) {
                  if (b >= 0 && b < numBins) {
                    volumeProfile[b] += (volume * wickWeight * prop) / cnt;
                    buyVolume[b] += (buyVol * wickWeight * prop) / cnt;
                    sellVolume[b] += (sellVol * wickWeight * prop) / cnt;
                  }
                }
              }
              if (lowerWickSize > 0 && lowBin < bodyLowBin) {
                const prop = lowerWickSize / totalWickSize;
                const cnt = bodyLowBin - lowBin;
                for (let b = lowBin; b < bodyLowBin; b++) {
                  if (b >= 0 && b < numBins) {
                    volumeProfile[b] += (volume * wickWeight * prop) / cnt;
                    buyVolume[b] += (buyVol * wickWeight * prop) / cnt;
                    sellVolume[b] += (sellVol * wickWeight * prop) / cnt;
                  }
                }
              }
            }
          }

          // VWAP
          const vwap = vwapDenominator > 0 ? vwapNumerator / vwapDenominator : pair.price;

          // POC (Point of Control)
          let pocIndex = 0;
          let maxVolume = 0;
          for (let b = 0; b < numBins; b++) {
            if (volumeProfile[b] > maxVolume) {
              maxVolume = volumeProfile[b];
              pocIndex = b;
            }
          }
          const poc = rangeLow + (pocIndex + 0.5) * binSize;

          // Value Area (70%)
          const totalVolume = volumeProfile.reduce((a, b) => a + b, 0);
          const valueAreaTarget = totalVolume * 0.7;
          let vaLowIndex = pocIndex;
          let vaHighIndex = pocIndex;
          let vaVolume = volumeProfile[pocIndex];

          while (vaVolume < valueAreaTarget && (vaLowIndex > 0 || vaHighIndex < numBins - 1)) {
            const lowerVol = vaLowIndex > 0 ? volumeProfile[vaLowIndex - 1] : 0;
            const upperVol = vaHighIndex < numBins - 1 ? volumeProfile[vaHighIndex + 1] : 0;
            if (lowerVol >= upperVol && vaLowIndex > 0) {
              vaLowIndex--;
              vaVolume += volumeProfile[vaLowIndex];
            } else if (vaHighIndex < numBins - 1) {
              vaHighIndex++;
              vaVolume += volumeProfile[vaHighIndex];
            } else if (vaLowIndex > 0) {
              vaLowIndex--;
              vaVolume += volumeProfile[vaLowIndex];
            }
          }

          const vaHigh = rangeLow + (vaHighIndex + 1) * binSize;
          const vaLow = rangeLow + vaLowIndex * binSize;

          // Delta calculation
          const totalBuy = buyVolume.reduce((a, b) => a + b, 0);
          const totalSell = sellVolume.reduce((a, b) => a + b, 0);
          const delta = totalBuy - totalSell;
          const deltaPct = totalVolume > 0 ? (delta / totalVolume) * 100 : 0;

          // Distance from POC and VWAP
          const pocDistancePct = Math.abs((pair.price - poc) / poc) * 100;
          const vwapDistancePct = Math.abs((pair.price - vwap) / vwap) * 100;

          // === SCORING ===
          // 1. Volatility Score (25% weight) - Higher ATR = more grid trades
          // Sweet spot: 2-8% ATR. Too low = no trades, too high = risky
          let volatilityScore: number;
          if (atrPct < 0.5)
            volatilityScore = 20; // Too quiet
          else if (atrPct < 1) volatilityScore = 40;
          else if (atrPct < 2) volatilityScore = 60;
          else if (atrPct < 4)
            volatilityScore = 90; // Sweet spot
          else if (atrPct < 8)
            volatilityScore = 100; // Ideal
          else if (atrPct < 15)
            volatilityScore = 70; // Getting risky
          else volatilityScore = 40; // Too volatile

          // 2. Mean Reversion Score (25% weight) - Closer to POC/VWAP = better entry
          const avgDistancePct = (pocDistancePct + vwapDistancePct) / 2;
          let meanReversionScore: number;
          if (avgDistancePct < 0.5)
            meanReversionScore = 100; // At the sweet spot
          else if (avgDistancePct < 1) meanReversionScore = 90;
          else if (avgDistancePct < 2) meanReversionScore = 75;
          else if (avgDistancePct < 3) meanReversionScore = 60;
          else if (avgDistancePct < 5) meanReversionScore = 40;
          else meanReversionScore = 20; // Extended from value

          // 3. Delta Balance Score (20% weight) - Balanced = sideways, trending = risky
          const absDeltaPct = Math.abs(deltaPct);
          let deltaBalanceScore: number;
          if (absDeltaPct < 5)
            deltaBalanceScore = 100; // Very balanced
          else if (absDeltaPct < 10) deltaBalanceScore = 85;
          else if (absDeltaPct < 20) deltaBalanceScore = 60;
          else if (absDeltaPct < 30) deltaBalanceScore = 40;
          else deltaBalanceScore = 20; // One-sided, trending

          // 4. Funding Score (15% weight) - Collect funding while gridding
          const absFunding = Math.abs(pair.fundingRate);
          let fundingScore: number;
          if (absFunding > 0.05)
            fundingScore = 100; // Extreme funding = good income
          else if (absFunding > 0.02) fundingScore = 80;
          else if (absFunding > 0.01) fundingScore = 60;
          else fundingScore = 40; // Low funding, less bonus

          // 5. Volume Score (15% weight) - Need liquidity for fills
          let volumeScore: number;
          if (pair.volume24h >= 10000000)
            volumeScore = 100; // $10M+
          else if (pair.volume24h >= 5000000) volumeScore = 90;
          else if (pair.volume24h >= 1000000) volumeScore = 75;
          else if (pair.volume24h >= 500000) volumeScore = 60;
          else volumeScore = 40;

          // Weighted total
          const totalScore =
            volatilityScore * 0.25 +
            meanReversionScore * 0.25 +
            deltaBalanceScore * 0.2 +
            fundingScore * 0.15 +
            volumeScore * 0.15;

          // Grade assignment
          let grade: string;
          if (totalScore >= 85) grade = 'A';
          else if (totalScore >= 70) grade = 'B';
          else if (totalScore >= 55) grade = 'C';
          else if (totalScore >= 40) grade = 'D';
          else grade = 'F';

          // Suggested grid parameters
          const suggestedRangePct = Math.min(Math.max(atrPct * 3, 2), 15); // 3x ATR, capped
          const suggestedGrids = Math.round(suggestedRangePct / 0.5); // ~0.5% per grid
          const gridSpacingPct = suggestedRangePct / suggestedGrids;

          // Entry zone suggestion
          let entryZone: string;
          if (pair.price < poc && pair.price < vwap) {
            entryZone = 'BELOW_VALUE - Favor LONG grids';
          } else if (pair.price > poc && pair.price > vwap) {
            entryZone = 'ABOVE_VALUE - Favor SHORT grids';
          } else {
            entryZone = 'IN_VALUE - Neutral, both directions';
          }

          // Build rationale
          const rationale: string[] = [];
          if (volatilityScore >= 80)
            rationale.push(`✅ Good volatility (${atrPct.toFixed(2)}% ATR)`);
          else if (volatilityScore < 50)
            rationale.push(`⚠️ Low volatility (${atrPct.toFixed(2)}% ATR)`);

          if (meanReversionScore >= 80)
            rationale.push(`✅ Price near value (${avgDistancePct.toFixed(2)}% from POC/VWAP)`);
          else if (meanReversionScore < 50)
            rationale.push(`⚠️ Extended from value (${avgDistancePct.toFixed(2)}%)`);

          if (deltaBalanceScore >= 80)
            rationale.push(`✅ Balanced flow (${deltaPct.toFixed(1)}% delta)`);
          else if (deltaBalanceScore < 50)
            rationale.push(`⚠️ One-sided flow (${deltaPct.toFixed(1)}% delta)`);

          if (pair.fundingRate > 0.02)
            rationale.push(`💰 High +funding (${pair.fundingRate.toFixed(4)}%) - shorts pay`);
          else if (pair.fundingRate < -0.02)
            rationale.push(`💰 High -funding (${pair.fundingRate.toFixed(4)}%) - longs pay`);

          return {
            symbol: pair.symbol,
            price: pair.price,
            score: Math.round(totalScore),
            grade,
            volume_24h: pair.volume24h,
            funding_rate: pair.fundingRate,
            metrics: {
              volatility_score: Math.round(volatilityScore),
              atr_pct: parseFloat(atrPct.toFixed(3)),
              range_24h_pct: parseFloat(range24hPct.toFixed(2)),
              mean_reversion_score: Math.round(meanReversionScore),
              poc_distance_pct: parseFloat(pocDistancePct.toFixed(3)),
              vwap_distance_pct: parseFloat(vwapDistancePct.toFixed(3)),
              delta_balance_score: Math.round(deltaBalanceScore),
              delta_pct: parseFloat(deltaPct.toFixed(2)),
              funding_score: Math.round(fundingScore),
              volume_score: Math.round(volumeScore),
            },
            levels: {
              poc: parseFloat(poc.toFixed(6)),
              vwap: parseFloat(vwap.toFixed(6)),
              va_high: parseFloat(vaHigh.toFixed(6)),
              va_low: parseFloat(vaLow.toFixed(6)),
              range_high: rangeHigh,
              range_low: rangeLow,
            },
            grid_params: {
              suggested_range_pct: parseFloat(suggestedRangePct.toFixed(2)),
              suggested_grids: suggestedGrids,
              grid_spacing_pct: parseFloat(gridSpacingPct.toFixed(3)),
              entry_zone: entryZone,
            },
            rationale,
          } as GridSignal;
        } catch (err) {
          console.error(`[Grid Scanner] Error analyzing ${pair.symbol}: ${err}`);
          return null;
        }
      }),
    );

    signals.push(...batchResults.filter((s): s is GridSignal => s !== null));
    console.error(
      `[Grid Scanner] Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${signals.length} pairs analyzed...`,
    );
  }

  // Filter by minimum score and sort
  const filtered = signals.filter(s => s.score >= minScore);
  filtered.sort((a, b) => b.score - a.score);

  // Take top results
  const topSignals = filtered.slice(0, limit);

  // Categorize by grade
  const gradeA = topSignals.filter(s => s.grade === 'A');
  const gradeB = topSignals.filter(s => s.grade === 'B');
  const gradeC = topSignals.filter(s => s.grade === 'C');

  // Format output
  const formatSignal = (s: GridSignal) => ({
    symbol: s.symbol,
    grade: s.grade,
    score: s.score,
    price: s.price,
    volume_24h: `$${(s.volume_24h / 1000000).toFixed(2)}M`,
    funding_rate: `${s.funding_rate.toFixed(4)}%`,
    atr_pct: `${s.metrics.atr_pct}%`,
    delta_pct: `${s.metrics.delta_pct}%`,
    poc_distance: `${s.metrics.poc_distance_pct.toFixed(2)}%`,
    levels: {
      poc: s.levels.poc,
      vwap: s.levels.vwap,
      va_high: s.levels.va_high,
      va_low: s.levels.va_low,
    },
    grid_suggestion: {
      range: `±${(s.grid_params.suggested_range_pct / 2).toFixed(1)}%`,
      grids: s.grid_params.suggested_grids,
      spacing: `${s.grid_params.grid_spacing_pct.toFixed(2)}%`,
      entry_zone: s.grid_params.entry_zone,
    },
    rationale: s.rationale,
  });

  // Count how many were filtered by ATR (returned null from batch)
  const filteredByAtr = fundingFiltered.length - signals.length;

  return JSON.stringify(
    {
      scan_time: new Date().toISOString(),
      scan_duration_ms: Date.now() - startTime,
      parameters: {
        min_volume: `$${(minVolume / 1000).toFixed(0)}k`,
        min_score: minScore,
        min_atr: `${minAtr}%`,
        timeframe,
        periods,
        funding_filter: preferFunding,
      },
      summary: {
        pairs_scanned: fundingFiltered.length,
        filtered_by_atr: filteredByAtr,
        analyzed: signals.length,
        passing_score: filtered.length,
        grade_A: gradeA.length,
        grade_B: gradeB.length,
        grade_C: gradeC.length,
      },
      top_picks:
        gradeA.length > 0
          ? gradeA.slice(0, 5).map(s => ({
              symbol: s.symbol,
              score: s.score,
              why: s.rationale.join(' | '),
            }))
          : [],
      results: topSignals.map(formatSignal),
    },
    null,
    2,
  );
}

// --- 36. OBV (On-Balance Volume) Analysis ---
async function handleOBVAnalysis(symbol: string, periods: number = 50): Promise<string> {
  const timeframes = ['5m', '15m', '1h', '4h'] as const;

  // Use proportional periods so each timeframe covers comparable time windows
  // This ensures MTF analysis is actually comparing the same market context
  // 5m/15m: ~24h lookback, 1h: ~48h, 4h: ~7d (need enough candles for OBV trend)
  const periodsPerTimeframe: Record<string, number> = {
    '5m': 288, // 288 * 5m = 24 hours
    '15m': 96, // 96 * 15m = 24 hours
    '1h': 48, // 48 * 1h = 48 hours (2 days)
    '4h': 42, // 42 * 4h = 168 hours (7 days)
  };

  const results: Record<
    string,
    {
      trend: string;
      trendStrength: number;
      divergence: string;
      divergenceNote: string;
      priceChange: string;
      obvChange: string;
      currentOBV: number;
    }
  > = {};

  let errorCount = 0;
  let hasDivergence = false;
  let overallBias: 'bullish' | 'bearish' | 'mixed' | 'neutral' = 'neutral';
  let bullishCount = 0;
  let bearishCount = 0;

  // Fetch klines for all timeframes in parallel with appropriate periods
  const klinePromises = timeframes.map(tf =>
    asterClient.getKlines(symbol, tf, periodsPerTimeframe[tf] || periods),
  );

  const klineResults = await Promise.all(klinePromises);

  for (let i = 0; i < timeframes.length; i++) {
    const tf = timeframes[i];
    const klines = klineResults[i];

    if (!klines.success || !klines.data || klines.data.length < 10) {
      results[tf] = {
        trend: 'error',
        trendStrength: 0,
        divergence: 'none',
        divergenceNote: 'Failed to fetch data',
        priceChange: 'N/A',
        obvChange: 'N/A',
        currentOBV: 0,
      };
      errorCount++;
      continue;
    }

    // Convert to Candle format
    const candles: Candle[] = klines.data.map((k: any) => ({
      t: k.openTime || 0,
      o: k.open,
      h: k.high,
      l: k.low,
      c: k.close,
      v: k.volume,
    }));

    const obv = calculateOBV(candles);

    results[tf] = {
      trend: obv.trend,
      trendStrength: Math.round(obv.trendStrength),
      divergence: obv.divergence,
      divergenceNote: obv.divergenceNote,
      priceChange: `${obv.priceChange >= 0 ? '+' : ''}${obv.priceChange.toFixed(2)}%`,
      obvChange: `${obv.obvChange >= 0 ? '+' : ''}${obv.obvChange.toFixed(2)}`,
      currentOBV: Math.round(obv.currentOBV),
    };

    if (obv.divergence !== 'none') {
      hasDivergence = true;
    }

    if (obv.trend === 'bullish') bullishCount++;
    else if (obv.trend === 'bearish') bearishCount++;
  }

  // Determine overall bias
  if (bullishCount >= 3) overallBias = 'bullish';
  else if (bearishCount >= 3) overallBias = 'bearish';
  else if (bullishCount > 0 && bearishCount > 0) overallBias = 'mixed';
  else overallBias = 'neutral';

  // Get current price for context
  const ticker = await asterClient.getTicker24h(symbol);
  const currentPrice =
    ticker.success && ticker.data
      ? parseFloat(Array.isArray(ticker.data) ? ticker.data[0].lastPrice : ticker.data.lastPrice)
      : 0;

  // Generate trading implications
  const implications: string[] = [];

  if (hasDivergence) {
    // Find which timeframe has divergence
    for (const [tf, data] of Object.entries(results)) {
      if (data.divergence === 'bullish_divergence') {
        implications.push(`⚠️ BULLISH DIVERGENCE on ${tf}: ${data.divergenceNote}`);
      } else if (data.divergence === 'bearish_divergence') {
        implications.push(`⚠️ BEARISH DIVERGENCE on ${tf}: ${data.divergenceNote}`);
      }
    }
  }

  // MTF confluence analysis
  if (overallBias === 'bullish') {
    implications.push(
      '✅ MTF BULLISH: OBV positive across majority of timeframes - accumulation confirmed',
    );
  } else if (overallBias === 'bearish') {
    implications.push(
      '❌ MTF BEARISH: OBV negative across majority of timeframes - distribution confirmed',
    );
  } else if (overallBias === 'mixed') {
    implications.push('⚡ MTF MIXED: Conflicting OBV signals across timeframes - exercise caution');
  }

  // Special case: positive OBV during dump (BTR situation)
  const hasPositiveOBVDuringDump = Object.values(results).some(
    r => r.trend === 'bullish' && parseFloat(r.priceChange) < -3,
  );
  if (hasPositiveOBVDuringDump) {
    implications.push(
      '🔍 HIDDEN ACCUMULATION DETECTED: Positive OBV during price decline - smart money may be buying',
    );
  }

  // Helper to format large numbers (e.g., 2089000 -> "2.09M")
  const formatOBV = (val: number): string => {
    const abs = Math.abs(val);
    const sign = val < 0 ? '-' : '+';
    if (abs >= 1_000_000) return `${sign}${(val / 1_000_000).toFixed(2)}M`;
    if (abs >= 1_000) return `${sign}${(val / 1_000).toFixed(1)}K`;
    return `${sign}${val.toFixed(0)}`;
  };

  // Format timeframe data for output
  const formattedTimeframes: Record<string, any> = {};
  for (const tf of timeframes) {
    const data = results[tf];
    formattedTimeframes[tf] = {
      trend: data.trend.toUpperCase(),
      strength: `${data.trendStrength}/100`,
      price_change: data.priceChange,
      obv_direction: data.obvChange,
      absolute_obv: formatOBV(data.currentOBV),
      divergence:
        data.divergence !== 'none' ? data.divergence.toUpperCase().replace('_', ' ') : 'None',
    };
  }

  return JSON.stringify(
    {
      symbol,
      analysis_time: new Date().toISOString(),
      current_price: currentPrice,
      overall_bias: overallBias.toUpperCase(),
      mtf_summary: {
        bullish_timeframes: bullishCount,
        bearish_timeframes: bearishCount,
        neutral_timeframes: timeframes.length - bullishCount - bearishCount - errorCount,
      },
      has_divergence: hasDivergence,
      timeframes: formattedTimeframes,
      trading_implications: implications,
      interpretation_guide: {
        absolute_obv:
          'Cumulative OBV over the analysis period. Positive = net buying, Negative = net selling. Compare across timeframes.',
        obv_direction:
          'Recent OBV trend (normalized). Shows direction of flow, not absolute volume.',
        bullish_divergence:
          'Price falling but OBV rising = hidden accumulation (potential reversal UP)',
        bearish_divergence:
          'Price rising but OBV falling = hidden distribution (potential reversal DOWN)',
        mtf_confluence: 'When 3+ timeframes agree on OBV direction, signal is higher conviction',
      },
    },
    null,
    2,
  );
}

// ==================== DEEP ANALYSIS (Comprehensive Trading Context) ====================

/**
 * Determine current trading session based on UTC hour
 */
function getCurrentSession(): { session: string; description: string; volatility: string } {
  const utcHour = new Date().getUTCHours();

  // Asian session: 00:00-08:00 UTC (Tokyo/Sydney)
  if (utcHour >= 0 && utcHour < 8) {
    return {
      session: 'ASIAN',
      description: 'Tokyo/Sydney session - typically lower volatility, range-bound',
      volatility: 'LOW_TO_MEDIUM',
    };
  }
  // London session: 08:00-16:00 UTC
  else if (utcHour >= 8 && utcHour < 16) {
    return {
      session: 'LONDON',
      description: 'London session - high liquidity, trend-following moves common',
      volatility: 'MEDIUM_TO_HIGH',
    };
  }
  // New York session: 13:00-21:00 UTC (overlaps with London 13:00-16:00)
  else if (utcHour >= 13 && utcHour < 21) {
    if (utcHour < 16) {
      return {
        session: 'LONDON_NY_OVERLAP',
        description: 'London/NY overlap - HIGHEST volatility window, major moves happen here',
        volatility: 'HIGHEST',
      };
    }
    return {
      session: 'NEW_YORK',
      description: 'New York session - high volume, institutional activity',
      volatility: 'HIGH',
    };
  }
  // Late NY / Early Asian: 21:00-00:00 UTC
  else {
    return {
      session: 'LATE_NY',
      description: 'Late NY / Pre-Asian - low liquidity, potential for gaps',
      volatility: 'LOW',
    };
  }
}

/**
 * Analyze orderbook depth at specific price levels
 */
async function analyzeOrderbookAtLevels(
  symbol: string,
  levels: { name: string; price: number }[],
): Promise<{
  liquidity_at_levels: Array<{
    level_name: string;
    price: number;
    bid_liquidity_usd: number;
    ask_liquidity_usd: number;
    imbalance_pct: number;
    pressure: string;
    depth_within_1pct: { bids_usd: number; asks_usd: number };
  }>;
  total_visible_liquidity: { bids_usd: number; asks_usd: number };
  orderbook_health: string;
}> {
  const orderbook = await asterClient.getOrderBook(symbol, 100);

  if (!orderbook.success || !orderbook.data) {
    return {
      liquidity_at_levels: [],
      total_visible_liquidity: { bids_usd: 0, asks_usd: 0 },
      orderbook_health: 'UNAVAILABLE',
    };
  }

  const bids = orderbook.data.bids || [];
  const asks = orderbook.data.asks || [];

  // Calculate total visible liquidity
  let totalBidsUsd = 0;
  let totalAsksUsd = 0;

  for (const [price, qty] of bids) {
    totalBidsUsd += parseFloat(price) * parseFloat(qty);
  }
  for (const [price, qty] of asks) {
    totalAsksUsd += parseFloat(price) * parseFloat(qty);
  }

  // Analyze liquidity at each VPVR level
  const levelAnalysis = levels.map(level => {
    const priceRange = level.price * 0.01; // 1% range around level
    const levelLow = level.price - priceRange;
    const levelHigh = level.price + priceRange;

    let bidLiquidityNearLevel = 0;
    let askLiquidityNearLevel = 0;

    for (const [price, qty] of bids) {
      const p = parseFloat(price);
      const q = parseFloat(qty);
      if (p >= levelLow && p <= levelHigh) {
        bidLiquidityNearLevel += p * q;
      }
    }

    for (const [price, qty] of asks) {
      const p = parseFloat(price);
      const q = parseFloat(qty);
      if (p >= levelLow && p <= levelHigh) {
        askLiquidityNearLevel += p * q;
      }
    }

    const total = bidLiquidityNearLevel + askLiquidityNearLevel;
    const imbalance =
      total > 0 ? ((bidLiquidityNearLevel - askLiquidityNearLevel) / total) * 100 : 0;

    let pressure = 'NEUTRAL';
    if (imbalance > 20) pressure = 'BID_HEAVY';
    else if (imbalance < -20) pressure = 'ASK_HEAVY';

    return {
      level_name: level.name,
      price: level.price,
      bid_liquidity_usd: Math.round(bidLiquidityNearLevel),
      ask_liquidity_usd: Math.round(askLiquidityNearLevel),
      imbalance_pct: Math.round(imbalance),
      pressure,
      depth_within_1pct: {
        bids_usd: Math.round(bidLiquidityNearLevel),
        asks_usd: Math.round(askLiquidityNearLevel),
      },
    };
  });

  // Determine orderbook health
  const totalImbalance =
    totalAsksUsd > 0 ? ((totalBidsUsd - totalAsksUsd) / (totalBidsUsd + totalAsksUsd)) * 100 : 0;
  let health = 'BALANCED';
  if (Math.abs(totalImbalance) > 30) {
    health = totalImbalance > 0 ? 'BID_DOMINATED' : 'ASK_DOMINATED';
  } else if (totalBidsUsd + totalAsksUsd < 10000) {
    health = 'THIN_LIQUIDITY';
  }

  return {
    liquidity_at_levels: levelAnalysis,
    total_visible_liquidity: {
      bids_usd: Math.round(totalBidsUsd),
      asks_usd: Math.round(totalAsksUsd),
    },
    orderbook_health: health,
  };
}

/**
 * Calculate correlation with BTC over recent candles
 */
async function calculateBTCCorrelation(
  symbol: string,
  timeframe: string,
  periods: number,
): Promise<{
  correlation: number;
  correlation_strength: string;
  btc_change_pct: number;
  symbol_change_pct: number;
  relative_strength: string;
  decoupling_risk: boolean;
}> {
  // Fetch both symbol and BTC klines
  const [symbolKlines, btcKlines] = await Promise.all([
    asterClient.getKlines(symbol, timeframe, periods),
    asterClient.getKlines('BTCUSDT', timeframe, periods),
  ]);

  if (
    !symbolKlines.success ||
    !btcKlines.success ||
    !symbolKlines.data?.length ||
    !btcKlines.data?.length
  ) {
    return {
      correlation: 0,
      correlation_strength: 'UNAVAILABLE',
      btc_change_pct: 0,
      symbol_change_pct: 0,
      relative_strength: 'UNKNOWN',
      decoupling_risk: false,
    };
  }

  // Get closing prices
  const symbolCloses = symbolKlines.data.map((k: any) => parseFloat(k.close));
  const btcCloses = btcKlines.data.map((k: any) => parseFloat(k.close));

  // Use the shorter length
  const minLen = Math.min(symbolCloses.length, btcCloses.length);
  const symbolPrices = symbolCloses.slice(-minLen);
  const btcPrices = btcCloses.slice(-minLen);

  // Calculate returns (percent change between candles)
  const symbolReturns: number[] = [];
  const btcReturns: number[] = [];

  for (let i = 1; i < minLen; i++) {
    symbolReturns.push(((symbolPrices[i] - symbolPrices[i - 1]) / symbolPrices[i - 1]) * 100);
    btcReturns.push(((btcPrices[i] - btcPrices[i - 1]) / btcPrices[i - 1]) * 100);
  }

  // Calculate Pearson correlation
  const n = symbolReturns.length;
  if (n < 5) {
    return {
      correlation: 0,
      correlation_strength: 'INSUFFICIENT_DATA',
      btc_change_pct: 0,
      symbol_change_pct: 0,
      relative_strength: 'UNKNOWN',
      decoupling_risk: false,
    };
  }

  const sumX = symbolReturns.reduce((a, b) => a + b, 0);
  const sumY = btcReturns.reduce((a, b) => a + b, 0);
  const sumXY = symbolReturns.reduce((acc, x, i) => acc + x * btcReturns[i], 0);
  const sumX2 = symbolReturns.reduce((acc, x) => acc + x * x, 0);
  const sumY2 = btcReturns.reduce((acc, y) => acc + y * y, 0);

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

  const correlation = denominator !== 0 ? numerator / denominator : 0;

  // Calculate overall price changes
  const symbolChange = ((symbolPrices[minLen - 1] - symbolPrices[0]) / symbolPrices[0]) * 100;
  const btcChange = ((btcPrices[minLen - 1] - btcPrices[0]) / btcPrices[0]) * 100;

  // Determine correlation strength
  let correlationStrength = 'WEAK';
  if (Math.abs(correlation) > 0.7) correlationStrength = 'STRONG';
  else if (Math.abs(correlation) > 0.4) correlationStrength = 'MODERATE';

  // Relative strength
  let relativeStrength = 'NEUTRAL';
  if (symbolChange > btcChange + 2) relativeStrength = 'OUTPERFORMING_BTC';
  else if (symbolChange < btcChange - 2) relativeStrength = 'UNDERPERFORMING_BTC';

  // Decoupling risk - if correlation is low but both are moving
  const decouplingRisk =
    Math.abs(correlation) < 0.3 && (Math.abs(symbolChange) > 5 || Math.abs(btcChange) > 3);

  return {
    correlation: Math.round(correlation * 100) / 100,
    correlation_strength: correlationStrength,
    btc_change_pct: Math.round(btcChange * 100) / 100,
    symbol_change_pct: Math.round(symbolChange * 100) / 100,
    relative_strength: relativeStrength,
    decoupling_risk: decouplingRisk,
  };
}

/**
 * Handle deep analysis - combines VPVR, orderbook depth, session, and BTC correlation
 */
async function handleDeepAnalysis(
  symbol: string,
  timeframe: string = '15m',
  periods: number = 96,
): Promise<string> {
  const startTime = Date.now();

  // Fetch all data in parallel — including Binance institutional signals
  const [
    klines,
    ticker,
    fundingRes,
    btcCorrelation,
    binanceOiHist,
    binanceTopLS,
    binanceGlobalLS,
    binanceTakerVol,
    binanceFundingRes,
  ] = await Promise.all([
    asterClient.getKlines(symbol, timeframe, periods),
    asterClient.getTicker24h(symbol),
    asterClient.getPremiumIndex(symbol),
    calculateBTCCorrelation(symbol, timeframe, periods),
    // Binance institutional data (gracefully fails if symbol not on Binance)
    binanceClient.getOpenInterestHist(symbol, '1h', 24).catch(() => ({ success: false }) as any),
    binanceClient.getTopLongShortRatio(symbol, '1h', 12).catch(() => ({ success: false }) as any),
    binanceClient
      .getGlobalLongShortRatio(symbol, '1h', 12)
      .catch(() => ({ success: false }) as any),
    binanceClient.getTakerBuySellVolume(symbol, '1h', 12).catch(() => ({ success: false }) as any),
    binanceClient.getPremiumIndex(symbol).catch(() => ({ success: false }) as any),
  ]);

  if (!klines.success || !klines.data || !klines.data.length) {
    return JSON.stringify({ error: 'Failed to fetch klines', symbol });
  }

  const klinesData = klines.data;
  const currentPrice =
    ticker.success && ticker.data
      ? parseFloat(Array.isArray(ticker.data) ? ticker.data[0].lastPrice : ticker.data.lastPrice)
      : parseFloat(klinesData[klinesData.length - 1].close);

  const fundingRate =
    fundingRes.success && fundingRes.data
      ? parseFloat(
          Array.isArray(fundingRes.data)
            ? fundingRes.data[0].lastFundingRate
            : fundingRes.data.lastFundingRate,
        )
      : 0;

  // Process Binance institutional data
  const binanceSignals: any = { available: false };
  const binanceImplications: string[] = [];

  // OI History
  if (binanceOiHist.success && binanceOiHist.data && binanceOiHist.data.length >= 3) {
    binanceSignals.available = true;
    const oiData = binanceOiHist.data;
    const oldestOI = parseFloat(oiData[0].sumOpenInterestValue || oiData[0].sumOpenInterest || '0');
    const latestOI = parseFloat(
      oiData[oiData.length - 1].sumOpenInterestValue ||
        oiData[oiData.length - 1].sumOpenInterest ||
        '0',
    );
    const oiChangePct = oldestOI > 0 ? ((latestOI - oldestOI) / oldestOI) * 100 : 0;

    const midIdx = Math.floor(oiData.length / 2);
    const midOI = parseFloat(
      oiData[midIdx].sumOpenInterestValue || oiData[midIdx].sumOpenInterest || '0',
    );
    const firstHalfChange = oldestOI > 0 ? ((midOI - oldestOI) / oldestOI) * 100 : 0;
    const secondHalfChange = midOI > 0 ? ((latestOI - midOI) / midOI) * 100 : 0;

    let oiTrend = 'FLAT';
    if (oiChangePct > 5) {
      oiTrend = secondHalfChange > firstHalfChange ? 'RISING_ACCELERATING' : 'RISING_DECELERATING';
    } else if (oiChangePct < -5) {
      oiTrend =
        secondHalfChange < firstHalfChange ? 'FALLING_ACCELERATING' : 'FALLING_DECELERATING';
    }

    binanceSignals.oi_change_24h = `${oiChangePct >= 0 ? '+' : ''}${oiChangePct.toFixed(2)}%`;
    binanceSignals.oi_trend = oiTrend;

    if (oiChangePct > 5)
      binanceImplications.push(
        `OI up ${oiChangePct.toFixed(1)}% (${oiTrend}) — new positions being opened`,
      );
    else if (oiChangePct < -5)
      binanceImplications.push(
        `OI down ${oiChangePct.toFixed(1)}% (${oiTrend}) — positions closing`,
      );
  }

  // Top Trader L/S
  if (binanceTopLS.success && binanceTopLS.data && binanceTopLS.data.length >= 1) {
    binanceSignals.available = true;
    const latest = binanceTopLS.data[binanceTopLS.data.length - 1];
    const oldest = binanceTopLS.data[0];
    const latestRatio = parseFloat(latest.longShortRatio || '1');
    const oldestRatio = parseFloat(oldest.longShortRatio || '1');
    const trend = latestRatio - oldestRatio;

    binanceSignals.top_trader_ls = latestRatio.toFixed(2);
    binanceSignals.top_trader_trend =
      trend > 0.15 ? 'INCREASINGLY_LONG' : trend < -0.15 ? 'INCREASINGLY_SHORT' : 'FLAT';

    if (latestRatio > 1.5)
      binanceImplications.push(`Top traders bullish (${latestRatio.toFixed(2)} L/S)`);
    else if (latestRatio < 0.67)
      binanceImplications.push(`Top traders bearish (${latestRatio.toFixed(2)} L/S)`);
  }

  // Global L/S (retail)
  if (binanceGlobalLS.success && binanceGlobalLS.data && binanceGlobalLS.data.length >= 1) {
    const latest = binanceGlobalLS.data[binanceGlobalLS.data.length - 1];
    const globalRatio = parseFloat(latest.longShortRatio || '1');
    binanceSignals.global_ls = globalRatio.toFixed(2);

    // Smart vs retail divergence
    if (binanceSignals.top_trader_ls) {
      const topLS = parseFloat(binanceSignals.top_trader_ls);
      const divergence = topLS - globalRatio;
      binanceSignals.smart_vs_retail = divergence.toFixed(2);
      if (divergence > 0.3) {
        binanceImplications.push(
          `Smart money more bullish than retail (+${divergence.toFixed(2)} divergence)`,
        );
      } else if (divergence < -0.3) {
        binanceImplications.push(
          `Retail more bullish than smart money — potential trap (${divergence.toFixed(2)} divergence)`,
        );
      }
    }
  }

  // Taker Buy/Sell
  if (binanceTakerVol.success && binanceTakerVol.data && binanceTakerVol.data.length >= 3) {
    const recentSlice = binanceTakerVol.data.slice(-6);
    const totalBuyVol = recentSlice.reduce(
      (s: number, d: any) => s + parseFloat(d.buyVol || '0'),
      0,
    );
    const totalSellVol = recentSlice.reduce(
      (s: number, d: any) => s + parseFloat(d.sellVol || '0'),
      0,
    );
    const totalVol = totalBuyVol + totalSellVol;
    const takerBuyPct = totalVol > 0 ? (totalBuyVol / totalVol) * 100 : 50;

    binanceSignals.taker_buy_pct = `${takerBuyPct.toFixed(1)}%`;
    if (takerBuyPct > 55)
      binanceImplications.push(
        `Aggressive buyers dominating (${takerBuyPct.toFixed(1)}% taker buy)`,
      );
    else if (takerBuyPct < 45)
      binanceImplications.push(
        `Aggressive sellers dominating (${takerBuyPct.toFixed(1)}% taker buy)`,
      );
  }

  // Binance funding comparison
  if (binanceFundingRes.success && binanceFundingRes.data) {
    const bFunding = Array.isArray(binanceFundingRes.data)
      ? binanceFundingRes.data[0]
      : binanceFundingRes.data;
    if (bFunding) {
      const binanceFundingRate = parseFloat(bFunding.lastFundingRate || '0');
      binanceSignals.funding_binance = `${(binanceFundingRate * 100).toFixed(4)}%`;
      binanceSignals.funding_aster = `${(fundingRate * 100).toFixed(4)}%`;
      const divBps = (fundingRate - binanceFundingRate) * 10000;
      binanceSignals.funding_divergence = `${divBps > 0 ? '+' : ''}${divBps.toFixed(1)}bps`;
      if (Math.abs(divBps) > 20) {
        binanceImplications.push(
          `Funding divergence ${divBps.toFixed(0)}bps between Aster/Binance`,
        );
      }
    }
  }

  // Derive institutional conviction
  if (binanceSignals.available) {
    let bullishCount = 0;
    let bearishCount = 0;
    let total = 0;

    if (binanceSignals.oi_trend) {
      total++;
      if (binanceSignals.oi_trend.startsWith('RISING')) bullishCount++;
      else if (binanceSignals.oi_trend.startsWith('FALLING')) bearishCount++;
    }
    if (binanceSignals.top_trader_ls) {
      total++;
      if (parseFloat(binanceSignals.top_trader_ls) > 1.2) bullishCount++;
      else if (parseFloat(binanceSignals.top_trader_ls) < 0.83) bearishCount++;
    }
    if (binanceSignals.taker_buy_pct) {
      total++;
      const tbp = parseFloat(binanceSignals.taker_buy_pct);
      if (tbp > 52) bullishCount++;
      else if (tbp < 48) bearishCount++;
    }

    const maxSide = bullishCount >= bearishCount ? 'BULLISH' : 'BEARISH';
    const maxCount = Math.max(bullishCount, bearishCount);
    binanceSignals.institutional_conviction = `${maxSide} — ${maxCount}/${total} indicators align`;
  }

  // Calculate VPVR
  const numBins = 40;
  const allHighs = klinesData.map((k: any) => parseFloat(k.high));
  const allLows = klinesData.map((k: any) => parseFloat(k.low));
  const rangeHigh = Math.max(...allHighs);
  const rangeLow = Math.min(...allLows);
  const range = rangeHigh - rangeLow;

  if (range === 0) {
    return JSON.stringify({ error: 'No price range detected', symbol });
  }

  const binSize = range / numBins;
  const volumeProfile: number[] = new Array(numBins).fill(0);
  const buyVolume: number[] = new Array(numBins).fill(0);
  const sellVolume: number[] = new Array(numBins).fill(0);
  let vwapNumerator = 0;
  let vwapDenominator = 0;

  for (const k of klinesData) {
    const high = parseFloat(k.high);
    const low = parseFloat(k.low);
    const close = parseFloat(k.close);
    const volume = parseFloat(k.quoteVolume);
    const typicalPrice = (high + low + close) / 3;

    vwapNumerator += typicalPrice * volume;
    vwapDenominator += volume;

    const candleRange = high - low;
    const buyRatio = candleRange > 0 ? (close - low) / candleRange : 0.5;
    const buyVol = volume * buyRatio;
    const sellVol = volume * (1 - buyRatio);

    const lowBin = Math.max(0, Math.floor((low - rangeLow) / binSize));
    const highBin = Math.min(Math.floor((high - rangeLow) / binSize), numBins - 1);
    const binsCount = highBin - lowBin + 1;

    for (let i = lowBin; i <= highBin; i++) {
      if (i >= 0 && i < numBins) {
        volumeProfile[i] += volume / binsCount;
        buyVolume[i] += buyVol / binsCount;
        sellVolume[i] += sellVol / binsCount;
      }
    }
  }

  const vwap = vwapDenominator > 0 ? vwapNumerator / vwapDenominator : currentPrice;
  const totalVolume = volumeProfile.reduce((a, b) => a + b, 0);

  // Find POC
  let pocIndex = 0;
  let maxVolume = 0;
  for (let i = 0; i < numBins; i++) {
    if (volumeProfile[i] > maxVolume) {
      maxVolume = volumeProfile[i];
      pocIndex = i;
    }
  }
  const pocPrice = rangeLow + (pocIndex + 0.5) * binSize;

  // Value Area
  const valueAreaTarget = totalVolume * 0.7;
  let vaLowIndex = pocIndex;
  let vaHighIndex = pocIndex;
  let vaVolume = volumeProfile[pocIndex];

  while (vaVolume < valueAreaTarget && (vaLowIndex > 0 || vaHighIndex < numBins - 1)) {
    const lowerVol = vaLowIndex > 0 ? volumeProfile[vaLowIndex - 1] : 0;
    const upperVol = vaHighIndex < numBins - 1 ? volumeProfile[vaHighIndex + 1] : 0;
    if (lowerVol >= upperVol && vaLowIndex > 0) {
      vaLowIndex--;
      vaVolume += volumeProfile[vaLowIndex];
    } else if (vaHighIndex < numBins - 1) {
      vaHighIndex++;
      vaVolume += volumeProfile[vaHighIndex];
    } else if (vaLowIndex > 0) {
      vaLowIndex--;
      vaVolume += volumeProfile[vaLowIndex];
    }
  }

  const vaHigh = rangeLow + (vaHighIndex + 1) * binSize;
  const vaLow = rangeLow + vaLowIndex * binSize;

  // Delta
  const totalBuy = buyVolume.reduce((a, b) => a + b, 0);
  const totalSell = sellVolume.reduce((a, b) => a + b, 0);
  const delta = totalBuy - totalSell;
  const deltaPct = totalVolume > 0 ? (delta / totalVolume) * 100 : 0;

  // Position analysis
  let pricePosition: string;
  let bias: string;
  if (currentPrice > vaHigh) {
    pricePosition = 'ABOVE_VALUE_AREA';
    bias = 'BULLISH_BREAKOUT';
  } else if (currentPrice < vaLow) {
    pricePosition = 'BELOW_VALUE_AREA';
    bias = 'BEARISH_BREAKDOWN';
  } else if (currentPrice > pocPrice) {
    pricePosition = 'UPPER_VALUE_AREA';
    bias = 'NEUTRAL_BULLISH';
  } else {
    pricePosition = 'LOWER_VALUE_AREA';
    bias = 'NEUTRAL_BEARISH';
  }

  // Get orderbook analysis at key levels
  const keyLevels = [
    { name: 'POC', price: pocPrice },
    { name: 'VAH', price: vaHigh },
    { name: 'VAL', price: vaLow },
    { name: 'CURRENT', price: currentPrice },
  ];
  const orderbookAnalysis = await analyzeOrderbookAtLevels(symbol, keyLevels);

  // Get session info
  const sessionInfo = getCurrentSession();

  // Generate trading implications
  const implications: string[] = [];

  // VPVR-based implications
  if (pricePosition === 'BELOW_VALUE_AREA') {
    implications.push('📉 BEARISH: Price below value area - distribution phase');
  } else if (pricePosition === 'ABOVE_VALUE_AREA') {
    implications.push('📈 BULLISH: Price above value area - accumulation phase');
  }

  // Delta implications
  if (deltaPct < -20) {
    implications.push(`🔴 SELLING PRESSURE: Delta ${deltaPct.toFixed(1)}% - sellers dominating`);
  } else if (deltaPct > 20) {
    implications.push(`🟢 BUYING PRESSURE: Delta +${deltaPct.toFixed(1)}% - buyers dominating`);
  }

  // BTC correlation implications
  if (btcCorrelation.decoupling_risk) {
    implications.push(
      '⚠️ DECOUPLING RISK: Low BTC correlation with significant moves - exercise caution',
    );
  }
  if (btcCorrelation.relative_strength === 'UNDERPERFORMING_BTC') {
    implications.push('📊 WEAK: Underperforming BTC - potential further downside if BTC drops');
  } else if (btcCorrelation.relative_strength === 'OUTPERFORMING_BTC') {
    implications.push('💪 STRONG: Outperforming BTC - relative strength indicates demand');
  }

  // Session implications
  if (sessionInfo.session === 'LATE_NY' || sessionInfo.session === 'ASIAN') {
    implications.push(
      `🌙 LOW VOLATILITY SESSION: ${sessionInfo.session} - be aware of potential gaps/thin liquidity`,
    );
  } else if (sessionInfo.session === 'LONDON_NY_OVERLAP') {
    implications.push('⚡ HIGH VOLATILITY WINDOW: London/NY overlap - expect fast moves');
  }

  // Orderbook implications
  const currentLevel = orderbookAnalysis.liquidity_at_levels.find(l => l.level_name === 'CURRENT');
  if (currentLevel) {
    if (currentLevel.pressure === 'ASK_HEAVY') {
      implications.push('📕 ORDERBOOK: Heavy ask pressure at current level - resistance zone');
    } else if (currentLevel.pressure === 'BID_HEAVY') {
      implications.push('📗 ORDERBOOK: Heavy bid support at current level - support zone');
    }
  }

  if (orderbookAnalysis.orderbook_health === 'THIN_LIQUIDITY') {
    implications.push(
      '⚠️ THIN ORDERBOOK: Low visible liquidity - expect slippage and volatile moves',
    );
  }

  // Format price helper
  const formatPrice = (p: number): string => {
    if (p < 0.0001) return p.toFixed(8);
    if (p < 0.01) return p.toFixed(6);
    if (p < 1) return p.toFixed(5);
    if (p < 100) return p.toFixed(4);
    return p.toFixed(2);
  };

  const analysisTime = Date.now() - startTime;
  const regimeBlock = await getCompactRegimeBlock();

  return JSON.stringify(
    {
      market_regime: regimeBlock,
      symbol,
      analysis_time: new Date().toISOString(),
      analysis_duration_ms: analysisTime,
      current_price: formatPrice(currentPrice),

      // VPVR Summary
      vpvr: {
        poc: formatPrice(pocPrice),
        vwap: formatPrice(vwap),
        vah: formatPrice(vaHigh),
        val: formatPrice(vaLow),
        price_position: pricePosition,
        bias,
        delta_pct: `${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(1)}%`,
        total_volume_usd:
          totalVolume > 1000000
            ? `$${(totalVolume / 1000000).toFixed(2)}M`
            : `$${(totalVolume / 1000).toFixed(0)}k`,
      },

      // Orderbook depth at key levels
      orderbook_depth: {
        health: orderbookAnalysis.orderbook_health,
        total_visible: orderbookAnalysis.total_visible_liquidity,
        at_vpvr_levels: orderbookAnalysis.liquidity_at_levels.map(l => ({
          level: l.level_name,
          price: formatPrice(l.price),
          bids_usd: l.bid_liquidity_usd,
          asks_usd: l.ask_liquidity_usd,
          pressure: l.pressure,
        })),
      },

      // Session context
      session: {
        current: sessionInfo.session,
        description: sessionInfo.description,
        volatility_expectation: sessionInfo.volatility,
        utc_hour: new Date().getUTCHours(),
      },

      // BTC correlation
      btc_correlation: btcCorrelation,

      // Funding
      funding: {
        rate: (fundingRate * 100).toFixed(4) + '%',
        daily_cost: (fundingRate * 3 * 100).toFixed(4) + '%',
        direction: fundingRate > 0 ? 'LONGS_PAY' : fundingRate < 0 ? 'SHORTS_PAY' : 'NEUTRAL',
        note:
          Math.abs(fundingRate) > 0.0003
            ? 'HIGH FUNDING - consider funding as directional signal'
            : 'Normal funding levels',
      },

      // Binance Institutional Signals (the good stuff)
      binance_signals: binanceSignals.available
        ? binanceSignals
        : { available: false, note: 'Symbol not found on Binance or data unavailable' },

      // Trading implications (now includes Binance insights)
      trading_implications: [...implications, ...binanceImplications.map(i => `[BINANCE] ${i}`)],

      // Quick decision summary
      quick_summary: {
        structure: bias,
        flow: deltaPct > 10 ? 'BUYERS' : deltaPct < -10 ? 'SELLERS' : 'BALANCED',
        btc_aligned: btcCorrelation.correlation > 0.5,
        session_favorable: sessionInfo.volatility !== 'LOW',
        orderbook_supportive: orderbookAnalysis.orderbook_health !== 'THIN_LIQUIDITY',
        binance_conviction: binanceSignals.institutional_conviction || 'N/A',
      },
    },
    null,
    2,
  );
}

// ==================== SCALEGRID HANDLERS ====================

/**
 * Initialize ScaleGrid engine if not already initialized
 */
async function ensureScaleGridEngine(): Promise<ScaleGridEngine> {
  if (scaleGridEngine) return scaleGridEngine;

  if (!tradingEnabled) {
    throw new Error(
      'Trading credentials required. Use manage_credentials to set API key and secret.',
    );
  }

  scaleGridEngine = new ScaleGridEngine();
  const creds = await credentialManager.getCredentials();
  if (!creds) {
    throw new Error('Credentials not found');
  }

  const result = await scaleGridEngine.initialize(creds.apiKey, creds.apiSecret);
  if (!result.success) {
    scaleGridEngine = null;
    throw new Error(result.error || 'Failed to initialize ScaleGrid engine');
  }

  return scaleGridEngine;
}

/**
 * Preview grid without placing orders
 */
async function handleGridPreview(
  symbol: string,
  baseOrderUsd: number,
  rangePercent: number = 20,
  positionScale: number = 1.5,
  stepScale: number = 1.2,
  tpPercent: number = 3,
  leverage: number = 10,
  entryPrice?: number,
): Promise<string> {
  // Get current price if not provided
  let price = entryPrice;
  if (!price) {
    const priceRes = await asterClient.getPrice(symbol);
    if (!priceRes.success || !priceRes.data) {
      return JSON.stringify({ error: 'Failed to get current price' });
    }
    price = parseFloat(Array.isArray(priceRes.data) ? priceRes.data[0].price : priceRes.data.price);
  }

  const config = mergeConfig({
    symbol: symbol.toUpperCase().endsWith('USDT')
      ? symbol.toUpperCase()
      : `${symbol.toUpperCase()}USDT`,
    baseOrderUsd,
    rangePercent,
    positionScale,
    stepScale,
    tpPercent,
    leverage,
  });

  const calculation = calculateGridLevels(price, config);
  const preview = formatGridCalculation(calculation, config);

  return JSON.stringify(
    {
      symbol: config.symbol,
      entry_price: price,
      config: {
        base_order_usd: baseOrderUsd,
        range_percent: rangePercent,
        position_scale: positionScale,
        step_scale: stepScale,
        tp_percent: tpPercent,
        leverage,
      },
      calculation: {
        total_levels: calculation.totalLevels,
        total_size_usd: calculation.totalSizeUsd,
        required_margin: calculation.requiredMargin,
        worst_case_avg_entry: calculation.worstCaseAvgEntry,
        worst_case_tp_price: calculation.worstCaseTpPrice,
      },
      levels: calculation.levels.map(l => ({
        index: l.index,
        price: l.price,
        distance_percent: l.distancePercent,
        size_usd: l.sizeUsd,
        multiplier: l.multiplier,
      })),
      formatted_preview: preview,
    },
    null,
    2,
  );
}

/**
 * Start a new scaled grid
 */
async function handleGridStart(
  symbol: string,
  baseOrderUsd: number,
  side: 'LONG' | 'SHORT' = 'LONG',
  rangePercent: number = 20,
  positionScale: number = 1.5,
  stepScale: number = 1.2,
  tpPercent: number = 3,
  maxPositionUsd: number = 1000,
  leverage: number = 10,
): Promise<string> {
  const engine = await ensureScaleGridEngine();

  const result = await engine.startGrid({
    symbol: symbol.toUpperCase().endsWith('USDT')
      ? symbol.toUpperCase()
      : `${symbol.toUpperCase()}USDT`,
    side,
    baseOrderUsd,
    rangePercent,
    positionScale,
    stepScale,
    tpPercent,
    maxPositionUsd,
    leverage,
  });

  if (!result.success) {
    return JSON.stringify({ error: result.error });
  }

  const grid = result.data!;
  return JSON.stringify(
    {
      success: true,
      grid_id: grid.id,
      symbol: grid.symbol,
      side: grid.config.side,
      entry_price: grid.entryPrice,
      levels: grid.levels.length,
      placed_levels: grid.levels.filter(l => l.status === 'PLACED').length,
      tp_price: grid.tpPrice,
      message: `Grid started! ID: ${grid.id}`,
    },
    null,
    2,
  );
}

/**
 * Get grid status
 */
async function handleGridStatus(gridId?: string): Promise<string> {
  const engine = await ensureScaleGridEngine();

  if (gridId) {
    const grid = engine.getGrid(gridId);
    if (!grid) {
      return JSON.stringify({ error: `Grid not found: ${gridId}` });
    }

    const riskStatus = engine.getRiskStatus(gridId);

    return JSON.stringify(
      {
        id: grid.id,
        symbol: grid.symbol,
        side: grid.config.side,
        risk_state: grid.riskState,
        entry_price: grid.entryPrice,
        avg_entry: grid.avgEntry,
        position_size: grid.positionSize,
        position_cost_usd: grid.positionCostUsd,
        tp_price: grid.tpPrice,
        unrealized_pnl: grid.unrealizedPnl,
        unrealized_pnl_percent: grid.unrealizedPnlPercent,
        filled_levels: grid.filledLevelCount,
        total_levels: grid.levels.length,
        levels: grid.levels.map(l => ({
          index: l.index,
          price: l.price,
          size_usd: l.sizeUsd,
          status: l.status,
          fill_price: l.fillPrice,
        })),
        risk_status: riskStatus,
        created_at: new Date(grid.createdAt).toISOString(),
        updated_at: new Date(grid.updatedAt).toISOString(),
      },
      null,
      2,
    );
  }

  // Show all grids
  const grids = engine.getAllGrids();
  if (grids.length === 0) {
    return JSON.stringify({ message: 'No grids found', grids: [] });
  }

  return JSON.stringify(
    {
      total_grids: grids.length,
      active_grids: grids.filter(g => g.riskState === 'ACTIVE' || g.riskState === 'CAPPED').length,
      grids: grids.map(g => ({
        id: g.id,
        symbol: g.symbol,
        side: g.config.side,
        risk_state: g.riskState,
        filled_levels: g.filledLevelCount,
        total_levels: g.levels.length,
        unrealized_pnl_percent: g.unrealizedPnlPercent,
      })),
    },
    null,
    2,
  );
}

/**
 * Adjust grid parameters
 */
async function handleGridAdjust(
  gridId: string,
  tpPercent?: number,
  maxPositionUsd?: number,
  maxDrawdownPercent?: number,
): Promise<string> {
  const engine = await ensureScaleGridEngine();

  const result = await engine.adjustGrid({
    gridId,
    tpPercent,
    maxPositionUsd,
    maxDrawdownPercent,
  });

  if (!result.success) {
    return JSON.stringify({ error: result.error });
  }

  return JSON.stringify(
    {
      success: true,
      grid_id: gridId,
      message: 'Grid adjusted',
      new_tp_price: result.data?.tpPrice,
    },
    null,
    2,
  );
}

/**
 * Pause grid
 */
async function handleGridPause(gridId: string): Promise<string> {
  const engine = await ensureScaleGridEngine();
  const result = await engine.pauseGrid(gridId);

  if (!result.success) {
    return JSON.stringify({ error: result.error });
  }

  return JSON.stringify({ success: true, message: `Grid ${gridId} paused` }, null, 2);
}

/**
 * Resume grid
 */
async function handleGridResume(gridId: string): Promise<string> {
  const engine = await ensureScaleGridEngine();
  const result = await engine.resumeGrid(gridId);

  if (!result.success) {
    return JSON.stringify({ error: result.error });
  }

  return JSON.stringify({ success: true, message: `Grid ${gridId} resumed` }, null, 2);
}

/**
 * Close grid
 */
async function handleGridClose(gridId: string, keepPosition: boolean = false): Promise<string> {
  const engine = await ensureScaleGridEngine();
  const result = await engine.closeGrid({ gridId, keepPosition });

  if (!result.success) {
    return JSON.stringify({ error: result.error });
  }

  return JSON.stringify(
    {
      success: true,
      message: `Grid ${gridId} closed`,
      position_kept: keepPosition,
    },
    null,
    2,
  );
}

// --- 19. VPVR Analysis (Enhanced with VWAP, Intrabar Delta, Dynamic Precision) ---

// Dynamic price formatter based on magnitude
function formatVPVRPrice(price: number): string {
  if (price >= 10000) return price.toFixed(1); // BTC: $92,117.4
  if (price >= 1000) return price.toFixed(2); // ETH: $3,245.67
  if (price >= 100) return price.toFixed(3); // SOL: $145.234
  if (price >= 1) return price.toFixed(4); // XRP: $0.5234
  if (price >= 0.01) return price.toFixed(5); // SHIB: $0.00001
  return price.toFixed(6); // Micro caps
}

// ANSI color codes (with fallback detection)
const useColors = process.stdout?.isTTY !== false;
const colors = {
  green: useColors ? '\x1b[32m' : '',
  red: useColors ? '\x1b[31m' : '',
  yellow: useColors ? '\x1b[33m' : '',
  cyan: useColors ? '\x1b[36m' : '',
  bold: useColors ? '\x1b[1m' : '',
  reset: useColors ? '\x1b[0m' : '',
};

async function handleVPVRAnalysis(
  symbol: string,
  timeframe: string = '15m',
  periods: number = 96,
  numBins: number = 40,
): Promise<string> {
  // Fetch all data in parallel (now includes BTC correlation for context)
  const [klines, ticker, fundingRes, btcCorrelation] = await Promise.all([
    asterClient.getKlines(symbol, timeframe, periods),
    asterClient.getTicker24h(symbol),
    asterClient.getPremiumIndex(symbol),
    calculateBTCCorrelation(symbol, timeframe, periods),
  ]);

  if (!klines.success || !klines.data || !klines.data.length) {
    return JSON.stringify({ error: 'Failed to fetch klines', symbol });
  }

  const klinesData = klines.data;

  // Get current price
  const currentPrice =
    ticker.success && ticker.data
      ? parseFloat(Array.isArray(ticker.data) ? ticker.data[0].lastPrice : ticker.data.lastPrice)
      : parseFloat(klinesData[klinesData.length - 1].close);

  // Get funding
  const fundingRate =
    fundingRes.success && fundingRes.data
      ? parseFloat(
          Array.isArray(fundingRes.data)
            ? fundingRes.data[0].lastFundingRate
            : fundingRes.data.lastFundingRate,
        )
      : 0;

  // Find price range
  const allHighs = klinesData.map((k: any) => parseFloat(k.high));
  const allLows = klinesData.map((k: any) => parseFloat(k.low));
  const rangeHigh = Math.max(...allHighs);
  const rangeLow = Math.min(...allLows);
  const range = rangeHigh - rangeLow;

  if (range === 0) {
    return JSON.stringify({ error: 'No price range detected', symbol });
  }

  // Create price buckets
  const binSize = range / numBins;
  const volumeProfile: number[] = new Array(numBins).fill(0);
  const buyVolume: number[] = new Array(numBins).fill(0);
  const sellVolume: number[] = new Array(numBins).fill(0);

  // VWAP calculation
  let vwapNumerator = 0;
  let vwapDenominator = 0;

  // Distribute volume across price levels with INTRABAR STRENGTH
  for (const k of klinesData) {
    const high = parseFloat(k.high);
    const low = parseFloat(k.low);
    const open = parseFloat(k.open);
    const close = parseFloat(k.close);
    const volume = parseFloat(k.quoteVolume);
    const typicalPrice = (high + low + close) / 3;

    // VWAP accumulation
    vwapNumerator += typicalPrice * volume;
    vwapDenominator += volume;

    // Use ACTUAL taker buy volume from Aster API (not heuristic estimation)
    // takerBuyQuoteVolume = volume bought by takers (aggressive buyers hitting asks)
    // Remaining volume = taker sells (aggressive sellers hitting bids)
    const takerBuyVol = parseFloat(k.takerBuyQuoteVolume || '0');
    const buyVol = takerBuyVol > 0 ? takerBuyVol : volume * 0.5; // Fallback if missing
    const sellVol = volume - buyVol;

    // WEIGHTED VOLUME DISTRIBUTION
    // Body (open-close) gets more weight than wicks since price spent more time there
    const bodyHigh = Math.max(open, close);
    const bodyLow = Math.min(open, close);
    const candleRange = high - low;

    // Handle edge cases
    if (candleRange === 0) {
      // Single price point - all volume to one bin
      const singleBin = Math.min(
        Math.max(0, Math.floor((close - rangeLow) / binSize)),
        numBins - 1,
      );
      volumeProfile[singleBin] += volume;
      buyVolume[singleBin] += buyVol;
      sellVolume[singleBin] += sellVol;
      continue;
    }

    // Weight distribution: body 70%, wicks 30% (split by wick size)
    const bodyWeight = 0.7;
    const wickWeight = 0.3;

    const upperWickSize = high - bodyHigh;
    const lowerWickSize = bodyLow - low;
    const totalWickSize = upperWickSize + lowerWickSize;

    // Calculate bins for each zone
    const lowBin = Math.max(0, Math.floor((low - rangeLow) / binSize));
    const highBin = Math.min(Math.floor((high - rangeLow) / binSize), numBins - 1);
    const bodyLowBin = Math.max(0, Math.floor((bodyLow - rangeLow) / binSize));
    const bodyHighBin = Math.min(Math.floor((bodyHigh - rangeLow) / binSize), numBins - 1);

    // Distribute to body bins (70% of volume)
    const bodyBinsCount = Math.max(1, bodyHighBin - bodyLowBin + 1);
    const volPerBodyBin = (volume * bodyWeight) / bodyBinsCount;
    const buyPerBodyBin = (buyVol * bodyWeight) / bodyBinsCount;
    const sellPerBodyBin = (sellVol * bodyWeight) / bodyBinsCount;

    for (let i = bodyLowBin; i <= bodyHighBin; i++) {
      if (i >= 0 && i < numBins) {
        volumeProfile[i] += volPerBodyBin;
        buyVolume[i] += buyPerBodyBin;
        sellVolume[i] += sellPerBodyBin;
      }
    }

    // Distribute to wick bins (30% of volume, split proportionally by wick size)
    if (totalWickSize > 0) {
      // Upper wick
      if (upperWickSize > 0 && bodyHighBin < highBin) {
        const upperWickProportion = upperWickSize / totalWickSize;
        const upperWickVol = volume * wickWeight * upperWickProportion;
        const upperWickBuy = buyVol * wickWeight * upperWickProportion;
        const upperWickSell = sellVol * wickWeight * upperWickProportion;
        const upperBinsCount = highBin - bodyHighBin;

        for (let i = bodyHighBin + 1; i <= highBin; i++) {
          if (i >= 0 && i < numBins) {
            volumeProfile[i] += upperWickVol / upperBinsCount;
            buyVolume[i] += upperWickBuy / upperBinsCount;
            sellVolume[i] += upperWickSell / upperBinsCount;
          }
        }
      }

      // Lower wick
      if (lowerWickSize > 0 && lowBin < bodyLowBin) {
        const lowerWickProportion = lowerWickSize / totalWickSize;
        const lowerWickVol = volume * wickWeight * lowerWickProportion;
        const lowerWickBuy = buyVol * wickWeight * lowerWickProportion;
        const lowerWickSell = sellVol * wickWeight * lowerWickProportion;
        const lowerBinsCount = bodyLowBin - lowBin;

        for (let i = lowBin; i < bodyLowBin; i++) {
          if (i >= 0 && i < numBins) {
            volumeProfile[i] += lowerWickVol / lowerBinsCount;
            buyVolume[i] += lowerWickBuy / lowerBinsCount;
            sellVolume[i] += lowerWickSell / lowerBinsCount;
          }
        }
      }
    }
  }

  // Calculate VWAP
  const vwap = vwapDenominator > 0 ? vwapNumerator / vwapDenominator : currentPrice;

  // Find POC
  let pocIndex = 0;
  let maxVolume = 0;
  for (let i = 0; i < numBins; i++) {
    if (volumeProfile[i] > maxVolume) {
      maxVolume = volumeProfile[i];
      pocIndex = i;
    }
  }
  const pocPrice = rangeLow + (pocIndex + 0.5) * binSize;

  // Calculate Value Area (70%)
  const totalVolume = volumeProfile.reduce((a, b) => a + b, 0);
  const valueAreaTarget = totalVolume * 0.7;

  let vaLowIndex = pocIndex;
  let vaHighIndex = pocIndex;
  let vaVolume = volumeProfile[pocIndex];

  while (vaVolume < valueAreaTarget && (vaLowIndex > 0 || vaHighIndex < numBins - 1)) {
    const lowerVol = vaLowIndex > 0 ? volumeProfile[vaLowIndex - 1] : 0;
    const upperVol = vaHighIndex < numBins - 1 ? volumeProfile[vaHighIndex + 1] : 0;

    if (lowerVol >= upperVol && vaLowIndex > 0) {
      vaLowIndex--;
      vaVolume += volumeProfile[vaLowIndex];
    } else if (vaHighIndex < numBins - 1) {
      vaHighIndex++;
      vaVolume += volumeProfile[vaHighIndex];
    } else if (vaLowIndex > 0) {
      vaLowIndex--;
      vaVolume += volumeProfile[vaLowIndex];
    }
  }

  const vaHigh = rangeLow + (vaHighIndex + 1) * binSize;
  const vaLow = rangeLow + vaLowIndex * binSize;

  // Identify HVN and LVN
  const avgVolume = totalVolume / numBins;
  const hvnThreshold = avgVolume * 1.5;
  const lvnThreshold = avgVolume * 0.5;

  const hvnZones: Array<{
    price: number;
    volume: number;
    pct_of_total: number;
    delta_pct: number;
  }> = [];
  const lvnZones: Array<{ price: number; volume: number }> = [];

  for (let i = 0; i < numBins; i++) {
    const price = rangeLow + (i + 0.5) * binSize;
    const binDelta =
      volumeProfile[i] > 0 ? ((buyVolume[i] - sellVolume[i]) / volumeProfile[i]) * 100 : 0;

    if (volumeProfile[i] > hvnThreshold) {
      hvnZones.push({
        price,
        volume: volumeProfile[i],
        pct_of_total: (volumeProfile[i] / totalVolume) * 100,
        delta_pct: binDelta,
      });
    }
    if (volumeProfile[i] < lvnThreshold && volumeProfile[i] > 0) {
      lvnZones.push({ price, volume: volumeProfile[i] });
    }
  }

  // Sort HVNs by volume
  hvnZones.sort((a, b) => b.volume - a.volume);

  // Calculate total delta with intrabar strength
  const totalBuy = buyVolume.reduce((a, b) => a + b, 0);
  const totalSell = sellVolume.reduce((a, b) => a + b, 0);
  const delta = totalBuy - totalSell;
  const deltaPct = totalVolume > 0 ? (delta / totalVolume) * 100 : 0;

  // Position relative to VA
  let pricePosition: string;
  let bias: string;
  if (currentPrice > vaHigh) {
    pricePosition = 'ABOVE_VALUE_AREA';
    bias = 'BULLISH_BREAKOUT';
  } else if (currentPrice < vaLow) {
    pricePosition = 'BELOW_VALUE_AREA';
    bias = 'BEARISH_BREAKDOWN';
  } else if (currentPrice > pocPrice) {
    pricePosition = 'UPPER_VALUE_AREA';
    bias = 'NEUTRAL_BULLISH';
  } else {
    pricePosition = 'LOWER_VALUE_AREA';
    bias = 'NEUTRAL_BEARISH';
  }

  // Identify LVN zones above/below current price for targets
  const lvnAbove = lvnZones.filter(z => z.price > currentPrice).sort((a, b) => a.price - b.price);
  const lvnBelow = lvnZones.filter(z => z.price < currentPrice).sort((a, b) => b.price - a.price);

  // VWAP vs POC confluence check
  const vwapPocConfluence = Math.abs(vwap - pocPrice) / pocPrice < 0.005; // Within 0.5%
  const vwapPosition = currentPrice > vwap ? 'ABOVE_VWAP' : 'BELOW_VWAP';

  // Get orderbook analysis at key VPVR levels
  const keyLevels = [
    { name: 'POC', price: pocPrice },
    { name: 'VAH', price: vaHigh },
    { name: 'VAL', price: vaLow },
    { name: 'VWAP', price: vwap },
    { name: 'CURRENT', price: currentPrice },
  ];
  const orderbookAnalysis = await analyzeOrderbookAtLevels(symbol, keyLevels);

  // Generate orderbook-based insights
  const orderbookInsights: string[] = [];
  const currentLevel = orderbookAnalysis.liquidity_at_levels.find(l => l.level_name === 'CURRENT');
  const vahLevel = orderbookAnalysis.liquidity_at_levels.find(l => l.level_name === 'VAH');
  const valLevel = orderbookAnalysis.liquidity_at_levels.find(l => l.level_name === 'VAL');

  if (currentLevel) {
    if (currentLevel.pressure === 'BID_HEAVY') {
      orderbookInsights.push(
        `Strong bid support at current price (${currentLevel.imbalance_pct.toFixed(1)}% bid imbalance)`,
      );
    } else if (currentLevel.pressure === 'ASK_HEAVY') {
      orderbookInsights.push(
        `Heavy ask resistance at current price (${Math.abs(currentLevel.imbalance_pct).toFixed(1)}% ask imbalance)`,
      );
    }
  }

  if (pricePosition === 'ABOVE_VALUE_AREA' && vahLevel) {
    if (vahLevel.pressure === 'BID_HEAVY')
      orderbookInsights.push('VAH has bid support - breakout likely to hold');
    else if (vahLevel.pressure === 'ASK_HEAVY')
      orderbookInsights.push('VAH has ask pressure - breakout may fail on retest');
  }

  if (pricePosition === 'BELOW_VALUE_AREA' && valLevel) {
    if (valLevel.pressure === 'ASK_HEAVY')
      orderbookInsights.push('VAL has ask pressure - breakdown likely to continue');
    else if (valLevel.pressure === 'BID_HEAVY')
      orderbookInsights.push('VAL has bid support - breakdown may reverse');
  }

  return JSON.stringify(
    {
      symbol,
      analysis_time: new Date().toISOString(),
      price: currentPrice,
      funding_rate: fundingRate,

      // Key Levels (Raw)
      levels: {
        poc: pocPrice,
        vwap: vwap,
        vah: vaHigh,
        val: vaLow,
        range_high: rangeHigh,
        range_low: rangeLow,
      },

      // Structure Analysis
      structure: {
        price_position: pricePosition,
        bias: bias,
        vwap_position: vwapPosition,
        vwap_poc_confluence: vwapPocConfluence,
        poc_distance_pct: Number((((currentPrice - pocPrice) / pocPrice) * 100).toFixed(2)),
      },

      // Volume & Delta
      volume: {
        total_volume: Math.round(totalVolume),
        buy_volume: Math.round(totalBuy),
        sell_volume: Math.round(totalSell),
        delta: Math.round(delta),
        delta_pct: Number(deltaPct.toFixed(2)),
        delta_strength:
          Math.abs(deltaPct) > 30 ? 'STRONG' : Math.abs(deltaPct) > 15 ? 'MODERATE' : 'WEAK',
      },

      // High Volume Nodes (Raw)
      hvn: hvnZones.slice(0, 5).map(h => ({
        price: h.price,
        pct_volume: Number(h.pct_of_total.toFixed(2)),
        delta_pct: Number(h.delta_pct.toFixed(2)),
      })),

      // Low Volume Nodes (Raw)
      lvn: {
        above: lvnAbove.slice(0, 3).map(l => l.price),
        below: lvnBelow.slice(0, 3).map(l => l.price),
      },

      // Orderbook Depth
      orderbook: {
        health: orderbookAnalysis.orderbook_health,
        total_bids_usd: orderbookAnalysis.total_visible_liquidity.bids_usd,
        total_asks_usd: orderbookAnalysis.total_visible_liquidity.asks_usd,
        levels: orderbookAnalysis.liquidity_at_levels.map(level => ({
          name: level.level_name,
          price: level.price,
          imbalance: Number(level.imbalance_pct.toFixed(2)),
          pressure: level.pressure,
        })),
        insights: orderbookInsights,
      },

      // Session & BTC Context
      context: {
        session: getCurrentSession().session,
        btc_correlation: btcCorrelation.correlation,
        btc_relative_strength: btcCorrelation.relative_strength,
      },

      // Quick Summary
      summary: {
        structure: bias,
        flow: deltaPct > 10 ? 'BUYERS' : deltaPct < -10 ? 'SELLERS' : 'BALANCED',
        btc_aligned: btcCorrelation.correlation > 0.5,
        orderbook_supportive: orderbookAnalysis.orderbook_health !== 'THIN_LIQUIDITY',
      },
    },
    null,
    2,
  );
}

// --- VPVR Cross-Exchange Comparison ---
interface VPVRResult {
  exchange: string;
  poc: number;
  vwap: number;
  vaHigh: number;
  vaLow: number;
  totalVolume: number;
  buyVolume: number;
  sellVolume: number;
  deltaPct: number;
  rangeHigh: number;
  rangeLow: number;
  volumeProfile: number[];
  buyProfile: number[];
  sellProfile: number[];
  binSize: number;
}

function calculateVPVRFromKlines(klinesData: any[], numBins: number): VPVRResult | null {
  if (!klinesData || klinesData.length === 0) return null;

  // Find price range
  const allHighs = klinesData.map((k: any) => parseFloat(k.high));
  const allLows = klinesData.map((k: any) => parseFloat(k.low));
  const rangeHigh = Math.max(...allHighs);
  const rangeLow = Math.min(...allLows);
  const range = rangeHigh - rangeLow;

  if (range === 0) return null;

  const binSize = range / numBins;
  const volumeProfile: number[] = new Array(numBins).fill(0);
  const buyVolume: number[] = new Array(numBins).fill(0);
  const sellVolume: number[] = new Array(numBins).fill(0);

  let vwapNumerator = 0;
  let vwapDenominator = 0;
  let totalBuyVol = 0;
  let totalSellVol = 0;

  for (const k of klinesData) {
    const high = parseFloat(k.high);
    const low = parseFloat(k.low);
    const open = parseFloat(k.open);
    const close = parseFloat(k.close);
    const volume = parseFloat(k.quoteVolume || k.volume);
    const typicalPrice = (high + low + close) / 3;

    vwapNumerator += typicalPrice * volume;
    vwapDenominator += volume;

    // Use actual taker buy volume if available, else fallback to 50/50
    const takerBuyVol = parseFloat(k.takerBuyQuoteVolume || '0');
    const buyVol = takerBuyVol > 0 ? takerBuyVol : volume * 0.5;
    const sellVol = volume - buyVol;
    totalBuyVol += buyVol;
    totalSellVol += sellVol;

    // WEIGHTED VOLUME DISTRIBUTION (body 70%, wicks 30%)
    const bodyHigh = Math.max(open, close);
    const bodyLow = Math.min(open, close);
    const candleRange = high - low;

    if (candleRange === 0) {
      const singleBin = Math.min(
        Math.max(0, Math.floor((close - rangeLow) / binSize)),
        numBins - 1,
      );
      volumeProfile[singleBin] += volume;
      buyVolume[singleBin] += buyVol;
      sellVolume[singleBin] += sellVol;
      continue;
    }

    const bodyWeight = 0.7;
    const wickWeight = 0.3;
    const upperWickSize = high - bodyHigh;
    const lowerWickSize = bodyLow - low;
    const totalWickSize = upperWickSize + lowerWickSize;

    const lowBin = Math.max(0, Math.floor((low - rangeLow) / binSize));
    const highBin = Math.min(Math.floor((high - rangeLow) / binSize), numBins - 1);
    const bodyLowBin = Math.max(0, Math.floor((bodyLow - rangeLow) / binSize));
    const bodyHighBin = Math.min(Math.floor((bodyHigh - rangeLow) / binSize), numBins - 1);

    // Body bins (70%)
    const bodyBinsCount = Math.max(1, bodyHighBin - bodyLowBin + 1);
    for (let i = bodyLowBin; i <= bodyHighBin; i++) {
      if (i >= 0 && i < numBins) {
        volumeProfile[i] += (volume * bodyWeight) / bodyBinsCount;
        buyVolume[i] += (buyVol * bodyWeight) / bodyBinsCount;
        sellVolume[i] += (sellVol * bodyWeight) / bodyBinsCount;
      }
    }

    // Wick bins (30%)
    if (totalWickSize > 0) {
      if (upperWickSize > 0 && bodyHighBin < highBin) {
        const prop = upperWickSize / totalWickSize;
        const cnt = highBin - bodyHighBin;
        for (let i = bodyHighBin + 1; i <= highBin; i++) {
          if (i >= 0 && i < numBins) {
            volumeProfile[i] += (volume * wickWeight * prop) / cnt;
            buyVolume[i] += (buyVol * wickWeight * prop) / cnt;
            sellVolume[i] += (sellVol * wickWeight * prop) / cnt;
          }
        }
      }
      if (lowerWickSize > 0 && lowBin < bodyLowBin) {
        const prop = lowerWickSize / totalWickSize;
        const cnt = bodyLowBin - lowBin;
        for (let i = lowBin; i < bodyLowBin; i++) {
          if (i >= 0 && i < numBins) {
            volumeProfile[i] += (volume * wickWeight * prop) / cnt;
            buyVolume[i] += (buyVol * wickWeight * prop) / cnt;
            sellVolume[i] += (sellVol * wickWeight * prop) / cnt;
          }
        }
      }
    }
  }

  const vwap = vwapDenominator > 0 ? vwapNumerator / vwapDenominator : 0;
  const totalVolume = volumeProfile.reduce((a, b) => a + b, 0);

  // Find POC
  let pocIndex = 0;
  let maxVolume = 0;
  for (let i = 0; i < numBins; i++) {
    if (volumeProfile[i] > maxVolume) {
      maxVolume = volumeProfile[i];
      pocIndex = i;
    }
  }
  const poc = rangeLow + (pocIndex + 0.5) * binSize;

  // Calculate Value Area (70%)
  const valueAreaTarget = totalVolume * 0.7;
  let vaLowIndex = pocIndex;
  let vaHighIndex = pocIndex;
  let vaVolume = volumeProfile[pocIndex];

  while (vaVolume < valueAreaTarget && (vaLowIndex > 0 || vaHighIndex < numBins - 1)) {
    const lowerVol = vaLowIndex > 0 ? volumeProfile[vaLowIndex - 1] : 0;
    const upperVol = vaHighIndex < numBins - 1 ? volumeProfile[vaHighIndex + 1] : 0;

    if (lowerVol >= upperVol && vaLowIndex > 0) {
      vaLowIndex--;
      vaVolume += volumeProfile[vaLowIndex];
    } else if (vaHighIndex < numBins - 1) {
      vaHighIndex++;
      vaVolume += volumeProfile[vaHighIndex];
    } else if (vaLowIndex > 0) {
      vaLowIndex--;
      vaVolume += volumeProfile[vaLowIndex];
    }
  }

  const vaHigh = rangeLow + (vaHighIndex + 1) * binSize;
  const vaLow = rangeLow + vaLowIndex * binSize;

  const deltaPct = totalVolume > 0 ? ((totalBuyVol - totalSellVol) / totalVolume) * 100 : 0;

  return {
    exchange: '',
    poc,
    vwap,
    vaHigh,
    vaLow,
    totalVolume,
    buyVolume: totalBuyVol,
    sellVolume: totalSellVol,
    deltaPct,
    rangeHigh,
    rangeLow,
    volumeProfile,
    buyProfile: buyVolume,
    sellProfile: sellVolume,
    binSize,
  };
}

async function handleVPVRCross(
  symbol: string,
  timeframe: string = '15m',
  periods: number = 96,
  numBins: number = 30,
): Promise<string> {
  // Normalize symbol for both exchanges
  const asterSymbol = symbol.toUpperCase().replace('PERP', '');
  const hlSymbol = asterSymbol.replace('USDT', '').replace('USD', '');

  // Fetch data from both exchanges in parallel
  const [asterKlines, hlKlines, asterTicker, hlTicker] = await Promise.all([
    asterClient.getKlines(asterSymbol, timeframe, periods),
    hyperliquidClient.getKlines(hlSymbol, timeframe, periods),
    asterClient.getTicker24h(asterSymbol),
    hyperliquidClient.getTicker24h(hlSymbol),
  ]);

  // Check if pair exists on both
  const asterExists = asterKlines.success && asterKlines.data && asterKlines.data.length > 0;
  const hlExists = hlKlines.success && hlKlines.data && hlKlines.data.length > 0;

  if (!asterExists && !hlExists) {
    return JSON.stringify({
      error: 'Symbol not found on either exchange',
      symbol,
      aster_available: false,
      hyperliquid_available: false,
    });
  }

  // Calculate VPVR for each exchange
  const asterVPVR =
    asterExists && asterKlines.data ? calculateVPVRFromKlines(asterKlines.data, numBins) : null;
  const hlVPVR = hlExists && hlKlines.data ? calculateVPVRFromKlines(hlKlines.data, numBins) : null;

  if (asterVPVR) asterVPVR.exchange = 'Aster';
  if (hlVPVR) hlVPVR.exchange = 'Hyperliquid';

  // Get current prices
  const asterPrice =
    asterTicker.success && asterTicker.data
      ? parseFloat(
          Array.isArray(asterTicker.data)
            ? asterTicker.data[0].lastPrice
            : asterTicker.data.lastPrice,
        )
      : asterVPVR?.vwap || 0;
  const hlPrice =
    hlTicker.success && hlTicker.data
      ? parseFloat(
          Array.isArray(hlTicker.data) ? hlTicker.data[0].lastPrice : hlTicker.data.lastPrice,
        )
      : hlVPVR?.vwap || 0;

  // If only one exchange has data
  if (!asterVPVR || !hlVPVR) {
    const available = asterVPVR || hlVPVR;
    return JSON.stringify(
      {
        symbol,
        warning: `Only available on ${available?.exchange}`,
        aster_available: asterExists,
        hyperliquid_available: hlExists,
        single_exchange: {
          exchange: available?.exchange,
          poc: available?.poc,
          vwap: available?.vwap,
          va_high: available?.vaHigh,
          va_low: available?.vaLow,
          delta_pct: available?.deltaPct?.toFixed(2) + '%',
          total_volume: available?.totalVolume,
        },
        recommendation:
          'Use single-exchange VPVR for Aster-exclusive tokens (often have extreme funding)',
      },
      null,
      2,
    );
  }

  // Compare the two profiles
  const pocDivergence = ((asterVPVR.poc - hlVPVR.poc) / hlVPVR.poc) * 100;
  const vwapDivergence = ((asterVPVR.vwap - hlVPVR.vwap) / hlVPVR.vwap) * 100;
  const volumeRatio = asterVPVR.totalVolume / hlVPVR.totalVolume;

  // Determine which exchange is leading
  let leadingExchange = 'Balanced';
  let leadingSignal = '';
  if (Math.abs(asterVPVR.deltaPct) > Math.abs(hlVPVR.deltaPct) + 10) {
    leadingExchange = 'Aster';
    leadingSignal = asterVPVR.deltaPct > 0 ? 'BULLISH' : 'BEARISH';
  } else if (Math.abs(hlVPVR.deltaPct) > Math.abs(asterVPVR.deltaPct) + 10) {
    leadingExchange = 'Hyperliquid';
    leadingSignal = hlVPVR.deltaPct > 0 ? 'BULLISH' : 'BEARISH';
  }

  // Detect POC divergence signals
  let pocSignal = 'ALIGNED';
  let pocInterpretation = 'Both exchanges agree on fair value';
  if (Math.abs(pocDivergence) > 2) {
    pocSignal = 'DIVERGENT';
    if (pocDivergence > 0) {
      pocInterpretation = `Aster traders value higher (+${pocDivergence.toFixed(2)}%) - potential buying opportunity on HL or selling on Aster`;
    } else {
      pocInterpretation = `HL traders value higher (${pocDivergence.toFixed(2)}%) - potential selling opportunity on HL or buying on Aster`;
    }
  }

  // Detect Value Area divergence
  const vaHighDiff = ((asterVPVR.vaHigh - hlVPVR.vaHigh) / hlVPVR.vaHigh) * 100;
  const vaLowDiff = ((asterVPVR.vaLow - hlVPVR.vaLow) / hlVPVR.vaLow) * 100;

  // Generate actionable signals
  const signals: string[] = [];

  if (Math.abs(pocDivergence) > 2) {
    signals.push(
      `⚠️ POC DIVERGENCE: ${pocDivergence > 0 ? 'Aster' : 'HL'} values ${Math.abs(pocDivergence).toFixed(1)}% higher`,
    );
  }
  if (asterVPVR.deltaPct > 20 && hlVPVR.deltaPct < -10) {
    signals.push('🔥 BULLISH DIVERGENCE: Aster accumulating while HL distributing');
  } else if (asterVPVR.deltaPct < -20 && hlVPVR.deltaPct > 10) {
    signals.push('❄️ BEARISH DIVERGENCE: Aster distributing while HL accumulating');
  }
  if (volumeRatio < 0.1) {
    signals.push('📉 LOW ASTER LIQUIDITY: HL dominates price discovery');
  } else if (volumeRatio > 10) {
    signals.push('📈 HIGH ASTER LIQUIDITY: Unusual - Aster dominates');
  }
  if (asterVPVR.deltaPct * hlVPVR.deltaPct < 0) {
    signals.push('🔀 DELTA CONFLICT: Exchanges disagree on direction');
  }

  // Price formatting helper
  const formatPrice = (p: number) => {
    if (p >= 1000) return p.toFixed(1);
    if (p >= 1) return p.toFixed(2);
    if (p >= 0.01) return p.toFixed(4);
    return p.toFixed(6);
  };

  return JSON.stringify(
    {
      symbol,
      timeframe,
      periods,

      // Current state
      current_prices: {
        aster: formatPrice(asterPrice),
        hyperliquid: formatPrice(hlPrice),
        price_diff_pct: (((asterPrice - hlPrice) / hlPrice) * 100).toFixed(3) + '%',
      },

      // VPVR Comparison
      poc_comparison: {
        aster: formatPrice(asterVPVR.poc),
        hyperliquid: formatPrice(hlVPVR.poc),
        divergence_pct: pocDivergence.toFixed(2) + '%',
        signal: pocSignal,
        interpretation: pocInterpretation,
      },

      vwap_comparison: {
        aster: formatPrice(asterVPVR.vwap),
        hyperliquid: formatPrice(hlVPVR.vwap),
        divergence_pct: vwapDivergence.toFixed(2) + '%',
      },

      value_area_comparison: {
        aster: { high: formatPrice(asterVPVR.vaHigh), low: formatPrice(asterVPVR.vaLow) },
        hyperliquid: { high: formatPrice(hlVPVR.vaHigh), low: formatPrice(hlVPVR.vaLow) },
        va_high_diff_pct: vaHighDiff.toFixed(2) + '%',
        va_low_diff_pct: vaLowDiff.toFixed(2) + '%',
      },

      // Delta comparison (who's buying/selling)
      delta_comparison: {
        aster: {
          delta_pct: asterVPVR.deltaPct.toFixed(2) + '%',
          buy_volume: Math.round(asterVPVR.buyVolume),
          sell_volume: Math.round(asterVPVR.sellVolume),
          bias:
            asterVPVR.deltaPct > 5
              ? '🟢 BUYERS'
              : asterVPVR.deltaPct < -5
                ? '🔴 SELLERS'
                : '⚪ NEUTRAL',
        },
        hyperliquid: {
          delta_pct: hlVPVR.deltaPct.toFixed(2) + '%',
          buy_volume: Math.round(hlVPVR.buyVolume),
          sell_volume: Math.round(hlVPVR.sellVolume),
          bias:
            hlVPVR.deltaPct > 5 ? '🟢 BUYERS' : hlVPVR.deltaPct < -5 ? '🔴 SELLERS' : '⚪ NEUTRAL',
        },
      },

      // Volume comparison
      volume_comparison: {
        aster_total: Math.round(asterVPVR.totalVolume),
        hyperliquid_total: Math.round(hlVPVR.totalVolume),
        aster_to_hl_ratio: volumeRatio.toFixed(3),
        liquidity_leader: volumeRatio > 1 ? 'Aster' : 'Hyperliquid',
      },

      // Analysis
      analysis: {
        leading_exchange: leadingExchange,
        leading_signal: leadingSignal,
        signals:
          signals.length > 0 ? signals : ['✅ Exchanges aligned - no major divergence detected'],
      },

      // Key levels from both exchanges
      key_levels: {
        resistance: [
          { price: formatPrice(asterVPVR.vaHigh), source: 'Aster VA High' },
          { price: formatPrice(hlVPVR.vaHigh), source: 'HL VA High' },
          { price: formatPrice(Math.max(asterVPVR.poc, hlVPVR.poc)), source: 'Higher POC' },
        ]
          .filter((v, i, a) => a.findIndex(t => t.price === v.price) === i)
          .slice(0, 3),
        support: [
          { price: formatPrice(asterVPVR.vaLow), source: 'Aster VA Low' },
          { price: formatPrice(hlVPVR.vaLow), source: 'HL VA Low' },
          { price: formatPrice(Math.min(asterVPVR.poc, hlVPVR.poc)), source: 'Lower POC' },
        ]
          .filter((v, i, a) => a.findIndex(t => t.price === v.price) === i)
          .slice(0, 3),
      },

      // Trading recommendations
      recommendations: {
        if_bullish:
          pocDivergence < -1
            ? `Buy on Aster (cheaper POC at ${formatPrice(asterVPVR.poc)}) - HL values higher`
            : 'Both exchanges aligned - trade either',
        if_bearish:
          pocDivergence > 1
            ? `Short on Aster (higher POC at ${formatPrice(asterVPVR.poc)}) - HL values lower`
            : 'Both exchanges aligned - trade either',
        liquidity_note:
          volumeRatio < 0.5
            ? 'Consider HL for larger orders (better liquidity)'
            : volumeRatio > 2
              ? 'Aster has good liquidity for this pair'
              : 'Similar liquidity on both',
      },
    },
    null,
    2,
  );
}

// --- 21. scan_breakouts (Structure-Based Breakout Scanner) ---

// Helper: Aggregate 5m candles into 15m candles
function aggregate5mTo15m(candles5m: Candle[]): Candle[] {
  const candles15m: Candle[] = [];
  for (let i = 0; i + 2 < candles5m.length; i += 3) {
    const c1 = candles5m[i];
    const c2 = candles5m[i + 1];
    const c3 = candles5m[i + 2];
    candles15m.push({
      t: c1.t,
      o: c1.o,
      h: String(Math.max(parseFloat(c1.h), parseFloat(c2.h), parseFloat(c3.h))),
      l: String(Math.min(parseFloat(c1.l), parseFloat(c2.l), parseFloat(c3.l))),
      c: c3.c,
      v: String(parseFloat(c1.v) + parseFloat(c2.v) + parseFloat(c3.v)),
    });
  }
  return candles15m;
}

// Helper: Calculate lightweight VPVR
interface LightVPVR {
  poc: number;
  vah: number;
  val: number;
  vwap: number;
  delta: number;
  deltaPct: number;
  totalVolume: number;
  buyVolume: number;
  sellVolume: number;
  rangeHigh: number;
  rangeLow: number;
}

function calculateLightVPVR(candles: Candle[]): LightVPVR {
  if (candles.length < 5) {
    return {
      poc: 0,
      vah: 0,
      val: 0,
      vwap: 0,
      delta: 0,
      deltaPct: 0,
      totalVolume: 0,
      buyVolume: 0,
      sellVolume: 0,
      rangeHigh: 0,
      rangeLow: 0,
    };
  }

  const highs = candles.map(c => parseFloat(c.h));
  const lows = candles.map(c => parseFloat(c.l));
  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  const range = rangeHigh - rangeLow;

  if (range === 0) {
    return {
      poc: rangeHigh,
      vah: rangeHigh,
      val: rangeLow,
      vwap: rangeHigh,
      delta: 0,
      deltaPct: 0,
      totalVolume: 0,
      buyVolume: 0,
      sellVolume: 0,
      rangeHigh,
      rangeLow,
    };
  }

  const numBins = 20;
  const binSize = range / numBins;
  const volumeProfile = new Array(numBins).fill(0);
  const buyVolProfile = new Array(numBins).fill(0);
  const sellVolProfile = new Array(numBins).fill(0);

  let vwapNum = 0;
  let vwapDenom = 0;
  let totalBuy = 0;
  let totalSell = 0;

  for (const c of candles) {
    const high = parseFloat(c.h);
    const low = parseFloat(c.l);
    const open = parseFloat(c.o);
    const close = parseFloat(c.c);
    const volume = parseFloat(c.v);
    const typicalPrice = (high + low + close) / 3;

    vwapNum += typicalPrice * volume;
    vwapDenom += volume;

    // Intrabar strength for buy/sell estimation (Candle interface lacks takerBuyQuoteVolume)
    const candleRange = high - low;
    let buyRatio = 0.5;
    if (candleRange > 0) {
      buyRatio = (close - low) / candleRange;
    }
    const buyVol = volume * buyRatio;
    const sellVol = volume * (1 - buyRatio);
    totalBuy += buyVol;
    totalSell += sellVol;

    // WEIGHTED VOLUME DISTRIBUTION (body 70%, wicks 30%)
    const bodyHigh = Math.max(open, close);
    const bodyLow = Math.min(open, close);

    if (candleRange === 0) {
      const singleBin = Math.min(
        Math.max(0, Math.floor((close - rangeLow) / binSize)),
        numBins - 1,
      );
      volumeProfile[singleBin] += volume;
      buyVolProfile[singleBin] += buyVol;
      sellVolProfile[singleBin] += sellVol;
      continue;
    }

    const bodyWeight = 0.7;
    const wickWeight = 0.3;
    const upperWickSize = high - bodyHigh;
    const lowerWickSize = bodyLow - low;
    const totalWickSize = upperWickSize + lowerWickSize;

    const lowBin = Math.max(0, Math.floor((low - rangeLow) / binSize));
    const highBin = Math.min(Math.floor((high - rangeLow) / binSize), numBins - 1);
    const bodyLowBin = Math.max(0, Math.floor((bodyLow - rangeLow) / binSize));
    const bodyHighBin = Math.min(Math.floor((bodyHigh - rangeLow) / binSize), numBins - 1);

    // Body bins (70%)
    const bodyBinsCount = Math.max(1, bodyHighBin - bodyLowBin + 1);
    for (let i = bodyLowBin; i <= bodyHighBin; i++) {
      if (i >= 0 && i < numBins) {
        volumeProfile[i] += (volume * bodyWeight) / bodyBinsCount;
        buyVolProfile[i] += (buyVol * bodyWeight) / bodyBinsCount;
        sellVolProfile[i] += (sellVol * bodyWeight) / bodyBinsCount;
      }
    }

    // Wick bins (30%)
    if (totalWickSize > 0) {
      if (upperWickSize > 0 && bodyHighBin < highBin) {
        const prop = upperWickSize / totalWickSize;
        const cnt = highBin - bodyHighBin;
        for (let i = bodyHighBin + 1; i <= highBin; i++) {
          if (i >= 0 && i < numBins) {
            volumeProfile[i] += (volume * wickWeight * prop) / cnt;
            buyVolProfile[i] += (buyVol * wickWeight * prop) / cnt;
            sellVolProfile[i] += (sellVol * wickWeight * prop) / cnt;
          }
        }
      }
      if (lowerWickSize > 0 && lowBin < bodyLowBin) {
        const prop = lowerWickSize / totalWickSize;
        const cnt = bodyLowBin - lowBin;
        for (let i = lowBin; i < bodyLowBin; i++) {
          if (i >= 0 && i < numBins) {
            volumeProfile[i] += (volume * wickWeight * prop) / cnt;
            buyVolProfile[i] += (buyVol * wickWeight * prop) / cnt;
            sellVolProfile[i] += (sellVol * wickWeight * prop) / cnt;
          }
        }
      }
    }
  }

  // Find POC
  let pocIndex = 0;
  let maxVol = 0;
  for (let i = 0; i < numBins; i++) {
    if (volumeProfile[i] > maxVol) {
      maxVol = volumeProfile[i];
      pocIndex = i;
    }
  }
  const poc = rangeLow + (pocIndex + 0.5) * binSize;

  // Calculate Value Area (70%)
  const totalVol = volumeProfile.reduce((a, b) => a + b, 0);
  const vaTarget = totalVol * 0.7;
  let vaLowIdx = pocIndex;
  let vaHighIdx = pocIndex;
  let vaVol = volumeProfile[pocIndex];

  while (vaVol < vaTarget && (vaLowIdx > 0 || vaHighIdx < numBins - 1)) {
    const lowerVol = vaLowIdx > 0 ? volumeProfile[vaLowIdx - 1] : 0;
    const upperVol = vaHighIdx < numBins - 1 ? volumeProfile[vaHighIdx + 1] : 0;
    if (lowerVol >= upperVol && vaLowIdx > 0) {
      vaLowIdx--;
      vaVol += volumeProfile[vaLowIdx];
    } else if (vaHighIdx < numBins - 1) {
      vaHighIdx++;
      vaVol += volumeProfile[vaHighIdx];
    } else if (vaLowIdx > 0) {
      vaLowIdx--;
      vaVol += volumeProfile[vaLowIdx];
    }
  }

  const vah = rangeLow + (vaHighIdx + 1) * binSize;
  const val = rangeLow + vaLowIdx * binSize;
  const vwap = vwapDenom > 0 ? vwapNum / vwapDenom : poc;
  const delta = totalBuy - totalSell;
  const deltaPct = totalVol > 0 ? (delta / totalVol) * 100 : 0;

  return {
    poc,
    vah,
    val,
    vwap,
    delta,
    deltaPct,
    totalVolume: totalVol,
    buyVolume: totalBuy,
    sellVolume: totalSell,
    rangeHigh,
    rangeLow,
  };
}

// Helper: Calculate structure score based on price position
function calculateStructureScore(
  price: number,
  vpvr: LightVPVR,
): { score: number; position: string } {
  if (vpvr.vah === vpvr.val) return { score: 50, position: 'NEUTRAL' };

  if (price > vpvr.vah) {
    // Above VAH - bullish breakout
    const distance = (price - vpvr.vah) / (vpvr.rangeHigh - vpvr.val);
    return { score: Math.min(100, 90 + distance * 10), position: 'ABOVE_VAH' };
  } else if (price < vpvr.val) {
    // Below VAL - bearish breakdown
    const distance = (vpvr.val - price) / (vpvr.vah - vpvr.rangeLow);
    return { score: Math.max(0, 10 - distance * 10), position: 'BELOW_VAL' };
  } else if (price >= vpvr.poc) {
    // Between POC and VAH
    const pctUp = (price - vpvr.poc) / (vpvr.vah - vpvr.poc);
    return { score: 60 + pctUp * 20, position: 'UPPER_VA' };
  } else {
    // Between VAL and POC
    const pctDown = (vpvr.poc - price) / (vpvr.poc - vpvr.val);
    return { score: 40 - pctDown * 20, position: 'LOWER_VA' };
  }
}

// Helper: Calculate volume score
function calculateVolumeScore(volumeRatio: number): number {
  if (volumeRatio >= 10) return 100;
  if (volumeRatio >= 5) return 70 + (volumeRatio - 5) * 6;
  if (volumeRatio >= 3) return 50 + (volumeRatio - 3) * 10;
  if (volumeRatio >= 1) return 20 + (volumeRatio - 1) * 15;
  return volumeRatio * 20;
}

// Helper: Calculate delta score
function calculateDeltaScore(deltaPct: number): number {
  // +30% = 90, +15% = 70, 0% = 50, -15% = 30, -30% = 10
  const normalized = 50 + (deltaPct / 30) * 40;
  return Math.max(0, Math.min(100, normalized));
}

// Helper: Calculate momentum score from RSI/MFI
// FIXED: Penalizes overbought/oversold extremes instead of treating them as high momentum
function calculateMomentumScore(rsi: number, mfi: number): number {
  // Base score is average of RSI and MFI
  let score = (rsi + mfi) / 2;

  // Penalize overbought zone (>70) - these are exhaustion levels, not bullish continuation
  // RSI 85 + MFI 90 should NOT score 87.5 (bullish) - it's reversal territory
  if (rsi > 70 && mfi > 70) {
    const overboughtPenalty = Math.min(rsi - 70 + (mfi - 70), 40);
    score -= overboughtPenalty;
  } else if (rsi > 70) {
    score -= Math.min(rsi - 70, 20);
  } else if (mfi > 70) {
    score -= Math.min(mfi - 70, 20);
  }

  // Penalize oversold zone (<30) - these are capitulation levels, not bearish continuation
  if (rsi < 30 && mfi < 30) {
    const oversoldPenalty = Math.min(30 - rsi + (30 - mfi), 40);
    score -= oversoldPenalty;
  } else if (rsi < 30) {
    score -= Math.min(30 - rsi, 20);
  } else if (mfi < 30) {
    score -= Math.min(30 - mfi, 20);
  }

  return Math.max(0, Math.min(100, score));
}

// Helper: Calculate funding rate modifier
// Positive funding = longs paying shorts (crowded long trade)
// Negative funding = shorts paying longs (crowded short trade)
// Returns bonus/penalty points based on whether we're going WITH or AGAINST the funding
function calculateFundingModifier(
  fundingRate: number,
  isBullish: boolean,
): { modifier: number; warning: string | null } {
  const fundingPct = fundingRate * 100; // Convert to percentage
  const absRate = Math.abs(fundingPct);

  if (absRate < 0.01) {
    // Neutral funding - no impact
    return { modifier: 0, warning: null };
  }

  if (isBullish) {
    // Going LONG
    if (fundingPct > 0.05) {
      // Very crowded long - longs paying 0.05%+ per 8h = fighting the crowd
      return {
        modifier: -15,
        warning: `⚠️ CROWDED LONG: Funding ${fundingPct.toFixed(3)}% - longs paying shorts`,
      };
    } else if (fundingPct > 0.02) {
      // Moderately crowded long
      return {
        modifier: -8,
        warning: `⚠️ Elevated funding ${fundingPct.toFixed(3)}% - longs paying`,
      };
    } else if (fundingPct < -0.02) {
      // Shorts paying longs - bonus for going long
      return { modifier: 10, warning: null };
    } else if (fundingPct < -0.05) {
      // Very crowded short - shorts paying heavily, good to be long
      return { modifier: 15, warning: null };
    }
  } else {
    // Going SHORT
    if (fundingPct < -0.05) {
      // Very crowded short - shorts paying 0.05%+ per 8h = fighting the crowd
      return {
        modifier: -15,
        warning: `⚠️ CROWDED SHORT: Funding ${fundingPct.toFixed(3)}% - shorts paying longs`,
      };
    } else if (fundingPct < -0.02) {
      // Moderately crowded short
      return {
        modifier: -8,
        warning: `⚠️ Negative funding ${fundingPct.toFixed(3)}% - shorts paying`,
      };
    } else if (fundingPct > 0.02) {
      // Longs paying shorts - bonus for going short
      return { modifier: 10, warning: null };
    } else if (fundingPct > 0.05) {
      // Very crowded long - longs paying heavily, good to be short
      return { modifier: 15, warning: null };
    }
  }

  return { modifier: 0, warning: null };
}

// Helper: Detect red flags (conflicting signals that should warn the trader)
function detectRedFlags(
  volumeRatio: number,
  deltaPct: number,
  rsi: number,
  mfi: number,
  isBullish: boolean,
  structurePosition: string,
  obvDivergence: string | null,
): string[] {
  const flags: string[] = [];

  // High volume but negative delta on bullish structure = distribution
  if (volumeRatio >= 3 && deltaPct < -10 && isBullish) {
    flags.push('🚩 High volume but sellers absorbing - likely distribution');
  }

  // High volume but positive delta on bearish structure = accumulation
  if (volumeRatio >= 3 && deltaPct > 10 && !isBullish) {
    flags.push('🚩 High volume but buyers absorbing - likely accumulation');
  }

  // Breaking VAH with low volume = likely false break
  if (structurePosition === 'ABOVE_VAH' && volumeRatio < 1.5) {
    flags.push('🚩 Breakout on low volume - likely false break');
  }

  // Breaking VAL with low volume = likely false break
  if (structurePosition === 'BELOW_VAL' && volumeRatio < 1.5) {
    flags.push('🚩 Breakdown on low volume - likely false break');
  }

  // Overbought exhaustion zone on bullish signal
  if (isBullish && rsi > 75 && mfi > 75) {
    flags.push('🚩 OVERBOUGHT EXHAUSTION: RSI+MFI both >75 - reversal risk high');
  }

  // Oversold exhaustion zone on bearish signal
  if (!isBullish && rsi < 25 && mfi < 25) {
    flags.push('🚩 OVERSOLD EXHAUSTION: RSI+MFI both <25 - reversal risk high');
  }

  // OBV divergence on directional signal
  if (obvDivergence === 'bearish_divergence' && isBullish) {
    flags.push('🚩 BEARISH DIVERGENCE: Smart money exiting while price rises');
  }
  if (obvDivergence === 'bullish_divergence' && !isBullish) {
    flags.push('🚩 BULLISH DIVERGENCE: Smart money buying while price falls');
  }

  return flags;
}

// Helper: Format price dynamically
function formatPriceAuto(price: number): string {
  if (price >= 10000) return `$${price.toFixed(1)}`;
  if (price >= 1000) return `$${price.toFixed(2)}`;
  if (price >= 100) return `$${price.toFixed(3)}`;
  if (price >= 1) return `$${price.toFixed(4)}`;
  if (price >= 0.01) return `$${price.toFixed(5)}`;
  if (price >= 0.0001) return `$${price.toFixed(6)}`;
  return `$${price.toFixed(8)}`;
}

// Helper: Calculate liquidity penalty (0-50 points) based on volume and spread
// Penalizes low liquidity instead of excluding - preserves early discovery
function calculateLiquidityPenalty(volume24h: number, spreadPct?: number): number {
  let penalty = 0;

  // Volume penalty: logarithmic scale
  // $100k+ = 0 penalty, $10k = ~10 penalty, $1k = ~20 penalty, $100 = ~30 penalty
  if (volume24h < 100000) {
    const logVol = Math.log10(Math.max(volume24h, 1));
    // 5 (log10 of 100k) = 0 penalty, 0 (log10 of 1) = 25 penalty
    penalty += Math.max(0, 25 - logVol * 5);
  }

  // Spread penalty: Linear penalty for wide spreads
  // <0.5% = 0 penalty, 0.5-2% = increasing penalty, >2% = max penalty
  if (spreadPct !== undefined && spreadPct > 0.5) {
    penalty += Math.min(25, (spreadPct - 0.5) * 12.5);
  }

  return Math.min(50, penalty); // Cap at 50
}

// Helper: Calculate liquidity grade (A-F) for display
function calculateLiquidityGrade(
  volume24h: number,
  spreadPct?: number,
): { grade: string; description: string } {
  const penalty = calculateLiquidityPenalty(volume24h, spreadPct);

  if (penalty <= 5) return { grade: 'A', description: 'Excellent liquidity' };
  if (penalty <= 15) return { grade: 'B', description: 'Good liquidity' };
  if (penalty <= 25) return { grade: 'C', description: 'Moderate liquidity' };
  if (penalty <= 35) return { grade: 'D', description: 'Low liquidity' };
  if (penalty <= 45) return { grade: 'E', description: 'Very low liquidity' };
  return { grade: 'F', description: 'Illiquid - trade with caution' };
}

// Helper: Classify signal tier based on score AND liquidity
function classifySignalTier(
  score: number,
  volume24h: number,
  spreadPct?: number,
): 'actionable' | 'early_warning' | 'speculative' {
  const hasGoodLiquidity = volume24h >= 25000 && (spreadPct === undefined || spreadPct < 2);
  const hasMinimalLiquidity = volume24h >= 5000;

  // Actionable: High score AND good liquidity
  if (score >= 70 && hasGoodLiquidity) {
    return 'actionable';
  }

  // Early warning: Either high score with poor liquidity OR moderate score with some liquidity
  if ((score >= 70 && hasMinimalLiquidity) || (score >= 50 && hasGoodLiquidity)) {
    return 'early_warning';
  }

  // Speculative: Everything else with score >= minScore
  return 'speculative';
}

// Main handler
async function handleScanBreakouts(
  mode: 'long' | 'short' | 'both' = 'both',
  minScore: number = 30,
  limit: number = 20,
  lookback5m: number = 144,
  outputFormat: 'json' | 'csv' | 'compact' = 'json',
): Promise<string> {
  const scanStart = Date.now();
  console.error(
    `[Breakout Scanner] Starting full scan with VPVR + liquidity scoring (mode: ${mode})...`,
  );

  // 1. Get ALL tickers, funding, and book ticker for spread data
  const [tickerRes, fundingRes, bookTickerRes] = await Promise.all([
    asterClient.getTicker24h(),
    asterClient.getPremiumIndex(),
    asterClient.getBookTicker(), // For bid/ask spread calculation
  ]);

  if (!tickerRes.success || !tickerRes.data) {
    return JSON.stringify({ error: 'Failed to fetch tickers' });
  }

  // Filter to tradeable symbols only (exclude SETTLING pairs like PORT3)
  const rawTickers = Array.isArray(tickerRes.data) ? tickerRes.data : [tickerRes.data];
  const tradeableTickers = await filterTradeableTickers(rawTickers);

  // Build funding map
  const fundingMap = new Map<string, number>();
  if (fundingRes.success && fundingRes.data) {
    const fd = Array.isArray(fundingRes.data) ? fundingRes.data : [fundingRes.data];
    fd.forEach((f: any) => fundingMap.set(f.symbol, parseFloat(f.lastFundingRate) || 0));
  }

  // Build spread map (bid/ask spread %)
  const spreadMap = new Map<string, number>();
  if (bookTickerRes.success && bookTickerRes.data) {
    const bt = Array.isArray(bookTickerRes.data) ? bookTickerRes.data : [bookTickerRes.data];
    bt.forEach((b: any) => {
      const bid = parseFloat(b.bidPrice);
      const ask = parseFloat(b.askPrice);
      if (bid > 0 && ask > 0) {
        const mid = (bid + ask) / 2;
        const spreadPct = ((ask - bid) / mid) * 100;
        spreadMap.set(b.symbol, spreadPct);
      }
    });
  }

  // Build pairs list - NO FILTERING (liquidity penalty instead) - uses pre-filtered tradeable tickers
  const allPairs = tradeableTickers.map((t: any) => ({
    symbol: t.symbol,
    price: parseFloat(t.lastPrice),
    volume24h: parseFloat(t.quoteVolume),
    change24h: parseFloat(t.priceChangePercent),
    fundingRate: fundingMap.get(t.symbol) || 0,
    spreadPct: spreadMap.get(t.symbol), // undefined if not available
  }));

  console.error(`[Breakout Scanner] Analyzing ALL ${allPairs.length} pairs...`);

  // 2. Fetch and analyze each pair
  const BATCH_SIZE = 15;
  const allSignals: any[] = [];
  let analyzed = 0;
  let cacheHits = 0;

  for (let i = 0; i < allPairs.length; i += BATCH_SIZE) {
    const batch = allPairs.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async pair => {
        const cacheKey = `breakout:${pair.symbol}:5m:${lookback5m}`;
        const cached = klineCache.get(cacheKey);
        const ttl = 60_000; // 60s cache for 5m

        if (cached && Date.now() - cached.timestamp < ttl) {
          cacheHits++;
          return { pair, candles5m: cached.candles };
        }

        const klineRes = await asterClient.getKlines(pair.symbol, '5m', lookback5m);
        if (!klineRes.success || !klineRes.data || klineRes.data.length < 30) {
          return { pair, candles5m: null };
        }

        klineCache.set(cacheKey, { candles: klineRes.data, timestamp: Date.now() });
        return { pair, candles5m: klineRes.data };
      }),
    );

    for (const { pair, candles5m: raw5m } of batchResults) {
      if (!raw5m) continue;

      try {
        // Convert to Candle format
        const candles5m: Candle[] = raw5m.map((k: any) => ({
          t: k.openTime,
          o: k.open,
          h: k.high,
          l: k.low,
          c: k.close,
          v: k.quoteVolume || k.volume,
        }));

        // Aggregate to 15m
        const candles15m = aggregate5mTo15m(candles5m);

        if (candles15m.length < 10) continue;

        // Calculate VPVR for both timeframes
        const vpvr5m = calculateLightVPVR(candles5m.slice(-48)); // Last 4 hours of 5m
        const vpvr15m = calculateLightVPVR(candles15m);

        // Calculate volume ratio
        const vols15m = candles15m.slice(0, -1).map(c => parseFloat(c.v));
        const baselineVol =
          vols15m.length > 0 ? vols15m.reduce((a, b) => a + b, 0) / vols15m.length : 1;
        const currentVol = parseFloat(candles15m[candles15m.length - 1].v);
        const volumeRatio = baselineVol > 0 ? currentVol / baselineVol : 1;

        // Calculate closes for momentum indicators
        const closes15m = candles15m.map(c => parseFloat(c.c));
        const rsi = calculateRSI(closes15m);
        const mfi = calculateMFI(candles15m);

        // Calculate OBV for divergence detection
        const obvResult = calculateOBV(candles15m);
        let obvWarning: string | null = null;
        let obvPenalty = 0;

        // FIXED: Significant penalty for divergence - this is smart money diverging from price
        // Bullish divergence on dump = hidden accumulation (bad for shorts)
        // Bearish divergence on pump = hidden distribution (bad for longs)
        if (obvResult.divergence === 'bullish_divergence') {
          obvWarning = `🚨 HIDDEN ACCUMULATION: Price down ${obvResult.priceChange.toFixed(1)}% but OBV rising - smart money buying, reversal likely`;
          obvPenalty = 25; // Significant penalty - this is a major red flag for shorts
        } else if (obvResult.divergence === 'bearish_divergence') {
          obvWarning = `🚨 HIDDEN DISTRIBUTION: Price up ${obvResult.priceChange.toFixed(1)}% but OBV falling - smart money exiting, trap likely`;
          obvPenalty = 25; // Significant penalty - this is a major red flag for longs
        }

        // Calculate component scores
        const structureResult = calculateStructureScore(pair.price, vpvr15m);
        const volumeScore = calculateVolumeScore(volumeRatio);
        const deltaScore = calculateDeltaScore(vpvr15m.deltaPct);
        const momentumScore = calculateMomentumScore(rsi, mfi);

        // MTF Confluence
        const delta5m = vpvr5m.deltaPct;
        const delta15m = vpvr15m.deltaPct;
        let mtfBonus = 0;
        let mtfSignal = 'NEUTRAL';
        let acceleration = 'STABLE';

        if (delta5m > delta15m + 5) {
          mtfBonus = 10;
          mtfSignal = 'BULLISH';
          acceleration = 'BUYERS_INCREASING';
        } else if (delta5m < delta15m - 5) {
          mtfBonus = -10;
          mtfSignal = 'BEARISH';
          acceleration = 'SELLERS_INCREASING';
        }

        // Check if 5m broke 15m VAH
        const recent5mClose = parseFloat(candles5m[candles5m.length - 1].c);
        const broke15mVah = recent5mClose > vpvr15m.vah;
        const broke15mVal = recent5mClose < vpvr15m.val;
        if (broke15mVah && mtfSignal !== 'BEARISH') {
          mtfBonus += 15;
          mtfSignal = 'BULLISH';
        }
        if (broke15mVal && mtfSignal !== 'BULLISH') {
          mtfBonus -= 15;
          mtfSignal = 'BEARISH';
        }

        // Determine bias FIRST (needed for funding modifier)
        const isBullish =
          structureResult.position === 'ABOVE_VAH' || structureResult.position === 'UPPER_VA';
        const isBearish =
          structureResult.position === 'BELOW_VAL' || structureResult.position === 'LOWER_VA';

        // Composite score (equal weights 25% each) + MTF bonus
        const baseScore =
          volumeScore * 0.25 +
          deltaScore * 0.25 +
          structureResult.score * 0.25 +
          momentumScore * 0.25;
        const rawScore = Math.max(0, Math.min(100, baseScore + mtfBonus));

        // Apply liquidity penalty - penalizes low volume/wide spread instead of filtering
        const liquidityPenalty = calculateLiquidityPenalty(pair.volume24h, pair.spreadPct);
        const liquidityGrade = calculateLiquidityGrade(pair.volume24h, pair.spreadPct);

        // Calculate funding rate modifier (±15 points based on alignment with funding)
        const fundingResult = calculateFundingModifier(pair.fundingRate, isBullish);
        const fundingModifier = fundingResult.modifier;
        const fundingWarning = fundingResult.warning;

        // Detect red flags for conflicting signals
        const redFlags = detectRedFlags(
          volumeRatio,
          vpvr15m.deltaPct,
          rsi,
          mfi,
          isBullish,
          structureResult.position,
          obvResult.divergence,
        );

        // Apply all penalties and modifiers
        // OBV penalty (25 points for divergence)
        // Funding modifier (±15 points)
        // Liquidity penalty (0-50 points)
        const finalScore = Math.max(0, rawScore - liquidityPenalty - obvPenalty + fundingModifier);

        // Classify signal tier based on score AND liquidity
        const signalTier = classifySignalTier(finalScore, pair.volume24h, pair.spreadPct);

        // Generate TLDR and why_flagged
        let tldr = '';
        let whyFlagged = '';
        const volDesc =
          volumeRatio >= 5
            ? `${volumeRatio.toFixed(1)}x volume spike`
            : volumeRatio >= 2
              ? `${volumeRatio.toFixed(1)}x volume building`
              : 'normal volume';
        const deltaDesc =
          vpvr15m.deltaPct > 15
            ? 'strong buying pressure'
            : vpvr15m.deltaPct > 5
              ? 'buyers in control'
              : vpvr15m.deltaPct < -15
                ? 'strong selling pressure'
                : vpvr15m.deltaPct < -5
                  ? 'sellers in control'
                  : 'balanced flow';

        if (isBullish) {
          tldr = `${structureResult.position === 'ABOVE_VAH' ? 'Breaking out above' : 'Testing'} value area, ${volDesc}, ${deltaDesc}`;
          whyFlagged =
            [
              volumeRatio >= 3 ? 'Volume spike' : null,
              structureResult.position === 'ABOVE_VAH' ? 'Structure breakout' : 'At resistance',
              mtfSignal === 'BULLISH' ? 'MTF confluence' : null,
              vpvr15m.deltaPct > 10 ? 'Positive delta' : null,
            ]
              .filter(Boolean)
              .join(' + ') || 'Bullish setup forming';
        } else if (isBearish) {
          tldr = `${structureResult.position === 'BELOW_VAL' ? 'Breaking down below' : 'Testing'} value area, ${volDesc}, ${deltaDesc}`;
          whyFlagged =
            [
              volumeRatio >= 3 ? 'Volume spike' : null,
              structureResult.position === 'BELOW_VAL' ? 'Structure breakdown' : 'At support',
              mtfSignal === 'BEARISH' ? 'MTF confluence' : null,
              vpvr15m.deltaPct < -10 ? 'Negative delta' : null,
            ]
              .filter(Boolean)
              .join(' + ') || 'Bearish setup forming';
        } else {
          tldr = `In value area, ${volDesc}, ${deltaDesc}`;
          whyFlagged = 'Consolidating in value area';
        }

        allSignals.push({
          symbol: pair.symbol,
          price: pair.price,
          score: finalScore,
          rawScore: rawScore, // Before liquidity penalty
          tier: signalTier,
          components: {
            volume: Math.round(volumeScore),
            delta: Math.round(deltaScore),
            structure: Math.round(structureResult.score),
            momentum: Math.round(momentumScore),
          },
          structure: {
            position: structureResult.position,
            poc: vpvr15m.poc,
            vah: vpvr15m.vah,
            val: vpvr15m.val,
            vwap: vpvr15m.vwap,
          },
          delta: {
            pct: vpvr15m.deltaPct,
            bias: vpvr15m.deltaPct > 5 ? 'BUYERS' : vpvr15m.deltaPct < -5 ? 'SELLERS' : 'NEUTRAL',
          },
          volume: {
            ratio: volumeRatio,
            vol24h: pair.volume24h,
          },
          liquidity: {
            grade: liquidityGrade.grade,
            description: liquidityGrade.description,
            spreadPct: pair.spreadPct ? parseFloat(pair.spreadPct.toFixed(3)) : null,
            penalty: Math.round(liquidityPenalty),
          },
          mtf: {
            signal: mtfSignal,
            delta5m: delta5m,
            delta15m: delta15m,
            acceleration: acceleration,
            broke15mVah: broke15mVah,
            broke15mVal: broke15mVal,
          },
          momentum: { rsi, mfi },
          obv: {
            trend: obvResult.trend.toUpperCase(),
            divergence:
              obvResult.divergence !== 'none'
                ? obvResult.divergence.toUpperCase().replace('_', ' ')
                : null,
            warning: obvWarning,
            priceChange: obvResult.priceChange,
            penalty: obvPenalty,
          },
          funding: {
            rate: pair.fundingRate,
            ratePct: (pair.fundingRate * 100).toFixed(4) + '%',
            modifier: fundingModifier,
            warning: fundingWarning,
            alignment:
              fundingModifier > 0 ? 'FAVORABLE' : fundingModifier < 0 ? 'UNFAVORABLE' : 'NEUTRAL',
          },
          redFlags: redFlags.length > 0 ? redFlags : null,
          change24h: pair.change24h,
          tldr,
          whyFlagged,
          isBullish,
          isBearish,
        });

        analyzed++;
      } catch (err) {
        continue;
      }
    }

    console.error(
      `[Breakout Scanner] Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${analyzed} analyzed (${cacheHits} cache hits)...`,
    );
  }

  const scanDuration = Date.now() - scanStart;
  console.error(
    `[Breakout Scanner] Complete in ${scanDuration}ms: ${allSignals.length} pairs scored`,
  );

  // Filter by mode
  let filtered = allSignals;
  if (mode === 'long') {
    filtered = allSignals.filter(s => s.isBullish || s.score >= 60);
  } else if (mode === 'short') {
    filtered = allSignals.filter(s => s.isBearish || s.score <= 40);
  }

  // Sort by score
  filtered.sort((a, b) => b.score - a.score);

  // Separate into tiers based on BOTH score AND liquidity
  const actionable = filtered.filter(s => s.tier === 'actionable' && s.score >= minScore);
  const earlyWarning = filtered.filter(s => s.tier === 'early_warning' && s.score >= minScore);
  const speculative = filtered.filter(s => s.tier === 'speculative' && s.score >= minScore);
  const allRanked = filtered.filter(s => s.score >= minScore);

  // Generate insights
  const insights: string[] = [];

  if (actionable.length > 0) {
    const top = actionable[0];
    insights.push(
      `🔥 ${top.symbol}: ${top.tldr} - strongest actionable setup (${top.liquidity.grade} liquidity)`,
    );
  }

  // Alert on high-score but low-liquidity signals
  const highScoreLowLiq = filtered.filter(s => s.rawScore >= 70 && s.liquidity.grade === 'F');
  if (highScoreLowLiq.length > 0) {
    const sym = highScoreLowLiq[0].symbol.replace('USDT', '');
    insights.push(
      `⚠️ ${sym}: Strong signal (raw ${highScoreLowLiq[0].rawScore}) but F-grade liquidity - early discovery, verify volume before entry`,
    );
  }

  // Find diverging delta (high volume but sellers absorbing)
  const diverging = allSignals.filter(s => s.volume.ratio >= 3 && s.delta.pct < -10);
  if (diverging.length > 0) {
    insights.push(
      `⚠️ ${diverging[0].symbol}: High volume but delta diverging (sellers absorbing) - caution`,
    );
  }

  // Find coins compressing at VAH
  const atVah = allSignals.filter(
    s => s.structure.position === 'UPPER_VA' && s.volume.ratio >= 1.5,
  );
  if (atVah.length >= 2) {
    const symbols = atVah
      .slice(0, 3)
      .map(s => s.symbol.replace('USDT', ''))
      .join(', ');
    insights.push(`👀 ${atVah.length} coins compressing at VAH - watch for breakouts: ${symbols}`);
  }

  // OBV divergence warnings (hidden accumulation/distribution)
  const obvDivergences = allSignals.filter(s => s.obv?.divergence);
  const hiddenAccumulation = obvDivergences.filter(
    s => s.obv.divergence === 'BULLISH DIVERGENCE' && s.isBearish,
  );
  const hiddenDistribution = obvDivergences.filter(
    s => s.obv.divergence === 'BEARISH DIVERGENCE' && s.isBullish,
  );

  if (hiddenAccumulation.length > 0) {
    const sym = hiddenAccumulation[0].symbol.replace('USDT', '');
    insights.push(
      `🔍 ${sym}: Bearish signal but OBV shows hidden accumulation - potential reversal, be cautious shorting`,
    );
  }
  if (hiddenDistribution.length > 0) {
    const sym = hiddenDistribution[0].symbol.replace('USDT', '');
    insights.push(
      `🔍 ${sym}: Bullish signal but OBV shows hidden distribution - smart money may be exiting`,
    );
  }

  // Red flags warnings - signals with multiple concerns
  const signalsWithRedFlags = allSignals.filter(
    s => s.redFlags && s.redFlags.length >= 2 && s.score >= 50,
  );
  if (signalsWithRedFlags.length > 0) {
    const worst = signalsWithRedFlags[0];
    insights.push(
      `🚩 ${worst.symbol}: ${worst.redFlags.length} red flags detected - ${worst.redFlags[0]}`,
    );
  }

  // Funding rate warnings
  const crowdedLongs = allSignals.filter(
    s => s.funding.modifier <= -15 && s.isBullish && s.score >= 50,
  );
  const crowdedShorts = allSignals.filter(
    s => s.funding.modifier <= -15 && s.isBearish && s.score >= 50,
  );
  if (crowdedLongs.length > 0) {
    const sym = crowdedLongs[0].symbol.replace('USDT', '');
    insights.push(
      `💰 ${sym}: Bullish signal but funding ${(crowdedLongs[0].funding.rate * 100).toFixed(3)}% - crowded long, consider waiting for reset`,
    );
  }
  if (crowdedShorts.length > 0) {
    const sym = crowdedShorts[0].symbol.replace('USDT', '');
    insights.push(
      `💰 ${sym}: Bearish signal but funding ${(crowdedShorts[0].funding.rate * 100).toFixed(3)}% - crowded short, consider waiting for reset`,
    );
  }

  // Market bias
  const bullishCount = allSignals.filter(s => s.isBullish && s.score >= 50).length;
  const bearishCount = allSignals.filter(s => s.isBearish && s.score >= 50).length;
  const totalActive = bullishCount + bearishCount;
  const marketBias =
    totalActive > 0
      ? bullishCount > bearishCount
        ? `BULLISH - ${Math.round((bullishCount / totalActive) * 100)}% of active signals are longs`
        : `BEARISH - ${Math.round((bearishCount / totalActive) * 100)}% of active signals are shorts`
      : 'NEUTRAL - no clear direction';

  // Format output (Lean/Raw Format)
  const formatSignalLean = (s: any) => ({
    symbol: s.symbol,
    score: Math.round(s.score),
    tier: s.tier,
    price: s.price,
    change_24h: s.change24h,
    structure: {
      position: s.structure.position,
      poc: s.structure.poc,
      vah: s.structure.vah,
      val: s.structure.val,
    },
    metrics: {
      volume_ratio: Number(s.volume.ratio.toFixed(2)),
      volume_24h: s.volume.vol24h,
      delta_pct: Number(s.delta.pct.toFixed(1)),
      funding_rate: s.funding.rate,
    },
    mtf: {
      signal: s.mtf.signal,
      delta_5m: Number(s.mtf.delta5m.toFixed(1)),
      delta_15m: Number(s.mtf.delta15m.toFixed(1)),
    },
    flags: {
      red_flags: s.redFlags,
      funding_warning: s.funding.warning,
      obv_warning: s.obv.warning,
    },
  });

  // CSV FORMAT
  if (outputFormat === 'csv') {
    const header = 'rank,symbol,score,tier,liq_grade,vol_24h,vol_ratio,structure,delta';
    const formatCsvRow = (s: any, i: number) =>
      `${i + 1},${s.symbol},${Math.round(s.score)},${s.tier.charAt(0).toUpperCase()},${s.liquidity.grade},${s.volume.vol24h >= 1000 ? `$${(s.volume.vol24h / 1000).toFixed(0)}k` : `$${s.volume.vol24h.toFixed(0)}`},${s.volume.ratio.toFixed(1)}x,${s.structure.position},${s.delta.pct >= 0 ? '+' : ''}${s.delta.pct.toFixed(0)}%`;

    let output = `# Breakout Scan: ${mode} | ${new Date().toISOString()} | ${analyzed} pairs | ${scanDuration}ms\n`;
    output += `# Bias: ${marketBias}\n`;
    output += `\n## ACTIONABLE (${actionable.length})\n${header}\n${actionable
      .slice(0, limit)
      .map((s, i) => formatCsvRow(s, i))
      .join('\n')}`;
    output += `\n\n## EARLY WARNING (${earlyWarning.length})\n${header}\n${earlyWarning
      .slice(0, limit)
      .map((s, i) => formatCsvRow(s, i))
      .join('\n')}`;
    output += `\n\n## SPECULATIVE (${speculative.length})\n${header}\n${speculative
      .slice(0, 10)
      .map((s, i) => formatCsvRow(s, i))
      .join('\n')}`;
    return output;
  }

  // COMPACT FORMAT
  if (outputFormat === 'compact') {
    const formatCompact = (s: any) => ({
      s: s.symbol,
      sc: Math.round(s.score),
      t: s.tier.charAt(0), // a/e/s
      lq: s.liquidity.grade,
      v: `${s.volume.ratio.toFixed(1)}x`,
      st: s.structure.position,
      d: `${s.delta.pct >= 0 ? '+' : ''}${s.delta.pct.toFixed(0)}%`,
    });

    const compactRegime = await getCompactRegimeBlock();
    return JSON.stringify({
      market_regime: compactRegime,
      t: new Date().toISOString(),
      n: analyzed,
      bias: marketBias.charAt(0),
      A: actionable.slice(0, limit).map(formatCompact),
      E: earlyWarning.slice(0, limit).map(formatCompact),
      S: speculative.slice(0, 10).map(formatCompact),
    });
  }

  // JSON FORMAT (Lean)
  // Combine all ranked signals into a single list
  const topSignals = allRanked.slice(0, limit * 2).map(formatSignalLean);
  const regimeBlock = await getCompactRegimeBlock();

  return JSON.stringify(
    {
      market_regime: regimeBlock,
      signals: topSignals,
    },
    null,
    2,
  );
}

// --- 22. get_funding_spread ---
// Compare funding rates between Aster and Hyperliquid for arbitrage detection
async function handleGetFundingSpread(
  minSpreadBps: number = 10,
  limit: number = 20,
  includeSingleExchange: boolean = false,
): Promise<string> {
  console.error(`[Funding Spread] Fetching cross-exchange funding rates...`);

  // Fetch funding rates from both exchanges in parallel
  // Aster: getPremiumIndex contains funding rates
  // Hyperliquid: getTicker24h contains funding rates
  const [asterFunding, hlTickers] = await Promise.all([
    asterClient.getPremiumIndex(),
    hyperliquidClient.getTicker24h(),
  ]);

  if (!asterFunding.success) {
    return JSON.stringify({ error: 'Failed to fetch Aster funding', details: asterFunding.error });
  }

  // Build maps for each exchange
  const asterMap = new Map<string, { rate: number; symbol: string; nextFundingTime?: number }>();
  const hlMap = new Map<string, { rate: number; symbol: string }>();

  // Normalize symbol helper
  const normalizeSymbol = (s: string) =>
    s.toUpperCase().replace('USDT', '').replace('USD', '').replace('PERP', '').replace('-', '');

  // Process Aster funding
  const asterData = Array.isArray(asterFunding.data) ? asterFunding.data : [asterFunding.data];
  for (const f of asterData) {
    if (!f) continue;
    const baseSymbol = normalizeSymbol(f.symbol);
    asterMap.set(baseSymbol, {
      rate: parseFloat(f.lastFundingRate) || 0,
      symbol: f.symbol,
      nextFundingTime: f.nextFundingTime,
    });
  }

  // Process Hyperliquid funding from ticker data
  if (hlTickers.success && hlTickers.data) {
    const hlData = Array.isArray(hlTickers.data) ? hlTickers.data : [hlTickers.data];
    for (const t of hlData) {
      const baseSymbol = normalizeSymbol(t.symbol);
      hlMap.set(baseSymbol, {
        rate: parseFloat(t.fundingRate) || 0,
        symbol: t.symbol,
      });
    }
  }

  // Find all unique symbols
  const allSymbols = new Set([...asterMap.keys(), ...hlMap.keys()]);

  // Calculate spreads
  interface FundingSpread {
    base_symbol: string;
    aster_symbol: string | null;
    hl_symbol: string | null;
    aster_rate: number | null;
    hl_rate: number | null;
    spread_bps: number;
    spread_pct: string;
    apr_potential: string;
    arbitrage_direction: string | null;
    next_funding?: number;
  }

  const spreads: FundingSpread[] = [];

  for (const symbol of allSymbols) {
    const aster = asterMap.get(symbol);
    const hl = hlMap.get(symbol);

    const asterRate = aster?.rate ?? null;
    const hlRate = hl?.rate ?? null;

    // Skip if both are null
    if (asterRate === null && hlRate === null) continue;

    // Calculate spread (null = 0 for comparison)
    const effectiveAster = asterRate ?? 0;
    const effectiveHl = hlRate ?? 0;
    const spreadDecimal = effectiveAster - effectiveHl;
    const spreadBps = Math.abs(spreadDecimal) * 10000; // Convert to basis points

    // Skip if below threshold
    if (spreadBps < minSpreadBps) continue;

    // Skip single-exchange unless requested
    const isSingleExchange = asterRate === null || hlRate === null;
    if (isSingleExchange && !includeSingleExchange) continue;

    // Calculate APR potential (8-hour funding, 3x daily)
    // Annual = daily * 365 = (spread * 3) * 365
    const dailyReturn = Math.abs(spreadDecimal) * 3;
    const annualReturn = dailyReturn * 365 * 100; // As percentage

    // Determine arbitrage direction
    let arbDirection: string | null = null;
    if (asterRate !== null && hlRate !== null) {
      if (asterRate > hlRate) {
        // Aster paying more -> Short Aster (receive funding), Long HL
        arbDirection = `Short ${aster!.symbol} / Long ${hl!.symbol}`;
      } else {
        // HL paying more -> Short HL, Long Aster (receive funding)
        arbDirection = `Short ${hl!.symbol} / Long ${aster!.symbol}`;
      }
    }

    spreads.push({
      base_symbol: symbol,
      aster_symbol: aster?.symbol ?? null,
      hl_symbol: hl?.symbol ?? null,
      aster_rate: asterRate !== null ? +(asterRate * 100).toFixed(4) : null, // As percentage
      hl_rate: hlRate !== null ? +(hlRate * 100).toFixed(4) : null,
      spread_bps: +spreadBps.toFixed(1),
      spread_pct: `${(spreadDecimal * 100).toFixed(4)}%`,
      apr_potential: `${annualReturn.toFixed(1)}%`,
      arbitrage_direction: arbDirection,
      next_funding: aster?.nextFundingTime,
    });
  }

  // Sort by spread (highest first)
  spreads.sort((a, b) => b.spread_bps - a.spread_bps);

  // Take top N
  const topSpreads = spreads.slice(0, limit);

  // Categorize spreads
  const highYield = topSpreads.filter(s => s.spread_bps >= 50); // 0.5%+ = very significant
  const moderate = topSpreads.filter(s => s.spread_bps >= 20 && s.spread_bps < 50);
  const low = topSpreads.filter(s => s.spread_bps < 20);

  return JSON.stringify(
    {
      scan_time: new Date().toISOString(),
      exchanges: ['Aster', 'Hyperliquid'],
      min_spread_bps: minSpreadBps,
      total_pairs_compared: allSymbols.size,
      spreads_found: spreads.length,
      summary: {
        high_yield: highYield.length,
        moderate: moderate.length,
        low: low.length,
      },
      top_opportunities: topSpreads.map(s => ({
        pair: s.base_symbol,
        aster: s.aster_rate !== null ? `${s.aster_rate}%` : 'N/A',
        hl: s.hl_rate !== null ? `${s.hl_rate}%` : 'N/A',
        spread: `${s.spread_bps}bps`,
        apr: s.apr_potential,
        trade: s.arbitrage_direction,
        category: s.spread_bps >= 50 ? 'HIGH_YIELD' : s.spread_bps >= 20 ? 'MODERATE' : 'LOW',
      })),
    },
    null,
    2,
  );
}

// --- 23. scan_oi_divergence ---
// Scan for price vs open interest divergence - a leading indicator
async function handleScanOIDivergence(
  lookbackPeriods: number = 24,
  minOIChangePct: number = 5,
  minVolume: number = 50000,
  limit: number = 15,
): Promise<string> {
  console.error(
    `[OI Divergence] Scanning with REAL Binance OI history (upgraded from volume proxy)...`,
  );

  // Step 1: Get Aster tradeable symbols intersected with Binance
  const [asterInfoRes, binanceSymbolsRes] = await Promise.all([
    asterClient.getExchangeInfo(),
    binanceClient.getSymbols(),
  ]);

  if (!asterInfoRes.success || !asterInfoRes.data?.symbols) {
    return JSON.stringify({ error: 'Failed to fetch Aster exchange info' });
  }
  if (!binanceSymbolsRes.success || !binanceSymbolsRes.data) {
    return JSON.stringify({ error: 'Failed to fetch Binance symbols' });
  }

  const asterPairs = asterInfoRes.data.symbols
    .filter((s: any) => s.status === 'TRADING' && s.symbol.endsWith('USDT'))
    .map((s: any) => s.symbol);
  const binanceSymbolSet = new Set(binanceSymbolsRes.data);
  const commonSymbols = asterPairs.filter((s: string) => binanceSymbolSet.has(s));

  // Step 2: Bulk fetch Binance tickers for volume filter + price context
  const binanceTickersRes = await binanceClient.getTicker24h();
  if (!binanceTickersRes.success || !binanceTickersRes.data) {
    return JSON.stringify({ error: 'Failed to fetch Binance tickers' });
  }

  const binanceTickerMap = new Map<string, any>();
  const rawTickers = Array.isArray(binanceTickersRes.data)
    ? binanceTickersRes.data
    : [binanceTickersRes.data];
  for (const t of rawTickers) binanceTickerMap.set(t.symbol, t);

  // Filter by volume on Binance (more reliable than Aster volume)
  const pairs = commonSymbols
    .map((symbol: string) => {
      const ticker = binanceTickerMap.get(symbol);
      if (!ticker) return null;
      const volume24h = parseFloat(ticker.quoteVolume || '0');
      if (volume24h < minVolume) return null;
      return {
        symbol,
        price: parseFloat(ticker.lastPrice),
        change24h: parseFloat(ticker.priceChangePercent),
        volume24h,
      };
    })
    .filter(Boolean) as { symbol: string; price: number; change24h: number; volume24h: number }[];

  console.error(
    `[OI Divergence] ${commonSymbols.length} common pairs, ${pairs.length} pass volume filter — fetching REAL Binance OI history...`,
  );

  interface OIDivergenceSignal {
    symbol: string;
    price: number;
    price_change_pct: number;
    oi_change_pct: number;
    oi_trend: string;
    volume_24h: number;
    divergence_type: string;
    signal_strength: number;
    interpretation: string;
    trade_bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  }

  const signals: OIDivergenceSignal[] = [];

  // Step 3: Fetch REAL OI history from Binance (not volume proxy)
  const period = lookbackPeriods <= 6 ? '15m' : lookbackPeriods <= 24 ? '1h' : '4h';
  const dataPoints =
    lookbackPeriods <= 6
      ? Math.ceil(lookbackPeriods * 4)
      : lookbackPeriods <= 24
        ? lookbackPeriods
        : Math.ceil(lookbackPeriods / 4);
  const clampedDataPoints = Math.min(dataPoints, 30);

  const BATCH_SIZE = 5; // Binance rate limit friendly
  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const batch = pairs.slice(i, i + BATCH_SIZE);

    const oiResults = await Promise.all(
      batch.map(async pair => {
        try {
          // Fetch REAL historical OI from Binance — no more guessing
          const oiHistRes = await binanceClient.getOpenInterestHist(
            pair.symbol,
            period as any,
            clampedDataPoints,
          );
          if (!oiHistRes.success || !oiHistRes.data || oiHistRes.data.length < 3) return null;

          const oiData = oiHistRes.data;
          const oldestOI = parseFloat(
            oiData[0].sumOpenInterestValue || oiData[0].sumOpenInterest || '0',
          );
          const latestOI = parseFloat(
            oiData[oiData.length - 1].sumOpenInterestValue ||
              oiData[oiData.length - 1].sumOpenInterest ||
              '0',
          );

          if (oldestOI <= 0) return null;

          const oiChangePct = ((latestOI - oldestOI) / oldestOI) * 100;
          if (Math.abs(oiChangePct) < minOIChangePct) return null;

          // Check OI acceleration (is it speeding up or slowing down?)
          const midIdx = Math.floor(oiData.length / 2);
          const midOI = parseFloat(
            oiData[midIdx].sumOpenInterestValue || oiData[midIdx].sumOpenInterest || '0',
          );
          const firstHalfChange = oldestOI > 0 ? ((midOI - oldestOI) / oldestOI) * 100 : 0;
          const secondHalfChange = midOI > 0 ? ((latestOI - midOI) / midOI) * 100 : 0;

          let oiTrend = 'FLAT';
          if (oiChangePct > 5) {
            oiTrend =
              secondHalfChange > firstHalfChange ? 'RISING_ACCELERATING' : 'RISING_DECELERATING';
          } else if (oiChangePct < -5) {
            oiTrend =
              secondHalfChange < firstHalfChange ? 'FALLING_ACCELERATING' : 'FALLING_DECELERATING';
          }

          // OI/Volume ratio for crowding detection
          const oiToVolumeRatio = latestOI / (pair.volume24h || 1);

          return {
            symbol: pair.symbol,
            price: pair.price,
            priceChangePct: pair.change24h,
            oiChangePct,
            oiTrend,
            volume24h: pair.volume24h,
            latestOI,
            oiToVolumeRatio,
          };
        } catch {
          return null;
        }
      }),
    );

    // Process results — same classification logic, now with real data
    for (const result of oiResults) {
      if (!result) continue;

      const { symbol, price, priceChangePct, oiChangePct, oiTrend, volume24h, oiToVolumeRatio } =
        result;

      let divergenceType = 'NONE';
      let interpretation = '';
      let tradeBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
      let signalStrength = 0;

      // Acceleration bonus: if OI change is accelerating, signal is stronger
      const accelBonus = oiTrend.includes('ACCELERATING') ? 15 : 0;

      // OI rising + price flat = Accumulation (bullish leading)
      if (oiChangePct > minOIChangePct && Math.abs(priceChangePct) < 3) {
        divergenceType = 'ACCUMULATION';
        interpretation = `Real OI up ${oiChangePct.toFixed(1)}% while price flat — positions being built quietly`;
        if (oiTrend === 'RISING_ACCELERATING') interpretation += ' (OI accelerating!)';
        tradeBias = 'BULLISH';
        signalStrength = Math.min(
          100,
          (oiChangePct / minOIChangePct) * 50 + (oiToVolumeRatio > 2 ? 25 : 0) + accelBonus,
        );
      }
      // OI rising + price falling = Short build (bearish)
      else if (oiChangePct > minOIChangePct && priceChangePct < -3) {
        divergenceType = 'SHORT_BUILD';
        interpretation = `Real OI up ${oiChangePct.toFixed(1)}% while price down ${priceChangePct.toFixed(1)}% — shorts accumulating`;
        tradeBias = 'BEARISH';
        signalStrength = Math.min(
          100,
          (oiChangePct / minOIChangePct) * 40 + Math.abs(priceChangePct) * 3 + accelBonus,
        );
      }
      // OI falling + price rising = Weak rally (short covering)
      else if (oiChangePct < -minOIChangePct && priceChangePct > 3) {
        divergenceType = 'WEAK_RALLY';
        interpretation = `Real OI down ${oiChangePct.toFixed(1)}% while price up ${priceChangePct.toFixed(1)}% — short covering, not real demand`;
        tradeBias = 'BEARISH';
        signalStrength = Math.min(
          100,
          (Math.abs(oiChangePct) / minOIChangePct) * 40 + priceChangePct * 2 + accelBonus,
        );
      }
      // OI falling + price falling = Capitulation (potential bottom)
      else if (oiChangePct < -minOIChangePct && priceChangePct < -3) {
        divergenceType = 'CAPITULATION';
        interpretation = `Real OI down ${oiChangePct.toFixed(1)}% with price down ${priceChangePct.toFixed(1)}% — longs capitulating, potential bottom`;
        tradeBias = 'BULLISH';
        signalStrength = Math.min(
          100,
          (Math.abs(oiChangePct) / minOIChangePct) * 35 + Math.abs(priceChangePct) * 2 + accelBonus,
        );
      }
      // OI rising + price rising = Trend confirmation or crowding
      else if (oiChangePct > minOIChangePct && priceChangePct > 3) {
        if (oiToVolumeRatio > 3) {
          divergenceType = 'CROWDED_LONG';
          interpretation = `OI/Volume ratio ${oiToVolumeRatio.toFixed(1)}x with price up — crowded trade, reversal risk`;
          tradeBias = 'BEARISH';
          signalStrength = Math.min(100, oiToVolumeRatio * 15 + accelBonus);
        } else {
          divergenceType = 'TREND_CONFIRMED';
          interpretation = `Real OI up ${oiChangePct.toFixed(1)}% confirming ${priceChangePct.toFixed(1)}% price rise — healthy trend`;
          tradeBias = 'BULLISH';
          signalStrength = Math.min(
            100,
            (oiChangePct / minOIChangePct) * 25 + priceChangePct * 2 + accelBonus,
          );
        }
      }

      if (divergenceType !== 'NONE' && signalStrength > 20) {
        signals.push({
          symbol,
          price,
          price_change_pct: +priceChangePct.toFixed(2),
          oi_change_pct: +oiChangePct.toFixed(2),
          oi_trend: oiTrend,
          volume_24h: volume24h,
          divergence_type: divergenceType,
          signal_strength: Math.round(signalStrength),
          interpretation,
          trade_bias: tradeBias,
        });
      }
    }
  }

  // Sort by signal strength
  signals.sort((a, b) => b.signal_strength - a.signal_strength);

  const bullish = signals.filter(s => s.trade_bias === 'BULLISH');
  const bearish = signals.filter(s => s.trade_bias === 'BEARISH');

  const regimeBlock = await getCompactRegimeBlock();
  return JSON.stringify(
    {
      market_regime: regimeBlock,
      scan_time: new Date().toISOString(),
      data_source: 'BINANCE_REAL_OI_HISTORY',
      note: 'Upgraded: uses real Binance OI history instead of volume-based estimation',
      aster_tradeable: asterPairs.length,
      common_with_binance: commonSymbols.length,
      pairs_analyzed: pairs.length,
      divergences_found: signals.length,
      lookback_hours: lookbackPeriods,
      period_used: period,
      min_oi_change_pct: minOIChangePct,
      summary: {
        bullish_setups: bullish.length,
        bearish_setups: bearish.length,
        types: {
          accumulation: signals.filter(s => s.divergence_type === 'ACCUMULATION').length,
          short_build: signals.filter(s => s.divergence_type === 'SHORT_BUILD').length,
          weak_rally: signals.filter(s => s.divergence_type === 'WEAK_RALLY').length,
          capitulation: signals.filter(s => s.divergence_type === 'CAPITULATION').length,
          crowded_long: signals.filter(s => s.divergence_type === 'CROWDED_LONG').length,
          trend_confirmed: signals.filter(s => s.divergence_type === 'TREND_CONFIRMED').length,
        },
      },
      bullish_signals: bullish.slice(0, limit).map(s => ({
        symbol: s.symbol,
        price: s.price,
        price_chg: `${s.price_change_pct >= 0 ? '+' : ''}${s.price_change_pct}%`,
        oi_chg: `${s.oi_change_pct >= 0 ? '+' : ''}${s.oi_change_pct}%`,
        oi_trend: s.oi_trend,
        type: s.divergence_type,
        strength: s.signal_strength,
        insight: s.interpretation,
      })),
      bearish_signals: bearish.slice(0, limit).map(s => ({
        symbol: s.symbol,
        price: s.price,
        price_chg: `${s.price_change_pct >= 0 ? '+' : ''}${s.price_change_pct}%`,
        oi_chg: `${s.oi_change_pct >= 0 ? '+' : ''}${s.oi_change_pct}%`,
        oi_trend: s.oi_trend,
        type: s.divergence_type,
        strength: s.signal_strength,
        insight: s.interpretation,
      })),
    },
    null,
    2,
  );
}

// --- 17. panic_button ---
async function handlePanicButton(confirm: boolean): Promise<string> {
  if (!confirm) return JSON.stringify({ error: 'Confirm required' });
  if (!tradingEnabled) return JSON.stringify({ error: 'Trading not enabled' });

  const posRes = await asterTrading.getPositions();
  if (!posRes.success) return JSON.stringify({ error: 'Failed fetch positions' });

  const active = (Array.isArray(posRes.data) ? posRes.data : []).filter(
    (p: any) => parseFloat(p.positionAmt) !== 0,
  );
  const results = [];
  for (const p of active) {
    await asterTrading.cancelAllOrders(p.symbol);
    const c = await asterTrading.closePosition(p.symbol);
    results.push({ s: p.symbol, success: c.success });
  }
  return JSON.stringify({ closed: results });
}

// --- 16. Strategy Engine Handlers ---
async function handleStartStrategy(
  strategyType: string = 'default',
  customConfig?: any,
): Promise<string> {
  if (!tradingEnabled) return JSON.stringify({ error: 'Trading not enabled' });

  if (strategyEngine && strategyEngine.getState().status === 'running') {
    return JSON.stringify({ error: 'Strategy already running' });
  }

  // Select config based on type
  let config;
  switch (strategyType) {
    case 'aggressive':
      config = { ...AGGRESSIVE_PUMP_STRATEGY };
      break;
    case 'conservative':
      config = { ...CONSERVATIVE_PUMP_STRATEGY };
      break;
    case 'custom':
      if (!customConfig) return JSON.stringify({ error: 'Custom config required' });
      config = { ...DEFAULT_PUMP_STRATEGY, ...customConfig };
      break;
    default:
      config = { ...DEFAULT_PUMP_STRATEGY };
  }

  config.enabled = true;

  // Create new engine instance
  strategyEngine = new StrategyEngine(asterClient, asterTrading, config);

  const result = await strategyEngine.start();

  return JSON.stringify(
    {
      success: result.success,
      message: result.message,
      config: {
        name: config.name,
        scanInterval: `${config.scanInterval / 1000}s`,
        volumeMultiple: `${config.volumeMultiple}x`,
        minScore: config.minScore,
        maxPositions: config.maxPositions,
        positionSize: `$${config.positionSizeUsd}`,
        leverage: `${config.leverage}x`,
        stopLoss: `${config.stopLossPercent}%`,
        takeProfit: `${config.takeProfitPercent}%`,
      },
    },
    null,
    2,
  );
}

async function handleStopStrategy(closePositions: boolean = false): Promise<string> {
  if (!strategyEngine) {
    return JSON.stringify({ error: 'No strategy running' });
  }

  if (closePositions) {
    await strategyEngine.closeAllPositions();
  }

  const result = await strategyEngine.stop();

  return JSON.stringify({
    success: result.success,
    message: result.message,
    positions_closed: closePositions,
  });
}

function handleGetStrategyStatus(): string {
  if (!strategyEngine) {
    return JSON.stringify({
      status: 'not_initialized',
      message: 'Strategy engine not started yet',
    });
  }

  const state = strategyEngine.getState();

  return JSON.stringify(
    {
      status: state.status,
      stats: {
        last_scan: state.lastScan > 0 ? new Date(state.lastScan).toISOString() : 'never',
        scans_completed: state.scansCompleted,
        signals_found: state.signalsFound,
        trades_executed: state.tradesExecuted,
        active_positions: state.activePositions.length,
        total_pnl: `$${state.totalPnl.toFixed(2)}`,
      },
      positions: state.activePositions.map(p => ({
        symbol: p.symbol,
        side: p.side,
        entry: `$${p.entryPrice.toFixed(4)}`,
        size: `$${p.size}`,
        leverage: `${p.leverage}x`,
        stop_loss: `$${p.stopLoss.toFixed(4)}`,
        take_profit: `$${p.takeProfit.toFixed(4)}`,
        entry_time: new Date(p.entryTime).toISOString(),
        signal_score: p.signalScore.toFixed(2),
      })),
    },
    null,
    2,
  );
}

function handleUpdateStrategyConfig(updates: any): string {
  if (!strategyEngine) {
    return JSON.stringify({ error: 'No strategy running' });
  }

  strategyEngine.updateConfig(updates);

  return JSON.stringify({
    success: true,
    message: 'Config updated',
    updates,
  });
}

async function handleCloseStrategyPosition(symbol: string): Promise<string> {
  if (!strategyEngine) {
    return JSON.stringify({ error: 'No strategy running' });
  }

  const result = await strategyEngine.closePosition(symbol);

  return JSON.stringify(result);
}

// ==================== SPOT TOOL HANDLERS ====================

async function handleGetSpotMarketData(
  type: string,
  symbol?: string,
  limit?: number,
): Promise<string> {
  switch (type) {
    case 'price': {
      const res = await asterSpot.getPrice(symbol);
      if (!res.success) return JSON.stringify({ error: res.error });
      if (Array.isArray(res.data)) {
        // Multiple prices - show top by symbol
        const sorted = res.data.sort((a: any, b: any) => a.symbol.localeCompare(b.symbol));
        return JSON.stringify(
          {
            type: 'spot_prices',
            count: sorted.length,
            prices: sorted.slice(0, limit || 20).map((p: any) => ({
              symbol: p.symbol,
              price: p.price,
            })),
          },
          null,
          2,
        );
      }
      return JSON.stringify({ symbol: res.data.symbol, price: res.data.price }, null, 2);
    }

    case 'ticker': {
      const res = await asterSpot.getTicker24h(symbol);
      if (!res.success) return JSON.stringify({ error: res.error });
      if (Array.isArray(res.data)) {
        // Sort by volume descending
        const sorted = res.data.sort(
          (a: any, b: any) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume),
        );
        return JSON.stringify(
          {
            type: 'spot_24h_tickers',
            count: sorted.length,
            tickers: sorted.slice(0, limit || 15).map((t: any) => ({
              symbol: t.symbol,
              price: t.lastPrice,
              change_pct: `${parseFloat(t.priceChangePercent).toFixed(2)}%`,
              volume_usd: `$${(parseFloat(t.quoteVolume) / 1000).toFixed(0)}k`,
              high: t.highPrice,
              low: t.lowPrice,
            })),
          },
          null,
          2,
        );
      }
      return JSON.stringify(
        {
          symbol: res.data.symbol,
          price: res.data.lastPrice,
          change_pct: `${parseFloat(res.data.priceChangePercent).toFixed(2)}%`,
          volume_usd: `$${(parseFloat(res.data.quoteVolume) / 1000).toFixed(0)}k`,
          high: res.data.highPrice,
          low: res.data.lowPrice,
          open: res.data.openPrice,
          trades: res.data.count,
        },
        null,
        2,
      );
    }

    case 'orderbook': {
      if (!symbol) return JSON.stringify({ error: 'Symbol required for orderbook' });
      const res = await asterSpot.getOrderbook(symbol, limit || 20);
      if (!res.success) return JSON.stringify({ error: res.error });
      return JSON.stringify(
        {
          symbol,
          bids: res.data.bids?.slice(0, 10).map((b: any) => ({ price: b[0], qty: b[1] })),
          asks: res.data.asks?.slice(0, 10).map((a: any) => ({ price: a[0], qty: a[1] })),
          spread:
            res.data.asks?.[0] && res.data.bids?.[0]
              ? `${(((parseFloat(res.data.asks[0][0]) - parseFloat(res.data.bids[0][0])) / parseFloat(res.data.bids[0][0])) * 100).toFixed(4)}%`
              : 'N/A',
        },
        null,
        2,
      );
    }

    case 'book_ticker': {
      const res = await asterSpot.getBookTicker(symbol);
      if (!res.success) return JSON.stringify({ error: res.error });
      if (Array.isArray(res.data)) {
        return JSON.stringify(
          {
            type: 'spot_book_tickers',
            count: res.data.length,
            tickers: res.data.slice(0, limit || 20).map((t: any) => ({
              symbol: t.symbol,
              bid: t.bidPrice,
              bid_qty: t.bidQty,
              ask: t.askPrice,
              ask_qty: t.askQty,
            })),
          },
          null,
          2,
        );
      }
      return JSON.stringify(
        {
          symbol: res.data.symbol,
          bid: res.data.bidPrice,
          bid_qty: res.data.bidQty,
          ask: res.data.askPrice,
          ask_qty: res.data.askQty,
        },
        null,
        2,
      );
    }

    case 'pairs': {
      const res = await asterSpot.getPairs();
      if (!res.success) return JSON.stringify({ error: res.error });
      return JSON.stringify(
        {
          type: 'spot_pairs',
          count: res.data?.length || 0,
          pairs: res.data,
        },
        null,
        2,
      );
    }

    case 'exchange_info': {
      const res = await asterSpot.getExchangeInfo();
      if (!res.success) return JSON.stringify({ error: res.error });
      const symbols = res.data.symbols || [];
      return JSON.stringify(
        {
          type: 'spot_exchange_info',
          total_symbols: symbols.length,
          symbols: symbols.slice(0, limit || 20).map((s: any) => ({
            symbol: s.symbol,
            base: s.baseAsset,
            quote: s.quoteAsset,
            status: s.status,
            min_qty: s.filters?.find((f: any) => f.filterType === 'LOT_SIZE')?.minQty,
            min_notional: s.filters?.find((f: any) => f.filterType === 'MIN_NOTIONAL')?.minNotional,
          })),
        },
        null,
        2,
      );
    }

    default:
      return JSON.stringify({ error: `Unknown spot market data type: ${type}` });
  }
}

async function handleGetSpotKlines(
  symbol: string,
  interval?: string,
  limit?: number,
): Promise<string> {
  const res = await asterSpot.getKlines(symbol, interval || '1h', limit || 100);
  if (!res.success) return JSON.stringify({ error: res.error });

  const klines = res.data || [];
  return JSON.stringify(
    {
      symbol,
      interval: interval || '1h',
      count: klines.length,
      candles: klines.slice(-20).map((k: any) => ({
        time: new Date(k[0]).toISOString(),
        open: k[1],
        high: k[2],
        low: k[3],
        close: k[4],
        volume: k[5],
        quote_volume: k[7],
      })),
    },
    null,
    2,
  );
}

async function handleGetSpotTrades(symbol: string, limit?: number): Promise<string> {
  const res = await asterSpot.getTrades(symbol, limit || 100);
  if (!res.success) return JSON.stringify({ error: res.error });

  const trades = res.data || [];
  return JSON.stringify(
    {
      symbol,
      count: trades.length,
      recent: trades.slice(-20).map((t: any) => ({
        price: t.price,
        qty: t.qty,
        quote_qty: t.quoteQty,
        time: new Date(t.time).toISOString(),
        buyer_maker: t.isBuyerMaker,
      })),
    },
    null,
    2,
  );
}

async function handleGetSpotAccount(
  type: string,
  symbol?: string,
  orderId?: number,
  limit?: number,
): Promise<string> {
  if (!tradingEnabled) {
    return JSON.stringify({ error: 'Trading not enabled. Set credentials first.' });
  }

  switch (type) {
    case 'balances': {
      const res = await asterSpot.getBalances();
      if (!res.success) return JSON.stringify({ error: res.error });
      return JSON.stringify(
        {
          type: 'spot_balances',
          balances: res.data?.map((b: any) => ({
            asset: b.asset,
            free: b.free,
            locked: b.locked,
            total: (parseFloat(b.free) + parseFloat(b.locked)).toFixed(8),
          })),
        },
        null,
        2,
      );
    }

    case 'open_orders': {
      const res = await asterSpot.getOpenOrders(symbol);
      if (!res.success) return JSON.stringify({ error: res.error });
      return JSON.stringify(
        {
          type: 'spot_open_orders',
          count: res.data?.length || 0,
          orders: res.data?.map((o: any) => ({
            symbol: o.symbol,
            order_id: o.orderId,
            side: o.side,
            type: o.type,
            price: o.price,
            qty: o.origQty,
            filled: o.executedQty,
            status: o.status,
            time: new Date(o.time).toISOString(),
          })),
        },
        null,
        2,
      );
    }

    case 'all_orders': {
      if (!symbol) return JSON.stringify({ error: 'Symbol required for order history' });
      const res = await asterSpot.getAllOrders(symbol, limit || 100);
      if (!res.success) return JSON.stringify({ error: res.error });
      return JSON.stringify(
        {
          type: 'spot_order_history',
          symbol,
          count: res.data?.length || 0,
          orders: res.data?.slice(-20).map((o: any) => ({
            order_id: o.orderId,
            side: o.side,
            type: o.type,
            price: o.price,
            qty: o.origQty,
            filled: o.executedQty,
            status: o.status,
            time: new Date(o.time).toISOString(),
          })),
        },
        null,
        2,
      );
    }

    case 'order_status': {
      if (!symbol || !orderId) return JSON.stringify({ error: 'Symbol and order_id required' });
      const res = await asterSpot.getOrder(symbol, orderId);
      if (!res.success) return JSON.stringify({ error: res.error });
      return JSON.stringify(
        {
          type: 'spot_order_status',
          order: {
            symbol: res.data?.symbol,
            order_id: res.data?.orderId,
            side: res.data?.side,
            type: res.data?.type,
            price: res.data?.price,
            qty: res.data?.origQty,
            filled: res.data?.executedQty,
            status: res.data?.status,
            time: res.data?.time ? new Date(res.data.time).toISOString() : undefined,
          },
        },
        null,
        2,
      );
    }

    case 'trades': {
      if (!symbol) return JSON.stringify({ error: 'Symbol required for trade history' });
      const res = await asterSpot.getUserTrades(symbol, limit || 100);
      if (!res.success) return JSON.stringify({ error: res.error });
      return JSON.stringify(
        {
          type: 'spot_trade_history',
          symbol,
          count: res.data?.length || 0,
          trades: res.data?.slice(-20).map((t: any) => ({
            trade_id: t.id,
            order_id: t.orderId,
            price: t.price,
            qty: t.qty,
            quote_qty: t.quoteQty,
            commission: t.commission,
            commission_asset: t.commissionAsset,
            time: new Date(t.time).toISOString(),
            buyer: t.isBuyer,
            maker: t.isMaker,
          })),
        },
        null,
        2,
      );
    }

    default:
      return JSON.stringify({ error: `Unknown spot account type: ${type}` });
  }
}

async function handleExecuteSpotOrder(
  action: string,
  symbol: string,
  amount: number,
  price?: number,
  timeInForce?: string,
): Promise<string> {
  if (!tradingEnabled) {
    return JSON.stringify({ error: 'Trading not enabled. Set credentials first.' });
  }

  let res;
  switch (action) {
    case 'market_buy':
      res = await asterSpot.marketBuy(symbol, amount);
      break;
    case 'market_sell':
      res = await asterSpot.marketSell(symbol, amount);
      break;
    case 'limit_buy':
      if (!price) return JSON.stringify({ error: 'Price required for limit order' });
      res = await asterSpot.limitOrder(symbol, 'BUY', price, amount, (timeInForce as any) || 'GTC');
      break;
    case 'limit_sell':
      if (!price) return JSON.stringify({ error: 'Price required for limit order' });
      res = await asterSpot.limitOrder(
        symbol,
        'SELL',
        price,
        amount,
        (timeInForce as any) || 'GTC',
      );
      break;
    default:
      return JSON.stringify({ error: `Unknown order action: ${action}` });
  }

  if (!res.success) return JSON.stringify({ error: res.error });

  return JSON.stringify(
    {
      success: true,
      action,
      order: {
        symbol: res.data?.symbol,
        order_id: res.data?.orderId,
        client_order_id: res.data?.clientOrderId,
        side: res.data?.side,
        type: res.data?.type,
        price: res.data?.price,
        qty: res.data?.origQty,
        filled: res.data?.executedQty,
        status: res.data?.status,
      },
    },
    null,
    2,
  );
}

async function handleCancelSpotOrder(
  action: string,
  symbol: string,
  orderId?: number,
): Promise<string> {
  if (!tradingEnabled) {
    return JSON.stringify({ error: 'Trading not enabled. Set credentials first.' });
  }

  let res;
  if (action === 'single') {
    if (!orderId) return JSON.stringify({ error: 'Order ID required for single cancel' });
    res = await asterSpot.cancelOrder(symbol, orderId);
  } else if (action === 'all') {
    res = await asterSpot.cancelAllOrders(symbol);
  } else {
    return JSON.stringify({ error: `Unknown cancel action: ${action}` });
  }

  if (!res.success) return JSON.stringify({ error: res.error });

  return JSON.stringify(
    {
      success: true,
      action: action === 'single' ? 'order_cancelled' : 'all_orders_cancelled',
      symbol,
      result: res.data,
    },
    null,
    2,
  );
}

async function handleSpotTransfer(
  direction: string,
  asset: string,
  amount: number,
): Promise<string> {
  if (!tradingEnabled) {
    return JSON.stringify({ error: 'Trading not enabled. Set credentials first.' });
  }

  let res;
  if (direction === 'spot_to_perp') {
    res = await asterSpot.transferToPerp(asset, amount);
  } else if (direction === 'perp_to_spot') {
    res = await asterSpot.transferToSpot(asset, amount);
  } else {
    return JSON.stringify({ error: `Unknown transfer direction: ${direction}` });
  }

  if (!res.success) return JSON.stringify({ error: res.error });

  return JSON.stringify(
    {
      success: true,
      direction,
      asset,
      amount,
      transaction_id: res.data?.tranId,
    },
    null,
    2,
  );
}

// ==================== CRYPTO BASE SCANNER (CBS) HANDLERS ====================

async function handleGetCBSSignals(
  algorithm?: string,
  limit?: number,
  minVolumeUsd?: number,
  minSuccessRate?: number,
): Promise<string> {
  if (!cbsClient.isConfigured()) {
    return JSON.stringify({
      error: 'CBS API key not configured',
      hint: 'Set CBS_API_KEY in .env to use Crypto Base Scanner features',
    });
  }

  const algo = (algorithm || 'original') as CBSAlgorithm;
  const maxResults = Math.min(limit || 15, 50);
  const minVol = minVolumeUsd || 1000;
  const minSuccess = minSuccessRate || 60;

  const res = await cbsClient.getCrackedBases(algo);
  if (!res.success) return JSON.stringify({ error: res.error });

  // Process and score signals
  const signals = (res.data || [])
    .map((m: any) => {
      const stats = m.marketStats?.find((s: any) => s.algorithm === algo);
      const successRate = parseFloat(stats?.ratio || '0');
      const medianBounce = parseFloat(stats?.medianBounce || '0');
      const volume = parseFloat(m.usdVolume || '0');
      // Score = success rate * bounce potential (weighted)
      const score = successRate * (1 + medianBounce / 20);

      return {
        symbol: `${m.baseCurrency}${m.quoteCurrency}`.toUpperCase(),
        exch: m.exchangeCode,
        price: m.currentPrice,
        drop: m.latestBase?.current_drop || 'N/A',
        bounce: stats?.medianBounce || 'N/A',
        success: stats?.ratio || 'N/A',
        hrs: stats?.hoursToRespected || 'N/A',
        vol: Math.round(volume),
        score: Math.round(score * 10) / 10,
        isLowest: m.latestBase?.isLowest || false,
      };
    })
    .filter((s: any) => s.vol >= minVol && parseFloat(s.success) >= minSuccess)
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, maxResults);

  const totalFound = (res.data || []).length;

  return JSON.stringify(
    {
      type: 'cbs_signals',
      algorithm: algo,
      showing: signals.length,
      total_available: totalFound,
      filters: { min_volume: minVol, min_success: minSuccess },
      signals,
    },
    null,
    2,
  );
}

async function handleGetCBSMarkets(
  algorithm?: string,
  exchange?: string,
  maxDrop?: number,
  limit?: number,
): Promise<string> {
  if (!cbsClient.isConfigured()) {
    return JSON.stringify({
      error: 'CBS API key not configured',
      hint: 'Set CBS_API_KEY in .env to use Crypto Base Scanner features',
    });
  }

  const algo = (algorithm || 'original') as CBSAlgorithm;
  const exch = (exchange || 'BINA') as CBSExchange;
  const drop = maxDrop || -10;
  const maxResults = Math.min(limit || 15, 50);

  const res = await cbsClient.getMarketsNearBase(exch, algo, drop);
  if (!res.success) return JSON.stringify({ error: res.error });

  // Compact format, sorted by proximity to base
  const markets = (res.data || []).slice(0, maxResults).map((m: any) => ({
    symbol: m.symbol,
    drop: m.currentDrop,
    base: m.basePrice,
    success: m.successRate,
    bounce: m.medianBounce,
  }));

  return JSON.stringify(
    {
      type: 'cbs_markets_near_base',
      algorithm: algo,
      exchange: exch,
      filter: `Within ${Math.abs(drop)}% of base`,
      showing: markets.length,
      markets,
    },
    null,
    2,
  );
}

async function handleCBSQuickScan(
  timeframe?: string,
  exchange?: string,
  limit?: number,
): Promise<string> {
  if (!cbsClient.isConfigured()) {
    return JSON.stringify({
      error: 'CBS API key not configured',
      hint: 'Set CBS_API_KEY in .env to use Crypto Base Scanner features',
    });
  }

  const tf = (timeframe || '15') as CBSTimeframe;
  const exch = (exchange || 'BINA') as CBSExchange;
  const maxResults = Math.min(limit || 15, 50);

  const res = await cbsClient.quickScan(exch, tf);
  if (!res.success) return JSON.stringify({ error: res.error });

  // Compact format sorted by biggest drops
  const drops = (res.data || [])
    .map((m: any) => ({
      symbol: `${m.baseCurrency}${m.quoteCurrency}`.toUpperCase(),
      drop: m.drop,
      price: m.lastPrice,
      fatFinger: m.fatFinger,
      vol: Math.round(parseFloat(m.usdVolume || '0')),
    }))
    .sort((a: any, b: any) => parseFloat(a.drop) - parseFloat(b.drop))
    .slice(0, maxResults);

  return JSON.stringify(
    {
      type: 'cbs_quick_scan',
      timeframe: `${tf} minutes`,
      exchange: exch,
      description: `Recent price drops in last ${tf} minutes`,
      count: drops.length,
      drops,
    },
    null,
    2,
  );
}

async function handleCompareCBSAlgorithms(symbol: string, exchange?: string): Promise<string> {
  if (!cbsClient.isConfigured()) {
    return JSON.stringify({
      error: 'CBS API key not configured',
      hint: 'Set CBS_API_KEY in .env to use Crypto Base Scanner features',
    });
  }

  const exch = (exchange || 'BINA') as CBSExchange;
  const res = await cbsClient.compareAlgorithms(symbol, exch);
  if (!res.success) return JSON.stringify({ error: res.error });

  return JSON.stringify(
    {
      type: 'cbs_algorithm_comparison',
      symbol: symbol.toUpperCase(),
      exchange: exch,
      description: 'How each algorithm views this symbol',
      algorithms: res.data?.algorithms || {},
      interpretation: {
        original: 'Standard QFL - balanced approach',
        day_trade: 'Quick scalps - tighter parameters, faster recoveries',
        conservative: 'Strict filters - higher success rate, fewer signals',
        position: 'Longer holds - deeper bases, bigger bounces expected',
      },
    },
    null,
    2,
  );
}

// ==================== MARKET REGIME DETECTION ====================

/**
 * Compact regime block for embedding in scan outputs.
 * Calls the cached singleton — costs nothing if called within the 30s TTL.
 */
async function getCompactRegimeBlock(): Promise<Record<string, unknown>> {
  try {
    const state = await getRegimeDetector().evaluate();
    return {
      regime: state.regime,
      confidence: state.confidence,
      confidence_band:
        state.confidence >= 75 ? 'HIGH' : state.confidence >= 60 ? 'MODERATE' : 'LOW',
      suggested_direction: state.suggested_direction,
      tradeable: state.suggested_direction !== 'none' && state.confidence >= 55,
      risk_flags: {
        panic: state.panic_active,
        crash_recovery: state.crash_recovery,
      },
      btc_1h_change_pct: +state.macro.btc.change_1h.toFixed(2),
      recency_s: Math.round((Date.now() - state.macro.timestamp.getTime()) / 1000),
    };
  } catch (err) {
    // Regime fetch failed — don't break the scan, just flag it
    return { regime: 'unknown', error: 'regime_fetch_failed' };
  }
}

/**
 * Get current BTC market regime with confidence score and reasoning
 * Uses EMA crossovers and RSI momentum from Binance data
 */
async function handleGetMarketRegime(
  reset: boolean,
  format: 'formatted' | 'raw' = 'formatted',
): Promise<string> {
  const detector = getRegimeDetector();

  if (reset) {
    detector.reset();
  }

  const state = await detector.evaluate();

  // Raw format: return RegimeState exactly as-is from evaluate()
  if (format === 'raw') {
    return JSON.stringify(state, null, 2);
  }

  // Format output with trading context
  const regimeEmoji = state.regime === 'bullish' ? '🟢' : state.regime === 'bearish' ? '🔴' : '⚪';
  const directionEmoji =
    state.suggested_direction === 'long'
      ? '📈'
      : state.suggested_direction === 'short'
        ? '📉'
        : '⏸️';

  return JSON.stringify(
    {
      regime: {
        current: state.regime,
        emoji: regimeEmoji,
        confidence: state.confidence,
        confidence_label:
          state.confidence >= 75 ? 'HIGH' : state.confidence >= 60 ? 'MODERATE' : 'LOW',
      },
      direction: {
        suggested: state.suggested_direction,
        emoji: directionEmoji,
        tradeable: state.suggested_direction !== 'none',
      },
      stability: {
        ticks_in_regime: state.ticks_in_regime,
        regime_changed: state.regime_changed,
        previous_regime: state.previous_regime,
        is_stable: state.ticks_in_regime >= 3,
      },
      risk_flags: {
        panic_active: state.panic_active,
        crash_recovery: state.crash_recovery,
        any_flags: state.panic_active || state.crash_recovery,
      },
      btc_macro: {
        price: state.macro.btc.price.toFixed(2),
        change_1h: `${state.macro.btc.change_1h >= 0 ? '+' : ''}${state.macro.btc.change_1h.toFixed(2)}%`,
        change_4h: `${state.macro.btc.change_4h >= 0 ? '+' : ''}${state.macro.btc.change_4h.toFixed(2)}%`,
        change_24h: `${state.macro.btc.change_24h >= 0 ? '+' : ''}${state.macro.btc.change_24h.toFixed(2)}%`,
        ema_21_1h: state.macro.btc.ema_21_1h.toFixed(2),
        ema_45_1h: state.macro.btc.ema_45_1h.toFixed(2),
        ema_spread_pct: `${state.macro.btc.ema_spread_pct >= 0 ? '+' : ''}${state.macro.btc.ema_spread_pct.toFixed(3)}%`,
        rsi_15m: state.macro.btc.rsi_15m.toFixed(1),
        rsi_1h: state.macro.btc.rsi_1h.toFixed(1),
      },
      reasoning: state.reasoning,
      trading_guidance: {
        long_bias: state.regime === 'bullish' && state.confidence >= 60,
        short_bias: state.regime === 'bearish' && state.confidence >= 60,
        reduce_size: state.crash_recovery || state.confidence < 60 || state.ticks_in_regime < 3,
        avoid_entry: state.panic_active || state.regime === 'neutral',
        message: state.panic_active
          ? '🚨 PANIC MODE - Avoid new entries, consider reducing exposure'
          : state.crash_recovery
            ? '⚠️ Crash recovery - Trade smaller, wait for stability'
            : state.regime === 'neutral'
              ? '⏸️ Mixed signals - Wait for regime clarity before trading'
              : state.confidence >= 75
                ? `✅ High confidence ${state.regime} regime - Trade with conviction`
                : state.confidence >= 60
                  ? `📊 Moderate ${state.regime} bias - Trade with normal sizing`
                  : `⚠️ Low confidence - Reduce size or wait`,
      },
      timestamp: state.macro.timestamp,
    },
    null,
    2,
  );
}

// ==================== BINANCE CROSS-EXCHANGE HANDLERS ====================

/**
 * Get Binance sentiment data: L/S ratios and taker flow
 * This is the "smart money" indicator - Binance moves first
 */
async function handleGetBinanceSentiment(
  symbol: string,
  period: '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '12h' | '1d' = '1h',
  limit: number = 12,
): Promise<string> {
  const sym = symbol.toUpperCase();

  // Fetch all three sentiment indicators in parallel
  const [topLsRes, globalLsRes, takerRes] = await Promise.all([
    binanceClient.getTopLongShortRatio(sym, period, limit),
    binanceClient.getGlobalLongShortRatio(sym, period, limit),
    binanceClient.getTakerBuySellVolume(sym, period, limit),
  ]);

  if (!topLsRes.success && !globalLsRes.success && !takerRes.success) {
    const sampleError = topLsRes.error || globalLsRes.error || takerRes.error || 'Unknown';
    return JSON.stringify({
      error: `Failed to fetch Binance data for ${sym}. ${sampleError}`,
    });
  }

  // Process top trader L/S ratio
  const topLsData = topLsRes.data || [];
  const latestTopLs = topLsData[topLsData.length - 1];
  const topLsTrend =
    topLsData.length >= 2
      ? parseFloat(topLsData[topLsData.length - 1]?.longShortRatio) -
        parseFloat(topLsData[0]?.longShortRatio)
      : 0;

  // Process global L/S ratio
  const globalLsData = globalLsRes.data || [];
  const latestGlobalLs = globalLsData[globalLsData.length - 1];
  const globalLsTrend =
    globalLsData.length >= 2
      ? parseFloat(globalLsData[globalLsData.length - 1]?.longShortRatio) -
        parseFloat(globalLsData[0]?.longShortRatio)
      : 0;

  // Process taker buy/sell volume
  const takerData = takerRes.data || [];
  const latestTaker = takerData[takerData.length - 1];
  const totalBuySell = takerData.reduce(
    (acc: { buy: number; sell: number }, t: any) => {
      acc.buy += parseFloat(t.buyVol || 0);
      acc.sell += parseFloat(t.sellVol || 0);
      return acc;
    },
    { buy: 0, sell: 0 },
  );

  // Calculate sentiment scores
  const topLsRatio = latestTopLs ? parseFloat(latestTopLs.longShortRatio) : null;
  const globalLsRatio = latestGlobalLs ? parseFloat(latestGlobalLs.longShortRatio) : null;
  const takerRatio = latestTaker ? parseFloat(latestTaker.buySellRatio) : null;

  // Interpret sentiment
  let sentiment = 'NEUTRAL';
  let interpretation: string[] = [];

  if (topLsRatio !== null) {
    if (topLsRatio > 1.5) {
      interpretation.push(`Top traders heavily LONG (${topLsRatio.toFixed(2)}:1)`);
      sentiment = 'BULLISH';
    } else if (topLsRatio < 0.67) {
      interpretation.push(`Top traders heavily SHORT (1:${(1 / topLsRatio).toFixed(2)})`);
      sentiment = 'BEARISH';
    } else {
      interpretation.push(`Top traders balanced (${topLsRatio.toFixed(2)}:1)`);
    }
  }

  if (takerRatio !== null) {
    if (takerRatio > 1.2) {
      interpretation.push(`Aggressive buying (taker ratio ${takerRatio.toFixed(2)})`);
      if (sentiment !== 'BEARISH') sentiment = 'BULLISH';
    } else if (takerRatio < 0.83) {
      interpretation.push(`Aggressive selling (taker ratio ${takerRatio.toFixed(2)})`);
      if (sentiment !== 'BULLISH') sentiment = 'BEARISH';
    }
  }

  if (topLsTrend > 0.1) interpretation.push('Top trader longs INCREASING');
  else if (topLsTrend < -0.1) interpretation.push('Top trader longs DECREASING');

  return JSON.stringify(
    {
      symbol: sym,
      exchange: 'BINANCE',
      period,
      timestamp: new Date().toISOString(),
      overall_sentiment: sentiment,
      top_traders: {
        current_ls_ratio: topLsRatio?.toFixed(3) || 'N/A',
        trend: topLsTrend > 0 ? `+${topLsTrend.toFixed(3)}` : topLsTrend.toFixed(3),
        trend_direction:
          topLsTrend > 0.05 ? 'MORE_LONG' : topLsTrend < -0.05 ? 'MORE_SHORT' : 'STABLE',
        long_pct: latestTopLs
          ? `${(parseFloat(latestTopLs.longAccount) * 100).toFixed(1)}%`
          : 'N/A',
      },
      global_accounts: {
        current_ls_ratio: globalLsRatio?.toFixed(3) || 'N/A',
        trend: globalLsTrend > 0 ? `+${globalLsTrend.toFixed(3)}` : globalLsTrend.toFixed(3),
      },
      taker_flow: {
        current_buy_sell_ratio: takerRatio?.toFixed(3) || 'N/A',
        period_buy_volume: totalBuySell.buy.toFixed(0),
        period_sell_volume: totalBuySell.sell.toFixed(0),
        net_flow: totalBuySell.buy > totalBuySell.sell ? 'NET_BUYING' : 'NET_SELLING',
        net_pct:
          (
            ((totalBuySell.buy - totalBuySell.sell) / (totalBuySell.buy + totalBuySell.sell)) *
            100
          ).toFixed(1) + '%',
      },
      interpretation,
      warning:
        sentiment === 'BULLISH' && topLsRatio && topLsRatio > 2
          ? 'CROWDED LONG - potential squeeze risk'
          : sentiment === 'BEARISH' && topLsRatio && topLsRatio < 0.5
            ? 'CROWDED SHORT - potential squeeze risk'
            : undefined,
    },
    null,
    2,
  );
}

/**
 * Compare volume/OI between Aster and Binance
 */
async function handleCompareExchangeVolume(symbol: string): Promise<string> {
  const sym = symbol.toUpperCase();

  // Fetch from both exchanges in parallel
  const [asterTicker, binanceTicker, asterOi, binanceOi, asterFunding, binanceFunding] =
    await Promise.all([
      asterClient.getTicker24h(sym),
      binanceClient.getTicker24h(sym),
      asterClient.getOpenInterest(sym),
      binanceClient.getOpenInterest(sym),
      asterClient.getPremiumIndex(sym),
      binanceClient.getPremiumIndex(sym),
    ]);

  // Handle array vs single object responses (API returns array when no symbol, object when symbol specified)
  const asterDataRaw = asterTicker.success ? asterTicker.data : null;
  const binanceDataRaw = binanceTicker.success ? binanceTicker.data : null;
  const asterData = asterDataRaw && !Array.isArray(asterDataRaw) ? asterDataRaw : null;
  const binanceData = binanceDataRaw && !Array.isArray(binanceDataRaw) ? binanceDataRaw : null;

  if (!asterData && !binanceData) {
    return JSON.stringify({ error: `${sym} not found on either exchange` });
  }

  const asterVol = asterData
    ? parseFloat((asterData as any).quoteVolume || (asterData as any).volume || '0')
    : 0;
  const binanceVol = binanceData ? parseFloat((binanceData as any).quoteVolume || '0') : 0;
  const volumeRatio = asterVol > 0 ? binanceVol / asterVol : Infinity;

  const asterOiVal =
    asterOi.success && asterOi.data ? parseFloat((asterOi.data as any).openInterest || '0') : 0;
  const binanceOiVal =
    binanceOi.success && binanceOi.data
      ? parseFloat((binanceOi.data as any).openInterest || '0')
      : 0;

  // Use lastFundingRate (Aster uses same field names as Binance)
  const asterFundingRaw =
    asterFunding.success && asterFunding.data && !Array.isArray(asterFunding.data)
      ? asterFunding.data
      : null;
  const binanceFundingRaw =
    binanceFunding.success && binanceFunding.data && !Array.isArray(binanceFunding.data)
      ? binanceFunding.data
      : null;
  const asterFundingRate = asterFundingRaw
    ? parseFloat((asterFundingRaw as any).lastFundingRate || '0')
    : 0;
  const binanceFundingRate = binanceFundingRaw
    ? parseFloat((binanceFundingRaw as any).lastFundingRate || '0')
    : 0;

  // Determine which exchange is leading
  let leader = 'NEITHER';
  let interpretation: string[] = [];

  if (volumeRatio > 50) {
    leader = 'BINANCE';
    interpretation.push(`Binance has ${volumeRatio.toFixed(0)}x more volume - Aster may lag`);
    interpretation.push('Watch Binance for early signals, execute on Aster');
  } else if (volumeRatio > 10) {
    interpretation.push(`Binance has ${volumeRatio.toFixed(1)}x more volume`);
  } else if (volumeRatio < 2) {
    interpretation.push('Volume relatively balanced between exchanges');
  }

  // Funding arb check
  const fundingSpread = (binanceFundingRate - asterFundingRate) * 100;
  if (Math.abs(fundingSpread) > 0.05) {
    interpretation.push(
      fundingSpread > 0
        ? `Funding arb: Long Aster (${(asterFundingRate * 100).toFixed(3)}%), Short Binance (${(binanceFundingRate * 100).toFixed(3)}%)`
        : `Funding arb: Long Binance (${(binanceFundingRate * 100).toFixed(3)}%), Short Aster (${(asterFundingRate * 100).toFixed(3)}%)`,
    );
  }

  const asterPrice = asterData ? (asterData as any).lastPrice : null;
  const binancePrice = binanceData ? (binanceData as any).lastPrice : null;
  const asterChangePercent = asterData ? (asterData as any).priceChangePercent : null;
  const binanceChangePercent = binanceData ? (binanceData as any).priceChangePercent : null;

  return JSON.stringify(
    {
      symbol: sym,
      timestamp: new Date().toISOString(),
      aster: {
        price: asterPrice || 'N/A',
        volume_24h_usd:
          asterVol > 1e6 ? `$${(asterVol / 1e6).toFixed(2)}M` : `$${asterVol.toFixed(0)}`,
        open_interest:
          asterOiVal > 1e6 ? `$${(asterOiVal / 1e6).toFixed(2)}M` : `$${asterOiVal.toFixed(0)}`,
        funding_rate: `${(asterFundingRate * 100).toFixed(4)}%`,
        price_change_24h: asterChangePercent
          ? `${parseFloat(asterChangePercent).toFixed(2)}%`
          : 'N/A',
      },
      binance: {
        price: binancePrice || 'N/A',
        volume_24h_usd:
          binanceVol > 1e6 ? `$${(binanceVol / 1e6).toFixed(2)}M` : `$${binanceVol.toFixed(0)}`,
        open_interest:
          binanceOiVal > 1e6
            ? `$${(binanceOiVal / 1e6).toFixed(2)}M`
            : `$${binanceOiVal.toFixed(0)}`,
        funding_rate: `${(binanceFundingRate * 100).toFixed(4)}%`,
        price_change_24h: binanceChangePercent
          ? `${parseFloat(binanceChangePercent).toFixed(2)}%`
          : 'N/A',
      },
      comparison: {
        volume_ratio:
          volumeRatio === Infinity ? 'Aster has no volume' : `${volumeRatio.toFixed(1)}x`,
        leader: leader,
        funding_spread_bps: (fundingSpread * 100).toFixed(1),
        price_diff_pct:
          asterPrice && binancePrice
            ? `${(((parseFloat(binancePrice) - parseFloat(asterPrice)) / parseFloat(asterPrice)) * 100).toFixed(3)}%`
            : 'N/A',
      },
      interpretation,
    },
    null,
    2,
  );
}

/**
 * Get Binance OI history
 */
async function handleGetBinanceOiHistory(
  symbol: string,
  period: '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '12h' | '1d' = '1h',
  limit: number = 24,
): Promise<string> {
  const sym = symbol.toUpperCase();

  const [oiRes, klinesRes] = await Promise.all([
    binanceClient.getOpenInterestHist(sym, period, limit),
    binanceClient.getKlines(sym, period === '1d' ? '1d' : '1h', Math.min(limit, 24)),
  ]);

  if (!oiRes.success || !oiRes.data) {
    return JSON.stringify({ error: `Failed to fetch OI history for ${sym}` });
  }

  const oiData = oiRes.data;
  const firstOi = parseFloat(oiData[0]?.sumOpenInterest || '0');
  const lastOi = parseFloat(oiData[oiData.length - 1]?.sumOpenInterest || '0');
  const oiChange = firstOi > 0 ? ((lastOi - firstOi) / firstOi) * 100 : 0;

  // Get price change over same period
  const klines = klinesRes.data || [];
  const firstPrice = klines.length > 0 ? parseFloat(klines[0].close) : 0;
  const lastPrice = klines.length > 0 ? parseFloat(klines[klines.length - 1].close) : 0;
  const priceChange = firstPrice > 0 ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0;

  // Interpret OI + Price relationship
  let interpretation: string;
  let signal: string;

  if (oiChange > 5 && priceChange > 2) {
    interpretation = 'Rising OI + Rising Price = New longs entering, trend confirmation';
    signal = 'BULLISH_CONFIRMED';
  } else if (oiChange > 5 && priceChange < -2) {
    interpretation = 'Rising OI + Falling Price = New shorts entering, bearish pressure';
    signal = 'SHORT_ACCUMULATION';
  } else if (oiChange < -5 && priceChange > 2) {
    interpretation = 'Falling OI + Rising Price = Short covering rally, may be weak';
    signal = 'SHORT_COVERING';
  } else if (oiChange < -5 && priceChange < -2) {
    interpretation = 'Falling OI + Falling Price = Long liquidations, capitulation';
    signal = 'LONG_LIQUIDATION';
  } else {
    interpretation = 'OI and price relatively stable';
    signal = 'NEUTRAL';
  }

  return JSON.stringify(
    {
      symbol: sym,
      exchange: 'BINANCE',
      period,
      data_points: oiData.length,
      timestamp: new Date().toISOString(),
      summary: {
        oi_start:
          firstOi > 1e9 ? `$${(firstOi / 1e9).toFixed(2)}B` : `$${(firstOi / 1e6).toFixed(2)}M`,
        oi_end: lastOi > 1e9 ? `$${(lastOi / 1e9).toFixed(2)}B` : `$${(lastOi / 1e6).toFixed(2)}M`,
        oi_change_pct: `${oiChange > 0 ? '+' : ''}${oiChange.toFixed(2)}%`,
        price_change_pct: `${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}%`,
      },
      signal,
      interpretation,
      recent_data: oiData.slice(-5).map((d: any) => ({
        time: new Date(d.timestamp).toISOString(),
        oi: `$${(parseFloat(d.sumOpenInterest) / 1e6).toFixed(2)}M`,
        oi_value: `$${(parseFloat(d.sumOpenInterestValue) / 1e6).toFixed(2)}M`,
      })),
    },
    null,
    2,
  );
}

/**
 * Get Binance funding rate
 */
async function handleGetBinanceFunding(symbol?: string): Promise<string> {
  const res = await binanceClient.getPremiumIndex(symbol?.toUpperCase());

  if (!res.success || !res.data) {
    return JSON.stringify({ error: 'Failed to fetch Binance funding data' });
  }

  const data = Array.isArray(res.data) ? res.data : [res.data];

  // Sort by absolute funding rate
  const sorted = data
    .map((d: any) => ({
      symbol: d.symbol,
      mark_price: d.markPrice,
      index_price: d.indexPrice,
      funding_rate: parseFloat(d.lastFundingRate),
      funding_pct: `${(parseFloat(d.lastFundingRate) * 100).toFixed(4)}%`,
      daily_cost: `${(parseFloat(d.lastFundingRate) * 100 * 3).toFixed(3)}%`,
      next_funding: new Date(d.nextFundingTime).toISOString(),
      direction: parseFloat(d.lastFundingRate) > 0 ? 'LONGS_PAY' : 'SHORTS_PAY',
    }))
    .sort((a: any, b: any) => Math.abs(b.funding_rate) - Math.abs(a.funding_rate));

  if (symbol) {
    return JSON.stringify(sorted[0] || { error: `${symbol} not found` }, null, 2);
  }

  // Return top positive and negative
  const topPositive = sorted.filter((d: any) => d.funding_rate > 0).slice(0, 10);
  const topNegative = sorted.filter((d: any) => d.funding_rate < 0).slice(0, 10);

  return JSON.stringify(
    {
      exchange: 'BINANCE',
      timestamp: new Date().toISOString(),
      top_longs_pay: topPositive.map((d: any) => ({
        symbol: d.symbol,
        rate: d.funding_pct,
        daily: d.daily_cost,
      })),
      top_shorts_pay: topNegative.map((d: any) => ({
        symbol: d.symbol,
        rate: d.funding_pct,
        daily: d.daily_cost,
      })),
    },
    null,
    2,
  );
}

/**
 * Scan for divergences between Aster and Binance
 */
async function handleScanExchangeDivergence(
  minVolumeRatio: number = 10,
  limit: number = 15,
): Promise<string> {
  // Get symbols from both exchanges
  const [asterSymbols, binanceSymbols] = await Promise.all([
    asterClient.getExchangeInfo(),
    binanceClient.getSymbols(),
  ]);

  if (!asterSymbols.success || !binanceSymbols.success) {
    return JSON.stringify({ error: 'Failed to fetch exchange symbols' });
  }

  const asterSyms = new Set(
    asterSymbols.data?.symbols
      ?.filter((s: any) => s.status === 'TRADING')
      .map((s: any) => s.symbol) || [],
  );
  const binanceSyms = new Set(binanceSymbols.data || []);

  // Find common symbols
  const commonSymbols = [...asterSyms].filter(s => binanceSyms.has(s));

  // Sample a subset to avoid rate limits (check top 50 by likely volume)
  const prioritySymbols = [
    'BTCUSDT',
    'ETHUSDT',
    'BNBUSDT',
    'SOLUSDT',
    'XRPUSDT',
    'DOGEUSDT',
    'AVAXUSDT',
    'LINKUSDT',
    'ADAUSDT',
    'DOTUSDT',
  ];
  const symbolsToCheck = [
    ...prioritySymbols.filter(s => commonSymbols.includes(s)),
    ...commonSymbols.filter(s => !prioritySymbols.includes(s)).slice(0, 40),
  ].slice(0, 30);

  // Fetch tickers from both exchanges
  const [asterTickers, binanceTickers] = await Promise.all([
    asterClient.getTicker24h(),
    binanceClient.getTicker24h(),
  ]);

  if (!asterTickers.success || !binanceTickers.success) {
    return JSON.stringify({ error: 'Failed to fetch tickers' });
  }

  const asterTickerMap = new Map<string, any>();
  const binanceTickerMap = new Map<string, any>();

  ((asterTickers.data as any[]) || []).forEach((t: any) => asterTickerMap.set(t.symbol, t));
  ((binanceTickers.data as any[]) || []).forEach((t: any) => binanceTickerMap.set(t.symbol, t));

  // Calculate divergences
  const divergences: any[] = [];

  for (const sym of symbolsToCheck) {
    const aster = asterTickerMap.get(sym);
    const binance = binanceTickerMap.get(sym);

    if (!aster || !binance) continue;

    const asterVol = parseFloat(aster.quoteVolume || '0');
    const binanceVol = parseFloat(binance.quoteVolume || '0');

    if (asterVol === 0) continue;

    const volumeRatio = binanceVol / asterVol;
    const priceDiff = Math.abs(
      ((parseFloat(binance.lastPrice) - parseFloat(aster.lastPrice)) /
        parseFloat(aster.lastPrice)) *
        100,
    );

    if (volumeRatio >= minVolumeRatio || priceDiff > 0.5) {
      divergences.push({
        symbol: sym,
        aster_volume:
          asterVol > 1e6 ? `$${(asterVol / 1e6).toFixed(2)}M` : `$${asterVol.toFixed(0)}`,
        binance_volume:
          binanceVol > 1e6 ? `$${(binanceVol / 1e6).toFixed(2)}M` : `$${binanceVol.toFixed(0)}`,
        volume_ratio: volumeRatio.toFixed(1) + 'x',
        price_diff_pct: priceDiff.toFixed(3) + '%',
        aster_change: parseFloat(aster.priceChangePercent).toFixed(2) + '%',
        binance_change: parseFloat(binance.priceChangePercent).toFixed(2) + '%',
        interpretation:
          volumeRatio > 50
            ? 'BINANCE_DOMINANT - Watch Binance for signals'
            : volumeRatio > 20
              ? 'BINANCE_LEADING - Aster may follow'
              : 'MODERATE_DIFFERENCE',
      });
    }
  }

  // Sort by volume ratio
  divergences.sort((a, b) => parseFloat(b.volume_ratio) - parseFloat(a.volume_ratio));

  return JSON.stringify(
    {
      scan_time: new Date().toISOString(),
      common_symbols: commonSymbols.length,
      checked: symbolsToCheck.length,
      min_volume_ratio: minVolumeRatio,
      divergences: divergences.slice(0, limit),
      insight:
        divergences.length > 0
          ? `Found ${divergences.length} pairs with significant Binance/Aster divergence. Use Binance as leading indicator for these.`
          : 'No significant divergences found at current threshold.',
    },
    null,
    2,
  );
}

// --- 50. scan_accumulation ---
// Detect early accumulation/distribution using Binance as PRIMARY data source
// Uses LEADING indicators: OI changes, funding velocity, smart money positioning
async function handleScanAccumulation(
  minScore: number = 20, // Lowered from 40 - most real signals score 15-35
  limit: number = 15,
  lookbackHours: number = 24,
  mode: 'long' | 'short' | 'both' = 'both',
): Promise<string> {
  console.error(
    `[Accumulation Scanner] Using Binance as primary data source for leading indicators...`,
  );

  // Step 1: Get tradeable pairs from Aster (what we can actually trade)
  const asterInfo = await asterClient.getExchangeInfo();
  if (!asterInfo.success || !asterInfo.data?.symbols) {
    return JSON.stringify({ error: 'Failed to fetch Aster symbols' });
  }

  const tradeablePairs = asterInfo.data.symbols
    .filter((s: any) => s.status === 'TRADING' && s.symbol.endsWith('USDT'))
    .map((s: any) => s.symbol);

  console.error(`[Accumulation Scanner] ${tradeablePairs.length} tradeable Aster pairs found`);

  // Step 2: Get Aster funding rates for cross-exchange comparison
  const asterFundingRes = await asterClient.getPremiumIndex();
  const asterFundingMap = new Map<string, number>();
  if (asterFundingRes.success && asterFundingRes.data) {
    const asterFunding = Array.isArray(asterFundingRes.data)
      ? asterFundingRes.data
      : [asterFundingRes.data];
    for (const f of asterFunding) {
      asterFundingMap.set(f.symbol, parseFloat(f.lastFundingRate || '0'));
    }
  }

  // Step 3: Get Binance symbols to find overlap
  const binanceSymbolsRes = await binanceClient.getSymbols();
  if (!binanceSymbolsRes.success || !binanceSymbolsRes.data) {
    return JSON.stringify({ error: 'Failed to fetch Binance symbols' });
  }
  const binanceSymbols = new Set(binanceSymbolsRes.data);

  // Find pairs available on BOTH exchanges (can trade on Aster, analyze on Binance)
  const analysisSymbols = tradeablePairs.filter((s: string) => binanceSymbols.has(s));
  console.error(
    `[Accumulation Scanner] ${analysisSymbols.length} pairs available on both exchanges`,
  );

  // Step 4: Get Binance funding and 24h tickers for context
  const [binanceFundingRes, binanceTickersRes, asterTickersRes] = await Promise.all([
    binanceClient.getPremiumIndex(),
    binanceClient.getTicker24h(),
    asterClient.getTicker24h(),
  ]);

  const binanceFundingMap = new Map<string, any>();
  const binanceTickerMap = new Map<string, any>();
  const asterTickerMap = new Map<string, any>();

  if (binanceFundingRes.success && binanceFundingRes.data) {
    const data = Array.isArray(binanceFundingRes.data)
      ? binanceFundingRes.data
      : [binanceFundingRes.data];
    for (const f of data) {
      binanceFundingMap.set(f.symbol, f);
    }
  }

  if (binanceTickersRes.success && binanceTickersRes.data) {
    const data = Array.isArray(binanceTickersRes.data)
      ? binanceTickersRes.data
      : [binanceTickersRes.data];
    for (const t of data) binanceTickerMap.set(t.symbol, t);
  }

  if (asterTickersRes.success && asterTickersRes.data) {
    const data = Array.isArray(asterTickersRes.data)
      ? asterTickersRes.data
      : [asterTickersRes.data];
    for (const t of data) asterTickerMap.set(t.symbol, t);
  }

  // Step 5: Analyze each symbol with Binance's LEADING indicators
  interface AccumulationSignal {
    symbol: string;
    score: number;
    bias: 'BULLISH' | 'BEARISH';
    price: number;
    price_change_24h: number;
    // Leading indicators from Binance
    oi_change_pct: number;
    oi_trend: string;
    funding_binance: number;
    funding_aster: number;
    funding_divergence: number;
    funding_velocity: string;
    top_trader_ls_ratio: number;
    taker_buy_ratio: number;
    // Interpretation
    signal_type: string;
    interpretation: string;
    components: { [key: string]: number };
  }

  const signals: AccumulationSignal[] = [];
  const period = lookbackHours <= 6 ? '15m' : lookbackHours <= 24 ? '1h' : '4h';
  const dataPoints =
    lookbackHours <= 6
      ? Math.ceil(lookbackHours * 4)
      : lookbackHours <= 24
        ? lookbackHours
        : Math.ceil(lookbackHours / 4);

  // Process in batches to respect rate limits
  // No cap - scan ALL available pairs for comprehensive coverage
  const BATCH_SIZE = 5;
  for (let i = 0; i < analysisSymbols.length; i += BATCH_SIZE) {
    const batch = analysisSymbols.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map(async (symbol: string) => {
        try {
          // Fetch all Binance leading indicators in parallel
          const [oiHistRes, topLSRes, takerVolRes] = await Promise.all([
            binanceClient.getOpenInterestHist(symbol, period as any, Math.min(dataPoints, 30)),
            binanceClient.getTopLongShortRatio(symbol, period as any, Math.min(dataPoints, 30)),
            binanceClient.getTakerBuySellVolume(symbol, period as any, Math.min(dataPoints, 30)),
          ]);

          // Get current data
          const binanceTicker = binanceTickerMap.get(symbol);
          const asterTicker = asterTickerMap.get(symbol);
          const binanceFunding = binanceFundingMap.get(symbol);
          const asterFunding = asterFundingMap.get(symbol) || 0;

          if (!binanceTicker) return null;

          const price = parseFloat(binanceTicker.lastPrice);
          const priceChange = parseFloat(binanceTicker.priceChangePercent);

          // Calculate OI change from history
          let oiChangePct = 0;
          let oiTrend = 'FLAT';
          if (oiHistRes.success && oiHistRes.data && oiHistRes.data.length >= 2) {
            const oiData = oiHistRes.data;
            const oldestOI = parseFloat(
              oiData[0].sumOpenInterestValue || oiData[0].sumOpenInterest || '0',
            );
            const latestOI = parseFloat(
              oiData[oiData.length - 1].sumOpenInterestValue ||
                oiData[oiData.length - 1].sumOpenInterest ||
                '0',
            );
            if (oldestOI > 0) {
              oiChangePct = ((latestOI - oldestOI) / oldestOI) * 100;
              oiTrend = oiChangePct > 5 ? 'RISING' : oiChangePct < -5 ? 'FALLING' : 'FLAT';
            }
          }

          // Calculate top trader positioning
          let topTraderLSRatio = 1;
          if (topLSRes.success && topLSRes.data && topLSRes.data.length > 0) {
            const latest = topLSRes.data[topLSRes.data.length - 1];
            topTraderLSRatio = parseFloat(latest.longShortRatio || '1');
          }

          // Calculate taker buy ratio (aggressive buying vs selling)
          let takerBuyRatio = 0.5;
          if (takerVolRes.success && takerVolRes.data && takerVolRes.data.length > 0) {
            const recentTaker = takerVolRes.data.slice(-6);
            const totalBuyVol = recentTaker.reduce(
              (s: number, d: any) => s + parseFloat(d.buyVol || '0'),
              0,
            );
            const totalSellVol = recentTaker.reduce(
              (s: number, d: any) => s + parseFloat(d.sellVol || '0'),
              0,
            );
            const totalVol = totalBuyVol + totalSellVol;
            takerBuyRatio = totalVol > 0 ? totalBuyVol / totalVol : 0.5;
          }

          // Calculate funding divergence (Aster vs Binance)
          const binanceFundingRate = binanceFunding
            ? parseFloat(binanceFunding.lastFundingRate || '0')
            : 0;
          const fundingDivergence = (asterFunding - binanceFundingRate) * 10000; // in bps

          // Calculate funding velocity (is it accelerating?)
          let fundingVelocity = 'STABLE';
          // We'll infer this from the current funding vs neutral
          if (Math.abs(binanceFundingRate) > 0.001) {
            fundingVelocity = binanceFundingRate > 0 ? 'SHORTS_PAYING' : 'LONGS_PAYING';
          }

          // Score each component (0-25 each, total 100)
          const components: { [key: string]: number } = {};

          // 1. OI/Price Divergence Score (max 30)
          // OI rising + price flat = accumulation (bullish)
          // OI falling + price rising = weak rally (bearish)
          let oiScore = 0;
          let signalType = 'NEUTRAL';
          let interpretation = '';

          if (oiChangePct > 5 && Math.abs(priceChange) < 3) {
            // OI rising, price flat = ACCUMULATION
            oiScore = Math.min(30, oiChangePct * 2);
            signalType = 'ACCUMULATION';
            interpretation = 'Smart money building positions while price stable';
          } else if (oiChangePct > 10 && priceChange < -3) {
            // OI rising, price falling = SHORT BUILD
            oiScore = Math.min(30, oiChangePct * 1.5);
            signalType = 'SHORT_BUILD';
            interpretation = 'Shorts accumulating, bearish setup';
          } else if (oiChangePct < -5 && priceChange > 3) {
            // OI falling, price rising = WEAK RALLY (short covering)
            oiScore = Math.min(25, Math.abs(oiChangePct) * 1.5);
            signalType = 'WEAK_RALLY';
            interpretation = 'Short covering rally, may reverse';
          } else if (oiChangePct < -10 && priceChange < -5) {
            // OI falling, price falling = CAPITULATION
            oiScore = Math.min(30, Math.abs(oiChangePct) * 1.5);
            signalType = 'CAPITULATION';
            interpretation = 'Longs capitulating, potential bottom';
          } else if (oiChangePct > 5 && priceChange > 5) {
            // OI rising with price = trend confirmation (but watch for crowding)
            oiScore = Math.min(20, oiChangePct);
            signalType = 'TREND_CONFIRMATION';
            interpretation = 'Healthy trend with position building';
          }
          components['oi_divergence'] = oiScore;

          // 2. Funding Divergence Score (max 25)
          // Large divergence between Aster and Binance = opportunity
          let fundingScore = 0;
          if (Math.abs(fundingDivergence) > 15) {
            // >0.15% divergence (lowered from 50bps)
            fundingScore = Math.min(25, Math.abs(fundingDivergence) / 2);
            if (fundingDivergence < -15) {
              interpretation += '. Aster funding lower than Binance - potential long opportunity';
            } else if (fundingDivergence > 15) {
              interpretation += '. Aster funding higher than Binance - potential short opportunity';
            }
          }
          // Also score for extreme funding on EITHER exchange
          const maxFunding = Math.max(Math.abs(binanceFundingRate), Math.abs(asterFunding));
          if (maxFunding > 0.003) {
            // >0.3% funding is notable
            fundingScore += Math.min(10, maxFunding * 1000);
            interpretation +=
              maxFunding > 0.01 ? '. EXTREME funding rate!' : '. Elevated funding rate';
          }
          components['funding_divergence'] = fundingScore;

          // 3. Smart Money Score (max 25)
          // Top traders positioning differently from price
          let smartMoneyScore = 0;
          if (topTraderLSRatio > 2 && priceChange < 0) {
            // Whales long while price dropping = accumulation
            smartMoneyScore = Math.min(25, (topTraderLSRatio - 1) * 15);
            interpretation += '. Whales accumulating during dip';
          } else if (topTraderLSRatio < 0.5 && priceChange > 0) {
            // Whales short while price rising = distribution
            smartMoneyScore = Math.min(25, (1 - topTraderLSRatio) * 25);
            interpretation += '. Whales distributing into rally';
          }
          components['smart_money'] = smartMoneyScore;

          // 4. Taker Flow Score (max 20)
          // Aggressive buying/selling (lowered thresholds from 60/40 to 54/46)
          let takerScore = 0;
          if (takerBuyRatio > 0.54) {
            takerScore = Math.min(20, (takerBuyRatio - 0.5) * 50);
            interpretation +=
              takerBuyRatio > 0.6 ? '. Strong aggressive buying' : '. Buyers in control';
          } else if (takerBuyRatio < 0.46) {
            takerScore = Math.min(20, (0.5 - takerBuyRatio) * 50);
            interpretation +=
              takerBuyRatio < 0.4 ? '. Strong aggressive selling' : '. Sellers in control';
          }
          components['taker_flow'] = takerScore;

          // Determine bias based on signal type
          const bullishTypes = ['ACCUMULATION', 'CAPITULATION', 'TREND_CONFIRMATION'];
          const bearishTypes = ['SHORT_BUILD', 'WEAK_RALLY'];
          let bias: 'BULLISH' | 'BEARISH' = bullishTypes.includes(signalType)
            ? 'BULLISH'
            : bearishTypes.includes(signalType)
              ? 'BEARISH'
              : takerBuyRatio > 0.5
                ? 'BULLISH'
                : 'BEARISH';

          // Adjust score direction based on mode
          let totalScore = oiScore + fundingScore + smartMoneyScore + takerScore;

          // For short mode, invert bullish signals
          if (mode === 'short' && bias === 'BULLISH') {
            totalScore = Math.max(0, 50 - totalScore); // Reduce bullish scores in short mode
          } else if (mode === 'long' && bias === 'BEARISH') {
            totalScore = Math.max(0, 50 - totalScore); // Reduce bearish scores in long mode
          }

          if (totalScore < minScore) return null;
          if (mode === 'long' && bias === 'BEARISH') return null;
          if (mode === 'short' && bias === 'BULLISH') return null;

          return {
            symbol,
            score: Math.round(totalScore),
            bias,
            price,
            price_change_24h: +priceChange.toFixed(2),
            oi_change_pct: +oiChangePct.toFixed(2),
            oi_trend: oiTrend,
            funding_binance: +(binanceFundingRate * 100).toFixed(4),
            funding_aster: +(asterFunding * 100).toFixed(4),
            funding_divergence: +fundingDivergence.toFixed(1),
            funding_velocity: fundingVelocity,
            top_trader_ls_ratio: +topTraderLSRatio.toFixed(2),
            taker_buy_ratio: +(takerBuyRatio * 100).toFixed(1),
            signal_type: signalType,
            interpretation: interpretation.trim() || 'No strong leading signals detected',
            components,
          } as AccumulationSignal;
        } catch (err) {
          console.error(`[Accumulation] Error analyzing ${symbol}:`, err);
          return null;
        }
      }),
    );

    for (const r of results) {
      if (r) signals.push(r);
    }
  }

  // Sort by score
  signals.sort((a, b) => b.score - a.score);

  // Categorize
  const bullish = signals.filter(s => s.bias === 'BULLISH');
  const bearish = signals.filter(s => s.bias === 'BEARISH');

  const regimeBlock = await getCompactRegimeBlock();
  return JSON.stringify(
    {
      market_regime: regimeBlock,
      scan_time: new Date().toISOString(),
      data_source: 'BINANCE_PRIMARY',
      methodology:
        'Leading indicators: OI history, funding velocity, smart money positioning, taker flow',
      mode,
      lookback_hours: lookbackHours,
      min_score: minScore,
      pairs_analyzed: analysisSymbols.length,
      signals_found: signals.length,
      summary: {
        bullish_setups: bullish.length,
        bearish_setups: bearish.length,
        signal_types: {
          accumulation: signals.filter(s => s.signal_type === 'ACCUMULATION').length,
          short_build: signals.filter(s => s.signal_type === 'SHORT_BUILD').length,
          weak_rally: signals.filter(s => s.signal_type === 'WEAK_RALLY').length,
          capitulation: signals.filter(s => s.signal_type === 'CAPITULATION').length,
          trend_confirmation: signals.filter(s => s.signal_type === 'TREND_CONFIRMATION').length,
        },
      },
      top_signals: signals.slice(0, limit).map(s => ({
        symbol: s.symbol,
        score: s.score,
        bias: s.bias,
        signal_type: s.signal_type,
        price: s.price,
        price_chg: `${s.price_change_24h >= 0 ? '+' : ''}${s.price_change_24h}%`,
        oi_chg: `${s.oi_change_pct >= 0 ? '+' : ''}${s.oi_change_pct}%`,
        oi_trend: s.oi_trend,
        funding_binance: `${s.funding_binance}%`,
        funding_aster: `${s.funding_aster}%`,
        funding_div: `${s.funding_divergence > 0 ? '+' : ''}${s.funding_divergence}bps`,
        top_trader_ls: s.top_trader_ls_ratio,
        taker_buy_pct: `${s.taker_buy_ratio}%`,
        interpretation: s.interpretation,
        score_breakdown: s.components,
      })),
      insight:
        signals.length > 0
          ? `Found ${signals.length} pairs with leading indicator signals. Top pick: ${signals[0]?.symbol} (${signals[0]?.signal_type}, score ${signals[0]?.score})`
          : 'No strong accumulation/distribution signals detected at current threshold.',
    },
    null,
    2,
  );
}

// --- 51. scan_funding_extremes ---
// Find extreme funding rates for squeeze potential
async function handleScanFundingExtremes(
  minFundingBps: number = 50,
  limit: number = 15,
  includeBinanceComparison: boolean = true,
): Promise<string> {
  console.error(
    `[Funding Extremes] Scanning for extreme funding rates (min ${minFundingBps}bps)...`,
  );

  // Get Aster funding rates
  const asterFundingRes = await asterClient.getPremiumIndex();
  if (!asterFundingRes.success || !asterFundingRes.data) {
    return JSON.stringify({ error: 'Failed to fetch Aster funding rates' });
  }

  const asterFunding = Array.isArray(asterFundingRes.data)
    ? asterFundingRes.data
    : [asterFundingRes.data];

  // Get Binance funding for comparison if requested
  let binanceFundingMap = new Map<string, any>();
  if (includeBinanceComparison) {
    const binanceFundingRes = await binanceClient.getPremiumIndex();
    if (binanceFundingRes.success && binanceFundingRes.data) {
      const data = Array.isArray(binanceFundingRes.data)
        ? binanceFundingRes.data
        : [binanceFundingRes.data];
      for (const f of data) {
        binanceFundingMap.set(f.symbol, f);
      }
    }
  }

  interface FundingExtreme {
    symbol: string;
    aster_funding_pct: number;
    aster_funding_bps: number;
    binance_funding_pct: number | null;
    divergence_bps: number | null;
    direction: 'LONGS_PAYING' | 'SHORTS_PAYING';
    squeeze_potential: 'HIGH' | 'MEDIUM' | 'LOW';
    interpretation: string;
    mark_price: number;
    next_funding_time: string;
  }

  const extremes: FundingExtreme[] = [];
  const minRate = minFundingBps / 10000; // Convert bps to decimal

  for (const f of asterFunding) {
    const rate = parseFloat(f.lastFundingRate || '0');
    const absRate = Math.abs(rate);

    if (absRate < minRate) continue;

    const direction = rate > 0 ? 'LONGS_PAYING' : 'SHORTS_PAYING';
    const binanceData = binanceFundingMap.get(f.symbol);
    const binanceRate = binanceData ? parseFloat(binanceData.lastFundingRate || '0') : null;
    const divergence = binanceRate !== null ? (rate - binanceRate) * 10000 : null;

    // Determine squeeze potential
    let squeezePotential: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
    let interpretation = '';

    if (absRate > 0.01) {
      // >1%
      squeezePotential = 'HIGH';
      interpretation =
        direction === 'LONGS_PAYING'
          ? 'Extreme positive funding - longs heavily paying. Short squeeze unlikely, but long squeeze if price drops.'
          : 'Extreme negative funding - shorts heavily paying. Long squeeze unlikely, but short squeeze if price rises.';
    } else if (absRate > 0.005) {
      // >0.5%
      squeezePotential = 'MEDIUM';
      interpretation =
        direction === 'LONGS_PAYING'
          ? 'High positive funding - consider shorting or wait for long capitulation.'
          : 'High negative funding - consider longing or wait for short capitulation.';
    } else {
      squeezePotential = 'LOW';
      interpretation = 'Moderate funding - no immediate squeeze expected.';
    }

    // Add divergence interpretation
    if (divergence !== null && Math.abs(divergence) > 30) {
      if (divergence > 30) {
        interpretation += ` Aster funding ${divergence.toFixed(0)}bps HIGHER than Binance - potential arbitrage: short Aster, long Binance.`;
      } else if (divergence < -30) {
        interpretation += ` Aster funding ${Math.abs(divergence).toFixed(0)}bps LOWER than Binance - potential arbitrage: long Aster, short Binance.`;
      }
    }

    const nextFundingTime = f.nextFundingTime
      ? new Date(f.nextFundingTime).toISOString()
      : 'unknown';

    extremes.push({
      symbol: f.symbol,
      aster_funding_pct: +(rate * 100).toFixed(4),
      aster_funding_bps: Math.round(rate * 10000),
      binance_funding_pct: binanceRate !== null ? +(binanceRate * 100).toFixed(4) : null,
      divergence_bps: divergence !== null ? Math.round(divergence) : null,
      direction,
      squeeze_potential: squeezePotential,
      interpretation,
      mark_price: parseFloat(f.markPrice || '0'),
      next_funding_time: nextFundingTime,
    });
  }

  // Sort by absolute funding rate (most extreme first)
  extremes.sort((a, b) => Math.abs(b.aster_funding_bps) - Math.abs(a.aster_funding_bps));

  // Categorize
  const longsPaying = extremes.filter(e => e.direction === 'LONGS_PAYING');
  const shortsPaying = extremes.filter(e => e.direction === 'SHORTS_PAYING');
  const highSqueeze = extremes.filter(e => e.squeeze_potential === 'HIGH');

  const regimeBlock = await getCompactRegimeBlock();
  return JSON.stringify(
    {
      market_regime: regimeBlock,
      scan_time: new Date().toISOString(),
      min_funding_bps: minFundingBps,
      pairs_found: extremes.length,
      summary: {
        longs_paying: longsPaying.length,
        shorts_paying: shortsPaying.length,
        high_squeeze_potential: highSqueeze.length,
      },
      longs_paying: longsPaying.slice(0, Math.ceil(limit / 2)).map(e => ({
        symbol: e.symbol,
        funding: `${e.aster_funding_pct}%`,
        funding_bps: e.aster_funding_bps,
        binance_funding: e.binance_funding_pct !== null ? `${e.binance_funding_pct}%` : 'N/A',
        divergence: e.divergence_bps !== null ? `${e.divergence_bps}bps` : 'N/A',
        squeeze: e.squeeze_potential,
        next_funding: e.next_funding_time,
        interpretation: e.interpretation,
      })),
      shorts_paying: shortsPaying.slice(0, Math.ceil(limit / 2)).map(e => ({
        symbol: e.symbol,
        funding: `${e.aster_funding_pct}%`,
        funding_bps: e.aster_funding_bps,
        binance_funding: e.binance_funding_pct !== null ? `${e.binance_funding_pct}%` : 'N/A',
        divergence: e.divergence_bps !== null ? `${e.divergence_bps}bps` : 'N/A',
        squeeze: e.squeeze_potential,
        next_funding: e.next_funding_time,
        interpretation: e.interpretation,
      })),
      insight:
        extremes.length > 0
          ? `Found ${extremes.length} pairs with extreme funding. ${highSqueeze.length} have HIGH squeeze potential. Most extreme: ${extremes[0]?.symbol} at ${extremes[0]?.aster_funding_pct}%`
          : 'No extreme funding rates found at current threshold.',
    },
    null,
    2,
  );
}

// ==================== 52. BINANCE ORACLE SCANNER ====================
// Comprehensive market scan using Binance as truth source for all Aster-tradeable pairs.
// Combines: real OI history, top trader positioning, taker flow, funding, Binance kline taker volume.

async function handleScanBinanceSignals(
  mode: 'long' | 'short' | 'both' = 'both',
  minScore: number = 15,
  limit: number = 20,
  minVolume: number = 500000,
  lookbackHours: number = 24,
  outputFormat: 'json' | 'compact' = 'json',
): Promise<string> {
  const scanStart = Date.now();
  console.error(`[Binance Oracle] Scanning with Binance as primary data source...`);

  // ── Step 1: Symbol Intersection ──
  // Get Aster tradeable symbols and intersect with Binance
  const [asterInfoRes, binanceSymbolsRes] = await Promise.all([
    asterClient.getExchangeInfo(),
    binanceClient.getSymbols(),
  ]);

  if (!asterInfoRes.success || !asterInfoRes.data?.symbols) {
    return JSON.stringify({ error: 'Failed to fetch Aster exchange info' });
  }
  if (!binanceSymbolsRes.success || !binanceSymbolsRes.data) {
    return JSON.stringify({ error: 'Failed to fetch Binance symbols' });
  }

  const asterPairs = asterInfoRes.data.symbols
    .filter((s: any) => s.status === 'TRADING' && s.symbol.endsWith('USDT'))
    .map((s: any) => s.symbol);

  const binanceSymbolSet = new Set(binanceSymbolsRes.data);
  const commonSymbols = asterPairs.filter((s: string) => binanceSymbolSet.has(s));
  console.error(
    `[Binance Oracle] ${asterPairs.length} Aster pairs, ${commonSymbols.length} also on Binance`,
  );

  // ── Step 2: Bulk Pre-filter with Binance Tickers ──
  // These are bulk calls (no per-symbol cost) — get everything at once
  const [binanceTickersRes, binanceFundingRes, asterFundingRes] = await Promise.all([
    binanceClient.getTicker24h(),
    binanceClient.getPremiumIndex(),
    asterClient.getPremiumIndex(),
  ]);

  // Build lookup maps
  const binanceTickerMap = new Map<string, any>();
  const binanceFundingMap = new Map<string, any>();
  const asterFundingMap = new Map<string, number>();

  if (binanceTickersRes.success && binanceTickersRes.data) {
    const data = Array.isArray(binanceTickersRes.data)
      ? binanceTickersRes.data
      : [binanceTickersRes.data];
    for (const t of data) binanceTickerMap.set(t.symbol, t);
  }
  if (binanceFundingRes.success && binanceFundingRes.data) {
    const data = Array.isArray(binanceFundingRes.data)
      ? binanceFundingRes.data
      : [binanceFundingRes.data];
    for (const f of data) binanceFundingMap.set(f.symbol, f);
  }
  if (asterFundingRes.success && asterFundingRes.data) {
    const data = Array.isArray(asterFundingRes.data)
      ? asterFundingRes.data
      : [asterFundingRes.data];
    for (const f of data) asterFundingMap.set(f.symbol, parseFloat(f.lastFundingRate || '0'));
  }

  // Pre-filter: only keep symbols with sufficient Binance volume
  interface PreFilteredSymbol {
    symbol: string;
    price: number;
    priceChange: number;
    volume24h: number;
    binanceFundingRate: number;
    asterFundingRate: number;
  }

  const preFiltered: PreFilteredSymbol[] = [];
  for (const symbol of commonSymbols) {
    const ticker = binanceTickerMap.get(symbol);
    if (!ticker) continue;

    const volume24h = parseFloat(ticker.quoteVolume || '0');
    if (volume24h < minVolume) continue;

    const binanceFunding = binanceFundingMap.get(symbol);
    const binanceFundingRate = binanceFunding
      ? parseFloat(binanceFunding.lastFundingRate || '0')
      : 0;
    const asterFundingRate = asterFundingMap.get(symbol) || 0;

    preFiltered.push({
      symbol,
      price: parseFloat(ticker.lastPrice),
      priceChange: parseFloat(ticker.priceChangePercent),
      volume24h,
      binanceFundingRate,
      asterFundingRate,
    });
  }

  console.error(
    `[Binance Oracle] ${preFiltered.length} pairs pass volume filter (min $${minVolume.toLocaleString()})`,
  );

  // ── Step 3: Deep Enrichment ──
  // Fetch institutional-grade data for each surviving symbol
  // Period selection based on lookback
  const period = lookbackHours <= 6 ? '15m' : lookbackHours <= 24 ? '1h' : '4h';
  const dataPoints =
    lookbackHours <= 6
      ? Math.ceil(lookbackHours * 4)
      : lookbackHours <= 24
        ? lookbackHours
        : Math.ceil(lookbackHours / 4);
  const clampedDataPoints = Math.min(dataPoints, 30);

  interface BinanceSignal {
    symbol: string;
    score: number;
    bias: 'BULLISH' | 'BEARISH';
    tier: 'high_conviction' | 'moderate' | 'speculative';
    price: number;
    price_change_24h: number;
    volume_24h: number;
    // Leading indicators
    oi_change_pct: number;
    oi_trend: string;
    oi_price_divergence: string;
    top_trader_ls_ratio: number;
    top_trader_ls_trend: string;
    global_ls_ratio: number;
    smart_retail_divergence: number;
    taker_buy_ratio: number;
    taker_flow_trend: string;
    cumulative_delta: number;
    funding_binance: number;
    funding_aster: number;
    funding_divergence_bps: number;
    volume_taker_buy_pct: number;
    volume_acceleration: number;
    // Scoring breakdown
    components: { [key: string]: number };
    // Human-readable
    interpretation: string;
    flags: string[];
  }

  const signals: BinanceSignal[] = [];
  const BATCH_SIZE = 5;
  let enrichedCount = 0;

  for (let i = 0; i < preFiltered.length; i += BATCH_SIZE) {
    const batch = preFiltered.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map(async pf => {
        try {
          // Parallel fetch: OI history, top trader L/S, global L/S, taker volume, and Binance klines
          const [oiHistRes, topLSRes, globalLSRes, takerVolRes, klinesRes] = await Promise.all([
            binanceClient.getOpenInterestHist(pf.symbol, period as any, clampedDataPoints),
            binanceClient.getTopLongShortRatio(pf.symbol, period as any, clampedDataPoints),
            binanceClient.getGlobalLongShortRatio(pf.symbol, period as any, clampedDataPoints),
            binanceClient.getTakerBuySellVolume(pf.symbol, period as any, clampedDataPoints),
            binanceClient.getKlines(
              pf.symbol,
              period === '15m' ? '15m' : period === '1h' ? '1h' : '4h',
              clampedDataPoints,
            ),
          ]);

          enrichedCount++;
          const flags: string[] = [];
          const interpretations: string[] = [];

          // ── 3a. OI Analysis ──
          let oiChangePct = 0;
          let oiTrend = 'FLAT';
          let oiPriceDivergence = 'NONE';

          if (oiHistRes.success && oiHistRes.data && oiHistRes.data.length >= 3) {
            const oiData = oiHistRes.data;
            const oldestOI = parseFloat(
              oiData[0].sumOpenInterestValue || oiData[0].sumOpenInterest || '0',
            );
            const latestOI = parseFloat(
              oiData[oiData.length - 1].sumOpenInterestValue ||
                oiData[oiData.length - 1].sumOpenInterest ||
                '0',
            );

            if (oldestOI > 0) {
              oiChangePct = ((latestOI - oldestOI) / oldestOI) * 100;
            }

            // Check OI trend direction (is it accelerating or decelerating?)
            const midIdx = Math.floor(oiData.length / 2);
            const midOI = parseFloat(
              oiData[midIdx].sumOpenInterestValue || oiData[midIdx].sumOpenInterest || '0',
            );
            const firstHalfChange = oldestOI > 0 ? ((midOI - oldestOI) / oldestOI) * 100 : 0;
            const secondHalfChange = midOI > 0 ? ((latestOI - midOI) / midOI) * 100 : 0;

            if (oiChangePct > 5) {
              oiTrend =
                secondHalfChange > firstHalfChange ? 'RISING_ACCELERATING' : 'RISING_DECELERATING';
            } else if (oiChangePct < -5) {
              oiTrend =
                secondHalfChange < firstHalfChange
                  ? 'FALLING_ACCELERATING'
                  : 'FALLING_DECELERATING';
            }

            // Classify OI/Price divergence
            if (oiChangePct > 5 && Math.abs(pf.priceChange) < 3) {
              oiPriceDivergence = 'ACCUMULATION';
              interpretations.push('OI rising while price flat — stealth accumulation');
            } else if (oiChangePct > 10 && pf.priceChange < -3) {
              oiPriceDivergence = 'SHORT_BUILD';
              interpretations.push('OI rising into falling price — short buildup');
            } else if (oiChangePct < -5 && pf.priceChange > 3) {
              oiPriceDivergence = 'WEAK_RALLY';
              interpretations.push(
                'Price rising on declining OI — short covering, not real demand',
              );
              flags.push('WEAK_RALLY');
            } else if (oiChangePct < -10 && pf.priceChange < -5) {
              oiPriceDivergence = 'CAPITULATION';
              interpretations.push('Longs capitulating — potential bottom forming');
            } else if (oiChangePct > 5 && pf.priceChange > 5) {
              oiPriceDivergence = 'TREND_CONFIRM';
              interpretations.push('OI confirming price trend — healthy directional move');
            }
          }

          // ── 3b. Top Trader Positioning ──
          let topTraderLSRatio = 1;
          let topTraderLSTrend = 'FLAT';

          if (topLSRes.success && topLSRes.data && topLSRes.data.length >= 3) {
            const lsData = topLSRes.data;
            const latest = parseFloat(lsData[lsData.length - 1].longShortRatio || '1');
            const oldest = parseFloat(lsData[0].longShortRatio || '1');
            topTraderLSRatio = latest;

            // Trend: are top traders adding or reducing?
            const lsChange = latest - oldest;
            if (lsChange > 0.15) {
              topTraderLSTrend = 'INCREASINGLY_LONG';
              if (pf.priceChange < -2) {
                interpretations.push(
                  `Top traders going long (${latest.toFixed(2)} L/S) despite price drop — smart money accumulating`,
                );
                flags.push('SMART_MONEY_ACCUMULATION');
              }
            } else if (lsChange < -0.15) {
              topTraderLSTrend = 'INCREASINGLY_SHORT';
              if (pf.priceChange > 2) {
                interpretations.push(
                  `Top traders reducing longs (${latest.toFixed(2)} L/S) despite price rise — distribution`,
                );
                flags.push('SMART_MONEY_DISTRIBUTION');
              }
            }

            // Extreme positioning
            if (latest > 2.0) {
              flags.push('TOP_TRADERS_VERY_LONG');
              interpretations.push(
                `Top traders heavily long at ${latest.toFixed(2)} L/S — high conviction bullish`,
              );
            } else if (latest < 0.5) {
              flags.push('TOP_TRADERS_VERY_SHORT');
              interpretations.push(
                `Top traders heavily short at ${latest.toFixed(2)} L/S — high conviction bearish`,
              );
            }
          }

          // ── 3b2. Global L/S Ratio + Smart vs Retail Divergence ──
          let globalLSRatio = 1;
          let smartRetailDivergence = 0;

          if (globalLSRes.success && globalLSRes.data && globalLSRes.data.length >= 1) {
            const latest = globalLSRes.data[globalLSRes.data.length - 1];
            globalLSRatio = parseFloat(latest.longShortRatio || '1');

            // Smart vs retail divergence: positive = smart money more long than retail
            smartRetailDivergence = topTraderLSRatio - globalLSRatio;
            if (smartRetailDivergence > 0.3) {
              flags.push('SMART_MONEY_DIVERGES_LONG');
              interpretations.push(
                `Smart money ${topTraderLSRatio.toFixed(2)} L/S vs retail ${globalLSRatio.toFixed(2)} — smart money significantly more bullish`,
              );
            } else if (smartRetailDivergence < -0.3) {
              flags.push('RETAIL_TRAP_RISK');
              interpretations.push(
                `Retail ${globalLSRatio.toFixed(2)} L/S vs smart money ${topTraderLSRatio.toFixed(2)} — potential retail trap`,
              );
            }
          }

          // ── 3c. Taker Flow Analysis ──
          let takerBuyRatio = 0.5;
          let takerFlowTrend = 'NEUTRAL';

          if (takerVolRes.success && takerVolRes.data && takerVolRes.data.length >= 3) {
            const takerData = takerVolRes.data;
            // Recent window (last 6 periods)
            const recentSlice = takerData.slice(-6);
            const totalBuyVol = recentSlice.reduce(
              (s: number, d: any) => s + parseFloat(d.buyVol || '0'),
              0,
            );
            const totalSellVol = recentSlice.reduce(
              (s: number, d: any) => s + parseFloat(d.sellVol || '0'),
              0,
            );
            const totalVol = totalBuyVol + totalSellVol;
            takerBuyRatio = totalVol > 0 ? totalBuyVol / totalVol : 0.5;

            // Compare recent vs older to detect trend
            const olderSlice = takerData.slice(0, 6);
            const olderBuyVol = olderSlice.reduce(
              (s: number, d: any) => s + parseFloat(d.buyVol || '0'),
              0,
            );
            const olderSellVol = olderSlice.reduce(
              (s: number, d: any) => s + parseFloat(d.sellVol || '0'),
              0,
            );
            const olderTotal = olderBuyVol + olderSellVol;
            const olderBuyRatio = olderTotal > 0 ? olderBuyVol / olderTotal : 0.5;

            const flowShift = takerBuyRatio - olderBuyRatio;
            if (flowShift > 0.05) {
              takerFlowTrend = 'BUYERS_INCREASING';
              interpretations.push('Aggressive buyers accelerating — real demand building');
            } else if (flowShift < -0.05) {
              takerFlowTrend = 'SELLERS_INCREASING';
              interpretations.push('Aggressive sellers accelerating — real selling pressure');
            }

            if (takerBuyRatio > 0.62) {
              flags.push('STRONG_TAKER_BUYING');
            } else if (takerBuyRatio < 0.38) {
              flags.push('STRONG_TAKER_SELLING');
            }
          }

          // ── 3d. Binance Kline Volume Analysis + Cumulative Delta ──
          // Binance klines include takerBuyVolume — directional flow per candle
          let volumeTakerBuyPct = 50;
          let volumeAcceleration = 1;
          let cumulativeDelta = 0; // Running sum of (buyVol - sellVol) — leading indicator

          if (klinesRes.success && klinesRes.data && klinesRes.data.length >= 6) {
            const klines = klinesRes.data;

            // Cumulative delta: sum of (takerBuyQuoteVolume - takerSellQuoteVolume) per candle
            // Positive = net aggressive buying, Negative = net aggressive selling
            for (const k of klines) {
              const buyQuoteVol = parseFloat(k.takerBuyQuoteVolume || '0');
              const totalQuoteVol = parseFloat(k.quoteVolume || '0');
              cumulativeDelta += 2 * buyQuoteVol - totalQuoteVol; // buyVol - sellVol
            }

            // Taker buy % across recent candles - FIXED: Use run-rate for current candle
            const recentKlines = klines.slice(-6);
            const totalKlineVol = recentKlines.reduce((s: number, k: any, idx: number) => {
              const vol = parseFloat(k.volume || '0');
              if (idx === recentKlines.length - 1) {
                return s + calculateProjectedVolume({ t: k.openTime, v: k.volume }, period);
              }
              return s + vol;
            }, 0);
            
            const totalTakerBuyVol = recentKlines.reduce((s: number, k: any, idx: number) => {
              const vol = parseFloat(k.takerBuyVolume || '0');
              if (idx === recentKlines.length - 1) {
                return s + calculateProjectedVolume({ t: k.openTime, v: k.takerBuyVolume }, period);
              }
              return s + vol;
            }, 0);
            
            volumeTakerBuyPct = totalKlineVol > 0 ? (totalTakerBuyVol / totalKlineVol) * 100 : 50;

            // Volume acceleration: recent 6 candles avg vs older 6 candles avg
            // FIXED: use calculateVolumeAcceleration with interval
            const volAccelResult = calculateVolumeAcceleration(klines, period);
            volumeAcceleration = Math.max(1, volAccelResult.acceleration + 1); // Normalize to multiplier

            if (volumeAcceleration > 2.0) {
              flags.push('VOLUME_SURGE');
              interpretations.push(
                `Volume ${volumeAcceleration.toFixed(1)}x recent average — something happening`,
              );
            }

            // Cumulative delta divergence from price
            if (cumulativeDelta > 0 && pf.priceChange < -2) {
              flags.push('DELTA_PRICE_DIVERGENCE_BULLISH');
              interpretations.push('Net buying flow despite price drop — hidden accumulation');
            } else if (cumulativeDelta < 0 && pf.priceChange > 2) {
              flags.push('DELTA_PRICE_DIVERGENCE_BEARISH');
              interpretations.push('Net selling flow despite price rise — hidden distribution');
            }
          }

          // ── Step 4: Scoring Engine ──
          const components: { [key: string]: number } = {};

          // Component 1: OI/Price Divergence (max 30)
          let oiScore = 0;
          if (oiPriceDivergence === 'ACCUMULATION') {
            oiScore = Math.min(30, oiChangePct * 2.5);
          } else if (oiPriceDivergence === 'SHORT_BUILD') {
            oiScore = Math.min(30, oiChangePct * 2);
          } else if (oiPriceDivergence === 'CAPITULATION') {
            // FIX: Capitulation only counts if we see BUYERS entering
            const hasCapitulationBuyback = takerBuyRatio > 0.52 || cumulativeDelta > 0;
            oiScore = hasCapitulationBuyback ? Math.min(25, Math.abs(oiChangePct) * 1.2) : 0;
            if (oiScore > 0) interpretations.push('Capitulation detected with BUYER absorption');
          } else if (oiPriceDivergence === 'WEAK_RALLY') {
            oiScore = Math.min(20, Math.abs(oiChangePct) * 1.2);
          } else if (oiPriceDivergence === 'TREND_CONFIRM') {
            oiScore = Math.min(20, oiChangePct * 1.0);
          }
          // Accelerating OI bonus
          if (oiTrend.includes('ACCELERATING') && oiScore > 0) {
            oiScore = Math.min(30, oiScore * 1.3);
          }
          components['oi_divergence'] = Math.round(oiScore);

          // Component 2: Smart Money (max 25)
          let smartScore = 0;
          // Strong directional positioning
          if (topTraderLSRatio > 1.5) {
            smartScore += Math.min(12, (topTraderLSRatio - 1) * 12);
          } else if (topTraderLSRatio < 0.67) {
            smartScore += Math.min(12, (1 - topTraderLSRatio) * 15);
          }
          
          // NEW: Smart Money "Front-Running" Bonus
          // If Smart-Retail divergence is widening while price is flat/down = 10/10 setup
          const isFrontRunning = Math.abs(smartRetailDivergence) > 0.4 && Math.abs(pf.priceChange) < 2;
          if (isFrontRunning) {
            smartScore += 10;
            flags.push('SMART_MONEY_FRONTRUNNING');
            interpretations.push('Whales front-running retail while price is flat');
          }

          // Positioning diverges from price (smart money is contrarian)
          if (topTraderLSTrend === 'INCREASINGLY_LONG' && pf.priceChange < 0) {
            smartScore += 8; // Buying the dip
          } else if (topTraderLSTrend === 'INCREASINGLY_SHORT' && pf.priceChange > 0) {
            smartScore += 8; // Selling into strength
          }
          // Alignment bonus (positioning confirms direction)
          if (topTraderLSTrend === 'INCREASINGLY_LONG' && pf.priceChange > 0) {
            smartScore += 4;
          } else if (topTraderLSTrend === 'INCREASINGLY_SHORT' && pf.priceChange < 0) {
            smartScore += 4;
          }
          // Smart vs retail divergence bonus — when smart money diverges from retail, that's alpha
          if (Math.abs(smartRetailDivergence) > 0.3) {
            smartScore += Math.min(6, Math.abs(smartRetailDivergence) * 8);
          }
          components['smart_money'] = Math.min(25, Math.round(smartScore));

          // Component 3: Taker Flow (max 25)
          // Only score if outside the dead zone (0.46-0.54 for scoring, 0.48-0.52 for bias)
          let takerScore = 0;
          const takerHasConviction = takerBuyRatio > 0.54 || takerBuyRatio < 0.46;
          // Raw buy/sell ratio — only score with clear directional signal
          if (takerBuyRatio > 0.54) {
            takerScore += Math.min(15, (takerBuyRatio - 0.5) * 75);
          } else if (takerBuyRatio < 0.46) {
            takerScore += Math.min(15, (0.5 - takerBuyRatio) * 75);
          }
          // Flow trend bonus — only if ratio also supports it
          if (takerFlowTrend === 'BUYERS_INCREASING' && takerBuyRatio > 0.5) {
            takerScore += 8;
          } else if (takerFlowTrend === 'SELLERS_INCREASING' && takerBuyRatio < 0.5) {
            takerScore += 8;
          }
          // Kline taker buy confirmation
          if (volumeTakerBuyPct > 55 && takerHasConviction) {
            takerScore += Math.min(5, (volumeTakerBuyPct - 50) * 0.5);
          } else if (volumeTakerBuyPct < 45 && takerHasConviction) {
            takerScore += Math.min(5, (50 - volumeTakerBuyPct) * 0.5);
          }
          components['taker_flow'] = Math.min(25, Math.round(takerScore));

          // Component 4: Funding Signal (max 10)
          let fundingScore = 0;
          const fundingDivBps = (pf.asterFundingRate - pf.binanceFundingRate) * 10000;
          // Cross-exchange funding divergence
          if (Math.abs(fundingDivBps) > 15) {
            fundingScore += Math.min(5, Math.abs(fundingDivBps) / 10);
          }
          // Extreme funding on either exchange
          const maxFunding = Math.max(
            Math.abs(pf.binanceFundingRate),
            Math.abs(pf.asterFundingRate),
          );
          if (maxFunding > 0.003) {
            fundingScore += Math.min(5, maxFunding * 500);
            if (maxFunding > 0.01) {
              flags.push('EXTREME_FUNDING');
              interpretations.push(
                `Extreme funding (${(maxFunding * 100).toFixed(3)}%) — squeeze potential`,
              );
            }
          }
          components['funding'] = Math.min(10, Math.round(fundingScore));

          // Component 5: Volume + Cumulative Delta (max 10)
          let volScore = 0;
          if (volumeAcceleration > 1.5) {
            volScore += Math.min(5, (volumeAcceleration - 1) * 4);
          }
          // Volume + directional taker alignment
          if (volumeAcceleration > 1.3 && (volumeTakerBuyPct > 55 || volumeTakerBuyPct < 45)) {
            volScore += 2; // Volume surge with directional conviction
          }
          // Cumulative delta confirmation (independent leading indicator)
          const absDelta = Math.abs(cumulativeDelta);
          const deltaIsSignificant = absDelta > pf.volume24h * 0.01; // Delta > 1% of daily vol
          if (deltaIsSignificant) {
            volScore += 3;
          }
          components['volume'] = Math.min(10, Math.round(volScore));

          // ── Total Score & Bias ──
          let totalScore = Object.values(components).reduce((a, b) => a + b, 0);

          // Determine bias from the weight of evidence
          let bullishWeight = 0;
          let bearishWeight = 0;

          // OI divergence direction
          if (oiPriceDivergence === 'ACCUMULATION') {
            bullishWeight += oiScore; // Accumulation = bullish regardless of price direction
          } else if (oiPriceDivergence === 'CAPITULATION') {
            // CAPITULATION is NOT categorically bullish — it's a potential bottom, not a confirmed one
            // Only lean bullish if other signals confirm (taker buying, smart money long)
            if (takerBuyRatio > 0.52 || topTraderLSRatio > 1.3) {
              bullishWeight += oiScore * 0.5; // Half weight, needs confirmation
            }
            // Otherwise it's neutral — don't add to either side
          } else if (oiPriceDivergence === 'TREND_CONFIRM' && pf.priceChange >= 0) {
            bullishWeight += oiScore;
          } else if (oiPriceDivergence === 'TREND_CONFIRM' && pf.priceChange < 0) {
            bearishWeight += oiScore;
          }
          if (['SHORT_BUILD', 'WEAK_RALLY'].includes(oiPriceDivergence)) {
            bearishWeight += oiScore;
          }

          // Smart money direction
          if (topTraderLSRatio > 1.2) bullishWeight += smartScore;
          else if (topTraderLSRatio < 0.83) bearishWeight += smartScore;

          // Smart-retail divergence direction
          if (smartRetailDivergence > 0.3)
            bullishWeight += 5; // Smart money more bullish than retail
          else if (smartRetailDivergence < -0.3) bearishWeight += 5; // Retail trap risk

          // Taker flow direction — only if outside dead zone
          if (takerBuyRatio > 0.52 && takerHasConviction) bullishWeight += takerScore;
          else if (takerBuyRatio < 0.48 && takerHasConviction) bearishWeight += takerScore;

          // Cumulative delta direction
          if (cumulativeDelta > 0 && deltaIsSignificant) bullishWeight += 4;
          else if (cumulativeDelta < 0 && deltaIsSignificant) bearishWeight += 4;

          // Kline taker direction
          if (volumeTakerBuyPct > 53) bullishWeight += 2;
          else if (volumeTakerBuyPct < 47) bearishWeight += 2;

          const bias: 'BULLISH' | 'BEARISH' =
            bullishWeight >= bearishWeight ? 'BULLISH' : 'BEARISH';

          // ── Gate Logic: Disqualify Contradictory Signals ──
          // If components disagree strongly, reduce confidence
          let gateReduction = 0;

          // Gate 1: Smart money opposes taker flow
          if (
            (topTraderLSRatio > 1.3 && takerBuyRatio < 0.45) ||
            (topTraderLSRatio < 0.77 && takerBuyRatio > 0.55)
          ) {
            gateReduction += 8;
            flags.push('CONFLICTING_SIGNALS');
          }

          // Gate 2: OI says accumulation but taker flow says selling
          if (oiPriceDivergence === 'ACCUMULATION' && takerBuyRatio < 0.44) {
            gateReduction += 5;
            flags.push('OI_FLOW_MISMATCH');
          }

          // Gate 3: Weak rally flagged — reduce long score
          if (oiPriceDivergence === 'WEAK_RALLY' && bias === 'BULLISH') {
            gateReduction += 10;
          }

          // Gate 4: Funding contradicts bias — crowded trade detection
          if (bias === 'BULLISH' && pf.binanceFundingRate > 0.001 && pf.asterFundingRate > 0.001) {
            gateReduction += 7;
            flags.push('CROWDED_LONG');
          } else if (
            bias === 'BEARISH' &&
            pf.binanceFundingRate < -0.001 &&
            pf.asterFundingRate < -0.001
          ) {
            gateReduction += 7;
            flags.push('CROWDED_SHORT');
          }

          // Gate 5: Volume declining while OI rising — single player, not genuine interest
          if (oiChangePct > 5 && volumeAcceleration < 0.7) {
            gateReduction += 5;
            flags.push('LOW_VOLUME_OI_RISE');
          }

          totalScore = Math.max(0, totalScore - gateReduction);
          if (gateReduction > 0) {
            components['gate_penalty'] = -gateReduction;
          }

          // Mode filtering
          if (mode === 'long' && bias === 'BEARISH') return null;
          if (mode === 'short' && bias === 'BULLISH') return null;
          if (totalScore < minScore) return null;

          // Tier classification
          let tier: 'high_conviction' | 'moderate' | 'speculative';
          const alignedComponents = Object.entries(components).filter(
            ([k, v]) => k !== 'gate_penalty' && v > 0,
          ).length;
          if (
            totalScore >= 45 &&
            alignedComponents >= 4 &&
            !flags.includes('CONFLICTING_SIGNALS')
          ) {
            tier = 'high_conviction';
          } else if (totalScore >= 25 && alignedComponents >= 3) {
            tier = 'moderate';
          } else {
            tier = 'speculative';
          }

          // Build final interpretation
          if (interpretations.length === 0) {
            interpretations.push('Moderate signal — no standout indicators');
          }

          return {
            symbol: pf.symbol,
            score: Math.round(totalScore),
            bias,
            tier,
            price: pf.price,
            price_change_24h: +pf.priceChange.toFixed(2),
            volume_24h: Math.round(pf.volume24h),
            oi_change_pct: +oiChangePct.toFixed(2),
            oi_trend: oiTrend,
            oi_price_divergence: oiPriceDivergence,
            top_trader_ls_ratio: +topTraderLSRatio.toFixed(2),
            top_trader_ls_trend: topTraderLSTrend,
            global_ls_ratio: +globalLSRatio.toFixed(2),
            smart_retail_divergence: +smartRetailDivergence.toFixed(2),
            taker_buy_ratio: +(takerBuyRatio * 100).toFixed(1),
            taker_flow_trend: takerFlowTrend,
            cumulative_delta: Math.round(cumulativeDelta),
            funding_binance: +(pf.binanceFundingRate * 100).toFixed(4),
            funding_aster: +(pf.asterFundingRate * 100).toFixed(4),
            funding_divergence_bps: +fundingDivBps.toFixed(1),
            volume_taker_buy_pct: +volumeTakerBuyPct.toFixed(1),
            volume_acceleration: +volumeAcceleration.toFixed(2),
            components,
            interpretation: interpretations.join('. '),
            flags,
          } as BinanceSignal;
        } catch (err: any) {
          console.error(`[Binance Oracle] Error enriching ${pf.symbol}: ${err.message}`);
          return null;
        }
      }),
    );

    for (const r of results) {
      if (r) signals.push(r);
    }
  }

  // ── Step 5: Sort & Output ──
  signals.sort((a, b) => b.score - a.score);

  const highConviction = signals.filter(s => s.tier === 'high_conviction').slice(0, limit);
  const moderate = signals.filter(s => s.tier === 'moderate').slice(0, limit);
  const speculative = signals.filter(s => s.tier === 'speculative').slice(0, Math.ceil(limit / 2));

  const allSignals = [...highConviction, ...moderate, ...speculative];
  const scanDuration = ((Date.now() - scanStart) / 1000).toFixed(1);

  // Build top picks summary
  const topPick = highConviction[0] || moderate[0] || signals[0];
  const insightParts: string[] = [];
  if (highConviction.length > 0) {
    insightParts.push(`${highConviction.length} high-conviction setups found`);
  }
  if (topPick) {
    insightParts.push(
      `Top pick: ${topPick.symbol} (${topPick.bias}, score ${topPick.score}, ${topPick.tier}) — ${topPick.interpretation.split('.')[0]}`,
    );
  }

  if (outputFormat === 'compact') {
    const compactSignals = allSignals.map(s => ({
      sym: s.symbol,
      score: s.score,
      bias: s.bias[0], // B or S for BULLISH/BEARISH
      tier: s.tier === 'high_conviction' ? 'HC' : s.tier === 'moderate' ? 'MOD' : 'SPEC',
      pChg: `${s.price_change_24h > 0 ? '+' : ''}${s.price_change_24h}%`,
      oiChg: `${s.oi_change_pct > 0 ? '+' : ''}${s.oi_change_pct}%`,
      topLS: s.top_trader_ls_ratio,
      taker: `${s.taker_buy_ratio}%`,
      fDiv: `${s.funding_divergence_bps > 0 ? '+' : ''}${s.funding_divergence_bps}bps`,
      flags: s.flags.join(',') || '-',
      why: s.interpretation.split('.')[0],
    }));

    const compactRegime = await getCompactRegimeBlock();
    return JSON.stringify(
      {
        market_regime: compactRegime,
        scan: 'binance_oracle',
        mode,
        pairs: `${preFiltered.length}/${commonSymbols.length}`,
        signals: compactSignals.length,
        duration: `${scanDuration}s`,
        hc: highConviction.length,
        mod: moderate.length,
        spec: speculative.length,
        results: compactSignals,
        insight: insightParts.join('. ') || 'No signals above threshold.',
      },
      null,
      2,
    );
  }

  const regimeBlock = await getCompactRegimeBlock();
  return JSON.stringify(
    {
      market_regime: regimeBlock,
      scan_type: 'binance_oracle',
      scan_time: new Date().toISOString(),
      data_source: 'BINANCE_PRIMARY',
      execution_venue: 'ASTER',
      methodology:
        'Institutional-grade signals: real OI history, top trader L/S positioning, taker buy/sell flow, funding divergence, Binance kline taker volume',
      config: {
        mode,
        min_score: minScore,
        min_volume: minVolume,
        lookback_hours: lookbackHours,
        period_used: period,
      },
      stats: {
        aster_pairs: asterPairs.length,
        common_with_binance: commonSymbols.length,
        passed_volume_filter: preFiltered.length,
        enriched: enrichedCount,
        signals_found: signals.length,
        scan_duration_sec: parseFloat(scanDuration),
      },
      summary: {
        high_conviction: highConviction.length,
        moderate: moderate.length,
        speculative: speculative.length,
        bullish_total: signals.filter(s => s.bias === 'BULLISH').length,
        bearish_total: signals.filter(s => s.bias === 'BEARISH').length,
      },
      high_conviction: highConviction.map(formatSignalOutput),
      moderate: moderate.map(formatSignalOutput),
      speculative: speculative.map(formatSignalOutput),
      insight:
        insightParts.join('. ') ||
        'No signals found above threshold. Consider lowering min_score or min_volume.',
    },
    null,
    2,
  );
}

function formatSignalOutput(s: any) {
  return {
    symbol: s.symbol,
    score: s.score,
    bias: s.bias,
    tier: s.tier,
    price: s.price,
    price_chg: `${s.price_change_24h >= 0 ? '+' : ''}${s.price_change_24h}%`,
    vol_24h: `$${(s.volume_24h / 1e6).toFixed(1)}M`,
    oi_chg: `${s.oi_change_pct >= 0 ? '+' : ''}${s.oi_change_pct}%`,
    oi_trend: s.oi_trend,
    oi_divergence: s.oi_price_divergence,
    top_trader_ls: s.top_trader_ls_ratio,
    top_trader_trend: s.top_trader_ls_trend,
    global_ls: s.global_ls_ratio,
    smart_vs_retail: s.smart_retail_divergence,
    taker_buy_pct: `${s.taker_buy_ratio}%`,
    taker_trend: s.taker_flow_trend,
    cumulative_delta: s.cumulative_delta,
    funding_binance: `${s.funding_binance}%`,
    funding_aster: `${s.funding_aster}%`,
    funding_div: `${s.funding_divergence_bps > 0 ? '+' : ''}${s.funding_divergence_bps}bps`,
    kline_taker_buy: `${s.volume_taker_buy_pct}%`,
    vol_accel: `${s.volume_acceleration}x`,
    score_breakdown: s.components,
    interpretation: s.interpretation,
    flags: s.flags,
  };
}

// ==================== SERVER SETUP ====================

const server = new Server(
  { name: 'aster-trading-suite', version: '2.10.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args } = request.params;
  try {
    let res = '';
    const a = args as any;

    switch (name) {
      case 'get_market_data':
        res = await handleGetMarketData(a.type, a.symbol, a.limit);
        break;
      case 'get_klines':
        res = await handleGetKlines(a.symbol, a.interval, a.limit);
        break;
      case 'get_recent_trades':
        res = await handleGetRecentTrades(a.symbol, a.limit);
        break;
      case 'scan_markets':
        res = await handleScanMarkets(a.sort_by, a.direction, a.limit, a.min_volume);
        break;
      case 'get_account_info':
        res = await handleGetAccountInfo(a.type, a.symbol, a.limit, a.income_type);
        break;
      case 'execute_order':
        res = await handleExecuteOrder(
          a.action,
          a.symbol,
          a.side,
          a.amount,
          a.price,
          a.leverage,
          a.params,
        );
        break;
      case 'manage_orders':
        res = await handleManageOrders(a.action, a.symbol, a.order_id, a.orders, a.seconds);
        break;
      case 'manage_strategy':
        res = await handleManageStrategy(a.strategy, a.action, a.config);
        break;
      case 'manage_stream':
        res = await handleManageStream(a.action, a.type, a.symbol, a.duration);
        break;
      case 'manage_cache':
        res = handleManageCache(a.action, a.key);
        break;
      case 'manage_credentials':
        res = await handleManageCredentials(a.action, a.api_key, a.api_secret);
        break;
      case 'calculate_position_size':
        res = await handleCalculatePositionSize(
          a.symbol,
          a.risk_percent,
          a.entry_price,
          a.stop_loss_price,
        );
        break;
      case 'get_market_intelligence':
        res = await handleGetMarketIntelligence(a.min_volume);
        break;
      case 'scan_for_pumps':
        res = await handleScanForPumps(
          a.mode || 'long',
          a.volume_multiple || 5,
          a.min_stoch_rsi || 50,
          a.min_mfi || 50,
          a.interval || '15m',
          a.lookback_periods || 96,
          a.limit || 10,
          a.min_volume || 1000,
          a.output_format || 'json',
        );
        break;
      case 'panic_button':
        res = await handlePanicButton(a.confirm);
        break;
      case 'start_strategy':
        res = await handleStartStrategy(a.strategy_type || 'default', a.custom_config);
        break;
      case 'stop_strategy':
        res = await handleStopStrategy(a.close_positions || false);
        break;
      case 'get_strategy_status':
        res = handleGetStrategyStatus();
        break;
      case 'update_strategy_config':
        res = handleUpdateStrategyConfig(a.updates);
        break;
      case 'close_strategy_position':
        res = await handleCloseStrategyPosition(a.symbol);
        break;
      case 'scan_for_pumps_hl':
        res = await handleScanForPumpsHL(
          a.volume_multiple || 5,
          a.min_stoch_rsi || 50,
          a.min_mfi || 50,
          a.interval || '15m',
          a.lookback_periods || 96,
          a.limit || 10,
          a.min_volume || 1000,
        );
        break;
      case 'scan_for_pumps_cross':
        res = await handleScanForPumpsCross(
          a.volume_multiple || 5,
          a.min_stoch_rsi || 50,
          a.min_mfi || 50,
          a.interval || '15m',
          a.lookback_periods || 96,
          a.limit || 15,
          a.min_volume || 1000,
        );
        break;
      case 'vpvr_analysis':
        res = await handleVPVRAnalysis(
          a.symbol,
          a.timeframe || '15m',
          a.periods || 96,
          a.num_bins || 40,
        );
        break;
      case 'vpvr_cross':
        res = await handleVPVRCross(
          a.symbol,
          a.timeframe || '15m',
          a.periods || 96,
          a.num_bins || 30,
        );
        break;
      case 'scan_breakouts':
        res = await handleScanBreakouts(
          a.mode || 'both',
          a.min_score || 30,
          a.limit || 20,
          a.lookback_5m || 144,
          a.output_format || 'json',
        );
        break;
      case 'get_funding_spread':
        res = await handleGetFundingSpread(
          a.min_spread_bps || 10,
          a.limit || 20,
          a.include_single_exchange || false,
        );
        break;
      case 'scan_oi_divergence':
        res = await handleScanOIDivergence(
          a.lookback_periods || 24,
          a.min_oi_change_pct || 5,
          a.min_volume || 50000,
          a.limit || 15,
        );
        break;
      case 'scan_momentum':
        res = await handleScanMomentum(
          a.mode || 'both',
          a.min_change || 5,
          a.min_volume || 50000,
          a.limit || 10,
          a.output_format || 'json',
        );
        break;
      case 'scan_liquidity':
        res = await handleScanLiquidity(
          a.symbols,
          a.limit || 20,
          a.min_score || 0,
          a.sort_by || 'score',
        );
        break;
      case 'scan_grid':
        res = await handleScanGrid(
          a.min_volume || 100000,
          a.min_score || 50,
          a.limit || 15,
          a.timeframe || '1h',
          a.periods || 48,
          a.prefer_funding || 'any',
          a.min_atr || 1.0,
        );
        break;
      case 'obv_analysis':
        res = await handleOBVAnalysis(a.symbol, a.periods || 50);
        break;
      case 'deep_analysis':
        res = await handleDeepAnalysis(a.symbol, a.timeframe || '15m', a.periods || 96);
        break;
      // Spot tools
      case 'get_spot_market_data':
        res = await handleGetSpotMarketData(a.type, a.symbol, a.limit);
        break;
      case 'get_spot_klines':
        res = await handleGetSpotKlines(a.symbol, a.interval, a.limit);
        break;
      case 'get_spot_trades':
        res = await handleGetSpotTrades(a.symbol, a.limit);
        break;
      case 'get_spot_account':
        res = await handleGetSpotAccount(a.type, a.symbol, a.order_id, a.limit);
        break;
      case 'execute_spot_order':
        res = await handleExecuteSpotOrder(a.action, a.symbol, a.amount, a.price, a.time_in_force);
        break;
      case 'cancel_spot_order':
        res = await handleCancelSpotOrder(a.action, a.symbol, a.order_id);
        break;
      case 'spot_transfer':
        res = await handleSpotTransfer(a.direction, a.asset, a.amount);
        break;
      // CBS (Crypto Base Scanner) tools
      case 'get_cbs_signals':
        res = await handleGetCBSSignals(a.algorithm, a.limit, a.min_volume_usd, a.min_success_rate);
        break;
      case 'get_cbs_markets':
        res = await handleGetCBSMarkets(a.algorithm, a.exchange, a.max_drop, a.limit);
        break;
      case 'get_cbs_quick_scan':
        res = await handleCBSQuickScan(a.timeframe, a.exchange, a.limit);
        break;
      case 'compare_cbs_algorithms':
        res = await handleCompareCBSAlgorithms(a.symbol, a.exchange);
        break;
      // ScaleGrid tools
      case 'grid_preview':
        res = await handleGridPreview(
          a.symbol,
          a.base_order_usd,
          a.range_percent,
          a.position_scale,
          a.step_scale,
          a.tp_percent,
          a.leverage,
          a.entry_price,
        );
        break;
      case 'grid_start':
        res = await handleGridStart(
          a.symbol,
          a.base_order_usd,
          a.side,
          a.range_percent,
          a.position_scale,
          a.step_scale,
          a.tp_percent,
          a.max_position_usd,
          a.leverage,
        );
        break;
      case 'grid_status':
        res = await handleGridStatus(a.grid_id);
        break;
      case 'grid_adjust':
        res = await handleGridAdjust(
          a.grid_id,
          a.tp_percent,
          a.max_position_usd,
          a.max_drawdown_percent,
        );
        break;
      case 'grid_pause':
        res = await handleGridPause(a.grid_id);
        break;
      case 'grid_resume':
        res = await handleGridResume(a.grid_id);
        break;
      case 'grid_close':
        res = await handleGridClose(a.grid_id, a.keep_position);
        break;
      // Market regime detection
      case 'get_market_regime':
        res = await handleGetMarketRegime(a.reset || false, a.format || 'formatted');
        break;
      // Binance cross-exchange tools
      case 'get_binance_sentiment':
        res = await handleGetBinanceSentiment(a.symbol, a.period || '1h', a.limit || 12);
        break;
      case 'compare_exchange_volume':
        res = await handleCompareExchangeVolume(a.symbol);
        break;
      case 'get_binance_oi_history':
        res = await handleGetBinanceOiHistory(a.symbol, a.period || '1h', a.limit || 24);
        break;
      case 'get_binance_funding':
        res = await handleGetBinanceFunding(a.symbol);
        break;
      case 'scan_exchange_divergence':
        res = await handleScanExchangeDivergence(a.min_volume_ratio || 10, a.limit || 15);
        break;
      // Leading indicator scanners
      case 'scan_accumulation':
        res = await handleScanAccumulation(
          a.min_score || 20,
          a.limit || 15,
          a.lookback_hours || 24,
          a.mode || 'both',
        );
        break;
      case 'scan_funding_extremes':
        res = await handleScanFundingExtremes(
          a.min_funding_bps || 50,
          a.limit || 15,
          a.include_binance_comparison !== false,
        );
        break;
      case 'scan_binance_signals':
        res = await handleScanBinanceSignals(
          a.mode ?? 'both',
          a.min_score ?? 15,
          a.limit ?? 20,
          a.min_volume ?? 500000,
          a.lookback_hours ?? 24,
          a.output_format ?? 'json',
        );
        break;
      default:
        res = JSON.stringify({ error: `Unknown tool: ${name}` });
    }

    return { content: [{ type: 'text', text: res }] };
  } catch (err: any) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
      isError: true,
    };
  }
});

async function main() {
  await initializeCredentials();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[Aster Trading Suite] Started v2.10.0 - Perpetual + Spot + QFL/CBS + Momentum + Binance Cross-Exchange (38 tools)`,
  );
}

main().catch(error => {
  console.error('[Aster MCP Server] Fatal error:', error);
  process.exit(1);
});
