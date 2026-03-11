/**
 * ScaleGrid Trading System - Main Engine
 *
 * Orchestrates grid management, order execution, and monitoring.
 */

import { EventEmitter } from 'events';
import {
  GridConfig,
  GridState,
  GridResult,
  GridLevel,
  GridEvent,
  GridEventType,
  StartGridCommand,
  AdjustGridCommand,
  CloseGridCommand,
  RiskState,
} from './types.js';
import {
  calculateGridLevels,
  calculateAvgEntry,
  calculateTpPrice,
  calculateUnrealizedPnl,
  calculateTrailedLevels,
  calculateRecenterLevels,
  mergeConfig,
  validateConfig,
  formatGridCalculation,
  roundQuantity,
} from './grid-manager.js';
import { StateManager } from './state-manager.js';
import { RiskMonitor } from './risk-monitor.js';
import { ExchangeAdapter } from './exchanges/adapter.js';
import { AsterAdapter } from './exchanges/aster-adapter.js';

export interface EngineConfig {
  /** Path to state file */
  statePath?: string;
  /** Enable auto-trailing */
  autoTrail?: boolean;
  /** Enable auto-recenter */
  autoRecenter?: boolean;
}

export class ScaleGridEngine extends EventEmitter {
  private stateManager: StateManager;
  private riskMonitor: RiskMonitor;
  private exchange: ExchangeAdapter;
  private config: EngineConfig;

  private running: boolean = false;
  private monitorInterval: NodeJS.Timeout | null = null;

  constructor(config: EngineConfig = {}) {
    super();
    this.config = {
      autoTrail: true,
      autoRecenter: true,
      ...config,
    };

    this.stateManager = new StateManager(config.statePath);
    this.riskMonitor = new RiskMonitor();
    this.exchange = new AsterAdapter();
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Initialize the engine
   */
  async initialize(apiKey: string, apiSecret: string): Promise<GridResult<void>> {
    try {
      // Set exchange credentials
      (this.exchange as AsterAdapter).setCredentials(apiKey, apiSecret);

      // Check connection
      const ready = await this.exchange.isReady();
      if (!ready) {
        return { success: false, error: 'Exchange connection failed', timestamp: Date.now() };
      }

      // Load state
      await this.stateManager.initialize();

      // Reconcile active grids
      for (const grid of this.stateManager.getActiveGrids()) {
        await this.reconcileGrid(grid.id);
      }

      this.running = true;
      this.startMonitoring();

      this.emitEvent('ENGINE_STARTED', { activeGrids: this.stateManager.activeGridCount() });

      return { success: true, timestamp: Date.now() };
    } catch (error: any) {
      return { success: false, error: error.message, timestamp: Date.now() };
    }
  }

  /**
   * Shutdown the engine
   */
  async shutdown(): Promise<void> {
    this.running = false;

    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }

    await this.stateManager.shutdown();
    this.emitEvent('ENGINE_STOPPED', {});
  }

  // ============================================================================
  // Grid Operations
  // ============================================================================

