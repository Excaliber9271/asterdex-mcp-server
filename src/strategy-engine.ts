/**
 * Strategy Engine - Automated Trading System
 * Scans for pump signals and executes trades automatically
 */

import { AsterClient } from './aster-client.js';
import { AsterTradingClient, OrderParams } from './aster-trading-client.js';
import * as fs from 'fs';
import * as path from 'path';

// ==================== TYPES ====================

export interface StrategyConfig {
  name: string;
  enabled: boolean;
  scanInterval: number; // milliseconds
  volumeMultiple: number;
  minStochRSI: number;
  minMFI: number;
  minScore: number;
  minVolume24h: number;
  maxPositions: number;
  positionSizeUsd: number;
  leverage: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingStopPercent?: number;
  // NEW: Bidirectional trading
  enableShorts: boolean;           // Enable short signals
  shortStopLossPercent?: number;   // Custom SL for shorts (defaults to stopLossPercent)
  shortTakeProfitPercent?: number; // Custom TP for shorts (defaults to takeProfitPercent)
  // NEW: Risk management
  maxDailyDrawdownPercent?: number;  // Pause if daily loss exceeds this
  maxConsecutiveLosses?: number;     // Pause after N consecutive losses
  cooldownMinutes?: number;          // Cooldown after hitting limits
}

export interface Signal {
  symbol: string;
  price: number;
  volumeRatio: number;
  stochRSI: number;
  mfi: number;
  rsi: number;
  score: number;
  timestamp: number;
  // NEW: Signal direction and metadata
  signalType: 'LONG' | 'SHORT';
  reason: string;                    // Why this signal triggered
  change24h?: number;                // 24h price change
  fundingRate?: number;              // Current funding rate
  structuralBias?: 'bullish' | 'bearish' | 'neutral';
}

export interface Position {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  size: number;
  leverage: number;
  stopLoss: number;
  takeProfit: number;
  entryTime: number;
  signalScore: number;
  signalReason?: string;             // Why we entered
}

// NEW: Exit reason type
export type ExitReason = 'SL' | 'TP' | 'TRAILING' | 'MANUAL' | 'UNKNOWN';

// NEW: Signal history for learning
export interface SignalHistoryEntry {
  signal: Signal;
  executed: boolean;
  executionTime?: number;
  skipReason?: string;               // Why signal wasn't executed
  outcome?: {
    exitTime: number;
    exitPrice: number;
    pnl: number;
    pnlPercent: number;
    exitReason: ExitReason;
    duration: number;                // ms
  };
}

export interface StrategyState {
  status: 'stopped' | 'running' | 'paused';
  lastScan: number;
  scansCompleted: number;
  signalsFound: number;
  tradesExecuted: number;
  activePositions: Position[];
  totalPnl: number;
  // NEW: Enhanced tracking
  longSignalsFound: number;
  shortSignalsFound: number;
  longsExecuted: number;
  shortsExecuted: number;
  consecutiveLosses: number;
  dailyPnl: number;
  dailyPnlResetTime: number;
  pauseReason?: string;
  pauseUntil?: number;
}

// ==================== TECHNICAL INDICATORS ====================

interface Candle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

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
  return 100 - (100 / (1 + rs));
}

function calculateStochRSI(closes: number[], rsiPeriod: number = 14, stochPeriod: number = 14): number {
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
  return 100 - (100 / (1 + moneyRatio));
}

function calculateVolumeRatio(candles: Candle[]): number {
  if (candles.length < 2) return 1;

  const currentVol = parseFloat(candles[candles.length - 1].v);
  const volumes = candles.slice(0, -1).map(c => parseFloat(c.v));
  const avgVol = volumes.reduce((sum, v) => sum + v, 0) / volumes.length;

  if (avgVol === 0) return currentVol > 0 ? 999 : 0;
  return currentVol / avgVol;
}

// NEW: Chaikin Money Flow - measures buying/selling pressure
// Returns -1 to +1: positive = accumulation, negative = distribution
function calculateCMF(candles: Candle[], period: number = 20): number {
  if (candles.length < period) return 0;

  const recentCandles = candles.slice(-period);
  let mfvSum = 0;
  let volSum = 0;

  for (const candle of recentCandles) {
    const high = parseFloat(candle.h);
    const low = parseFloat(candle.l);
    const close = parseFloat(candle.c);
    const volume = parseFloat(candle.v);

    // Money Flow Multiplier: ((close - low) - (high - close)) / (high - low)
    const range = high - low;
    if (range === 0) continue;

    const mfm = ((close - low) - (high - close)) / range;
    const mfv = mfm * volume;

    mfvSum += mfv;
    volSum += volume;
  }

  if (volSum === 0) return 0;
  return mfvSum / volSum;
}

