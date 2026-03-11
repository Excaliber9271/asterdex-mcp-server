/**
 * Grid Trading Strategy
 *
 * Creates a grid of buy and sell orders to profit from price oscillation:
 * 1. Define price range (upper/lower bounds)
 * 2. Place buy orders below current price, sell orders above
 * 3. When a buy fills, place a sell at the next grid level up
 * 4. When a sell fills, place a buy at the next grid level down
 *
 * Best for: Ranging/sideways markets
 * Risk: Trending markets can cause losses (inventory accumulates in wrong direction)
 */

import { AsterTradingClient, OrderParams } from '../aster-trading-client.js';
import { AsterClient } from '../aster-client.js';
import {
  GridConfig,
  StrategyState,
  StrategyResult,
} from './types.js';

export interface GridLevel {
  price: number;
  side: 'BUY' | 'SELL';
  orderId?: number;
  status: 'pending' | 'placed' | 'filled' | 'cancelled';
  filledAt?: number;
  quantity: number;
}

export interface GridState {
  config: GridConfig;
  levels: GridLevel[];
  currentPrice: number;
  totalBuysFilled: number;
  totalSellsFilled: number;
  realizedPnL: number;
  inventory: number; // Net position (positive = long, negative = short)
}

export class GridTradingStrategy {
  private tradingClient: AsterTradingClient;
  private marketClient: AsterClient;
  private state: StrategyState;
  private gridState: GridState | null = null;
  private refreshInterval: NodeJS.Timeout | null = null;

  constructor(tradingClient: AsterTradingClient, marketClient: AsterClient) {
    this.tradingClient = tradingClient;
    this.marketClient = marketClient;
    this.state = this.initializeState();
  }

