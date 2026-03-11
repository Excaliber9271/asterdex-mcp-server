import express from 'express';
import cors from 'cors';
import { AsterClient } from './aster-client.js';
import { AsterTradingClient } from './aster-trading-client.js';
import { StrategyEngine, DEFAULT_PUMP_STRATEGY } from './strategy-engine.js';
import 'dotenv/config';

const app = express();
const port = process.env.BRIDGE_PORT || 3001;

app.use(cors());
app.use(express.json());

// Initialize core components
const asterClient = new AsterClient();
const asterTrading = new AsterTradingClient();
const strategyEngine = new StrategyEngine(asterClient, asterTrading, DEFAULT_PUMP_STRATEGY);

// --- Endpoints ---

// Get real-time signals for the screener
app.get('/api/signals', async (req, res) => {
  try {
    // In a real scenario, we might want to cache this or use the engine's background scan results
    // For now, we'll trigger a fresh scan for the dashboard
    // @ts-ignore - access private method for the bridge
    const signals = await strategyEngine.scanForSignals();
    res.json({ success: true, data: signals });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get engine state
app.get('/api/state', (req, res) => {
  res.json({ success: true, data: strategyEngine.getState() });
});

// Get signal history and stats
app.get('/api/stats', (req, res) => {
  res.json({
    success: true,
    data: {
      stats: strategyEngine.getSignalStats(),
      history: strategyEngine.getSignalHistory(50)
    }
  });
});

// Control strategy
app.post('/api/strategy/start', async (req, res) => {
  const result = await strategyEngine.start();
  res.json(result);
});

app.post('/api/strategy/stop', async (req, res) => {
  const result = await strategyEngine.stop();
  res.json(result);
});

// --- Manual Trading & Position Management ---

// Get active positions (merged from engine state and exchange)
app.get('/api/positions', async (req, res) => {
  try {
    const result = await asterTrading.getPositions();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual entry
app.post('/api/trade/manual', async (req, res) => {
  const { symbol, side, score = 10, reason = 'manual_entry' } = req.body;
  
  if (!symbol || !side) {
    return res.status(400).json({ success: false, error: 'Symbol and side are required' });
  }

  try {
    // We construct a "fake" signal to reuse the engine's execution logic (SL/TP placement)
    const tickerRes = await asterClient.getTicker24h();
    const ticker = Array.isArray(tickerRes.data) 
      ? tickerRes.data.find((t: any) => t.symbol === symbol)
      : tickerRes.data;
    
    if (!ticker) throw new Error('Symbol not found');

    const signal = {
      symbol,
      price: parseFloat(ticker.lastPrice),
      volumeRatio: 1,
      stochRSI: 50,
      mfi: 50,
      rsi: 50,
      score,
      timestamp: Date.now(),
      signalType: side as 'LONG' | 'SHORT',
      reason: reason
    };

    const success = await strategyEngine.executeEntry(signal);
    res.json({ success, message: success ? `Manual ${side} opened` : 'Execution failed' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Close position
app.post('/api/trade/close', async (req, res) => {
  const { symbol } = req.body;
  if (!symbol) return res.status(400).json({ success: false, error: 'Symbol required' });

  try {
    const result = await strategyEngine.closePosition(symbol);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Proxy market data for charts
app.get('/api/klines/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const { interval = '15m', limit = '100' } = req.query;
  
  try {
    const result = await asterClient.getKlines(symbol, interval as string, parseInt(limit as string));
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get available pairs
app.get('/api/pairs', async (req, res) => {
  try {
    const result = await asterClient.getTicker24h();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(port, () => {
  console.log(`[Aster Bridge] Server running at http://localhost:${port}`);
});
