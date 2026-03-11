#!/usr/bin/env node
/**
 * Aster Terminal Dashboard
 * Real-time position and order monitoring in your terminal
 * Features: Real-time prices, sparklines, fill notifications, trade logging
 */

import blessed from 'blessed';
import contrib from 'blessed-contrib';
import { AsterTradingClient, Position } from './aster-trading-client.js';
import { AsterClient } from './aster-client.js';
import { AsterWebSocket, AccountUpdate, OrderUpdate, MarkPriceUpdate } from './aster-websocket.js';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env from package root or monorepo root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

// Types
interface OpenOrder {
  symbol: string;
  orderId: number;
  side: string;
  type: string;
  price: string;
  origQty: string;
  status: string;
  time: number;
}

interface AssetBalance {
  asset: string;
  balance: string;
  availableBalance: string;
}

interface SparklineData {
  symbol: string;
  prices: number[];  // Last 20 close prices
  lastFetch: number;
}

interface DashboardState {
  positions: Position[];
  orders: OpenOrder[];
  lastUpdate: Date;
  wsConnected: boolean;
  marketWsConnected: boolean;
  balances: AssetBalance[];
  totalPnl: number;
  markPrices: Map<string, number>;  // Real-time mark prices
  sparklines: Map<string, SparklineData>;  // Price history for sparklines
  subscribedSymbols: Set<string>;  // Symbols we're subscribed to
}

// Initialize clients
const tradingClient = new AsterTradingClient();
const marketClient = new AsterClient();
const wsClient = new AsterWebSocket();  // For user data stream
const marketWsClient = new AsterWebSocket();  // For market data (mark prices)

// Load credentials
const apiKey = process.env.ASTER_API_KEY;
const apiSecret = process.env.ASTER_API_SECRET;

if (!apiKey || !apiSecret) {
  console.error('Error: ASTER_API_KEY and ASTER_API_SECRET must be set in environment');
  process.exit(1);
}

tradingClient.setCredentials(apiKey, apiSecret);

// Dashboard state
const state: DashboardState = {
  positions: [],
  orders: [],
  lastUpdate: new Date(),
  wsConnected: false,
  marketWsConnected: false,
  balances: [],
  totalPnl: 0,
  markPrices: new Map(),
  sparklines: new Map(),
  subscribedSymbols: new Set(),
};

// ==================== SUPABASE TRADE LOGGING ====================

interface TradeLog {
  symbol: string;
  side: 'BUY' | 'SELL';
  order_type: string;
  price: number;
  quantity: number;
  quote_quantity: number;
  commission: number;
  commission_asset: string;
  realized_pnl: number;
  order_id: string;
  trade_id: string;
  is_maker: boolean;
  timestamp: Date;
}

// Initialize Supabase client (optional - only if env vars are set)
let supabase: SupabaseClient | null = null;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
}

// Log trade to Supabase
async function logTrade(trade: TradeLog): Promise<void> {
  if (!supabase) return;  // Supabase not configured

  try {
    const { error } = await supabase.from('trades').insert({
      symbol: trade.symbol,
      side: trade.side,
      order_type: trade.order_type,
      price: trade.price,
      quantity: trade.quantity,
      quote_quantity: trade.quote_quantity,
      commission: trade.commission,
      commission_asset: trade.commission_asset,
      realized_pnl: trade.realized_pnl,
      order_id: trade.order_id,
      trade_id: trade.trade_id,
      is_maker: trade.is_maker,
      executed_at: trade.timestamp.toISOString(),
      exchange: 'aster',
    });

    if (error) {
      // Silently fail - don't disrupt dashboard
    }
  } catch {
    // Silently fail
  }
}

// ==================== FILL NOTIFICATION QUEUE ====================

interface FillNotification {
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  realizedPnl: number;
  timestamp: Date;
}

const fillNotifications: FillNotification[] = [];
const MAX_NOTIFICATIONS = 5;  // Keep last 5 fills visible
const NOTIFICATION_DURATION_MS = 8000;  // 8 seconds per notification

// Render throttling - dirty flag pattern
let renderDirty = false;
let lastRenderTime = 0;
const RENDER_INTERVAL_MS = 100;  // 10fps max

function queueRender(): void {
  renderDirty = true;
}

function renderLoop(): void {
  const now = Date.now();
  if (renderDirty && now - lastRenderTime >= RENDER_INTERVAL_MS) {
    renderDirty = false;
    lastRenderTime = now;
    screen.render();
  }
}

// Start render loop
setInterval(renderLoop, 16);  // Check at ~60fps, render at 10fps max