  /**
   * Start a new grid
   */
  async startGrid(command: StartGridCommand): Promise<GridResult<GridState>> {
    try {
      // Validate config
      const config = mergeConfig(command);
      const validation = validateConfig(config);
      if (!validation.valid) {
        return { success: false, error: validation.errors.join(', '), timestamp: Date.now() };
      }

      // Check if symbol already has active grid
      if (this.stateManager.hasActiveGrid(config.symbol)) {
        return { success: false, error: `Active grid already exists for ${config.symbol}`, timestamp: Date.now() };
      }

      // Get current price
      const priceResult = await this.exchange.getPrice(config.symbol);
      if (!priceResult.success || !priceResult.data) {
        return { success: false, error: `Failed to get price: ${priceResult.error}`, timestamp: Date.now() };
      }
      const entryPrice = priceResult.data;

      // Calculate grid levels
      const calculation = calculateGridLevels(entryPrice, config);

      // Check if we have enough balance
      const balanceResult = await this.exchange.getBalance();
      if (!balanceResult.success || !balanceResult.data) {
        return { success: false, error: 'Failed to get balance', timestamp: Date.now() };
      }

      if (balanceResult.data.available < calculation.requiredMargin) {
        return {
          success: false,
          error: `Insufficient margin: need $${calculation.requiredMargin.toFixed(2)}, have $${balanceResult.data.available.toFixed(2)}`,
          timestamp: Date.now(),
        };
      }

      // Set leverage
      await this.exchange.setLeverage(config.symbol, config.leverage);

      // Create grid state
      const gridState = this.stateManager.createGrid(config, entryPrice, calculation.levels);

      // Calculate initial TP
      gridState.tpPrice = calculateTpPrice(entryPrice, config.tpPercent, config.side);

      // Place entry order (market or limit based on config)
      const entryLevel = gridState.levels[0];
      const entryResult = await this.placeLevel(gridState, entryLevel);

      if (!entryResult.success) {
        // Rollback
        this.stateManager.removeGrid(gridState.id);
        return { success: false, error: `Failed to place entry: ${entryResult.error}`, timestamp: Date.now() };
      }

      // Place safety orders
      for (let i = 1; i < gridState.levels.length; i++) {
        const level = gridState.levels[i];
        const riskCheck = this.riskMonitor.checkCanPlaceLevel(
          gridState,
          level.sizeUsd,
          level.distancePercent
        );

        if (!riskCheck.allowed) {
          level.status = 'SKIPPED';
          if (riskCheck.newState) {
            gridState.riskState = riskCheck.newState;
          }
          continue;
        }

        await this.placeLevel(gridState, level);
      }

      // Save state
      await this.stateManager.forceSave();

      this.emitEvent('GRID_STARTED', {
        gridId: gridState.id,
        symbol: config.symbol,
        levels: gridState.levels.length,
        entryPrice,
      });

      return { success: true, data: gridState, timestamp: Date.now() };
    } catch (error: any) {
      return { success: false, error: error.message, timestamp: Date.now() };
    }
  }

  /**
   * Get grid status
   */
  getGrid(gridIdOrSymbol: string): GridState | undefined {
    return (
      this.stateManager.getGrid(gridIdOrSymbol) ||
      this.stateManager.getGridBySymbol(gridIdOrSymbol)
    );
  }

  /**
   * Get all grids
   */
  getAllGrids(): GridState[] {
    return this.stateManager.getAllGrids();
  }

  /**
   * Get active grids
   */
  getActiveGrids(): GridState[] {
    return this.stateManager.getActiveGrids();
  }

  /**
   * Adjust grid parameters
   */
  async adjustGrid(command: AdjustGridCommand): Promise<GridResult<GridState>> {
    const grid = this.stateManager.getGrid(command.gridId);
    if (!grid) {
      return { success: false, error: 'Grid not found', timestamp: Date.now() };
    }

    // Update config
    const updates: Partial<GridState> = {};

    if (command.tpPercent !== undefined) {
      grid.config.tpPercent = command.tpPercent;
      grid.tpPrice = calculateTpPrice(grid.avgEntry, command.tpPercent, grid.config.side);
      updates.tpPrice = grid.tpPrice;

      // Update TP order on exchange
      await this.updateTpOrder(grid);
    }

    if (command.maxPositionUsd !== undefined) {
      grid.config.maxPositionUsd = command.maxPositionUsd;
    }

    if (command.maxDrawdownPercent !== undefined) {
      grid.config.maxDrawdownPercent = command.maxDrawdownPercent;
    }

    this.stateManager.updateGrid(grid.id, { config: grid.config, ...updates });

    return { success: true, data: grid, timestamp: Date.now() };
  }

  /**
   * Pause grid (stop trailing, keep orders)
   */
  async pauseGrid(gridId: string): Promise<GridResult<void>> {
    const grid = this.stateManager.getGrid(gridId);
    if (!grid) {
      return { success: false, error: 'Grid not found', timestamp: Date.now() };
    }

    if (!this.riskMonitor.canTransition(grid, 'PAUSED')) {
      return { success: false, error: 'Cannot pause grid in current state', timestamp: Date.now() };
    }

    this.stateManager.updateGrid(gridId, { riskState: 'PAUSED' });
    this.emitEvent('GRID_PAUSED', { gridId });

    return { success: true, timestamp: Date.now() };
  }

  /**
   * Resume paused grid
   */
  async resumeGrid(gridId: string): Promise<GridResult<void>> {
    const grid = this.stateManager.getGrid(gridId);
    if (!grid) {
      return { success: false, error: 'Grid not found', timestamp: Date.now() };
    }

    // Check if can resume
    const resumeCheck = this.riskMonitor.checkCanResume(grid);
    if (!resumeCheck.allowed) {
      return { success: false, error: resumeCheck.reason, timestamp: Date.now() };
    }

    this.stateManager.updateGrid(gridId, { riskState: resumeCheck.newState || 'ACTIVE' });
    this.emitEvent('GRID_RESUMED', { gridId });

    return { success: true, timestamp: Date.now() };
  }

