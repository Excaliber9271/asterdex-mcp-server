/**
 * Funding Farm Strategy
 *
 * Captures funding rate payments by:
 * 1. Finding pairs with extreme funding rates
 * 2. Going opposite to the crowd (short when funding is positive, long when negative)
 * 3. Collecting funding every 8 hours
 * 4. Exiting when funding normalizes or hits stop loss
 *
 * Risk: Price can move against you faster than funding accumulates
 * Best for: Sideways/ranging markets with extreme funding
 */

import { AsterTradingClient } from '../aster-trading-client.js';
import { AsterClient } from '../aster-client.js';
import {
  FundingFarmConfig,
  StrategyState,
  StrategyStats,
  StrategyResult,
} from './types.js';

export interface FundingOpportunity {
  symbol: string;
  fundingRate: number;
  fundingRateAnnualized: number;
  markPrice: number;
  nextFundingTime: number;
  recommendedSide: 'LONG' | 'SHORT';
  hoursUntilFunding: number;
}

export interface ActiveFundingPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  quantity: number;
  entryFundingRate: number;
  fundingCollected: number;
  unrealizedPnL: number;
  enteredAt: number;
}

export class FundingFarmStrategy {
  private tradingClient: AsterTradingClient;
  private marketClient: AsterClient;
  private state: StrategyState;
  private config: FundingFarmConfig | null = null;
  private activePositions: Map<string, ActiveFundingPosition> = new Map();
  private monitorInterval: NodeJS.Timeout | null = null;

  constructor(tradingClient: AsterTradingClient, marketClient: AsterClient) {
    this.tradingClient = tradingClient;
    this.marketClient = marketClient;
    this.state = this.initializeState();
  }

  private initializeState(): StrategyState {
    return {
      id: `funding-farm-${Date.now()}`,
      type: 'funding-farm',
      status: 'idle',
      stats: {
        totalTrades: 0,
        successfulTrades: 0,
        failedTrades: 0,
        totalPnL: 0,
        totalFees: 0,
        netPnL: 0,
        runtime: 0,
      },
    };
  }

  /**
   * Scan market for funding opportunities
   */
  async scanOpportunities(minRate: number = 0.0003): Promise<FundingOpportunity[]> {
    const response = await this.marketClient.getPremiumIndex();
    if (!response.success || !response.data) {
      return [];
    }

    const data = Array.isArray(response.data) ? response.data : [response.data];
    const now = Date.now();

    const opportunities: FundingOpportunity[] = data
      .filter((d: any) => Math.abs(parseFloat(d.lastFundingRate || '0')) >= minRate)
      .map((d: any) => {
        const fundingRate = parseFloat(d.lastFundingRate || '0');
        const nextFundingTime = parseInt(d.nextFundingTime || '0');
        const hoursUntilFunding = (nextFundingTime - now) / (1000 * 60 * 60);

        return {
          symbol: d.symbol,
          fundingRate,
          fundingRateAnnualized: fundingRate * 3 * 365 * 100, // Percentage
          markPrice: parseFloat(d.markPrice || '0'),
          nextFundingTime,
          recommendedSide: fundingRate > 0 ? 'SHORT' as const : 'LONG' as const,
          hoursUntilFunding: Math.max(0, hoursUntilFunding),
        };
      })
      .sort((a, b) => Math.abs(b.fundingRate) - Math.abs(a.fundingRate));

    return opportunities;
  }

  /**
   * Enter a funding farm position
   */
  async enterPosition(
    symbol: string,
    side: 'LONG' | 'SHORT',
    usdAmount: number,
    leverage: number = 5,
    stopLossPercent: number = 3
  ): Promise<StrategyResult> {
    try {
      // Get current funding rate
      const premiumResponse = await this.marketClient.getPremiumIndex(symbol);
      if (!premiumResponse.success || !premiumResponse.data) {
        return { success: false, message: 'Failed to get funding rate', error: premiumResponse.error };
      }

      // Handle both single object and array responses
      const premiumData = Array.isArray(premiumResponse.data)
        ? premiumResponse.data[0]
        : premiumResponse.data;

      const fundingRate = parseFloat(premiumData?.lastFundingRate || '0');
      const markPrice = parseFloat(premiumData?.markPrice || '0');

      // Open position with stop loss
      const openResult = await this.tradingClient.openPosition({
        symbol,
        side,
        usdAmount,
        leverage,
        stopLossPercent,
      });

      if (!openResult.success) {
        this.state.stats.failedTrades++;
        return { success: false, message: 'Failed to open position', error: openResult.error };
      }

      // Track the position
      const quantity = (usdAmount * leverage) / markPrice;
      const position: ActiveFundingPosition = {
        symbol,
        side,
        entryPrice: markPrice,
        quantity,
        entryFundingRate: fundingRate,
        fundingCollected: 0,
        unrealizedPnL: 0,
        enteredAt: Date.now(),
      };

      this.activePositions.set(symbol, position);
      this.state.stats.totalTrades++;
      this.state.stats.successfulTrades++;

      return {
        success: true,
        message: `Entered ${side} position on ${symbol}`,
        data: {
          position,
          expectedFundingPerInterval: Math.abs(fundingRate) * usdAmount * leverage,
          annualizedYield: `${(Math.abs(fundingRate) * 3 * 365 * 100).toFixed(1)}%`,
        },
      };
    } catch (error: any) {
      this.state.stats.failedTrades++;
      return { success: false, message: 'Error entering position', error: error.message };
    }
  }