// NEW: Calculate structural bias from recent price action
function calculateStructuralBias(candles: Candle[]): 'bullish' | 'bearish' | 'neutral' {
  if (candles.length < 10) return 'neutral';

  const recent = candles.slice(-10);
  const closes = recent.map(c => parseFloat(c.c));
  const highs = recent.map(c => parseFloat(c.h));
  const lows = recent.map(c => parseFloat(c.l));

  // Check for higher highs and higher lows (bullish) or lower highs and lower lows (bearish)
  let hhCount = 0;
  let llCount = 0;
  let lhCount = 0;
  let hlCount = 0;

  for (let i = 1; i < recent.length; i++) {
    if (highs[i] > highs[i - 1]) hhCount++;
    if (lows[i] > lows[i - 1]) hlCount++;
    if (highs[i] < highs[i - 1]) lhCount++;
    if (lows[i] < lows[i - 1]) llCount++;
  }

  const bullishScore = hhCount + hlCount;
  const bearishScore = lhCount + llCount;

  if (bullishScore >= 6 && bullishScore > bearishScore + 2) return 'bullish';
  if (bearishScore >= 6 && bearishScore > bullishScore + 2) return 'bearish';
  return 'neutral';
}

// ==================== STRATEGY ENGINE ====================

export class StrategyEngine {
  private client: AsterClient;
  private trading: AsterTradingClient;
  private config: StrategyConfig;
  private state: StrategyState;
  private scanTimer: NodeJS.Timeout | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private stateFilePath: string;
  private historyFilePath: string;
  private signalHistory: SignalHistoryEntry[] = [];

  constructor(client: AsterClient, trading: AsterTradingClient, config: StrategyConfig, stateDir?: string) {
    this.client = client;
    this.trading = trading;
    this.config = config;

    // Set up state persistence path
    const dir = stateDir || process.cwd();
    this.stateFilePath = path.join(dir, 'strategy-state.json');
    this.historyFilePath = path.join(dir, 'signal-history.json');

    // Load signal history
    this.loadSignalHistory();

    // Try to load existing state, otherwise initialize fresh
    const loadedState = this.loadState();
    if (loadedState) {
      this.state = loadedState;
      this.state.status = 'stopped'; // Always start stopped, user must explicitly start
      // Reset daily PnL if new day
      if (Date.now() - this.state.dailyPnlResetTime > 24 * 60 * 60 * 1000) {
        this.state.dailyPnl = 0;
        this.state.dailyPnlResetTime = Date.now();
      }
      console.error(`[Strategy Engine] Loaded previous state: ${this.state.activePositions.length} tracked positions, ${this.signalHistory.length} history entries`);
    } else {
      this.state = {
        status: 'stopped',
        lastScan: 0,
        scansCompleted: 0,
        signalsFound: 0,
        tradesExecuted: 0,
        activePositions: [],
        totalPnl: 0,
        // NEW fields
        longSignalsFound: 0,
        shortSignalsFound: 0,
        longsExecuted: 0,
        shortsExecuted: 0,
        consecutiveLosses: 0,
        dailyPnl: 0,
        dailyPnlResetTime: Date.now(),
      };
    }
  }

  // ==================== SIGNAL HISTORY ====================