  /**
   * Close grid
   */
  async closeGrid(command: CloseGridCommand): Promise<GridResult<void>> {
    const grid = this.stateManager.getGrid(command.gridId);
    if (!grid) {
      return { success: false, error: 'Grid not found', timestamp: Date.now() };
    }

    try {
      // Cancel all open orders for this grid
      await this.exchange.cancelAllOrders(grid.symbol);

      // Close position if requested
      if (!command.keepPosition && grid.positionSize > 0) {
        await this.exchange.closePosition(grid.symbol);
      }

      // Update state
      this.stateManager.closeGrid(grid.id);

      this.emitEvent('GRID_CLOSED', {
        gridId: grid.id,
        symbol: grid.symbol,
        keepPosition: command.keepPosition,
      });

      return { success: true, timestamp: Date.now() };
    } catch (error: any) {
      return { success: false, error: error.message, timestamp: Date.now() };
    }
  }

  // ============================================================================
  // Order Management
  // ============================================================================

  /**
   * Place a grid level order
   */
  private async placeLevel(grid: GridState, level: GridLevel): Promise<GridResult<void>> {
    const { config } = grid;
    const side = config.side === 'LONG' ? 'BUY' : 'SELL';

    // Get symbol info for precision
    const infoResult = await this.exchange.getSymbolInfo(config.symbol);
    if (!infoResult.success || !infoResult.data) {
      return { success: false, error: 'Failed to get symbol info', timestamp: Date.now() };
    }

    const quantity = roundQuantity(level.sizeBase, infoResult.data.minQuantity);

    // Place limit order
    const orderResult = await this.exchange.placeOrder({
      symbol: config.symbol,
      side,
      type: 'LIMIT',
      quantity,
      price: level.price,
      timeInForce: 'GTC',
    });

    if (!orderResult.success || !orderResult.data) {
      return { success: false, error: orderResult.error, timestamp: Date.now() };
    }

    // Update level
    level.status = 'PLACED';
    level.orderId = orderResult.data.orderId;
    this.stateManager.updateLevel(grid.id, level.index, level);

    this.emitEvent('LEVEL_PLACED', {
      gridId: grid.id,
      level: level.index,
      price: level.price,
      size: level.sizeUsd,
      orderId: level.orderId,
    });

    return { success: true, timestamp: Date.now() };
  }

  /**
   * Update take profit order
   */
  private async updateTpOrder(grid: GridState): Promise<void> {
    // Cancel existing TP if any
    if (grid.tpOrderId) {
      await this.exchange.cancelOrder(grid.symbol, grid.tpOrderId);
    }

    // Only place TP if we have a position
    if (grid.positionSize === 0) return;

    const side = grid.config.side === 'LONG' ? 'SELL' : 'BUY';

    const orderResult = await this.exchange.placeOrder({
      symbol: grid.symbol,
      side,
      type: 'LIMIT',
      quantity: grid.positionSize,
      price: grid.tpPrice,
      reduceOnly: true,
      timeInForce: 'GTC',
    });

    if (orderResult.success && orderResult.data) {
      this.stateManager.updateGrid(grid.id, { tpOrderId: orderResult.data.orderId });
      this.emitEvent('TP_ADJUSTED', {
        gridId: grid.id,
        tpPrice: grid.tpPrice,
        orderId: orderResult.data.orderId,
      });
    }
  }

  // ============================================================================
  // Monitoring & Updates
  // ============================================================================

  /**
   * Start monitoring loop
   */
  private startMonitoring(): void {
    // Check every 5 seconds
    this.monitorInterval = setInterval(() => {
      this.monitorLoop().catch(console.error);
    }, 5000);
  }

  /**
   * Main monitoring loop
   */
  private async monitorLoop(): Promise<void> {
    if (!this.running) return;

    for (const grid of this.stateManager.getActiveGrids()) {
      try {
        await this.updateGrid(grid);
      } catch (error: any) {
        console.error(`[Engine] Error updating grid ${grid.id}: ${error.message}`);
      }
    }
  }