  private initializeState(): StrategyState {
    return {
      id: `grid-${Date.now()}`,
      type: 'grid-trading',
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
   * Calculate grid levels based on config
   */
  calculateGridLevels(config: GridConfig, currentPrice: number): GridLevel[] {
    const { lowerPrice, upperPrice, gridLevels, quantityPerGrid } = config;
    const priceStep = (upperPrice - lowerPrice) / (gridLevels - 1);
    const levels: GridLevel[] = [];

    for (let i = 0; i < gridLevels; i++) {
      const price = lowerPrice + (priceStep * i);
      const side = price < currentPrice ? 'BUY' : 'SELL';

      levels.push({
        price: parseFloat(price.toFixed(2)),
        side,
        status: 'pending',
        quantity: quantityPerGrid,
      });
    }

    return levels;
  }

  /**
   * Calculate optimal grid parameters based on volatility
   */
  async suggestGridParams(
    symbol: string,
    usdBudget: number,
    leverage: number = 5
  ): Promise<{
    lowerPrice: number;
    upperPrice: number;
    gridLevels: number;
    quantityPerGrid: number;
    estimatedProfitPerGrid: number;
  }> {
    // Get recent price data
    const klineResponse = await this.marketClient.getKlines(symbol, '1h', 24);
    const priceResponse = await this.marketClient.getPrice(symbol);

    if (!klineResponse.success || !priceResponse.success) {
      throw new Error('Failed to fetch market data');
    }

    const currentPrice = parseFloat(priceResponse.data?.price || '0');
    const klines = klineResponse.data || [];

    // Calculate 24h high/low
    let high = 0;
    let low = Infinity;
    for (const k of klines) {
      high = Math.max(high, parseFloat(k.high));
      low = Math.min(low, parseFloat(k.low));
    }

    // Add buffer
    const range = high - low;
    const lowerPrice = low - (range * 0.1);
    const upperPrice = high + (range * 0.1);

    // Suggest 5-10 grid levels based on range
    const rangePercent = ((upperPrice - lowerPrice) / currentPrice) * 100;
    const gridLevels = Math.min(10, Math.max(5, Math.floor(rangePercent / 2)));

    // Calculate quantity per grid
    const totalNotional = usdBudget * leverage;
    const quantityPerGrid = totalNotional / gridLevels / currentPrice;

    // Estimate profit per grid cycle (buy low -> sell high)
    const priceStep = (upperPrice - lowerPrice) / (gridLevels - 1);
    const estimatedProfitPerGrid = quantityPerGrid * priceStep;

    return {
      lowerPrice: parseFloat(lowerPrice.toFixed(2)),
      upperPrice: parseFloat(upperPrice.toFixed(2)),
      gridLevels,
      quantityPerGrid: parseFloat(quantityPerGrid.toFixed(6)),
      estimatedProfitPerGrid: parseFloat(estimatedProfitPerGrid.toFixed(4)),
    };
  }

  /**
   * Start the grid strategy
   */
  async start(config: GridConfig): Promise<StrategyResult> {
    try {
      // Set leverage
      await this.tradingClient.setLeverage(config.symbol, config.leverage);

      // Get current price
      const priceResponse = await this.marketClient.getPrice(config.symbol);
      if (!priceResponse.success || !priceResponse.data) {
        return { success: false, message: 'Failed to get current price' };
      }
      const currentPrice = parseFloat(priceResponse.data.price);

      // Calculate grid levels
      const levels = this.calculateGridLevels(config, currentPrice);

      // Initialize grid state
      this.gridState = {
        config,
        levels,
        currentPrice,
        totalBuysFilled: 0,
        totalSellsFilled: 0,
        realizedPnL: 0,
        inventory: 0,
      };

      // Place initial orders
      const placementResult = await this.placeGridOrders();

      this.state.status = 'running';
      this.state.startedAt = Date.now();

      return {
        success: true,
        message: `Grid started on ${config.symbol}`,
        data: {
          symbol: config.symbol,
          range: `${config.lowerPrice} - ${config.upperPrice}`,
          levels: levels.length,
          ordersPlaced: placementResult.placed,
          currentPrice,
        },
      };
    } catch (error: any) {
      this.state.status = 'error';
      this.state.error = error.message;
      return { success: false, message: 'Failed to start grid', error: error.message };
    }
  }

  /**
   * Place grid orders (initial or refresh)
   */
  private async placeGridOrders(): Promise<{ placed: number; failed: number }> {
    if (!this.gridState) {
      return { placed: 0, failed: 0 };
    }

    let placed = 0;
    let failed = 0;

    // Group orders into batches of 5 (API limit)
    const pendingLevels = this.gridState.levels.filter(l => l.status === 'pending');

    for (let i = 0; i < pendingLevels.length; i += 5) {
      const batch = pendingLevels.slice(i, i + 5);
      const orders: OrderParams[] = batch.map(level => ({
        symbol: this.gridState!.config.symbol,
        side: level.side,
        type: 'LIMIT',
        quantity: level.quantity.toString(),
        price: level.price.toString(),
        timeInForce: 'GTC',
      }));

      const result = await this.tradingClient.placeBatchOrders(orders);

      if (result.success && result.data) {
        result.data.forEach((orderResult: any, idx: number) => {
          if (orderResult.orderId) {
            batch[idx].orderId = orderResult.orderId;
            batch[idx].status = 'placed';
            placed++;
            this.state.stats.totalTrades++;
          } else {
            batch[idx].status = 'pending'; // Keep pending for retry
            failed++;
            this.state.stats.failedTrades++;
          }
        });
      } else {
        failed += batch.length;
      }
    }

    return { placed, failed };
  }

  /**
   * Check and update grid state
   */
  async refresh(): Promise<StrategyResult> {
    if (!this.gridState || this.state.status !== 'running') {
      return { success: false, message: 'Grid not running' };
    }

    try {
      // Get current open orders
      const ordersResponse = await this.tradingClient.getOpenOrders(this.gridState.config.symbol);
      const openOrders = ordersResponse.success ? ordersResponse.data || [] : [];
      const openOrderIds = new Set(openOrders.map((o: any) => o.orderId));

      // Check for filled orders
      let newFills = 0;
      for (const level of this.gridState.levels) {
        if (level.status === 'placed' && level.orderId && !openOrderIds.has(level.orderId)) {
          // Order was filled
          level.status = 'filled';
          level.filledAt = Date.now();
          newFills++;

          if (level.side === 'BUY') {
            this.gridState.totalBuysFilled++;
            this.gridState.inventory += level.quantity;
          } else {
            this.gridState.totalSellsFilled++;
            this.gridState.inventory -= level.quantity;
          }

          this.state.stats.successfulTrades++;
        }
      }

      // Update current price
      const priceResponse = await this.marketClient.getPrice(this.gridState.config.symbol);
      if (priceResponse.success && priceResponse.data) {
        this.gridState.currentPrice = parseFloat(priceResponse.data.price);
      }

      // Calculate realized PnL (simplified: assumes each grid cycle profits by 1 grid step)
      const gridStep = (this.gridState.config.upperPrice - this.gridState.config.lowerPrice) /
                       (this.gridState.config.gridLevels - 1);
      const completedCycles = Math.min(this.gridState.totalBuysFilled, this.gridState.totalSellsFilled);
      this.gridState.realizedPnL = completedCycles * gridStep * this.gridState.config.quantityPerGrid;
      this.state.stats.totalPnL = this.gridState.realizedPnL;

      return {
        success: true,
        message: `Grid refreshed. ${newFills} new fills.`,
        data: {
          newFills,
          totalBuys: this.gridState.totalBuysFilled,
          totalSells: this.gridState.totalSellsFilled,
          inventory: this.gridState.inventory,
          realizedPnL: this.gridState.realizedPnL,
          currentPrice: this.gridState.currentPrice,
        },
      };
    } catch (error: any) {
      return { success: false, message: 'Failed to refresh grid', error: error.message };
    }
  }

  /**
   * Get grid status
   */
  getStatus(): {
    state: StrategyState;
    grid: GridState | null;
  } {
    return {
      state: this.state,
      grid: this.gridState,
    };
  }

  /**
   * Stop the grid and optionally close all positions
   */
  async stop(closePositions: boolean = true): Promise<StrategyResult> {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }

    if (!this.gridState) {
      return { success: false, message: 'No grid running' };
    }

    try {
      // Cancel all open orders
      await this.tradingClient.cancelAllOrders(this.gridState.config.symbol);

      // Close positions if requested
      if (closePositions && this.gridState.inventory !== 0) {
        await this.tradingClient.closePosition(this.gridState.config.symbol);
      }

      this.state.status = 'stopped';
      this.state.stoppedAt = Date.now();
      this.state.stats.runtime = this.state.stoppedAt - (this.state.startedAt || this.state.stoppedAt);

      const summary = {
        totalBuysFilled: this.gridState.totalBuysFilled,
        totalSellsFilled: this.gridState.totalSellsFilled,
        realizedPnL: this.gridState.realizedPnL,
        runtime: this.state.stats.runtime,
      };

      this.gridState = null;

      return {
        success: true,
        message: 'Grid stopped',
        data: summary,
      };
    } catch (error: any) {
      return { success: false, message: 'Error stopping grid', error: error.message };
    }
  }
}