  private loadSignalHistory(): void {
    try {
      if (fs.existsSync(this.historyFilePath)) {
        const data = fs.readFileSync(this.historyFilePath, 'utf-8');
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) {
          // Keep last 1000 entries to prevent unbounded growth
          this.signalHistory = parsed.slice(-1000);
          console.error(`[Strategy Engine] Loaded ${this.signalHistory.length} signal history entries`);
        }
      }
    } catch (err: any) {
      console.error(`[Strategy Engine] Failed to load signal history: ${err.message}`);
    }
  }

  private saveSignalHistory(): void {
    try {
      // Keep last 1000 entries
      const toSave = this.signalHistory.slice(-1000);
      fs.writeFileSync(this.historyFilePath, JSON.stringify(toSave, null, 2));
    } catch (err: any) {
      console.error(`[Strategy Engine] Failed to save signal history: ${err.message}`);
    }
  }

  private recordSignal(signal: Signal, executed: boolean, skipReason?: string): void {
    const entry: SignalHistoryEntry = {
      signal,
      executed,
      executionTime: executed ? Date.now() : undefined,
      skipReason,
    };
    this.signalHistory.push(entry);
    // Save periodically (every 10 entries)
    if (this.signalHistory.length % 10 === 0) {
      this.saveSignalHistory();
    }
  }

  private recordOutcome(symbol: string, exitPrice: number, pnl: number, exitReason: ExitReason): void {
    // Find the most recent executed signal for this symbol
    for (let i = this.signalHistory.length - 1; i >= 0; i--) {
      const entry = this.signalHistory[i];
      if (entry.signal.symbol === symbol && entry.executed && !entry.outcome) {
        entry.outcome = {
          exitTime: Date.now(),
          exitPrice,
          pnl,
          pnlPercent: (pnl / this.config.positionSizeUsd) * 100,
          exitReason,
          duration: Date.now() - (entry.executionTime || entry.signal.timestamp),
        };
        this.saveSignalHistory();
        break;
      }
    }
  }

  getSignalHistory(limit: number = 100): SignalHistoryEntry[] {
    return this.signalHistory.slice(-limit);
  }

  getSignalStats(): {
    total: number;
    executed: number;
    profitable: number;
    avgPnl: number;
    winRate: number;
    longWinRate: number;
    shortWinRate: number;
  } {
    const executed = this.signalHistory.filter(h => h.executed && h.outcome);
    const profitable = executed.filter(h => h.outcome!.pnl > 0);
    const avgPnl = executed.length > 0
      ? executed.reduce((sum, h) => sum + h.outcome!.pnl, 0) / executed.length
      : 0;

    const longTrades = executed.filter(h => h.signal.signalType === 'LONG');
    const shortTrades = executed.filter(h => h.signal.signalType === 'SHORT');
    const longWins = longTrades.filter(h => h.outcome!.pnl > 0);
    const shortWins = shortTrades.filter(h => h.outcome!.pnl > 0);

    return {
      total: this.signalHistory.length,
      executed: executed.length,
      profitable: profitable.length,
      avgPnl,
      winRate: executed.length > 0 ? (profitable.length / executed.length) * 100 : 0,
      longWinRate: longTrades.length > 0 ? (longWins.length / longTrades.length) * 100 : 0,
      shortWinRate: shortTrades.length > 0 ? (shortWins.length / shortTrades.length) * 100 : 0,
    };
  }

  // ==================== STATE PERSISTENCE ====================

  private saveState(): void {
    try {
      const stateToSave = {
        ...this.state,
        savedAt: Date.now(),
        configName: this.config.name,
      };
      fs.writeFileSync(this.stateFilePath, JSON.stringify(stateToSave, null, 2));
    } catch (err: any) {
      console.error(`[Strategy Engine] Failed to save state: ${err.message}`);
    }
  }

  private loadState(): StrategyState | null {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const data = fs.readFileSync(this.stateFilePath, 'utf-8');
        const parsed = JSON.parse(data);
        // Validate it has the expected shape
        if (parsed.activePositions && typeof parsed.scansCompleted === 'number') {
          return parsed as StrategyState;
        }
      }
    } catch (err: any) {
      console.error(`[Strategy Engine] Failed to load state: ${err.message}`);
    }
    return null;
  }

  /**
   * Reconcile tracked positions with actual exchange positions
   * Call this on startup to sync state with reality
   */
  async reconcilePositions(): Promise<{ reconciled: number; orphaned: string[]; missing: string[] }> {
    const result = { reconciled: 0, orphaned: [] as string[], missing: [] as string[] };

    try {
      const posRes = await this.trading.getPositions();
      if (!posRes.success || !posRes.data) {
        console.error('[Strategy Engine] Could not fetch exchange positions for reconciliation');
        return result;
      }

      const exchangePositions = (Array.isArray(posRes.data) ? posRes.data : [posRes.data])
        .filter((p: any) => parseFloat(p.positionAmt) !== 0);

      const exchangeSymbols = new Set(exchangePositions.map((p: any) => p.symbol));
      const trackedSymbols = new Set(this.state.activePositions.map(p => p.symbol));

      // Find positions we're tracking that no longer exist on exchange
      for (const tracked of this.state.activePositions) {
        if (!exchangeSymbols.has(tracked.symbol)) {
          result.missing.push(tracked.symbol);
        } else {
          result.reconciled++;
        }
      }

      // Remove missing positions from our tracking
      if (result.missing.length > 0) {
        this.state.activePositions = this.state.activePositions.filter(
          p => !result.missing.includes(p.symbol)
        );
        console.error(`[Strategy Engine] Removed ${result.missing.length} closed positions: ${result.missing.join(', ')}`);
      }

      // Find exchange positions we're not tracking (orphaned)
      for (const exchPos of exchangePositions) {
        if (!trackedSymbols.has(exchPos.symbol)) {
          result.orphaned.push(exchPos.symbol);
        }
      }

      if (result.orphaned.length > 0) {
        console.error(`[Strategy Engine] Found ${result.orphaned.length} untracked positions: ${result.orphaned.join(', ')}`);
      }

      this.saveState();
      return result;
    } catch (err: any) {
      console.error(`[Strategy Engine] Reconciliation error: ${err.message}`);
      return result;
    }
  }

  // ==================== CORE METHODS ====================

  async start(): Promise<{ success: boolean; message: string; reconciliation?: any }> {
    if (this.state.status === 'running') {
      return { success: false, message: 'Strategy already running' };
    }

    console.error(`[Strategy Engine] Starting ${this.config.name}...`);

    // Reconcile state with exchange before starting
    console.error(`[Strategy Engine] Reconciling positions with exchange...`);
    const reconciliation = await this.reconcilePositions();

    this.state.status = 'running';
    this.saveState();

    // Run initial scan immediately
    await this.runScan();

    // Schedule periodic scans
    this.scanTimer = setInterval(() => this.runScan(), this.config.scanInterval);

    // Start position monitoring (every 30 seconds)
    this.monitorTimer = setInterval(() => this.monitorPositions(), 30000);

    return {
      success: true,
      message: `Strategy ${this.config.name} started`,
      reconciliation,
    };
  }

  async stop(): Promise<{ success: boolean; message: string }> {
    console.error(`[Strategy Engine] Stopping ${this.config.name}...`);

    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.monitorTimer) clearInterval(this.monitorTimer);

    this.state.status = 'stopped';
    this.saveState();

    return { success: true, message: `Strategy ${this.config.name} stopped` };
  }

  getState(): StrategyState {
    return { ...this.state };
  }

  updateConfig(updates: Partial<StrategyConfig>): void {
    this.config = { ...this.config, ...updates };
    this.saveState();
    console.error(`[Strategy Engine] Config updated:`, updates);
  }

  // ==================== SCANNING ====================

  private async runScan(): Promise<void> {
    if (this.state.status !== 'running') return;

    try {
      console.error(`[Strategy Engine] Running scan #${this.state.scansCompleted + 1}...`);

      const signals = await this.scanForSignals();
      this.state.lastScan = Date.now();
      this.state.scansCompleted++;
      this.state.signalsFound += signals.length;

      if (signals.length > 0) {
        console.error(`[Strategy Engine] Found ${signals.length} signals`);
        await this.processSignals(signals);
      } else {
        console.error(`[Strategy Engine] No signals found`);
      }
    } catch (err: any) {
      console.error(`[Strategy Engine] Scan error:`, err.message);
    }
  }

  private async scanForSignals(): Promise<Signal[]> {
    // Get all tickers AND funding rates in parallel
    const [tickerRes, fundingRes] = await Promise.all([
      this.client.getTicker24h(),
      this.client.getPremiumIndex()
    ]);

    if (!tickerRes.success || !tickerRes.data) return [];

    // Build funding rate map
    const fundingMap = new Map<string, number>();
    if (fundingRes.success && fundingRes.data) {
      const fundingData = Array.isArray(fundingRes.data) ? fundingRes.data : [fundingRes.data];
      fundingData.forEach((f: any) => {
        fundingMap.set(f.symbol, parseFloat(f.lastFundingRate) || 0);
      });
    }

    const pairs = (Array.isArray(tickerRes.data) ? tickerRes.data : [tickerRes.data])
      .filter((t: any) => parseFloat(t.quoteVolume) >= this.config.minVolume24h)
      .map((t: any) => ({
        symbol: t.symbol,
        price: parseFloat(t.lastPrice),
        volume24h: parseFloat(t.quoteVolume),
        change24h: parseFloat(t.priceChangePercent) || 0,
        fundingRate: fundingMap.get(t.symbol) || 0,
      }));

    // Process pairs in parallel batches (15 concurrent requests)
    const BATCH_SIZE = 15;
    const signals: Signal[] = [];

    for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
      const batch = pairs.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map(async (pair): Promise<Signal[]> => {
          const pairSignals: Signal[] = [];

          try {
            // Get 15-min klines
            const klineRes = await this.client.getKlines(pair.symbol, '15m', 48);
            if (!klineRes.success || !klineRes.data || klineRes.data.length < 20) return [];

            const candles: Candle[] = klineRes.data.map((k: any) => ({
              t: k.openTime,
              o: k.open,
              h: k.high,
              l: k.low,
              c: k.close,
              v: k.volume,
            }));

            // Calculate indicators
            const closes = candles.map(c => parseFloat(c.c));
            const volumeRatio = calculateVolumeRatio(candles);
            const stochRSI = calculateStochRSI(closes);
            const mfi = calculateMFI(candles);
            const rsi = calculateRSI(closes);
            const cmf = calculateCMF(candles);
            const structuralBias = calculateStructuralBias(candles);

            const hasVolumeSpike = volumeRatio >= this.config.volumeMultiple;

            // ==================== LONG SIGNAL LOGIC ====================
            // Requirements:
            // 1. Volume spike (required)
            // 2. NOT dumping hard (change24h > -5%)
            // 3. MFI not extremely low (> 30)
            // 4. Structural bias not bearish (unless extreme volume)
            const isHardDump = pair.change24h < -5;
            const mfiTooLow = mfi < 30;
            const hasVeryStrongVolume = volumeRatio >= 10;
            const hasPositiveMomentum = stochRSI > 50 || mfi > 50;

            const longDisqualified = isHardDump || mfiTooLow ||
              (structuralBias === 'bearish' && !hasVeryStrongVolume);

            if (hasVolumeSpike && hasPositiveMomentum && !longDisqualified) {
              // Calculate LONG score
              const accelBonus = cmf > 0.2 ? 1.5 : cmf > 0 ? 0.5 : 0;
              const structureBonus = structuralBias === 'bullish' ? 1.5 :
                structuralBias === 'neutral' ? 0 : -1;
              const changeBonus = pair.change24h > 0 ? 1 : pair.change24h > -2 ? 0 : -0.5;

              const longScore = (volumeRatio * 0.6) + ((stochRSI / 100) * 2) + ((mfi / 100) * 2) +
                accelBonus + structureBonus + changeBonus;

              const reason = hasVeryStrongVolume ? 'extreme_volume' :
                pair.change24h > 0 ? 'price_rising' :
                  structuralBias === 'bullish' ? 'bullish_structure' : 'volume_spike';

              pairSignals.push({
                symbol: pair.symbol,
                price: pair.price,
                volumeRatio,
                stochRSI,
                mfi,
                rsi,
                score: longScore,
                timestamp: Date.now(),
                signalType: 'LONG',
                reason,
                change24h: pair.change24h,
                fundingRate: pair.fundingRate,
                structuralBias,
              });

              this.state.longSignalsFound++;
            }

            // ==================== SHORT SIGNAL LOGIC ====================
            // Only if shorts are enabled
            if (this.config.enableShorts) {
              const hasNegativeMomentum = stochRSI < 50 || mfi < 50;
              const isDumping = pair.change24h < -5;
              const hasPositiveFunding = pair.fundingRate > 0.0001; // Longs paying shorts
              const mfiWeak = mfi < 40;

              // Short conditions:
              // 1. Volume spike + bearish structure + weak momentum
              // 2. OR: Active dump + crowded longs (positive funding) = squeeze
              const shortCondition1 = hasVolumeSpike && structuralBias === 'bearish' && hasNegativeMomentum;
              const shortCondition2 = isDumping && hasPositiveFunding && volumeRatio >= 2;

              if (shortCondition1 || shortCondition2) {
                // Calculate SHORT score (inverse momentum weighting)
                const structureBonus = structuralBias === 'bearish' ? 1.5 :
                  structuralBias === 'neutral' ? 0 : -1;
                const fundingBonus = hasPositiveFunding ? 1.5 : 0; // Bonus for long squeeze setup

                const shortScore = (volumeRatio * 0.4) +
                  (((100 - stochRSI) / 100) * 2) +
                  (((100 - mfi) / 100) * 2) +
                  fundingBonus + structureBonus;

                const reason = shortCondition2 ? 'long_squeeze' :
                  structuralBias === 'bearish' ? 'bearish_structure' :
                    mfiWeak ? 'weak_mfi' : 'volume_distribution';

                pairSignals.push({
                  symbol: pair.symbol,
                  price: pair.price,
                  volumeRatio,
                  stochRSI,
                  mfi,
                  rsi,
                  score: shortScore,
                  timestamp: Date.now(),
                  signalType: 'SHORT',
                  reason,
                  change24h: pair.change24h,
                  fundingRate: pair.fundingRate,
                  structuralBias,
                });

                this.state.shortSignalsFound++;
              }
            }

            return pairSignals;
          } catch (err) {
            return [];
          }
        })
      );

      // Flatten and collect signals from this batch
      for (const result of batchResults) {
        signals.push(...result);
      }
    }

    // Sort by score (best first)
    signals.sort((a, b) => b.score - a.score);

    return signals;
  }

  // ==================== SIGNAL PROCESSING ====================

  private async processSignals(signals: Signal[]): Promise<void> {
    // Check circuit breaker conditions
    if (this.isCircuitBreakerTripped()) {
      console.error(`[Strategy Engine] ⚠️ Circuit breaker active: ${this.state.pauseReason}`);
      for (const signal of signals.slice(0, 5)) {
        this.recordSignal(signal, false, `circuit_breaker: ${this.state.pauseReason}`);
      }
      return;
    }

    // Check if we can take more positions
    const availableSlots = this.config.maxPositions - this.state.activePositions.length;
    if (availableSlots <= 0) {
      console.error(`[Strategy Engine] Max positions reached (${this.config.maxPositions})`);
      for (const signal of signals.slice(0, 5)) {
        this.recordSignal(signal, false, 'max_positions_reached');
      }
      return;
    }

    // Take top N signals
    const signalsToTrade = signals.slice(0, availableSlots);

    for (const signal of signalsToTrade) {
      // Check if already in position
      if (this.state.activePositions.find(p => p.symbol === signal.symbol)) {
        console.error(`[Strategy Engine] Already in position: ${signal.symbol}`);
        this.recordSignal(signal, false, 'already_in_position');
        continue;
      }

      const executed = await this.executeEntry(signal);
      if (executed) {
        this.recordSignal(signal, true);
      } else {
        this.recordSignal(signal, false, 'execution_failed');
      }
    }

    // Record remaining signals as not executed
    for (const signal of signals.slice(availableSlots, availableSlots + 10)) {
      this.recordSignal(signal, false, 'no_available_slots');
    }
  }

  private isCircuitBreakerTripped(): boolean {
    // Check if we're in cooldown
    if (this.state.pauseUntil && Date.now() < this.state.pauseUntil) {
      return true;
    }

    // Check max consecutive losses
    if (this.config.maxConsecutiveLosses && this.state.consecutiveLosses >= this.config.maxConsecutiveLosses) {
      this.state.pauseReason = `${this.state.consecutiveLosses} consecutive losses`;
      this.state.pauseUntil = Date.now() + (this.config.cooldownMinutes || 30) * 60 * 1000;
      this.saveState();
      return true;
    }

    // Check max daily drawdown
    if (this.config.maxDailyDrawdownPercent) {
      const drawdownPct = (Math.abs(this.state.dailyPnl) / (this.config.positionSizeUsd * this.config.maxPositions)) * 100;
      if (this.state.dailyPnl < 0 && drawdownPct >= this.config.maxDailyDrawdownPercent) {
        this.state.pauseReason = `daily drawdown ${drawdownPct.toFixed(1)}% exceeds ${this.config.maxDailyDrawdownPercent}%`;
        this.state.pauseUntil = Date.now() + (this.config.cooldownMinutes || 60) * 60 * 1000;
        this.saveState();
        return true;
      }
    }

    // Clear pause reason if checks pass
    if (this.state.pauseReason) {
      this.state.pauseReason = undefined;
      this.state.pauseUntil = undefined;
    }

    return false;
  }

  public async executeEntry(signal: Signal): Promise<boolean> {
    try {
      const isLong = signal.signalType === 'LONG';
      const side = isLong ? 'LONG' : 'SHORT';
      const entrySide = isLong ? 'BUY' : 'SELL';
      const exitSide = isLong ? 'SELL' : 'BUY';

      console.error(`[Strategy Engine] Opening ${side} position: ${signal.symbol} @ $${signal.price}`);
      console.error(`  Score: ${signal.score.toFixed(2)} | Vol: ${signal.volumeRatio.toFixed(1)}x | Reason: ${signal.reason}`);
      console.error(`  StochRSI: ${signal.stochRSI.toFixed(1)} | MFI: ${signal.mfi.toFixed(1)} | Funding: ${((signal.fundingRate || 0) * 100).toFixed(4)}%`);

      // 1. Set leverage first
      const leverageRes = await this.trading.setLeverage(signal.symbol, this.config.leverage);
      if (!leverageRes.success) {
        console.error(`[Strategy Engine] ❌ Failed to set leverage: ${leverageRes.error}`);
        return false;
      }

      // 2. Calculate quantity
      const quantity = ((this.config.positionSizeUsd * this.config.leverage) / signal.price).toFixed(8);

      // 3. Place MARKET entry order
      const entryRes = await this.trading.placeMarketOrder(signal.symbol, entrySide, quantity);
      if (!entryRes.success) {
        console.error(`[Strategy Engine] ❌ Failed to place entry order: ${entryRes.error}`);
        return false;
      }

      // Get actual fill price (use signal price as fallback)
      const entryPrice = entryRes.data?.avgPrice ? parseFloat(entryRes.data.avgPrice) : signal.price;

      // 4. Calculate stop loss and take profit prices
      // For LONG: SL below entry, TP above entry
      // For SHORT: SL above entry, TP below entry
      const slPercent = isLong
        ? this.config.stopLossPercent
        : (this.config.shortStopLossPercent || this.config.stopLossPercent);
      const tpPercent = isLong
        ? this.config.takeProfitPercent
        : (this.config.shortTakeProfitPercent || this.config.takeProfitPercent);

      const stopLossPrice = isLong
        ? entryPrice * (1 - slPercent / 100)
        : entryPrice * (1 + slPercent / 100);
      const takeProfitPrice = isLong
        ? entryPrice * (1 + tpPercent / 100)
        : entryPrice * (1 - tpPercent / 100);

      // 5. Build batch orders for SL and TP (atomic placement)
      const protectionOrders: OrderParams[] = [
        {
          symbol: signal.symbol,
          side: exitSide,
          type: 'STOP_MARKET',
          stopPrice: stopLossPrice.toFixed(2),
          closePosition: true,
          workingType: 'CONTRACT_PRICE',
        },
      ];

      // Add take profit - either trailing or fixed
      if (this.config.trailingStopPercent) {
        protectionOrders.push({
          symbol: signal.symbol,
          side: exitSide,
          type: 'TRAILING_STOP_MARKET',
          callbackRate: this.config.trailingStopPercent.toString(),
          activationPrice: takeProfitPrice.toFixed(2),
          closePosition: true,
          workingType: 'CONTRACT_PRICE',
        });
      } else {
        protectionOrders.push({
          symbol: signal.symbol,
          side: exitSide,
          type: 'TAKE_PROFIT_MARKET',
          stopPrice: takeProfitPrice.toFixed(2),
          closePosition: true,
          workingType: 'CONTRACT_PRICE',
        });
      }

      // 6. Place SL + TP atomically via batch orders
      const batchRes = await this.trading.placeBatchOrders(protectionOrders);

      if (!batchRes.success) {
        // CRITICAL: Entry succeeded but SL/TP failed - close position immediately!
        console.error(`[Strategy Engine] ⚠️ CRITICAL: SL/TP batch failed, closing position to protect: ${batchRes.error}`);
        await this.trading.closePosition(signal.symbol);
        return false;
      }

      // Check if any orders in the batch failed
      const failedOrders = batchRes.data?.filter((o: any) => o.code && o.code !== 0);
      if (failedOrders && failedOrders.length > 0) {
        console.error(`[Strategy Engine] ⚠️ CRITICAL: Some protection orders failed, closing position`);
        console.error(`  Failed orders: ${JSON.stringify(failedOrders)}`);
        await this.trading.closePosition(signal.symbol);
        return false;
      }

      // 7. Track position
      const position: Position = {
        symbol: signal.symbol,
        side,
        entryPrice,
        size: this.config.positionSizeUsd,
        leverage: this.config.leverage,
        stopLoss: stopLossPrice,
        takeProfit: takeProfitPrice,
        entryTime: Date.now(),
        signalScore: signal.score,
        signalReason: signal.reason,
      };

      this.state.activePositions.push(position);
      this.state.tradesExecuted++;
      if (isLong) {
        this.state.longsExecuted++;
      } else {
        this.state.shortsExecuted++;
      }
      this.saveState();

      console.error(`[Strategy Engine] ✅ ${side} position opened: ${signal.symbol}`);
      console.error(`  Entry: $${entryPrice.toFixed(4)} | SL: $${stopLossPrice.toFixed(2)} | TP: $${takeProfitPrice.toFixed(2)}`);

      return true;
    } catch (err: any) {
      console.error(`[Strategy Engine] Entry error:`, err.message);
      return false;
    }
  }

  // ==================== POSITION MONITORING ====================

  private async monitorPositions(): Promise<void> {
    if (this.state.activePositions.length === 0) return;

    console.error(`[Strategy Engine] Monitoring ${this.state.activePositions.length} positions...`);

    try {
      // Get current positions from exchange
      const posRes = await this.trading.getPositions();
      if (!posRes.success || !posRes.data) return;

      const exchangePositions = (Array.isArray(posRes.data) ? posRes.data : [posRes.data])
        .filter((p: any) => parseFloat(p.positionAmt) !== 0);

      let stateChanged = false;

      // Update our tracked positions
      for (const trackedPos of this.state.activePositions) {
        const exchangePos = exchangePositions.find((p: any) => p.symbol === trackedPos.symbol);

        if (!exchangePos) {
          // Position closed (hit stop/TP or manually closed)
          console.error(`[Strategy Engine] Position closed: ${trackedPos.symbol}`);
          this.state.activePositions = this.state.activePositions.filter(p => p.symbol !== trackedPos.symbol);
          stateChanged = true;
          continue;
        }

        // Update PnL
        const currentPnl = parseFloat(exchangePos.unRealizedProfit || '0');
        console.error(`  ${trackedPos.symbol}: PnL $${currentPnl.toFixed(2)}`);
      }

      // Calculate total PnL
      const totalPnl = exchangePositions.reduce((sum: number, p: any) =>
        sum + parseFloat(p.unRealizedProfit || '0'), 0
      );
      this.state.totalPnl = totalPnl;

      // Save state if positions changed
      if (stateChanged) {
        this.saveState();
      }

    } catch (err: any) {
      console.error(`[Strategy Engine] Monitor error:`, err.message);
    }
  }

  // ==================== MANUAL CONTROLS ====================

  async closePosition(symbol: string): Promise<{ success: boolean; message: string }> {
    const position = this.state.activePositions.find(p => p.symbol === symbol);
    if (!position) {
      return { success: false, message: `No active position for ${symbol}` };
    }

    const result = await this.trading.closePosition(symbol);

    if (result.success) {
      this.state.activePositions = this.state.activePositions.filter(p => p.symbol !== symbol);
      this.saveState();
      return { success: true, message: `Closed position: ${symbol}` };
    }

    return { success: false, message: result.error || 'Failed to close position' };
  }

  async closeAllPositions(): Promise<{ success: boolean; message: string }> {
    const symbols = this.state.activePositions.map(p => p.symbol);

    for (const symbol of symbols) {
      await this.closePosition(symbol);
    }

    this.saveState();
    return { success: true, message: `Closed ${symbols.length} positions` };
  }

  /**
   * Get the state file path (for external access if needed)
   */
  getStateFilePath(): string {
    return this.stateFilePath;
  }

  /**
   * Force save state (useful after config updates)
   */
  forceSaveState(): void {
    this.saveState();
  }
}