// Suppress console.log from WebSocket client (interferes with blessed)
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
console.log = () => {};
console.error = () => {};

// Create blessed screen
const screen = blessed.screen({
  smartCSR: true,
  title: 'Aster Trading Terminal',
  fullUnicode: true,
});

// Create grid layout
const grid = new contrib.grid({ rows: 12, cols: 12, screen });

// Header box
const headerBox = grid.set(0, 0, 1, 12, blessed.box, {
  content: '{bold}{yellow-fg}ASTER POSITION MONITOR{/yellow-fg}{/bold}',
  tags: true,
  style: {
    fg: 'white',
    bg: 'black',
  },
});

// Positions table (reduced height to make room for fill log)
const positionsTable = grid.set(1, 0, 4, 12, contrib.table, {
  keys: true,
  fg: 'white',
  selectedFg: 'black',
  selectedBg: 'cyan',
  interactive: true,
  label: ' Positions (↑↓ select, Ctrl+R reverse) ',
  width: '100%',
  height: '100%',
  border: { type: 'line', fg: 'cyan' },
  columnSpacing: 2,
  columnWidth: [10, 10, 10, 10, 10, 10, 10, 12],  // Symbol, Side, Size, Entry, Mark, PnL, Liq, Trend
});

// Orders table (shifted up)
const ordersTable = grid.set(5, 0, 2, 8, contrib.table, {
  keys: true,
  fg: 'white',
  selectedFg: 'black',
  selectedBg: 'yellow',
  interactive: true,
  label: ' Open Orders ',
  width: '100%',
  height: '100%',
  border: { type: 'line', fg: 'white' },
  columnSpacing: 2,
  columnWidth: [12, 8, 12, 12, 10, 16],
});

// Fill log (right side, shows recent order fills)
const fillLogBox = grid.set(5, 8, 2, 4, blessed.log, {
  label: ' Recent Fills ',
  tags: true,
  border: { type: 'line', fg: 'magenta' },
  style: { fg: 'white', bg: 'black' },
  scrollable: true,
  alwaysScroll: true,
  scrollbar: {
    ch: ' ',
    inverse: true,
  },
});

// Balance box
const balanceBox = grid.set(7, 0, 3, 12, blessed.box, {
  label: ' Account ',
  content: ' Loading...',
  tags: true,
  border: { type: 'line', fg: 'green' },
  style: { fg: 'white', bg: 'black' },
});

// Status bar
const statusBar = grid.set(10, 0, 2, 12, blessed.box, {
  content: ' Connecting...',
  tags: true,
  style: { fg: 'black', bg: 'white' },
});

// Track which table is focused
let focusedTable: 'positions' | 'orders' = 'positions';

// Track if we're waiting for panic button confirmation
let awaitingPanicConfirm = false;
let panicConfirmTimeout: NodeJS.Timeout | null = null;

// Calculate liquidation risk level (0-100, higher = more dangerous)
function getLiquidationRisk(position: Position): number {
  const amt = parseFloat(position.positionAmt);
  const mark = parseFloat(position.markPrice);
  const liq = parseFloat(position.liquidationPrice);

  if (liq <= 0 || amt === 0) return 0;

  // Calculate distance to liquidation as percentage
  const distancePercent = Math.abs((mark - liq) / mark) * 100;

  // Convert to risk: closer = higher risk
  // < 5% distance = critical (80-100)
  // 5-15% = danger (50-80)
  // 15-30% = warning (20-50)
  // > 30% = safe (0-20)
  if (distancePercent < 5) return 100 - distancePercent;
  if (distancePercent < 15) return 80 - (distancePercent - 5) * 3;
  if (distancePercent < 30) return 50 - (distancePercent - 15) * 2;
  return Math.max(0, 20 - (distancePercent - 30) * 0.5);
}

// Format liquidation price with color based on risk
function formatLiquidation(position: Position): string {
  const liq = parseFloat(position.liquidationPrice);
  if (liq <= 0) return 'N/A';

  const risk = getLiquidationRisk(position);
  const formatted = liq.toFixed(liq < 1 ? 6 : 2);

  if (risk >= 70) return `!!${formatted}!!`;  // Critical - will show in table
  if (risk >= 40) return `! ${formatted} !`;  // Danger
  if (risk >= 20) return `  ${formatted}  `;  // Warning
  return `  ${formatted}  `;                   // Safe
}

// Get color code for liquidation risk (for display purposes)
function getLiquidationColor(risk: number): string {
  if (risk >= 70) return 'red';
  if (risk >= 40) return 'yellow';
  if (risk >= 20) return 'white';
  return 'green';
}

