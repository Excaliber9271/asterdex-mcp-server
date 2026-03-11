/**
 * ScaleGrid Trading System - Type Definitions
 *
 * Core types for the scaled grid trading system.
 */

// ============================================================================
// Configuration Types
// ============================================================================

export interface GridConfig {
  /** Trading pair symbol (e.g., MONUSDT) */
  symbol: string;

  /** Grid direction */
  side: 'LONG' | 'SHORT';

  /** Base order size in USD */
  baseOrderUsd: number;

  /** Position size multiplier per level (e.g., 1.5 = 50% larger each level) */
  positionScale: number;

  /** Step distance multiplier (e.g., 1.2 = steps widen 20% each level) */
  stepScale: number;

  /** Take profit % from average entry */
  tpPercent: number;

  /** Range to cover as % from entry (e.g., 20 = cover 20% drawdown) */
  rangePercent: number;

  /** Maximum total position size in USD */
  maxPositionUsd: number;

  /** Maximum unrealized drawdown % before freezing */
  maxDrawdownPercent: number;

  /** Maximum range % - never place orders beyond this */
  maxRangePercent: number;

  /** Leverage to use */
  leverage: number;

  /** How often to check for trailing (ms) */
  trailIntervalMs: number;

  /** Minimum price move % to trigger trailing */
  trailThresholdPercent: number;
}

export const DEFAULT_CONFIG: Partial<GridConfig> = {
  side: 'LONG',
  positionScale: 1.5,
  stepScale: 1.2,
  tpPercent: 3,
  rangePercent: 20,
  maxPositionUsd: 1000,
  maxDrawdownPercent: 15,
  maxRangePercent: 30,
  leverage: 10,
  trailIntervalMs: 5000,
  trailThresholdPercent: 2,
};

// ============================================================================
// Grid Level Types
// ============================================================================

export interface GridLevel {
  /** Level index (0 = entry, 1+ = safety orders) */
  index: number;

  /** Target price for this level */
  price: number;

  /** Distance from entry as % */
  distancePercent: number;

  /** Order size in USD for this level */
  sizeUsd: number;

  /** Order size in base asset */
  sizeBase: number;

  /** Cumulative multiplier (1x, 1.5x, 2.25x, etc.) */
  multiplier: number;

  /** Current status of this level */
  status: LevelStatus;

  /** Exchange order ID if placed */
  orderId?: string;

  /** Actual fill price if filled */
  fillPrice?: number;

  /** Actual fill quantity if filled */
  fillQty?: number;

  /** Fill timestamp */
  filledAt?: number;
}

export type LevelStatus =
  | 'PENDING'    // Calculated but not yet placed
  | 'PLACED'     // Order placed on exchange
  | 'FILLED'     // Order filled
  | 'CANCELLED'  // Order cancelled
  | 'SKIPPED';   // Skipped due to risk limits

// ============================================================================
// Grid State Types
// ============================================================================

export interface GridState {
  /** Unique grid ID */
  id: string;

  /** Symbol this grid is trading */
  symbol: string;

  /** Full config for this grid */
  config: GridConfig;

  /** Current risk state */
  riskState: RiskState;

  /** All levels (calculated and actual) */
  levels: GridLevel[];

  /** Current entry price (initial or re-centered) */
  entryPrice: number;

  /** Weighted average entry price across filled levels */
  avgEntry: number;

  /** Total position size in base asset */
  positionSize: number;

  /** Total position cost in USD */
  positionCostUsd: number;

  /** Current take profit price */
  tpPrice: number;

  /** TP order ID if placed */
  tpOrderId?: string;

  /** Unrealized PnL in USD */
  unrealizedPnl: number;

  /** Unrealized PnL as % of position */
  unrealizedPnlPercent: number;

  /** Number of filled levels */
  filledLevelCount: number;

  /** Timestamp when grid was created */
  createdAt: number;

  /** Timestamp of last state update */
  updatedAt: number;

  /** Timestamp of last trail adjustment */
  lastTrailAt?: number;

  /** Last known market price */
  lastPrice: number;
}

export type RiskState =
  | 'ACTIVE'   // Normal operation
  | 'CAPPED'   // Max position reached, no new levels
  | 'FROZEN'   // Max drawdown hit, emergency stop
  | 'PAUSED'   // Manually paused
  | 'CLOSED';  // Grid closed

// ============================================================================
// Exchange Types
// ============================================================================

export interface ExchangeOrder {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET' | 'STOP_MARKET';
  price: number;
  quantity: number;
  status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED';
  filledQty: number;
  avgFillPrice: number;
  createdAt: number;
  updatedAt: number;
}

export interface ExchangePosition {
  symbol: string;
  side: 'LONG' | 'SHORT' | 'BOTH';
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  liquidationPrice: number;
}

export interface ExchangeBalance {
  asset: string;
  available: number;
  total: number;
  unrealizedPnl: number;
}

// ============================================================================
// Event Types
// ============================================================================

export interface GridEvent {
  type: GridEventType;
  gridId: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export type GridEventType =
  | 'GRID_CREATED'
  | 'GRID_STARTED'
  | 'LEVEL_PLACED'
  | 'LEVEL_FILLED'
  | 'LEVEL_CANCELLED'
  | 'TP_PLACED'
  | 'TP_FILLED'
  | 'TP_ADJUSTED'
  | 'GRID_TRAILED'
  | 'GRID_RECENTERED'
  | 'RISK_CAPPED'
  | 'RISK_FROZEN'
  | 'GRID_PAUSED'
  | 'GRID_RESUMED'
  | 'GRID_CLOSED'
  | 'ERROR';

// ============================================================================
// Command Types
// ============================================================================

export interface StartGridCommand {
  symbol: string;
  side?: 'LONG' | 'SHORT';
  baseOrderUsd: number;
  rangePercent?: number;
  positionScale?: number;
  stepScale?: number;
  tpPercent?: number;
  maxPositionUsd?: number;
  leverage?: number;
}

export interface AdjustGridCommand {
  gridId: string;
  tpPercent?: number;
  maxPositionUsd?: number;
  maxDrawdownPercent?: number;
}

export interface CloseGridCommand {
  gridId: string;
  keepPosition?: boolean;
}

// ============================================================================
// Result Types
// ============================================================================

export interface GridResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
}

export interface GridCalculation {
  levels: GridLevel[];
  totalLevels: number;
  totalSizeUsd: number;
  worstCaseAvgEntry: number;
  worstCaseTpPrice: number;
  requiredMargin: number;
}

// ============================================================================
// Storage Types
// ============================================================================

export interface GridStorage {
  version: number;
  grids: Record<string, GridState>;
  lastUpdated: number;
}

export const STORAGE_VERSION = 1;