  /**
   * Update a single grid
   */
  private async updateGrid(grid: GridState): Promise<void> {
    // Get current price
    const priceResult = await this.exchange.getPrice(grid.symbol);
    if (!priceResult.success || !priceResult.data) return;

    const currentPrice = priceResult.data;
    grid.lastPrice = currentPrice;

    // Check for filled orders
    await this.checkFills(grid);

    // Update position stats
    await this.updatePositionStats(grid);

    // Check risk limits
    const riskCheck = this.riskMonitor.checkDrawdown(grid);
    if (!riskCheck.allowed && riskCheck.newState) {
      grid.riskState = riskCheck.newState;
      this.stateManager.updateGrid(grid.id, { riskState: grid.riskState });

      if (riskCheck.event) {
        this.emit('event', riskCheck.event);
      }

      // Cancel pending orders on freeze
      if (grid.riskState === 'FROZEN') {
        await this.exchange.cancelAllOrders(grid.symbol);
      }

      return;
    }

    // Check for trailing
    if (this.config.autoTrail && grid.riskState === 'ACTIVE') {
      await this.checkTrailing(grid, currentPrice);
    }

    // Check for re-center
    if (this.config.autoRecenter && grid.riskState === 'ACTIVE') {
      await this.checkRecenter(grid, currentPrice);
    }

    this.stateManager.updateGrid(grid.id, grid);
  }

  /**
   * Check for filled orders
   */
  private async checkFills(grid: GridState): Promise<void> {
    const ordersResult = await this.exchange.getOpenOrders(grid.symbol);
    if (!ordersResult.success) return;

    const openOrderIds = new Set(ordersResult.data?.map((o) => o.orderId) || []);

    for (const level of grid.levels) {
      if (level.status !== 'PLACED' || !level.orderId) continue;

      // If order not in open orders, it was filled or cancelled
      if (!openOrderIds.has(level.orderId)) {
        // Get order status
        const orderResult = await this.exchange.getOrder(grid.symbol, level.orderId);

        if (orderResult.success && orderResult.data) {
          if (orderResult.data.status === 'FILLED') {
            level.status = 'FILLED';
            level.fillPrice = orderResult.data.avgFillPrice;
            level.fillQty = orderResult.data.filledQty;
            level.filledAt = Date.now();

            this.emitEvent('LEVEL_FILLED', {
              gridId: grid.id,
              level: level.index,
              fillPrice: level.fillPrice,
              fillQty: level.fillQty,
            });
          } else if (orderResult.data.status === 'CANCELLED') {
            level.status = 'CANCELLED';
            this.emitEvent('LEVEL_CANCELLED', {
              gridId: grid.id,
              level: level.index,
            });
          }
        }
      }
    }

    // Update filled count
    grid.filledLevelCount = grid.levels.filter((l) => l.status === 'FILLED').length;
  }

  /**
   * Update position statistics
   */
  private async updatePositionStats(grid: GridState): Promise<void> {
    // Calculate from filled levels
    const { avgEntry, totalSize, totalCost } = calculateAvgEntry(grid.levels);

    if (totalSize > 0) {
      grid.avgEntry = avgEntry;
      grid.positionSize = totalSize;
      grid.positionCostUsd = totalCost;
      grid.tpPrice = calculateTpPrice(avgEntry, grid.config.tpPercent, grid.config.side);

      // Calculate unrealized PnL
      const pnl = calculateUnrealizedPnl(avgEntry, grid.lastPrice, totalSize, grid.config.side);
      grid.unrealizedPnl = pnl.pnl;
      grid.unrealizedPnlPercent = pnl.pnlPercent;
    }
  }

  /**
   * Check if trailing is needed
   */
  private async checkTrailing(grid: GridState, currentPrice: number): Promise<void> {
    const threshold = grid.config.trailThresholdPercent;
    const priceDiff = ((currentPrice - grid.entryPrice) / grid.entryPrice) * 100;

    // Only trail up (for long grids)
    if (grid.config.side === 'LONG' && priceDiff > threshold) {
      await this.trailGrid(grid, currentPrice);
    }

    // For short grids, trail down
    if (grid.config.side === 'SHORT' && priceDiff < -threshold) {
      await this.trailGrid(grid, currentPrice);
    }
  }