// Format PnL with color indicator
function formatPnlForTable(pnl: number): string {
  const formatted = Math.abs(pnl).toFixed(2);
  if (pnl > 0) return `+$${formatted}`;
  if (pnl < 0) return `-$${formatted}`;
  return `$${formatted}`;
}

// Format side for table
function formatSideForTable(amt: number, leverage: string): string {
  if (amt > 0) return `LONG ${leverage}x`;
  if (amt < 0) return `SHORT ${leverage}x`;
  return 'FLAT';
}

// Generate ASCII sparkline from price array
const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

function generateSparkline(prices: number[], width: number = 10): string {
  if (!prices || prices.length < 2) return '─'.repeat(width);

  // Take last 'width' prices
  const data = prices.slice(-width);
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min;

  if (range === 0) return '▄'.repeat(data.length);

  return data.map(p => {
    const normalized = (p - min) / range;
    const index = Math.min(Math.floor(normalized * 8), 7);
    return SPARK_CHARS[index];
  }).join('');
}

// Get real-time mark price (from WS) or fall back to position data
function getMarkPrice(position: Position): number {
  const wsPrice = state.markPrices.get(position.symbol);
  return wsPrice ?? parseFloat(position.markPrice);
}

// Calculate real-time PnL using current mark price
function calculatePnl(position: Position): number {
  const amt = parseFloat(position.positionAmt);
  if (amt === 0) return 0;

  const entry = parseFloat(position.entryPrice);
  const mark = getMarkPrice(position);

  // Long: (mark - entry) * qty, Short: (entry - mark) * |qty|
  if (amt > 0) {
    return (mark - entry) * amt;
  } else {
    return (entry - mark) * Math.abs(amt);
  }
}

// ==================== ORDER FILL HANDLING ====================

// Handle an order fill event
function handleOrderFill(orderUpdate: OrderUpdate): void {
  const o = orderUpdate.o;

  // Only process TRADE executions (actual fills)
  if (o.x !== 'TRADE') return;

  const symbol = o.s;
  const side = o.S as 'BUY' | 'SELL';
  const price = parseFloat(o.L);  // Last filled price
  const quantity = parseFloat(o.l);  // Last filled quantity
  const realizedPnl = parseFloat(o.rp);
  const commission = parseFloat(o.n);
  const commissionAsset = o.N;
  const orderType = o.o;
  const orderId = o.i.toString();
  const tradeId = o.t.toString();
  const isMaker = (o as any).m || false;  // If order was maker (may not exist in type)
  const timestamp = new Date(orderUpdate.T);

  // Add to notification queue
  const notification: FillNotification = {
    symbol,
    side,
    price,
    quantity,
    realizedPnl,
    timestamp,
  };

  fillNotifications.unshift(notification);
  if (fillNotifications.length > MAX_NOTIFICATIONS) {
    fillNotifications.pop();
  }

  // Update fill log display
  updateFillLog(notification);

  // Log to Supabase (async, don't await)
  logTrade({
    symbol,
    side,
    order_type: orderType,
    price,
    quantity,
    quote_quantity: price * quantity,
    commission,
    commission_asset: commissionAsset,
    realized_pnl: realizedPnl,
    order_id: orderId,
    trade_id: tradeId,
    is_maker: isMaker,
    timestamp,
  });

  // Flash the fill log border to draw attention
  flashFillLog();
}

// Update the fill log display with a new fill
function updateFillLog(fill: FillNotification): void {
  const sym = fill.symbol.replace('USDT', '');
  const sideColor = fill.side === 'BUY' ? 'green' : 'red';
  const pnlStr = fill.realizedPnl !== 0
    ? (fill.realizedPnl > 0 ? `{green-fg}+$${fill.realizedPnl.toFixed(2)}{/}` : `{red-fg}$${fill.realizedPnl.toFixed(2)}{/}`)
    : '';
  const time = fill.timestamp.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const line = `{${sideColor}-fg}${fill.side}{/} ${sym} @ ${fill.price.toFixed(fill.price < 1 ? 6 : 2)} ${pnlStr} {gray-fg}${time}{/}`;

  fillLogBox.log(line);
  queueRender();
}

// Flash the fill log border to draw attention
let fillFlashTimeout: NodeJS.Timeout | null = null;
function flashFillLog(): void {
  // Set to bright color
  fillLogBox.style.border = { fg: 'yellow' };
  queueRender();

  // Reset after delay
  if (fillFlashTimeout) clearTimeout(fillFlashTimeout);
  fillFlashTimeout = setTimeout(() => {
    fillLogBox.style.border = { fg: 'magenta' };
    queueRender();
  }, 500);
}