  /**
   * Exit a funding farm position
   */
  async exitPosition(symbol: string): Promise<StrategyResult> {
    try {
      const position = this.activePositions.get(symbol);
      if (!position) {
        return { success: false, message: `No active position for ${symbol}` };
      }

      const closeResult = await this.tradingClient.closePosition(symbol);
      if (!closeResult.success) {
        return { success: false, message: 'Failed to close position', error: closeResult.error };
      }

      // Get final PnL
      const posResponse = await this.tradingClient.getPositions(symbol);
      let realizedPnL = 0;
      if (posResponse.success && posResponse.data) {
        const pos = posResponse.data.find((p: any) => p.symbol === symbol);
        if (pos) {
          realizedPnL = parseFloat(pos.unRealizedProfit || '0');
        }
      }

      // Update stats
      this.state.stats.totalPnL += realizedPnL + position.fundingCollected;
      this.state.stats.netPnL = this.state.stats.totalPnL - this.state.stats.totalFees;

      this.activePositions.delete(symbol);

      return {
        success: true,
        message: `Closed ${symbol} position`,
        data: {
          holdTime: Date.now() - position.enteredAt,
          fundingCollected: position.fundingCollected,
          pricePnL: realizedPnL,
          totalPnL: realizedPnL + position.fundingCollected,
        },
      };
    } catch (error: any) {
      return { success: false, message: 'Error exiting position', error: error.message };
    }
  }

  /**
   * Get current strategy status
   */
  getStatus(): {
    state: StrategyState;
    activePositions: ActiveFundingPosition[];
    config: FundingFarmConfig | null;
  } {
    return {
      state: this.state,
      activePositions: Array.from(this.activePositions.values()),
      config: this.config,
    };
  }

  /**
   * Calculate expected funding earnings
   */
  calculateExpectedEarnings(
    fundingRate: number,
    positionSizeUsd: number,
    leverage: number,
    daysHeld: number
  ): {
    perFundingInterval: number;
    perDay: number;
    total: number;
    annualizedAPY: number;
  } {
    const notionalValue = positionSizeUsd * leverage;
    const perFundingInterval = Math.abs(fundingRate) * notionalValue;
    const perDay = perFundingInterval * 3; // 3 funding intervals per day

    return {
      perFundingInterval,
      perDay,
      total: perDay * daysHeld,
      annualizedAPY: Math.abs(fundingRate) * 3 * 365 * 100,
    };
  }

  /**
   * Auto-farm: Scan and enter best opportunities
   */
  async autoFarm(config: FundingFarmConfig): Promise<StrategyResult> {
    this.config = config;
    this.state.status = 'running';
    this.state.startedAt = Date.now();

    try {
      // Find opportunities
      const opportunities = await this.scanOpportunities(config.minFundingRate);

      if (opportunities.length === 0) {
        return {
          success: false,
          message: `No opportunities found with funding rate >= ${config.minFundingRate * 100}%`,
        };
      }

      // Enter top opportunity (or specific symbol if provided)
      const symbolToFind = config.symbol;
      const target = symbolToFind
        ? opportunities.find(o => o.symbol === symbolToFind.toUpperCase())
        : opportunities[0];

      if (!target) {
        return {
          success: false,
          message: config.symbol
            ? `${config.symbol} doesn't meet minimum funding rate criteria`
            : 'No valid opportunities found',
        };
      }

      const result = await this.enterPosition(
        target.symbol,
        target.recommendedSide,
        config.positionSizeUsd,
        config.leverage,
        config.stopLossPercent || 3
      );

      return result;
    } catch (error: any) {
      this.state.status = 'error';
      this.state.error = error.message;
      return { success: false, message: 'Auto-farm failed', error: error.message };
    }
  }

  /**
   * Stop the strategy
   */
  async stop(closePositions: boolean = true): Promise<StrategyResult> {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }

    if (closePositions) {
      for (const [symbol] of this.activePositions) {
        await this.exitPosition(symbol);
      }
    }

    this.state.status = 'stopped';
    this.state.stoppedAt = Date.now();
    this.state.stats.runtime = (this.state.stoppedAt - (this.state.startedAt || this.state.stoppedAt));

    return {
      success: true,
      message: 'Funding farm stopped',
      data: this.state.stats,
    };
  }
}
