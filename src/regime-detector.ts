/**
 * RegimeDetector - Market regime detection from BTC macro data
 *
 * Evolves binary triggers into regime awareness:
 * - bullish: EMA trending up + RSI strength
 * - bearish: EMA trending down + RSI weakness
 * - neutral: Mixed signals
 *
 * Uses Binance data as the regime reference (most liquid market).
 */

import { getBinanceClient, BinanceClient } from './binance-client.js';

export type Regime = 'bullish' | 'bearish' | 'neutral';
export type Direction = 'long' | 'short' | 'none';

export interface MacroState {
  btc: {
    price: number;
    change_1h: number;      // % change over last 1h
    change_4h: number;      // % change over last 4h
    change_24h: number;     // % change over last 24h
    ema_21_1h: number;      // 21-period EMA on 1h
    ema_45_1h: number;      // 45-period EMA on 1h
    ema_spread_pct: number; // (ema21 - ema45) / ema45 * 100
    rsi_15m: number;        // RSI(14) on 15m
    rsi_1h: number;         // RSI(14) on 1h
  };
  timestamp: Date;
}

export interface RegimeState {
  regime: Regime;
  confidence: number;           // 0-100
  previous_regime: Regime;
  regime_changed: boolean;
  ticks_in_regime: number;      // How many evaluations in current regime
  suggested_direction: Direction;
  panic_active: boolean;        // Crash protection still applies
  crash_recovery: boolean;      // Recently recovered from panic
  macro: MacroState;
  reasoning: string[];          // Human-readable explanation
}

interface RegimeThresholds {
  rsi_bullish: number;          // RSI >= this = bullish momentum
  rsi_bearish: number;          // RSI <= this = bearish momentum
  panic_change_pct: number;     // 1h change <= this = panic mode
  confirmation_ticks: number;   // Ticks needed to confirm regime change
  ema_spread_strong: number;    // EMA spread % for strong trend
}

const DEFAULT_THRESHOLDS: RegimeThresholds = {
  rsi_bullish: 55,
  rsi_bearish: 45,
  panic_change_pct: -2.0,
  confirmation_ticks: 3,
  ema_spread_strong: 0.5,
};

export class RegimeDetector {
  private binanceClient: BinanceClient;
  private thresholds: RegimeThresholds;
  private previousRegime: Regime = 'neutral';
  private ticksInCurrentRegime: number = 0;
  private lastConfirmedRegime: Regime = 'neutral';
  private lastPanicTime: Date | null = null;

  // Cache for macro state (30 second TTL)
  private macroCache: MacroState | null = null;
  private macroCacheExpiry: Date | null = null;
  private readonly cacheTTL: number = 30_000;