// Update positions table
function updatePositionsTable(): void {
  const activePositions = state.positions.filter(p => parseFloat(p.positionAmt) !== 0);

  if (activePositions.length === 0) {
    positionsTable.setData({
      headers: ['Symbol', 'Side', 'Size', 'Entry', 'Mark', 'PnL', 'Liq', 'Trend'],
      data: [['', '', '-- No Active Positions --', '', '', '', '', '']],
    });
    return;
  }

  const data = activePositions.map(p => {
    const amt = parseFloat(p.positionAmt);
    const entry = parseFloat(p.entryPrice);
    const mark = getMarkPrice(p);  // Use real-time mark price
    const pnl = calculatePnl(p);   // Calculate PnL from real-time price
    const liq = parseFloat(p.liquidationPrice);
    const size = Math.abs(amt * mark);
    const risk = getLiquidationRisk(p);

    // Build row with visual indicators
    const pnlStr = formatPnlForTable(pnl);
    const sideStr = formatSideForTable(amt, p.leverage);

    // Liquidation with risk indicator
    let liqStr = liq > 0 ? liq.toFixed(liq < 1 ? 6 : 2) : 'N/A';
    if (risk >= 70) liqStr = `** ${liqStr} **`;
    else if (risk >= 40) liqStr = `*  ${liqStr}  *`;

    // Sparkline from historical data
    const sparkData = state.sparklines.get(p.symbol);
    const sparkline = sparkData ? generateSparkline(sparkData.prices, 10) : '──────────';

    return [
      p.symbol.replace('USDT', ''),
      sideStr,
      `$${size.toFixed(2)}`,
      entry.toFixed(entry < 1 ? 6 : 2),
      mark.toFixed(mark < 1 ? 6 : 2),
      pnlStr,
      liqStr,
      sparkline,
    ];
  });

  positionsTable.setData({
    headers: ['Symbol', 'Side', 'Size', 'Entry', 'Mark', 'PnL', 'Liq', 'Trend'],
    data,
  });

  // Calculate total PnL using real-time prices
  state.totalPnl = activePositions.reduce((sum, p) => sum + calculatePnl(p), 0);

  // Update position table border color based on worst liquidation risk
  const maxRisk = Math.max(...activePositions.map(getLiquidationRisk), 0);
  if (focusedTable === 'positions') {
    if (maxRisk >= 70) {
      positionsTable.style.border = { fg: 'red' };
    } else if (maxRisk >= 40) {
      positionsTable.style.border = { fg: 'yellow' };
    } else {
      positionsTable.style.border = { fg: 'cyan' };
    }
  }
}

// Update orders table
function updateOrdersTable(): void {
  if (state.orders.length === 0) {
    ordersTable.setData({
      headers: ['Symbol', 'Side', 'Type', 'Price', 'Qty', 'Time'],
      data: [['', '', '-- No Open Orders --', '', '', '']],
    });
    return;
  }

  const data = state.orders.map(o => {
    const time = new Date(o.time).toLocaleTimeString();
    const sideIndicator = o.side === 'BUY' ? 'BUY' : 'SELL';
    return [
      o.symbol.replace('USDT', ''),
      sideIndicator,
      o.type,
      parseFloat(o.price).toFixed(parseFloat(o.price) < 1 ? 6 : 2),
      o.origQty,
      time,
    ];
  });

  ordersTable.setData({
    headers: ['Symbol', 'Side', 'Type', 'Price', 'Qty', 'Time'],
    data,
  });
}

// Update balance display (multi-asset)
function updateBalanceDisplay(): void {
  const nonZeroBalances = state.balances.filter(b => parseFloat(b.balance) > 0.01);

  if (nonZeroBalances.length === 0) {
    balanceBox.setContent(' No balances');
    return;
  }

  // Format balances in a nice grid
  const balanceStrings = nonZeroBalances.map(b => {
    const bal = parseFloat(b.balance);
    const formatted = bal >= 1000 ? bal.toFixed(0) : bal.toFixed(2);
    return `{bold}${b.asset}{/bold}: ${formatted}`;
  });

  // Add total PnL
  const pnlColor = state.totalPnl >= 0 ? 'green' : 'red';
  const pnlSign = state.totalPnl >= 0 ? '+' : '';
  const pnlStr = `{${pnlColor}-fg}{bold}PnL: ${pnlSign}$${state.totalPnl.toFixed(2)}{/bold}{/${pnlColor}-fg}`;

  balanceBox.setContent(` ${balanceStrings.join('  |  ')}  ||  ${pnlStr}`);
}

