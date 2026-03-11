/**
 * ScaleGrid Trading System - Grid Manager
 *
 * Handles grid calculation, level management, and position math.
 */

import {
  GridConfig,
  GridLevel,
  GridCalculation,
  GridState,
  DEFAULT_CONFIG,
} from './types.js';

// ============================================================================
// Grid Calculation
// ============================================================================

/**
 * Calculate grid levels based on configuration.
 *
 * Uses range-based approach: given a % range to cover, calculates
 * optimal number of levels with scaling position sizes and step distances.
 */
export function calculateGridLevels(
  entryPrice: number,
  config: GridConfig
): GridCalculation {
  const levels: GridLevel[] = [];
  const { side, baseOrderUsd, positionScale, stepScale, rangePercent, maxRangePercent } = config;

  // For LONG: levels go DOWN from entry
  // For SHORT: levels go UP from entry
  const direction = side === 'LONG' ? -1 : 1;

  // Calculate levels until we hit the range limit
  let currentPrice = entryPrice;
  let currentStepPercent = rangePercent / 10; // Start with ~10 levels estimate, will adjust
  let currentMultiplier = 1;
  let totalSizeUsd = 0;
  let levelIndex = 0;

  // First, estimate initial step size to roughly fill the range
  // We'll use iterative approach to fit levels within range
  const targetLevels = estimateLevelCount(rangePercent, stepScale);
  const initialStepPercent = calculateInitialStep(rangePercent, targetLevels, stepScale);

  currentStepPercent = initialStepPercent;

  // Entry level (level 0)
  const entryLevel: GridLevel = {
    index: 0,
    price: entryPrice,
    distancePercent: 0,
    sizeUsd: baseOrderUsd,
    sizeBase: baseOrderUsd / entryPrice,
    multiplier: 1,
    status: 'PENDING',
  };
  levels.push(entryLevel);
  totalSizeUsd += baseOrderUsd;
  levelIndex++;

  // Safety order levels
  let cumulativeDistance = 0;

  while (cumulativeDistance < Math.min(rangePercent, maxRangePercent)) {
    // Calculate step for this level
    const stepPercent = currentStepPercent * Math.pow(stepScale, levelIndex - 1);
    cumulativeDistance += stepPercent;

    // Check if we'd exceed max range
    if (cumulativeDistance > Math.min(rangePercent, maxRangePercent)) {
      break;
    }

    // Calculate price for this level
    const priceChange = entryPrice * (cumulativeDistance / 100) * direction;
    const levelPrice = entryPrice + priceChange;

    // Calculate size for this level
    currentMultiplier = Math.pow(positionScale, levelIndex);
    const levelSizeUsd = baseOrderUsd * currentMultiplier;

    const level: GridLevel = {
      index: levelIndex,
      price: roundPrice(levelPrice, entryPrice),
      distancePercent: cumulativeDistance,
      sizeUsd: levelSizeUsd,
      sizeBase: levelSizeUsd / levelPrice,
      multiplier: currentMultiplier,
      status: 'PENDING',
    };

    levels.push(level);
    totalSizeUsd += levelSizeUsd;
    levelIndex++;

    // Safety: max 20 levels
    if (levelIndex >= 20) break;
  }

  // Calculate worst case scenario (all levels filled)
  const worstCase = calculateWorstCaseEntry(levels);

  return {
    levels,
    totalLevels: levels.length,
    totalSizeUsd,
    worstCaseAvgEntry: worstCase.avgEntry,
    worstCaseTpPrice: worstCase.avgEntry * (1 + (config.tpPercent / 100) * (side === 'LONG' ? 1 : -1)),
    requiredMargin: totalSizeUsd / config.leverage,
  };
}

/**
 * Estimate how many levels we can fit in a given range with step scaling
 */
function estimateLevelCount(rangePercent: number, stepScale: number): number {
  // With step scaling, each step is stepScale times the previous
  // Sum of geometric series: S = a * (r^n - 1) / (r - 1)
  // We want to solve for n given S (range) and r (stepScale)
  // This is approximate - we'll refine with actual calculation
  if (stepScale === 1) {
    return Math.floor(rangePercent / 2); // 2% steps without scaling
  }
  // Approximate: log calculation
  return Math.min(Math.floor(Math.log(rangePercent) / Math.log(stepScale)) + 3, 15);
}

/**
 * Calculate initial step size to fill the range with estimated level count
 */