  /**
   * Trail grid to new entry price
   */
  private async trailGrid(grid: GridState, newEntryPrice: number): Promise<void> {
    // Cancel unfilled orders
    for (const level of grid.levels) {
      if (level.status === 'PLACED' && level.orderId) {
        await this.exchange.cancelOrder(grid.symbol, level.orderId);
        level.status = 'CANCELLED';
      }
    }

    // Calculate new levels
    const newLevels = calculateTrailedLevels(
      grid.levels,
      grid.entryPrice,
      newEntryPrice,
      grid.config
    );

    // Place new orders for unfilled levels
    for (const level of newLevels) {
      if (level.status === 'CANCELLED' || level.status === 'PENDING') {
        level.status = 'PENDING';
        const riskCheck = this.riskMonitor.checkCanPlaceLevel(grid, level.sizeUsd, level.distancePercent);

        if (riskCheck.allowed) {
          await this.placeLevel(grid, level);
        } else {
          level.status = 'SKIPPED';
        }
      }
    }

    grid.entryPrice = newEntryPrice;
    grid.levels = newLevels;
    grid.lastTrailAt = Date.now();

    this.emitEvent('GRID_TRAILED', {
      gridId: grid.id,
      oldEntry: grid.entryPrice,
      newEntry: newEntryPrice,
    });
  }

  /**
   * Check if re-centering is needed
   */
  private async checkRecenter(grid: GridState, currentPrice: number): Promise<void> {
    // Only recenter if all levels are filled
    const allFilled = grid.levels.every(
      (l) => l.status === 'FILLED' || l.status === 'SKIPPED' || l.status === 'CANCELLED'
    );

    if (!allFilled) return;

    // Calculate new range
    const newRange = Math.abs(((currentPrice - grid.avgEntry) / grid.avgEntry) * 100);

    // Check if recenter is allowed
    const riskCheck = this.riskMonitor.checkCanRecenter(grid, newRange);
    if (!riskCheck.allowed) return;

    // Calculate new levels
    const newLevels = calculateRecenterLevels(currentPrice, grid.levels, grid.config);

    // Place new safety orders
    for (const level of newLevels) {
      const canPlace = this.riskMonitor.checkCanPlaceLevel(grid, level.sizeUsd, level.distancePercent);
      if (canPlace.allowed) {
        grid.levels.push(level);
        await this.placeLevel(grid, level);
      }
    }

    this.emitEvent('GRID_RECENTERED', {
      gridId: grid.id,
      newLevels: newLevels.length,
      currentPrice,
    });
  }

  /**
   * Reconcile grid with exchange state
   */
  private async reconcileGrid(gridId: string): Promise<void> {
    const grid = this.stateManager.getGrid(gridId);
    if (!grid) return;

    const ordersResult = await this.exchange.getOpenOrders(grid.symbol);
    const positionResult = await this.exchange.getPosition(grid.symbol);

    const exchangeOrders = ordersResult.success
      ? (ordersResult.data || []).map((o) => ({
          orderId: o.orderId,
          status: o.status,
          filledQty: o.filledQty,
          avgFillPrice: o.avgFillPrice,
        }))
      : [];

    const exchangePosition =
      positionResult.success && positionResult.data
        ? { size: positionResult.data.size, entryPrice: positionResult.data.entryPrice }
        : null;

    const { changes, warnings } = await this.stateManager.reconcile(
      gridId,
      exchangeOrders,
      exchangePosition
    );

    if (changes.length > 0 || warnings.length > 0) {
      console.log(`[Engine] Reconciled grid ${gridId}:`);
      changes.forEach((c) => console.log(`  Change: ${c}`));
      warnings.forEach((w) => console.log(`  Warning: ${w}`));
    }
  }

  // ============================================================================
  // Events
  // ============================================================================

  private emitEvent(type: string, data: Record<string, unknown>): void {
    const event: GridEvent = {
      type: type as GridEventType,
      gridId: (data.gridId as string) || '',
      timestamp: Date.now(),
      data,
    };

    this.emit('event', event);
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  /**
   * Preview grid calculation without starting
   */
  previewGrid(command: StartGridCommand, entryPrice: number): string {
    const config = mergeConfig(command);
    const calculation = calculateGridLevels(entryPrice, config);
    return formatGridCalculation(calculation, config);
  }

  /**
   * Get risk status for a grid
   */
  getRiskStatus(gridIdOrSymbol: string): string | undefined {
    const grid = this.getGrid(gridIdOrSymbol);
    if (!grid) return undefined;

    const status = this.riskMonitor.getRiskStatus(grid);
    return this.riskMonitor.formatRiskStatus(status);
  }
}