// Update status bar
function updateStatusBar(): void {
  const userWs = state.wsConnected ? '{green-fg}U{/green-fg}' : '{red-fg}U{/red-fg}';
  const mktWs = state.marketWsConnected ? '{green-fg}M{/green-fg}' : '{red-fg}M{/red-fg}';
  const time = state.lastUpdate.toLocaleTimeString();
  const posCount = state.positions.filter(p => parseFloat(p.positionAmt) !== 0).length;
  const orderCount = state.orders.length;
  const focusIndicator = focusedTable === 'positions' ? '{cyan-fg}[POS]{/cyan-fg}' : '{yellow-fg}[ORD]{/yellow-fg}';

  statusBar.setContent(` {bold}R{/bold}:Refresh {bold}Ctrl+R{/bold}:Reverse {bold}A{/bold}:CloseAll {bold}Tab{/bold}:Switch {bold}Q{/bold}:Quit | ${focusIndicator} | WS:[${userWs}|${mktWs}] | ${time} | Pos:${posCount} Ord:${orderCount}`);
}

// Refresh all data
async function refreshData(): Promise<void> {
  try {
    // Fetch positions
    const posResult = await tradingClient.getPositions();
    if (posResult.success && posResult.data) {
      state.positions = posResult.data;
    }

    // Fetch open orders
    const ordersResult = await tradingClient.getOpenOrders();
    if (ordersResult.success && ordersResult.data) {
      state.orders = ordersResult.data;
    }

    // Fetch all balances
    const balanceResult = await tradingClient.getBalance();
    if (balanceResult.success && balanceResult.data) {
      state.balances = balanceResult.data;
    }

    state.lastUpdate = new Date();

    // Update mark price subscriptions if positions changed
    if (state.marketWsConnected) {
      await updateMarkPriceSubscriptions();
    }

    updatePositionsTable();
    updateOrdersTable();
    updateBalanceDisplay();
    updateStatusBar();
    queueRender();
  } catch (error: any) {
    statusBar.setContent(` {red-fg}Error: ${error.message}{/red-fg}`);
    queueRender();
  }
}

// Close selected position
async function closeSelectedPosition(): Promise<void> {
  const activePositions = state.positions.filter(p => parseFloat(p.positionAmt) !== 0);
  // @ts-ignore - blessed types are incomplete
  const selectedIndex = positionsTable.rows?.selected || 0;

  if (activePositions.length === 0 || selectedIndex >= activePositions.length) {
    return;
  }

  const position = activePositions[selectedIndex];
  statusBar.setContent(` {yellow-fg}Closing ${position.symbol}...{/yellow-fg}`);
  screen.render();

  try {
    const result = await tradingClient.closePosition(position.symbol);
    if (result.success) {
      statusBar.setContent(` {green-fg}Closed ${position.symbol}{/green-fg}`);
    } else {
      statusBar.setContent(` {red-fg}Failed: ${result.error}{/red-fg}`);
    }
    await refreshData();
  } catch (error: any) {
    statusBar.setContent(` {red-fg}Error: ${error.message}{/red-fg}`);
    queueRender();
  }
}

// Cancel selected order
async function cancelSelectedOrder(): Promise<void> {
  // @ts-ignore - blessed types are incomplete
  const selectedIndex = ordersTable.rows?.selected || 0;

  if (state.orders.length === 0 || selectedIndex >= state.orders.length) {
    return;
  }

  const order = state.orders[selectedIndex];
  statusBar.setContent(` {yellow-fg}Cancelling order ${order.orderId}...{/yellow-fg}`);
  screen.render();

  try {
    const result = await tradingClient.cancelOrder(order.symbol, order.orderId.toString());
    if (result.success) {
      statusBar.setContent(` {green-fg}Cancelled order on ${order.symbol}{/green-fg}`);
    } else {
      statusBar.setContent(` {red-fg}Failed: ${result.error}{/red-fg}`);
    }
    await refreshData();
  } catch (error: any) {
    statusBar.setContent(` {red-fg}Error: ${error.message}{/red-fg}`);
    queueRender();
  }
}

// Request close all positions (requires confirmation)
function requestCloseAll(): void {
  const activePositions = state.positions.filter(p => parseFloat(p.positionAmt) !== 0);

  if (activePositions.length === 0) {
    statusBar.setContent(' {yellow-fg}No positions to close{/yellow-fg}');
    queueRender();
    return;
  }

  // Set confirmation mode
  awaitingPanicConfirm = true;
  statusBar.setContent(` {red-fg}{bold}CLOSE ALL ${activePositions.length} POSITIONS? Press Y to confirm, any other key to cancel{/bold}{/red-fg}`);
  screen.render();

  // Auto-cancel after 5 seconds
  if (panicConfirmTimeout) clearTimeout(panicConfirmTimeout);
  panicConfirmTimeout = setTimeout(() => {
    if (awaitingPanicConfirm) {
      awaitingPanicConfirm = false;
      updateStatusBar();
      queueRender();
    }
  }, 5000);
}