// ==================== DEFAULT CONFIGS ====================
//
// BIDIRECTIONAL TRADING:
// - LONG signals: Volume spike + positive momentum + not dumping
// - SHORT signals: Volume spike + bearish structure OR long squeeze (positive funding + dump)
//
// VOLUME-PRIMARY LOGIC:
// Trigger when: Volume >= volumeMultiple AND momentum confirmation
// This catches early pumps/dumps without requiring all indicators to align perfectly.

export const DEFAULT_PUMP_STRATEGY: StrategyConfig = {
  name: 'Pump Hunter',
  enabled: false,
  scanInterval: 15 * 60 * 1000, // 15 minutes
  volumeMultiple: 5,            // PRIMARY: 5x volume spike required
  minStochRSI: 50,              // SECONDARY: Used in OR check (stochRSI > 50 OR mfi > 50)
  minMFI: 50,                   // SECONDARY: Used in OR check
  minScore: 0,                  // Not used for filtering (kept for compatibility)
  minVolume24h: 5000,           // $5k minimum 24h volume (pre-filter)
  maxPositions: 3,              // Max 3 simultaneous positions
  positionSizeUsd: 50,          // $50 per position
  leverage: 5,
  stopLossPercent: 3,           // 3% stop loss
  takeProfitPercent: 10,        // 10% take profit
  trailingStopPercent: 2,       // 2% trailing stop
  // Bidirectional settings
  enableShorts: false,          // Disabled by default for safety
  // Risk management
  maxDailyDrawdownPercent: 15,  // Pause if daily loss > 15%
  maxConsecutiveLosses: 5,      // Pause after 5 consecutive losses
  cooldownMinutes: 30,          // 30 minute cooldown
};

