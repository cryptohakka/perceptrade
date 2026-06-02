# PercepTrade

**Multi-CEX Crowd Risk Detection Trading Agent** — Bitget Hackathon S1

Live demo: [perceptrade.a2aflow.space](https://perceptrade.a2aflow.space)

---

## The Problem

Most trading agents react to price. PercepTrade reads the crowd.

Funding Rate and Open Interest are real-time signals of how leveraged the market is — and *which exchange* is driving that leverage. When one venue shows anomalous FR or OI relative to peers, it indicates localized crowd behavior before price reacts.

PercepTrade aggregates 6 CEX/DEX sources, detects these cross-venue anomalies in real time (**Crowd Risk Detection**), and adjusts position sizing before the crowd unwinds.

---

## Architecture

```
Perception Layer (6 sources)
  Bybit / OKX / Binance / KuCoin / Hyperliquid DEX
  + Bitget (FR / OI / Long-Short Ratio — Bitget exclusive)
       │
       ▼
Signal Computation
  directionSignal  →  long / short + confidence %
  riskSignal       →  sizeMultiplier (×0.25 / ×0.50 / ×1.00)
  crowdRisk        →  anomalous exchange detection + size suppression
       │
       ▼
Triple-A Agent Council (OpenRouter / gemini-2.5-flash-lite)
  Architect  →  proposes action with L/S ratio context
  Auditor    →  stress-tests proposal, flags crowd risk
  Arbiter    →  final decision + position size
       │
       ▼
Bitget Futures Execution
  Market order + TP/SL (place-pos-tpsl)
```

**Cycle:** 5 minutes | **Bot/Agent split:** ~60% rule-based / ~40% LLM

---

## Crowd Risk Detection

The core differentiator. Each cycle, PercepTrade checks whether any single exchange is behaving anomalously relative to the 6-source aggregate.

**Trigger conditions (OR logic):**
- FR of one venue deviates >2σ from the cross-CEX mean
- OI change at one venue is >3× the average OI change rate

**When triggered:**
- The anomalous exchange and deviation magnitude are surfaced to the Auditor agent
- `sizeMultiplier` is hard-capped at `×0.25` regardless of direction confidence
- The Risk Assessment UI highlights the offending venue in red

**Why it matters:** Crowd piling into one venue — visible as FR/OI divergence — is a leading indicator of forced liquidation cascades. Reducing size before the crowd unwinds is the alpha.

---

## Bitget-Exclusive Signals

Beyond execution, PercepTrade uses Bitget-specific market data unavailable on other exchanges:

| Signal | Endpoint | Usage |
|--------|----------|-------|
| Long/Short Position Ratio | `/api/v2/mix/market/position-long-short` | Injected into Architect prompt as crowd sentiment context |
| Funding Rate (with upper/lower bounds) | `/api/v2/mix/market/current-fund-rate` | FR deviation baseline for Crowd Risk |
| Open Interest | `/api/v2/mix/market/open-interest` | OI momentum computation |

The Long/Short Ratio is displayed as a live gauge in the Analysis UI with a **BITGET EXCLUSIVE** label.

---

## Signal Design

### Direction Signal
| Value | Condition |
|-------|-----------|
| `long` + high confidence | FR elevated, OI growing — crowd leveraged long |
| `short` + high confidence | FR negative, OI growing — crowd leveraged short |
| `neutral` | Mixed or low-conviction signals |

### Risk Signal → sizeMultiplier
| Multiplier | Condition |
|------------|-----------|
| `×1.00` | Low FR deviation, stable OI |
| `×0.50` | Moderate cross-CEX divergence |
| `×0.25` | High deviation, rapid OI shift, or Crowd Risk triggered |

---

## Triple-A Framework

Sequential debate — no agent shares system prompts with others:

- **Architect** — evaluates direction + risk signals + Bitget L/S ratio, proposes `long / short / hold`
- **Auditor** — challenges proposal, explicitly flags Crowd Risk anomalies, can reduce confidence
- **Arbiter** — final decision: `action` + `size_pct = proposal.confidence × sizeMultiplier`

---

## Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js |
| LLM | OpenRouter → `gemini-2.5-flash-lite` |
| Perception | Bybit / OKX / Bitget / Binance / KuCoin / Hyperliquid |
| Execution | Bitget Futures API v2 (market order + place-pos-tpsl) |
| UI | Vanilla HTML/CSS/JS |
| Process | systemd (`perceptrade-agent`) |
| Infra | VPS + nginx |

---

## UI

| Page | Path | Description |
|------|------|-------------|
| Landing | `/` | Project overview |
| Dashboard | `/app` | Live position (with TP/SL), Triple-A council log, execution log |
| Analysis | `/analysis` | Per-CEX FR/OI charts, direction confidence, Crowd Risk status, Bitget L/S Ratio gauge |

---

## Running Locally

```bash
git clone https://github.com/cryptohakka/perceptrade.git
cd perceptrade
npm install
cp .env.example .env
node main.js
```

### Required `.env`

```
OPENROUTER_API_KEY=
BITGET_API_KEY=
BITGET_SECRET_KEY=
BITGET_PASSPHRASE=
CYCLE_INTERVAL_MS=300000
MAX_POSITION_SIZE_USDT=100
```

> FR/OI perception uses public endpoints across all 6 sources. API keys are only required for Bitget execution.

---

## File Structure

```
perceptrade/
├── main.js          # entry point
├── agent.js         # Triple-A council + execution logic
├── perception.js    # FR/OI/L-S collection (6 sources)
├── risk.js          # directionSignal + riskSignal + crowdRisk
├── bitget.js        # Bitget API wrapper (order + market data)
├── server.js        # Express UI server
└── public/
    ├── landing.html
    ├── app.html
    └── analysis.html
```

---

Built by [@cryptohakka](https://github.com/cryptohakka) / [a2aflow.space](https://a2aflow.space)  
Submitted to **Bitget Hackathon S1**