// Actually close all positions (after confirmation)
async function executeCloseAll(): Promise<void> {
  awaitingPanicConfirm = false;
  if (panicConfirmTimeout) {
    clearTimeout(panicConfirmTimeout);
    panicConfirmTimeout = null;
  }

  const activePositions = state.positions.filter(p => parseFloat(p.positionAmt) !== 0);

  statusBar.setContent(` {yellow-fg}Closing ${activePositions.length} positions...{/yellow-fg}`);
  screen.render();

  for (const position of activePositions) {
    try {
      await tradingClient.closePosition(position.symbol);
    } catch (error) {
      // Continue with other positions
    }
  }

  statusBar.setContent(` {green-fg}Closed all positions{/green-fg}`);
  await refreshData();
}

// Cancel the panic confirmation
function cancelPanicConfirm(): void {
  awaitingPanicConfirm = false;
  if (panicConfirmTimeout) {
    clearTimeout(panicConfirmTimeout);
    panicConfirmTimeout = null;
  }
  statusBar.setContent(' {cyan-fg}Close all cancelled{/cyan-fg}');
  queueRender();
  setTimeout(() => {
    updateStatusBar();
    queueRender();
  }, 1500);
}

// Switch focus between tables
function switchFocus(): void {
  if (focusedTable === 'positions') {
    focusedTable = 'orders';
    ordersTable.focus();
    positionsTable.style.border = { fg: 'white' };
    ordersTable.style.border = { fg: 'yellow' };
    positionsTable.interactive = false;
    ordersTable.interactive = true;
  } else {
    focusedTable = 'positions';
    positionsTable.focus();
    ordersTable.style.border = { fg: 'white' };
    ordersTable.interactive = false;
    positionsTable.interactive = true;
    // Re-apply risk-based color for positions
    const activePositions = state.positions.filter(p => parseFloat(p.positionAmt) !== 0);
    const maxRisk = Math.max(...activePositions.map(getLiquidationRisk), 0);
    if (maxRisk >= 70) {
      positionsTable.style.border = { fg: 'red' };
    } else if (maxRisk >= 40) {
      positionsTable.style.border = { fg: 'yellow' };
    } else {
      positionsTable.style.border = { fg: 'cyan' };
    }
  }
  updateStatusBar();
  queueRender();
}

// Setup WebSocket for real-time updates
async function setupWebSocket(): Promise<void> {
  try {
    const listenKeyResult = await tradingClient.createListenKey();
    if (!listenKeyResult.success || !listenKeyResult.data?.listenKey) {
      statusBar.setContent(' {red-fg}Failed to create listen key{/red-fg}');
      return;
    }

    const listenKey = listenKeyResult.data.listenKey;

    await wsClient.connectUserDataStream(listenKey, (update) => {
      if (update.e === 'ACCOUNT_UPDATE') {
        const accountUpdate = update as AccountUpdate;
        // Update positions from WebSocket
        for (const posUpdate of accountUpdate.a.P) {
          const existingPos = state.positions.find(p => p.symbol === posUpdate.s);
          if (existingPos) {
            existingPos.positionAmt = posUpdate.pa;
            existingPos.entryPrice = posUpdate.ep;
            existingPos.unRealizedProfit = posUpdate.up;
          }
        }
        // Update balances
        for (const balUpdate of accountUpdate.a.B) {
          const existingBal = state.balances.find(b => b.asset === balUpdate.a);
          if (existingBal) {
            existingBal.balance = balUpdate.wb;
          }
        }
        state.lastUpdate = new Date();
        updatePositionsTable();
        updateBalanceDisplay();
        updateStatusBar();
        queueRender();
      } else if (update.e === 'ORDER_TRADE_UPDATE') {
        const orderUpdate = update as OrderUpdate;
        // Handle fill notification and logging
        handleOrderFill(orderUpdate);
        // Refresh orders on any order update
        refreshData();
      }
    });

    state.wsConnected = true;
    updateStatusBar();
    queueRender();

    // Keep listen key alive every 30 minutes
    setInterval(async () => {
      try {
        await tradingClient.keepAliveListenKey(listenKey);
      } catch (error) {
        // Will reconnect on next refresh
      }
    }, 30 * 60 * 1000);

  } catch (error: any) {
    statusBar.setContent(` {red-fg}WebSocket error: ${error.message}{/red-fg}`);
    queueRender();
  }
}