  constructor(thresholds?: Partial<RegimeThresholds>) {
    this.binanceClient = getBinanceClient();
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /**
   * Evaluate current market regime
   */
  async evaluate(): Promise<RegimeState> {
    const macro = await this.getMacroState();

    // Check panic condition first (crash protection)
    const panicActive = macro.btc.change_1h <= this.thresholds.panic_change_pct;

    // Track panic recovery (within 2 hours of panic)
    if (panicActive) {
      this.lastPanicTime = new Date();
    }
    const crashRecovery = this.lastPanicTime !== null &&
      (Date.now() - this.lastPanicTime.getTime()) < 2 * 60 * 60 * 1000 &&
      !panicActive;

    // Detect raw regime from indicators
    const { regime: rawRegime, reasoning } = this.detectRawRegime(macro);

    // Track regime persistence
    if (rawRegime === this.previousRegime) {
      this.ticksInCurrentRegime++;
    } else {
      this.ticksInCurrentRegime = 1;
    }

    // Only confirm regime change after persistence threshold
    const confirmedRegime = this.ticksInCurrentRegime >= this.thresholds.confirmation_ticks
      ? rawRegime
      : this.lastConfirmedRegime;

    const regimeChanged = confirmedRegime !== this.lastConfirmedRegime;

    // Update state
    const previousConfirmed = this.lastConfirmedRegime;
    if (regimeChanged) {
      this.lastConfirmedRegime = confirmedRegime;
    }
    this.previousRegime = rawRegime;

    // Calculate confidence
    const confidence = this.calculateConfidence(macro, confirmedRegime);

    // Determine suggested direction
    const suggestedDirection = this.getSuggestedDirection(confirmedRegime, panicActive, crashRecovery, confidence);

    // Add panic/recovery reasoning
    const fullReasoning = [...reasoning];
    if (panicActive) {
      fullReasoning.push(`🚨 PANIC MODE: BTC down ${macro.btc.change_1h.toFixed(2)}% in 1h`);
    }
    if (crashRecovery) {
      fullReasoning.push(`⚠️ CRASH RECOVERY: Recently exited panic mode, proceed with caution`);
    }

    return {
      regime: confirmedRegime,
      confidence,
      previous_regime: previousConfirmed,
      regime_changed: regimeChanged,
      ticks_in_regime: this.ticksInCurrentRegime,
      suggested_direction: suggestedDirection,
      panic_active: panicActive,
      crash_recovery: crashRecovery,
      macro,
      reasoning: fullReasoning,
    };
  }

  /**
   * Get macro state with caching
   */
  private async getMacroState(): Promise<MacroState> {
    // Return cached if fresh
    if (this.macroCache && this.macroCacheExpiry && new Date() < this.macroCacheExpiry) {
      return this.macroCache;
    }

    // Fetch klines from Binance
    const [klines1hRes, klines15mRes, klines4hRes] = await Promise.all([
      this.binanceClient.getKlines('BTCUSDT', '1h', 50),
      this.binanceClient.getKlines('BTCUSDT', '15m', 20),
      this.binanceClient.getKlines('BTCUSDT', '4h', 10),
    ]);

    if (!klines1hRes.success || !klines15mRes.success || !klines4hRes.success) {
      throw new Error('Failed to fetch BTC klines from Binance');
    }

    const klines1h = klines1hRes.data!;
    const klines15m = klines15mRes.data!;
    const klines4h = klines4hRes.data!;

    const closes1h = klines1h.map((k: any) => parseFloat(k.close));
    const closes15m = klines15m.map((k: any) => parseFloat(k.close));
    const closes4h = klines4h.map((k: any) => parseFloat(k.close));

    const currentPrice = closes1h[closes1h.length - 1];
    const ema21 = this.calculateEMA(closes1h, 21);
    const ema45 = this.calculateEMA(closes1h, 45);

    this.macroCache = {
      btc: {
        price: currentPrice,
        change_1h: this.calculateChange(closes1h.slice(-2)),
        change_4h: this.calculateChange(closes4h.slice(-2)),
        change_24h: this.calculateChange(closes1h.slice(-24)),
        ema_21_1h: ema21,
        ema_45_1h: ema45,
        ema_spread_pct: ((ema21 - ema45) / ema45) * 100,
        rsi_15m: this.calculateRSI(closes15m, 14),
        rsi_1h: this.calculateRSI(closes1h, 14),
      },
      timestamp: new Date(),
    };

    this.macroCacheExpiry = new Date(Date.now() + this.cacheTTL);
    return this.macroCache;
  }

  /**
   * Detect regime from raw indicators (before confirmation)
   */
  private detectRawRegime(macro: MacroState): { regime: Regime; reasoning: string[] } {
    const reasoning: string[] = [];

    const emaUp = macro.btc.ema_21_1h > macro.btc.ema_45_1h;
    const emaSpread = Math.abs(macro.btc.ema_spread_pct);
    const emaStrong = emaSpread >= this.thresholds.ema_spread_strong;

    const rsi = macro.btc.rsi_15m;
    const rsiStrong = rsi >= this.thresholds.rsi_bullish;
    const rsiWeak = rsi <= this.thresholds.rsi_bearish;

    // Also check 1h RSI for confluence
    const rsi1h = macro.btc.rsi_1h;
    const rsi1hBullish = rsi1h >= 50;
    const rsi1hBearish = rsi1h <= 50;

    // Add reasoning
    reasoning.push(`EMA21 ${emaUp ? '>' : '<'} EMA45 (spread: ${macro.btc.ema_spread_pct.toFixed(3)}%)`);
    reasoning.push(`RSI 15m: ${rsi.toFixed(1)} | RSI 1h: ${rsi1h.toFixed(1)}`);

    // BULLISH: EMA trending up AND RSI shows strength
    if (emaUp && rsiStrong) {
      if (emaStrong && rsi1hBullish) {
        reasoning.push('✅ STRONG BULLISH: EMA trending up with RSI confirmation on multiple timeframes');
      } else {
        reasoning.push('✅ BULLISH: EMA trending up + RSI momentum');
      }
      return { regime: 'bullish', reasoning };
    }

    // BEARISH: EMA trending down AND RSI shows weakness
    if (!emaUp && rsiWeak) {
      if (emaStrong && rsi1hBearish) {
        reasoning.push('❌ STRONG BEARISH: EMA trending down with RSI weakness on multiple timeframes');
      } else {
        reasoning.push('❌ BEARISH: EMA trending down + RSI weakness');
      }
      return { regime: 'bearish', reasoning };
    }

    // NEUTRAL: Mixed signals
    reasoning.push('⚖️ NEUTRAL: Mixed signals between EMA trend and RSI momentum');
    return { regime: 'neutral', reasoning };
  }

  /**
   * Calculate confidence in the regime (0-100)
   */
  private calculateConfidence(macro: MacroState, regime: Regime): number {
    let confidence = 50; // Base neutral

    const emaSpread = Math.abs(macro.btc.ema_spread_pct);
    const rsiExtreme = Math.abs(macro.btc.rsi_15m - 50);
    const rsi1hExtreme = Math.abs(macro.btc.rsi_1h - 50);

    if (regime === 'bullish' || regime === 'bearish') {
      // EMA spread adds confidence (up to +20)
      confidence += Math.min(emaSpread * 10, 20);
      // RSI 15m distance from neutral adds confidence (up to +15)
      confidence += Math.min(rsiExtreme * 0.3, 15);
      // RSI 1h confluence adds confidence (up to +15)
      confidence += Math.min(rsi1hExtreme * 0.3, 15);
    } else {
      // Neutral - confidence reflects how mixed the signals are
      // Higher RSI extremes with wrong EMA = lower neutral confidence
      confidence = 50 - Math.min(emaSpread * 5, 15);
    }

    return Math.max(0, Math.min(100, Math.round(confidence)));
  }

  /**
   * Get suggested trading direction based on regime
   */
  private getSuggestedDirection(
    regime: Regime,
    panicActive: boolean,
    crashRecovery: boolean,
    confidence: number
  ): Direction {
    // Panic mode = no new entries
    if (panicActive) {
      return 'none';
    }

    // Low confidence = no entries
    if (confidence < 55) {
      return 'none';
    }

    // Crash recovery = reduced size (communicated via reasoning), but allow direction
    switch (regime) {
      case 'bullish':
        return 'long';
      case 'bearish':
        return 'short';
      default:
        return 'none';
    }
  }

  /**
   * Calculate percent change from first to last close
   */
  private calculateChange(closes: number[]): number {
    if (closes.length < 2) return 0;
    const first = closes[0];
    const last = closes[closes.length - 1];
    return ((last - first) / first) * 100;
  }

  /**
   * Calculate Exponential Moving Average
   */
  private calculateEMA(closes: number[], period: number): number {
    if (closes.length < period) {
      return closes.reduce((a, b) => a + b, 0) / closes.length;
    }

    const multiplier = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < closes.length; i++) {
      ema = (closes[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  /**
   * Calculate Relative Strength Index
   */
  private calculateRSI(closes: number[], period: number = 14): number {
    if (closes.length < period + 1) {
      return 50;
    }

    const changes: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      changes.push(closes[i] - closes[i - 1]);
    }

    const gains = changes.map(c => (c > 0 ? c : 0));
    const losses = changes.map(c => (c < 0 ? Math.abs(c) : 0));

    let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < changes.length; i++) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }

    if (avgLoss === 0) {
      return 100;
    }

    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  /**
   * Get current thresholds
   */
  getThresholds(): RegimeThresholds {
    return { ...this.thresholds };
  }

  /**
   * Force cache invalidation
   */
  invalidateCache(): void {
    this.macroCache = null;
    this.macroCacheExpiry = null;
  }

  /**
   * Reset state
   */
  reset(): void {
    this.previousRegime = 'neutral';
    this.ticksInCurrentRegime = 0;
    this.lastConfirmedRegime = 'neutral';
    this.lastPanicTime = null;
    this.invalidateCache();
  }
}

// Singleton instance for MCP server
let regimeDetectorInstance: RegimeDetector | null = null;

export function getRegimeDetector(): RegimeDetector {
  if (!regimeDetectorInstance) {
    regimeDetectorInstance = new RegimeDetector();
  }
  return regimeDetectorInstance;
}