function calculateInitialStep(rangePercent: number, levelCount: number, stepScale: number): number {
  if (stepScale === 1) {
    return rangePercent / levelCount;
  }
  // Sum of geometric series: S = a * (r^n - 1) / (r - 1)
  // Solve for a (initial step): a = S * (r - 1) / (r^n - 1)
  const sumFactor = (Math.pow(stepScale, levelCount) - 1) / (stepScale - 1);
  return rangePercent / sumFactor;
}

/**
 * Calculate worst case average entry if all levels fill
 */
function calculateWorstCaseEntry(levels: GridLevel[]): { avgEntry: number; totalSize: number } {
  let totalCost = 0;
  let totalSize = 0;

  for (const level of levels) {
    totalCost += level.sizeUsd;
    totalSize += level.sizeBase;
  }

  return {
    avgEntry: totalCost / totalSize,
    totalSize,
  };
}

// ============================================================================
// Position Calculations
// ============================================================================

/**
 * Calculate current average entry from filled levels
 */
export function calculateAvgEntry(levels: GridLevel[]): { avgEntry: number; totalSize: number; totalCost: number } {
  let totalCost = 0;
  let totalSize = 0;

  for (const level of levels) {
    if (level.status === 'FILLED' && level.fillPrice && level.fillQty) {
      totalCost += level.fillPrice * level.fillQty;
      totalSize += level.fillQty;
    }
  }

  if (totalSize === 0) {
    return { avgEntry: 0, totalSize: 0, totalCost: 0 };
  }

  return {
    avgEntry: totalCost / totalSize,
    totalSize,
    totalCost,
  };
}

/**
 * Calculate take profit price from average entry
 */
export function calculateTpPrice(avgEntry: number, tpPercent: number, side: 'LONG' | 'SHORT'): number {
  const direction = side === 'LONG' ? 1 : -1;
  return avgEntry * (1 + (tpPercent / 100) * direction);
}

/**
 * Calculate unrealized PnL
 */
export function calculateUnrealizedPnl(
  avgEntry: number,
  currentPrice: number,
  positionSize: number,
  side: 'LONG' | 'SHORT'
): { pnl: number; pnlPercent: number } {
  if (positionSize === 0 || avgEntry === 0) {
    return { pnl: 0, pnlPercent: 0 };
  }

  const direction = side === 'LONG' ? 1 : -1;
  const priceDiff = (currentPrice - avgEntry) * direction;
  const pnl = priceDiff * positionSize;
  const pnlPercent = (priceDiff / avgEntry) * 100;

  return { pnl, pnlPercent };
}

// ============================================================================
// Trail Calculations
// ============================================================================

/**
 * Calculate new level prices after trailing
 */
export function calculateTrailedLevels(
  levels: GridLevel[],
  oldEntryPrice: number,
  newEntryPrice: number,
  config: GridConfig
): GridLevel[] {
  const priceDiff = newEntryPrice - oldEntryPrice;
  const percentChange = (priceDiff / oldEntryPrice) * 100;

  return levels.map((level) => {
    // Only trail unfilled levels
    if (level.status === 'FILLED' || level.status === 'CANCELLED' || level.status === 'SKIPPED') {
      return level;
    }

    // Trail the price
    const newPrice = level.price + priceDiff;
    const newSizeBase = level.sizeUsd / newPrice;

    return {
      ...level,
      price: roundPrice(newPrice, newEntryPrice),
      sizeBase: newSizeBase,
      // Note: distancePercent stays the same (relative to new entry)
    };
  });
}

/**
 * Calculate new levels for re-centering (when all levels filled and price keeps moving)
 */