// Setup market WebSocket for real-time mark prices
async function setupMarketWebSocket(): Promise<void> {
  try {
    await marketWsClient.connect();
    state.marketWsConnected = true;

    // Update subscriptions based on active positions
    await updateMarkPriceSubscriptions();

    updateStatusBar();
    queueRender();
  } catch (error: any) {
    statusBar.setContent(` {red-fg}Market WS error: ${error.message}{/red-fg}`);
    queueRender();
  }
}

// Update mark price subscriptions based on current positions
async function updateMarkPriceSubscriptions(): Promise<void> {
  const activeSymbols = new Set(
    state.positions
      .filter(p => parseFloat(p.positionAmt) !== 0)
      .map(p => p.symbol)
  );

  // Unsubscribe from symbols we no longer have positions in
  for (const symbol of state.subscribedSymbols) {
    if (!activeSymbols.has(symbol)) {
      marketWsClient.unsubscribe([`${symbol.toLowerCase()}@markPrice`]);
      state.subscribedSymbols.delete(symbol);
      state.markPrices.delete(symbol);
    }
  }

  // Subscribe to new symbols
  for (const symbol of activeSymbols) {
    if (!state.subscribedSymbols.has(symbol)) {
      marketWsClient.subscribeMarkPrice(symbol, (data: MarkPriceUpdate) => {
        state.markPrices.set(data.s, parseFloat(data.p));
        state.lastUpdate = new Date();
        updatePositionsTable();
        updateBalanceDisplay();  // PnL changed
        queueRender();
      });
      state.subscribedSymbols.add(symbol);
    }
  }
}

// Fetch sparkline data for all open positions
async function fetchSparklineData(): Promise<void> {
  const activePositions = state.positions.filter(p => parseFloat(p.positionAmt) !== 0);

  for (const position of activePositions) {
    const symbol = position.symbol;
    const existing = state.sparklines.get(symbol);

    // Only fetch if we don't have data or it's older than 5 minutes
    if (!existing || Date.now() - existing.lastFetch > 5 * 60 * 1000) {
      try {
        const klineRes = await marketClient.getKlines(symbol, '15m', 20);
        if (klineRes.success && klineRes.data && klineRes.data.length > 0) {
          const prices = klineRes.data.map((k: any) => parseFloat(k.close));
          state.sparklines.set(symbol, {
            symbol,
            prices,
            lastFetch: Date.now(),
          });
        }
      } catch (error) {
        // Silently fail, will retry next interval
      }
    }
  }

  updatePositionsTable();
  queueRender();
}

// Reverse position state (needs confirmation like panic button)
let awaitingReverseConfirm = false;
let reverseConfirmTimeout: NodeJS.Timeout | null = null;
let reverseTargetSymbol: string | null = null;

// Request reverse position (requires confirmation)
function requestReversePosition(): void {
  const activePositions = state.positions.filter(p => parseFloat(p.positionAmt) !== 0);
  // @ts-ignore - blessed types are incomplete
  const selectedIndex = positionsTable.rows?.selected || 0;

  if (activePositions.length === 0 || selectedIndex >= activePositions.length) {
    statusBar.setContent(' {yellow-fg}No position selected to reverse{/yellow-fg}');
    queueRender();
    return;
  }

  const position = activePositions[selectedIndex];
  const amt = parseFloat(position.positionAmt);
  const side = amt > 0 ? 'LONG' : 'SHORT';
  const newSide = amt > 0 ? 'SHORT' : 'LONG';

  reverseTargetSymbol = position.symbol;
  awaitingReverseConfirm = true;

  statusBar.setContent(` {yellow-fg}{bold}REVERSE ${position.symbol.replace('USDT', '')} from ${side} to ${newSide}? Press Y to confirm{/bold}{/yellow-fg}`);
  queueRender();

  // Auto-cancel after 5 seconds
  if (reverseConfirmTimeout) clearTimeout(reverseConfirmTimeout);
  reverseConfirmTimeout = setTimeout(() => {
    if (awaitingReverseConfirm) {
      awaitingReverseConfirm = false;
      reverseTargetSymbol = null;
      updateStatusBar();
      queueRender();
    }
  }, 5000);
}

