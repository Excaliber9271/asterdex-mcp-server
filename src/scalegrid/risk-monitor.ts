/**
 * ScaleGrid Trading System - Risk Monitor
 *
 * Implements three circuit breakers:
 * 1. Max Position Size - caps total position
 * 2. Max Drawdown % - freezes grid on excessive loss
 * 3. Max Grid Range - limits how far we chase
 */

import { GridState, GridConfig, RiskState, GridEvent, GridEventType } from './types.js';

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
  newState?: RiskState;
  event?: GridEvent;
}

export interface RiskStatus {
  state: RiskState;
  positionPercent: number; // % of max position used
  drawdownPercent: number; // Current unrealized drawdown %
  rangePercent: number; // % of max range used
  warnings: string[];
}

export class RiskMonitor {
  // ============================================================================
  // Circuit Breaker Checks
  // ============================================================================

  /**
   * Check if placing a new level is allowed
   */
  checkCanPlaceLevel(
    grid: GridState,
    levelSizeUsd: number,
    levelDistancePercent: number
  ): RiskCheckResult {
    const { config } = grid;

    // Check 1: Max Position Size
    const newPositionCost = grid.positionCostUsd + levelSizeUsd;
    if (newPositionCost > config.maxPositionUsd) {
      return {
        allowed: false,
        reason: `Would exceed max position ($${newPositionCost.toFixed(2)} > $${config.maxPositionUsd})`,
        newState: 'CAPPED',
        event: this.createEvent(grid.id, 'RISK_CAPPED', {
          trigger: 'MAX_POSITION',
          current: grid.positionCostUsd,
          attempted: newPositionCost,
          limit: config.maxPositionUsd,
        }),
      };
    }

    // Check 2: Max Drawdown (only if we have a position)
    if (grid.positionSize > 0 && grid.unrealizedPnlPercent < -config.maxDrawdownPercent) {
      return {
        allowed: false,
        reason: `Drawdown exceeds limit (${grid.unrealizedPnlPercent.toFixed(1)}% < -${config.maxDrawdownPercent}%)`,
        newState: 'FROZEN',
        event: this.createEvent(grid.id, 'RISK_FROZEN', {
          trigger: 'MAX_DRAWDOWN',
          current: grid.unrealizedPnlPercent,
          limit: -config.maxDrawdownPercent,
        }),
      };
    }

    // Check 3: Max Grid Range
    if (levelDistancePercent > config.maxRangePercent) {
      return {
        allowed: false,
        reason: `Level distance exceeds max range (${levelDistancePercent.toFixed(1)}% > ${config.maxRangePercent}%)`,
        newState: grid.riskState, // Don't change state, just skip this level
      };
    }

    return { allowed: true };
  }

  /**
   * Check if grid should be frozen due to drawdown
   */
  checkDrawdown(grid: GridState): RiskCheckResult {
    if (grid.positionSize === 0) {
      return { allowed: true };
    }

    if (grid.unrealizedPnlPercent < -grid.config.maxDrawdownPercent) {
      return {
        allowed: false,
        reason: `Drawdown limit breached: ${grid.unrealizedPnlPercent.toFixed(1)}%`,
        newState: 'FROZEN',
        event: this.createEvent(grid.id, 'RISK_FROZEN', {
          trigger: 'MAX_DRAWDOWN',
          current: grid.unrealizedPnlPercent,
          limit: -grid.config.maxDrawdownPercent,
          positionSize: grid.positionSize,
          unrealizedPnl: grid.unrealizedPnl,
        }),
      };
    }

    return { allowed: true };
  }

  /**
   * Check if re-centering is allowed
   */
  checkCanRecenter(grid: GridState, newRangePercent: number): RiskCheckResult {
    // Can't recenter if frozen
    if (grid.riskState === 'FROZEN') {
      return {
        allowed: false,
        reason: 'Grid is frozen - cannot recenter',
      };
    }

    // Check position limit
    if (grid.positionCostUsd >= grid.config.maxPositionUsd) {
      return {
        allowed: false,
        reason: 'Max position reached - cannot add more levels',
        newState: 'CAPPED',
      };
    }

    // Check range limit
    if (newRangePercent > grid.config.maxRangePercent) {
      return {
        allowed: false,
        reason: `New range (${newRangePercent.toFixed(1)}%) exceeds max (${grid.config.maxRangePercent}%)`,
      };
    }

    return { allowed: true };
  }

  // ============================================================================
  // Status & Monitoring
  // ============================================================================

