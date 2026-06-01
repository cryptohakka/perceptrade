# PercepTrade

**Multi-CEX Risk-Aware Trading Agent** — Bitget Hackathon S1 submission

Live demo: [perceptrade.a2aflow.space](https://perceptrade.a2aflow.space)

---

## Overview

PercepTrade is an autonomous trading agent that monitors Funding Rate (FR) and Open Interest (OI) across 6 centralized and decentralized exchanges, interprets market conditions through a multi-agent AI council, and executes futures positions on Bitget.

The core insight: FR and OI are real-time proxies for crowd sentiment and leverage positioning. When aggregated across multiple venues, divergences reveal structural risks before price reacts.

---

## Architecture

```
Perception Layer (6 sources)
  Bybit / OKX / Bitget / Binance / KuCoin / Hyperliquid DEX
       │
       ▼
Signal Computation
  directionSignal  →  long / short + confidence %
  riskSignal       →  sizeMultiplier (×0.25 / ×0.50 / ×1.00)
       │
       ▼
Triple-A Agent Council (OpenRouter / gemini-2.5-flash-lite)
  Architect  →  proposes action
  Auditor    →  stress-tests the proposal
  Arbiter    →  final decision + position size
       │
       ▼
Bitget Futures Execution
  Market order + TP/SL
```

**Cycle interval:** 5 minutes  
**Bot/Agent split:** ~60% rule-based signal computation / ~40% LLM interpretation

---

## Signal Design

### Direction Signal
Derived from FR absolute level (market heat) and OI momentum across venues.

| Value | Meaning |
|-------|---------|
| `long` + high confidence | FR elevated, OI growing — crowd is leveraged long |
| `short` + high confidence | FR negative, OI growing — crowd is leveraged short |
| `neutral` | Mixed or low-conviction signals |

### Risk Signal
Measures FR deviation across exchanges and OI change rate to size positions conservatively when signals conflict.

| sizeMultiplier | Condition |
|----------------|-----------|
| `×1.00` | Low deviation, stable OI |
| `×0.50` | Moderate divergence across CEX |
| `×0.25` | High deviation or rapid OI shift |

---

## Triple-A Framework

Sequential debate structure:

- **Architect** — evaluates direction and risk signals, proposes `long / short / hold` with rationale
- **Auditor** — challenges the proposal, checks for bias or overconfidence, can block
- **Arbiter** — weighs both outputs, makes final call, sets `size_pct`

Each agent receives the full market snapshot (per-exchange FR/OI, computed scores) as context. No agent sees the others' system prompts.

---

## Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js |
| LLM | OpenRouter → `gemini-2.5-flash-lite` |
| Exchanges | Bybit / OKX / Bitget / Binance / KuCoin / Hyperliquid |
| Execution | Bitget Futures API |
| UI | Vanilla HTML/CSS/JS (no framework) |
| Process | systemd (`perceptrade-agent`) |
| Infra | VPS, reverse proxy via nginx |

---

## UI

| Page | Path | Description |
|------|------|-------------|
| Landing | `/` | Project overview |
| Dashboard | `/app` | Live position, agent council log, execution log |
| Analysis | `/analysis` | Per-CEX FR/OI bar charts, direction confidence, risk score |

---

## Running Locally

```bash
git clone https://github.com/cryptohakka/perceptrade.git
cd perceptrade
npm install
cp .env.example .env  # fill in API keys
node main.js
```

### Required `.env` keys

```
OPENROUTER_API_KEY=
BITGET_API_KEY=
BITGET_SECRET_KEY=
BITGET_PASSPHRASE=
CYCLE_INTERVAL_MS=300000
```

> All 6 perception sources (Bybit, OKX, Binance, KuCoin, Hyperliquid, Bitget) use public endpoints for FR/OI data. API keys are only required for Bitget futures execution.

---

## File Structure

```
perceptrade/
├── main.js          # entry point, starts server + agent loop
├── agent.js         # Triple-A council orchestration
├── perception.js    # FR/OI collection from 6 sources
├── risk.js          # directionSignal + riskSignal computation
├── bitget.js        # Bitget API wrapper
├── server.js        # Express UI server
└── public/
    ├── landing.html
    ├── app.html
    └── analysis.html
```

---

## Bitget Agent Hub Integration

PercepTrade integrates Bitget Agent Hub for both execution and perception:

| Module | Usage |
|--------|-------|
| `bitget-skill` (MCP, 58 tools) | Futures order placement, position management, funding rate retrieval, P&L tracking |

The MCP server handles all Bitget futures execution, giving the Triple-A agent council direct access to trading operations without custom API wrappers.

Setup:
```bash
npx bitget-hub upgrade-all --target claude
```

---

## Hackathon

Submitted to **Bitget Hackathon S1** as a Multi-CEX Risk-Aware Trading Agent.

Built by [@cryptohakka](https://github.com/cryptohakka) / [a2aflow.space](https://a2aflow.space)