// Execute reverse position (after confirmation)
async function executeReversePosition(): Promise<void> {
  awaitingReverseConfirm = false;
  if (reverseConfirmTimeout) {
    clearTimeout(reverseConfirmTimeout);
    reverseConfirmTimeout = null;
  }

  if (!reverseTargetSymbol) return;

  const position = state.positions.find(p => p.symbol === reverseTargetSymbol);
  if (!position) {
    statusBar.setContent(' {red-fg}Position not found{/red-fg}');
    queueRender();
    return;
  }

  const amt = parseFloat(position.positionAmt);
  const symbol = position.symbol;
  const size = Math.abs(amt);
  const newSide = amt > 0 ? 'SELL' : 'BUY';

  statusBar.setContent(` {yellow-fg}Reversing ${symbol}...{/yellow-fg}`);
  queueRender();

  try {
    // Close existing position
    const closeResult = await tradingClient.closePosition(symbol);
    if (!closeResult.success) {
      statusBar.setContent(` {red-fg}Failed to close: ${closeResult.error}{/red-fg}`);
      queueRender();
      return;
    }

    // Open reverse position with same size
    const quantity = size.toFixed(8);
    const openResult = await tradingClient.placeMarketOrder(symbol, newSide, quantity);

    if (openResult.success) {
      statusBar.setContent(` {green-fg}Reversed ${symbol} successfully{/green-fg}`);
    } else {
      statusBar.setContent(` {yellow-fg}Closed but failed to open reverse: ${openResult.error}{/yellow-fg}`);
    }

    reverseTargetSymbol = null;
    await refreshData();
  } catch (error: any) {
    statusBar.setContent(` {red-fg}Reverse error: ${error.message}{/red-fg}`);
    queueRender();
  }
}

// Cancel reverse confirmation
function cancelReverseConfirm(): void {
  awaitingReverseConfirm = false;
  reverseTargetSymbol = null;
  if (reverseConfirmTimeout) {
    clearTimeout(reverseConfirmTimeout);
    reverseConfirmTimeout = null;
  }
  statusBar.setContent(' {cyan-fg}Reverse cancelled{/cyan-fg}');
  queueRender();
  setTimeout(() => {
    updateStatusBar();
    queueRender();
  }, 1500);
}

// Key bindings
screen.key(['q', 'C-c'], () => {
  wsClient.disconnectUserDataStream();
  marketWsClient.disconnect();
  process.exit(0);
});

// Refresh data
screen.key(['r'], () => {
  if (!awaitingPanicConfirm && !awaitingReverseConfirm) {
    refreshData();
  }
});

// Ctrl+R = Reverse position (requires confirmation)
screen.key(['C-r'], () => {
  if (!awaitingPanicConfirm && !awaitingReverseConfirm && focusedTable === 'positions') {
    requestReversePosition();
  }
});

// A = Close ALL positions (panic button, requires confirmation)
screen.key(['a', 'A'], () => {
  if (!awaitingPanicConfirm && !awaitingReverseConfirm) {
    requestCloseAll();
  }
});

// Y = Confirm dangerous action
screen.key(['y', 'Y'], () => {
  if (awaitingPanicConfirm) {
    executeCloseAll();
  } else if (awaitingReverseConfirm) {
    executeReversePosition();
  }
});

// Any other key cancels confirmation (except navigation keys)
screen.on('keypress', (ch: string, key: any) => {
  const isConfirmKey = key && key.name === 'y';
  const isNavKey = key && (key.name === 'up' || key.name === 'down');

  if ((awaitingPanicConfirm || awaitingReverseConfirm) && !isConfirmKey && !isNavKey) {
    if (awaitingPanicConfirm) {
      cancelPanicConfirm();
    }
    if (awaitingReverseConfirm) {
      cancelReverseConfirm();
    }
  }
});

screen.key(['tab'], () => {
  switchFocus();
});

// Also handle shift+tab for reverse switching
screen.key(['S-tab'], () => {
  switchFocus();
});

// Initial focus
positionsTable.focus();
positionsTable.interactive = true;
ordersTable.interactive = false;

// Start the dashboard
async function main(): Promise<void> {
  headerBox.setContent('{bold}{yellow-fg} ASTER TRADING TERMINAL {/yellow-fg}{/bold}  |  Real-time prices  |  Sparklines  |  WS: [U]ser [M]arket');
  screen.render();

  // Initial data load
  await refreshData();

  // Setup WebSockets for real-time updates
  await setupWebSocket();      // User data stream (positions, orders, balances)
  await setupMarketWebSocket(); // Market data (mark prices)

  // Initial sparkline fetch
  await fetchSparklineData();

  // Fallback polling every 10 seconds (in case WebSocket misses something)
  setInterval(refreshData, 10000);

  // Refresh sparklines every 2 minutes
  setInterval(fetchSparklineData, 2 * 60 * 1000);

  queueRender();
}

main().catch((error) => {
  console.error('Dashboard error:', error);
  process.exit(1);
});