  /**
   * Get comprehensive risk status for a grid
   */
  getRiskStatus(grid: GridState): RiskStatus {
    const { config } = grid;
    const warnings: string[] = [];

    // Calculate percentages
    const positionPercent = (grid.positionCostUsd / config.maxPositionUsd) * 100;
    const rangePercent = this.calculateRangeUsed(grid);

    // Generate warnings
    if (positionPercent > 80) {
      warnings.push(`Position at ${positionPercent.toFixed(0)}% of max`);
    }

    if (grid.unrealizedPnlPercent < -config.maxDrawdownPercent * 0.7) {
      warnings.push(`Drawdown at ${Math.abs(grid.unrealizedPnlPercent).toFixed(1)}% (limit: ${config.maxDrawdownPercent}%)`);
    }

    if (rangePercent > 80) {
      warnings.push(`Range at ${rangePercent.toFixed(0)}% of max`);
    }

    // Check for approaching limits
    if (grid.riskState === 'ACTIVE') {
      if (positionPercent > 95) {
        warnings.push('⚠️ About to hit position cap');
      }
      if (grid.unrealizedPnlPercent < -config.maxDrawdownPercent * 0.9) {
        warnings.push('⚠️ About to trigger drawdown freeze');
      }
    }

    return {
      state: grid.riskState,
      positionPercent,
      drawdownPercent: Math.abs(Math.min(0, grid.unrealizedPnlPercent)),
      rangePercent,
      warnings,
    };
  }

  /**
   * Calculate current range used as percentage of max
   */
  private calculateRangeUsed(grid: GridState): number {
    if (grid.levels.length === 0) return 0;

    // Find the furthest level from entry
    let maxDistance = 0;
    for (const level of grid.levels) {
      if (level.distancePercent > maxDistance) {
        maxDistance = level.distancePercent;
      }
    }

    return (maxDistance / grid.config.maxRangePercent) * 100;
  }

  // ============================================================================
  // State Transitions
  // ============================================================================

  /**
   * Check if grid can transition from current state
   */
  canTransition(grid: GridState, toState: RiskState): boolean {
    const { riskState: fromState } = grid;

    // State machine rules
    const transitions: Record<RiskState, RiskState[]> = {
      ACTIVE: ['CAPPED', 'FROZEN', 'PAUSED', 'CLOSED'],
      CAPPED: ['ACTIVE', 'FROZEN', 'PAUSED', 'CLOSED'],
      FROZEN: ['PAUSED', 'CLOSED'], // Can't go back to ACTIVE/CAPPED without manual intervention
      PAUSED: ['ACTIVE', 'CAPPED', 'FROZEN', 'CLOSED'],
      CLOSED: [], // Terminal state
    };

    return transitions[fromState]?.includes(toState) ?? false;
  }

  /**
   * Attempt to resume a frozen grid (manual intervention)
   */
  checkCanResume(grid: GridState): RiskCheckResult {
    // Can resume if drawdown has recovered
    if (grid.unrealizedPnlPercent > -grid.config.maxDrawdownPercent * 0.5) {
      return {
        allowed: true,
        newState: grid.positionCostUsd >= grid.config.maxPositionUsd ? 'CAPPED' : 'ACTIVE',
      };
    }

    return {
      allowed: false,
      reason: `Drawdown still too high: ${grid.unrealizedPnlPercent.toFixed(1)}% (need > -${(grid.config.maxDrawdownPercent * 0.5).toFixed(1)}% to resume)`,
    };
  }

  // ============================================================================
  // Event Creation
  // ============================================================================

  private createEvent(gridId: string, type: GridEventType, data: Record<string, unknown>): GridEvent {
    return {
      type,
      gridId,
      timestamp: Date.now(),
      data,
    };
  }

  // ============================================================================
  // Formatting
  // ============================================================================

  /**
   * Format risk status for display
   */
  formatRiskStatus(status: RiskStatus): string {
    const stateEmoji = {
      ACTIVE: '🟢',
      CAPPED: '🟡',
      FROZEN: '🔴',
      PAUSED: '⏸️',
      CLOSED: '⬛',
    };

    const lines: string[] = [
      `${stateEmoji[status.state]} Risk State: ${status.state}`,
      `├─ Position: ${status.positionPercent.toFixed(0)}% of max`,
      `├─ Drawdown: ${status.drawdownPercent.toFixed(1)}%`,
      `└─ Range: ${status.rangePercent.toFixed(0)}% of max`,
    ];

    if (status.warnings.length > 0) {
      lines.push('');
      lines.push('Warnings:');
      for (const warning of status.warnings) {
        lines.push(`  ${warning}`);
      }
    }

    return lines.join('\n');
  }
}