export function calculateRecenterLevels(
  currentPrice: number,
  filledLevels: GridLevel[],
  config: GridConfig
): GridLevel[] {
  // Calculate new entry point (current price)
  // Then calculate new safety levels below/above
  const newCalc = calculateGridLevels(currentPrice, config);

  // Return only the safety orders (not entry, since we're already in position)
  return newCalc.levels.slice(1).map((level, index) => ({
    ...level,
    index: filledLevels.length + index, // Continue index from filled levels
  }));
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Round price to appropriate precision based on price magnitude
 */
export function roundPrice(price: number, referencePrice: number): number {
  // Determine precision based on price magnitude
  let precision: number;
  if (referencePrice >= 1000) {
    precision = 2;
  } else if (referencePrice >= 100) {
    precision = 3;
  } else if (referencePrice >= 10) {
    precision = 4;
  } else if (referencePrice >= 1) {
    precision = 5;
  } else if (referencePrice >= 0.1) {
    precision = 6;
  } else {
    precision = 8;
  }

  return Number(price.toFixed(precision));
}

/**
 * Round quantity to appropriate precision
 */
export function roundQuantity(qty: number, minQty: number = 0.001): number {
  // Round to same precision as minQty
  const precision = Math.max(0, -Math.floor(Math.log10(minQty)));
  const rounded = Number(qty.toFixed(precision));
  return Math.max(rounded, minQty);
}

/**
 * Validate grid configuration
 */
export function validateConfig(config: Partial<GridConfig>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.symbol) {
    errors.push('Symbol is required');
  }

  if (!config.baseOrderUsd || config.baseOrderUsd <= 0) {
    errors.push('Base order USD must be positive');
  }

  if (config.positionScale && config.positionScale < 1) {
    errors.push('Position scale must be >= 1');
  }

  if (config.stepScale && config.stepScale < 1) {
    errors.push('Step scale must be >= 1');
  }

  if (config.tpPercent && config.tpPercent <= 0) {
    errors.push('TP percent must be positive');
  }

  if (config.rangePercent && (config.rangePercent <= 0 || config.rangePercent > 100)) {
    errors.push('Range percent must be between 0 and 100');
  }

  if (config.leverage && (config.leverage < 1 || config.leverage > 125)) {
    errors.push('Leverage must be between 1 and 125');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Merge partial config with defaults
 */
export function mergeConfig(partial: Partial<GridConfig>): GridConfig {
  return {
    symbol: partial.symbol || '',
    side: partial.side || DEFAULT_CONFIG.side!,
    baseOrderUsd: partial.baseOrderUsd || 0,
    positionScale: partial.positionScale ?? DEFAULT_CONFIG.positionScale!,
    stepScale: partial.stepScale ?? DEFAULT_CONFIG.stepScale!,
    tpPercent: partial.tpPercent ?? DEFAULT_CONFIG.tpPercent!,
    rangePercent: partial.rangePercent ?? DEFAULT_CONFIG.rangePercent!,
    maxPositionUsd: partial.maxPositionUsd ?? DEFAULT_CONFIG.maxPositionUsd!,
    maxDrawdownPercent: partial.maxDrawdownPercent ?? DEFAULT_CONFIG.maxDrawdownPercent!,
    maxRangePercent: partial.maxRangePercent ?? DEFAULT_CONFIG.maxRangePercent!,
    leverage: partial.leverage ?? DEFAULT_CONFIG.leverage!,
    trailIntervalMs: partial.trailIntervalMs ?? DEFAULT_CONFIG.trailIntervalMs!,
    trailThresholdPercent: partial.trailThresholdPercent ?? DEFAULT_CONFIG.trailThresholdPercent!,
  };
}

/**
 * Generate unique grid ID
 */
export function generateGridId(symbol: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 6);
  return `${symbol.replace('USDT', '').toLowerCase()}-${timestamp}-${random}`;
}

// ============================================================================
// Display/Formatting
// ============================================================================

/**
 * Format grid calculation for display
 */
export function formatGridCalculation(calc: GridCalculation, config: GridConfig): string {
  const lines: string[] = [
    `Grid Calculation for ${config.symbol} (${config.side})`,
    `═══════════════════════════════════════`,
    `Base Order: $${config.baseOrderUsd} | Scale: ${config.positionScale}x | Step Scale: ${config.stepScale}x`,
    `Range: ${config.rangePercent}% | TP: ${config.tpPercent}% | Leverage: ${config.leverage}x`,
    ``,
    `Levels:`,
  ];

  for (const level of calc.levels) {
    const prefix = level.index === 0 ? 'Entry' : `SO${level.index}`;
    lines.push(
      `  ${prefix.padEnd(6)} $${level.price.toFixed(6)} (${level.distancePercent.toFixed(1).padStart(5)}%) ` +
        `$${level.sizeUsd.toFixed(2).padStart(8)} (${level.multiplier.toFixed(2)}x)`
    );
  }

  lines.push(``);
  lines.push(`Summary:`);
  lines.push(`  Total Levels: ${calc.totalLevels}`);
  lines.push(`  Total Size: $${calc.totalSizeUsd.toFixed(2)}`);
  lines.push(`  Required Margin: $${calc.requiredMargin.toFixed(2)}`);
  lines.push(`  Worst Case Avg Entry: $${calc.worstCaseAvgEntry.toFixed(6)}`);
  lines.push(`  Worst Case TP: $${calc.worstCaseTpPrice.toFixed(6)}`);

  return lines.join('\n');
}
