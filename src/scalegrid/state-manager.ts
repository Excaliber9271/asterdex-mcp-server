/**
 * ScaleGrid Trading System - State Manager
 *
 * Handles persistence and reconciliation of grid state.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  GridState,
  GridStorage,
  STORAGE_VERSION,
  GridConfig,
  GridLevel,
  RiskState,
} from './types.js';
import { generateGridId } from './grid-manager.js';

const DEFAULT_STORAGE_PATH = path.join(process.cwd(), 'data', 'grids.json');

export class StateManager {
  private storagePath: string;
  private grids: Map<string, GridState> = new Map();
  private dirty: boolean = false;
  private autoSaveInterval: NodeJS.Timeout | null = null;

  constructor(storagePath: string = DEFAULT_STORAGE_PATH) {
    this.storagePath = storagePath;
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Initialize state manager - load from disk
   */
  async initialize(): Promise<void> {
    await this.load();

    // Start auto-save interval (every 10 seconds if dirty)
    this.autoSaveInterval = setInterval(() => {
      if (this.dirty) {
        this.save().catch(console.error);
      }
    }, 10000);
  }

  /**
   * Shutdown - save and cleanup
   */
  async shutdown(): Promise<void> {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = null;
    }

    await this.save();
  }

  // ============================================================================
  // CRUD Operations
  // ============================================================================

  /**
   * Create a new grid state
   */
  createGrid(config: GridConfig, entryPrice: number, levels: GridLevel[]): GridState {
    const id = generateGridId(config.symbol);

    const state: GridState = {
      id,
      symbol: config.symbol,
      config,
      riskState: 'ACTIVE',
      levels,
      entryPrice,
      avgEntry: entryPrice,
      positionSize: 0,
      positionCostUsd: 0,
      tpPrice: 0,
      unrealizedPnl: 0,
      unrealizedPnlPercent: 0,
      filledLevelCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastPrice: entryPrice,
    };

    this.grids.set(id, state);
    this.dirty = true;

    return state;
  }

  /**
   * Get grid by ID
   */
  getGrid(gridId: string): GridState | undefined {
    return this.grids.get(gridId);
  }

  /**
   * Get grid by symbol (returns first active grid for symbol)
   */
  getGridBySymbol(symbol: string): GridState | undefined {
    const normalized = symbol.toUpperCase();
    for (const grid of this.grids.values()) {
      if (grid.symbol === normalized && grid.riskState !== 'CLOSED') {
        return grid;
      }
    }
    return undefined;
  }

  /**
   * Get all grids
   */
  getAllGrids(): GridState[] {
    return Array.from(this.grids.values());
  }

  /**
   * Get active grids
   */
  getActiveGrids(): GridState[] {
    return Array.from(this.grids.values()).filter(
      (g) => g.riskState === 'ACTIVE' || g.riskState === 'CAPPED'
    );
  }

  /**
   * Update grid state
   */
  updateGrid(gridId: string, updates: Partial<GridState>): GridState | undefined {
    const grid = this.grids.get(gridId);
    if (!grid) return undefined;

    const updated: GridState = {
      ...grid,
      ...updates,
      updatedAt: Date.now(),
    };

    this.grids.set(gridId, updated);
    this.dirty = true;

    return updated;
  }

  /**
   * Update grid level
   */
  updateLevel(gridId: string, levelIndex: number, updates: Partial<GridLevel>): GridState | undefined {
    const grid = this.grids.get(gridId);
    if (!grid) return undefined;

    const levels = [...grid.levels];
    const level = levels.find((l) => l.index === levelIndex);
    if (!level) return undefined;

    Object.assign(level, updates);

    return this.updateGrid(gridId, { levels });
  }

  /**
   * Delete/close grid
   */
  closeGrid(gridId: string): boolean {
    const grid = this.grids.get(gridId);
    if (!grid) return false;

    this.updateGrid(gridId, { riskState: 'CLOSED' });
    return true;
  }

  /**
   * Permanently remove grid (for cleanup)
   */
  removeGrid(gridId: string): boolean {
    const existed = this.grids.has(gridId);
    this.grids.delete(gridId);
    if (existed) this.dirty = true;
    return existed;
  }

  // ============================================================================
  // State Queries
  // ============================================================================

  /**
   * Check if symbol has an active grid
   */
  hasActiveGrid(symbol: string): boolean {
    return this.getGridBySymbol(symbol) !== undefined;
  }

  /**
   * Count active grids
   */
  activeGridCount(): number {
    return this.getActiveGrids().length;
  }

  // ============================================================================
  // Persistence
  // ============================================================================

  /**
   * Load state from disk
   */
  async load(): Promise<void> {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Check if file exists
      if (!fs.existsSync(this.storagePath)) {
        console.log('[StateManager] No existing state file, starting fresh');
        return;
      }

      const data = fs.readFileSync(this.storagePath, 'utf-8');
      const storage: GridStorage = JSON.parse(data);

      // Version check
      if (storage.version !== STORAGE_VERSION) {
        console.warn(`[StateManager] Storage version mismatch: ${storage.version} vs ${STORAGE_VERSION}`);
        // Could add migration logic here
      }

      // Load grids
      for (const [id, state] of Object.entries(storage.grids)) {
        this.grids.set(id, state);
      }

      console.log(`[StateManager] Loaded ${this.grids.size} grids from disk`);
    } catch (error: any) {
      console.error(`[StateManager] Failed to load state: ${error.message}`);
    }
  }

  /**
   * Save state to disk
   */
  async save(): Promise<void> {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const storage: GridStorage = {
        version: STORAGE_VERSION,
        grids: Object.fromEntries(this.grids),
        lastUpdated: Date.now(),
      };

      const data = JSON.stringify(storage, null, 2);
      fs.writeFileSync(this.storagePath, data, 'utf-8');

      this.dirty = false;
      console.log(`[StateManager] Saved ${this.grids.size} grids to disk`);
    } catch (error: any) {
      console.error(`[StateManager] Failed to save state: ${error.message}`);
    }
  }

  /**
   * Force immediate save
   */
  async forceSave(): Promise<void> {
    this.dirty = true;
    await this.save();
  }

  // ============================================================================
  // Reconciliation
  // ============================================================================

  /**
   * Reconcile local state with exchange state
   *
   * Call this on startup to ensure local state matches reality.
   */
  async reconcile(
    gridId: string,
    exchangeOrders: Array<{ orderId: string; status: string; filledQty: number; avgFillPrice: number }>,
    exchangePosition: { size: number; entryPrice: number } | null
  ): Promise<{ changes: string[]; warnings: string[] }> {
    const changes: string[] = [];
    const warnings: string[] = [];

    const grid = this.grids.get(gridId);
    if (!grid) {
      warnings.push(`Grid ${gridId} not found in local state`);
      return { changes, warnings };
    }

    // Build order ID map for quick lookup
    const orderMap = new Map(exchangeOrders.map((o) => [o.orderId, o]));

    // Check each level
    for (const level of grid.levels) {
      if (!level.orderId) continue;

      const exchangeOrder = orderMap.get(level.orderId);

      if (!exchangeOrder) {
        // Order not found on exchange
        if (level.status === 'PLACED') {
          warnings.push(`Level ${level.index} order ${level.orderId} not found on exchange`);
          level.status = 'CANCELLED';
          changes.push(`Level ${level.index}: PLACED -> CANCELLED (order not found)`);
        }
        continue;
      }

      // Check for fills
      if (exchangeOrder.status === 'FILLED' && level.status !== 'FILLED') {
        level.status = 'FILLED';
        level.fillPrice = exchangeOrder.avgFillPrice;
        level.fillQty = exchangeOrder.filledQty;
        level.filledAt = Date.now();
        changes.push(`Level ${level.index}: ${level.status} -> FILLED`);
      }

      // Check for cancellations
      if (exchangeOrder.status === 'CANCELLED' && level.status === 'PLACED') {
        level.status = 'CANCELLED';
        changes.push(`Level ${level.index}: PLACED -> CANCELLED`);
      }
    }

    // Reconcile position
    if (exchangePosition && exchangePosition.size > 0) {
      const filledLevels = grid.levels.filter((l) => l.status === 'FILLED');

      if (filledLevels.length === 0 && exchangePosition.size > 0) {
        warnings.push('Exchange shows position but no levels marked as filled');
      }

      // Update position stats
      grid.positionSize = exchangePosition.size;
      grid.avgEntry = exchangePosition.entryPrice;
    }

    // Recalculate derived values
    grid.filledLevelCount = grid.levels.filter((l) => l.status === 'FILLED').length;
    grid.updatedAt = Date.now();

    this.dirty = true;

    return { changes, warnings };
  }

  // ============================================================================
  // Export/Import
  // ============================================================================

  /**
   * Export grid config (for sharing/backup)
   */
  exportConfig(gridId: string): GridConfig | undefined {
    const grid = this.grids.get(gridId);
    return grid?.config;
  }

  /**
   * Export all configs
   */
  exportAllConfigs(): GridConfig[] {
    return Array.from(this.grids.values()).map((g) => g.config);
  }
}