export const AGGRESSIVE_PUMP_STRATEGY: StrategyConfig = {
  name: 'Aggressive Pump Hunter',
  enabled: false,
  scanInterval: 5 * 60 * 1000,  // 5 minutes (faster scanning)
  volumeMultiple: 3,            // Lower volume threshold - catch earlier
  minStochRSI: 50,
  minMFI: 50,
  minScore: 0,
  minVolume24h: 1000,           // Lower volume filter
  maxPositions: 5,
  positionSizeUsd: 30,
  leverage: 10,                 // Higher leverage (more risk!)
  stopLossPercent: 5,
  takeProfitPercent: 20,        // Higher TP target
  trailingStopPercent: 3,
  // Bidirectional settings
  enableShorts: true,           // Shorts enabled for aggressive mode
  shortStopLossPercent: 4,      // Tighter SL for shorts
  shortTakeProfitPercent: 15,   // Tighter TP for shorts
  // Risk management
  maxDailyDrawdownPercent: 20,
  maxConsecutiveLosses: 4,
  cooldownMinutes: 15,
};

export const CONSERVATIVE_PUMP_STRATEGY: StrategyConfig = {
  name: 'Conservative Pump Hunter',
  enabled: false,
  scanInterval: 30 * 60 * 1000, // 30 minutes (slower)
  volumeMultiple: 10,           // Only major spikes (10x+)
  minStochRSI: 50,
  minMFI: 50,
  minScore: 0,
  minVolume24h: 10000,          // Higher volume requirement
  maxPositions: 2,
  positionSizeUsd: 100,
  leverage: 3,                  // Lower leverage (safer)
  stopLossPercent: 2,
  takeProfitPercent: 15,
  trailingStopPercent: 1.5,
  // Bidirectional settings
  enableShorts: false,          // No shorts in conservative mode
  // Risk management
  maxDailyDrawdownPercent: 10,  // Tight drawdown limit
  maxConsecutiveLosses: 3,
  cooldownMinutes: 60,          // Long cooldown
};

