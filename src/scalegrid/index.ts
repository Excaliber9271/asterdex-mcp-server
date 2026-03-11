/**
 * ScaleGrid Trading System
 *
 * A position-scaling grid trading system for leveraged perpetual futures.
 */

// Types
export * from './types.js';

// Core modules
export { ScaleGridEngine, EngineConfig } from './engine.js';
export {
  calculateGridLevels,
  calculateAvgEntry,
  calculateTpPrice,
  calculateUnrealizedPnl,
  validateConfig,
  mergeConfig,
  formatGridCalculation,
} from './grid-manager.js';
export { StateManager } from './state-manager.js';
export { RiskMonitor } from './risk-monitor.js';

// Exchange adapters
export { ExchangeAdapter, BaseExchangeAdapter, SymbolInfo } from './exchanges/adapter.js';
export { AsterAdapter } from './exchanges/aster-adapter.js';
