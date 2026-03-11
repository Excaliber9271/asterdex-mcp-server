/**
 * Strategy Types and Interfaces
 */

export type StrategyStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'error';

export interface StrategyState {
  id: string;
  type: string;
  status: StrategyStatus;
  startedAt?: number;
  stoppedAt?: number;
  error?: string;
  stats: StrategyStats;
}

export interface StrategyStats {
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  totalPnL: number;
  totalFees: number;
  netPnL: number;
  runtime: number; // milliseconds
}

export interface StrategyConfig {
  symbol: string;
  maxPositionSize?: number;
  stopLossPercent?: number;
}

// Funding Farm specific
export interface FundingFarmConfig {
  symbol?: string;             // Optional - if omitted, auto-selects best opportunity
  minFundingRate: number;      // Minimum absolute funding rate to enter (e.g., 0.0005 = 0.05%)
  positionSizeUsd: number;     // USD size of position
  leverage: number;            // Leverage to use
  stopLossPercent?: number;    // Stop loss percentage
  hedgeOnCex?: boolean;        // Whether to hedge on CEX (future feature)
  autoCompound?: boolean;      // Reinvest profits
  maxPositions?: number;       // Max concurrent positions
}

// Grid Trading specific
export interface GridConfig extends StrategyConfig {
  lowerPrice: number;          // Grid lower bound
  upperPrice: number;          // Grid upper bound
  gridLevels: number;          // Number of grid lines
  quantityPerGrid: number;     // Quantity at each level (USD value)
  leverage: number;
  mode?: 'long' | 'short' | 'neutral'; // Grid bias (default: neutral)
}

export interface StrategyResult {
  success: boolean;
  message: string;
  data?: any;
  error?: string;
}