// NEW: Bidirectional strategy that trades both directions
export const BIDIRECTIONAL_STRATEGY: StrategyConfig = {
  name: 'Bidirectional Hunter',
  enabled: false,
  scanInterval: 10 * 60 * 1000, // 10 minutes
  volumeMultiple: 5,
  minStochRSI: 50,
  minMFI: 50,
  minScore: 0,
  minVolume24h: 5000,
  maxPositions: 4,              // 4 positions (can be mix of long/short)
  positionSizeUsd: 40,
  leverage: 5,
  stopLossPercent: 3,
  takeProfitPercent: 10,
  trailingStopPercent: 2,
  // Bidirectional settings
  enableShorts: true,           // Both directions enabled
  shortStopLossPercent: 3,      // Same SL for shorts
  shortTakeProfitPercent: 8,    // Slightly tighter TP for shorts (mean reversion)
  // Risk management
  maxDailyDrawdownPercent: 15,
  maxConsecutiveLosses: 4,
  cooldownMinutes: 30,
};

// NEW: Long squeeze hunter - specifically targets crowded longs
export const SQUEEZE_HUNTER_STRATEGY: StrategyConfig = {
  name: 'Squeeze Hunter',
  enabled: false,
  scanInterval: 5 * 60 * 1000,  // Fast scanning for squeeze setups
  volumeMultiple: 2,            // Lower volume requirement - squeezes often happen fast
  minStochRSI: 50,
  minMFI: 50,
  minScore: 0,
  minVolume24h: 10000,          // Higher liquidity requirement
  maxPositions: 3,
  positionSizeUsd: 50,
  leverage: 7,
  stopLossPercent: 4,
  takeProfitPercent: 15,        // Squeezes can be violent
  trailingStopPercent: 2.5,
  // Bidirectional settings - SHORT FOCUSED
  enableShorts: true,
  shortStopLossPercent: 3,
  shortTakeProfitPercent: 12,
  // Risk management
  maxDailyDrawdownPercent: 12,
  maxConsecutiveLosses: 3,
  cooldownMinutes: 20,
};
