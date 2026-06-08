# PercepTrade

**Multi-CEX FR Z-Score Contrarian Trading Agent** — Bitget Hackathon S1

Live demo: [perceptrade.a2aflow.space](https://perceptrade.a2aflow.space)

PercepTrade combines quantitative crowd positioning signals with a **Triple-A AI Council** (Architect, Auditor, Arbiter) to determine when — and how aggressively — to fade leveraged crowd extremes across 6 CEX/DEX sources.

---

## The Problem

Most trading agents react to price. PercepTrade reads the crowd.

Funding Rate is a real-time signal of how leveraged and directionally biased the market is across all major venues. When the cross-CEX average FR deviates significantly from its recent baseline, it signals a statistically over-extended crowd — ripe for mean reversion.

PercepTrade aggregates 6 CEX/DEX sources, computes a **FR Z-Score** against a 24-hour rolling baseline, and fades the crowd when the signal is statistically clear. An **OI momentum gate** prevents entry when the crowd is still actively building. A **Crowd Risk detector** identifies single-exchange anomalies and suppresses position size before forced liquidations cascade.

---

## Architecture

```
Perception Layer (6 sources)
  Bybit / OKX / Binance / KuCoin / Bitget / Hyperliquid DEX
  │
  │  Bitget contributes additional proprietary signals:
  │  Funding Rate bounds, Open Interest, and Long/Short Ratio
       │
       ▼
Signal Computation (rule-based, deterministic)
  frZ              →  z-score of cross-CEX avgFR vs 24h rolling baseline
  oiMomentum       →  log-change of OI vs previous cycle (entry gate)
  frRegime         →  Normal / Extreme (|frZ| ≥ FR_Z_EXTREME, default 2σ → ×0.7 size caution)
  crowdRisk        →  single-exchange FR/OI anomaly detection (MAD-based)
  riskAttribution  →  per-component score breakdown (CEX Spread / OI Momentum / Total Risk)
       │
       ▼
Triple-A Agent Council (OpenRouter / gemini-2.5-flash-lite)
  Architect  →  proposes action with frZ, frRegime, L/S ratio context
  Auditor    →  stress-tests proposal, flags crowd risk and regime conditions
  Arbiter    →  final decision + position size
       │
       ▼
Bitget Futures Execution
  Market order (taker) + TP/SL (place-pos-tpsl)
```

**Cycle:** 5 minutes

**Bot/Agent split:** ~60% rule-based / ~40% LLM — Deterministic signals (FR Z-score, OI momentum, Crowd Risk) remain rule-based for consistency and auditability, while the Triple-A council interprets context and determines position sizing.

---

## Triple-A Agent Council

The AI core of PercepTrade. Three adversarial agents debate each cycle — no agent shares system prompts with others:

- **Architect** — evaluates frZ, frRegime, OI gate status, and Bitget L/S ratio; proposes `long / short / hold`
- **Auditor** — receives natural language Crowd Risk warning (exchange name, FR value, MAD deviation) and regime context; challenges proposal, can reduce confidence
- **Arbiter** — final decision: `action` + `size_pct = confidence × sizeMultiplier × regimeFactor`

The council provides a flexible layer for interpreting unstructured market context — crowd anomaly descriptions, regime warnings, and cross-venue sentiment — and translating it into position sizing decisions.

**Fallback behavior:** If OpenRouter is unavailable or rate-limited, each agent falls back to a safe default — Architect and Arbiter default to `hold`, Auditor defaults to conservative reject. The system never trades on an incomplete council decision.

### Example: One Cycle

```
frZ         = +2.1   (crowd statistically over-long)
OI momentum = +0.08% (below +30bps gate — ALLOWED)
frRegime    = Extreme (|frZ| ≥ FR_Z_EXTREME=2.0 → ×0.7)
Crowd Risk  = none
Bitget L/S  = 73% long

Architect:
  "Cross-CEX FR is elevated at +2.1σ above 24h baseline.
   Bitget L/S shows 73% positioned long — crowd over-extended.
   Recommend SHORT."

Auditor:
  "No single-exchange anomaly detected (all venues within 2× MAD).
   Extreme frRegime noted — size caution applies.
   Signal remains valid. No objection."

Arbiter:
  SHORT · confidence 78% · size 39%
  (78% confidence × ×0.7 regime factor × base = 39% of max position)
```

---

## Core Strategy: FR Z-Score Contrarian

The primary signal. PercepTrade computes `frZ` — the z-score of the current cross-CEX average funding rate against a 24-hour rolling baseline (288 five-minute samples).

| frZ | Interpretation | Action |
|-----|---------------|--------|
| ≥ +1.5 | Crowd statistically over-long | **SHORT** |
| ≤ −1.5 | Crowd statistically over-short | **LONG** |
| −1.5 to +1.5 | No clear over-extension | **HOLD** |

**Why contrarian?** Funding rates mean-revert. When FR is unusually elevated, leveraged longs are paying — pressure builds for unwind. Fading the crowd at statistical extremes captures this reversion.

### OI Momentum Gate

Before any entry, OI log-momentum is checked. If open interest is still actively building (threshold: **+30 bps**), the trade is blocked regardless of frZ signal — entering into an accelerating crowd trend defeats the contrarian premise.

### FR Regime

`frRegime` tracks the absolute magnitude of `frZ` against σ-bands:

| Regime | Condition | Size Factor |
|--------|-----------|-------------|
| Normal | \|frZ\| < 2σ | ×1.0 |
| Extreme | \|frZ\| ≥ FR_Z_EXTREME (default 2σ, configurable) | ×0.7 |

Extreme regime means unstable liquidity — size is reduced as a caution measure, not as a signal amplifier. The threshold that triggers a trade (±1.5) and the regime label are intentionally separate layers.

### Restart Resilience

On restart, `frHistory` and `prevSources` are restored from the most recent `snapshots.json` entry (with a 10-minute guard). frZ computation and OI momentum are never zeroed by a service restart.

---

## Crowd Risk Detection

A secondary defense layer. Each cycle, PercepTrade checks whether any single exchange is behaving anomalously relative to the 6-source aggregate.

**Trigger conditions (OR logic):**
- FR of one venue deviates >3.5× MAD from the cross-CEX median
- OI change at one venue is abnormally concentrated relative to peers

**When triggered:**
- The anomalous exchange and deviation magnitude are surfaced to the Auditor agent as a natural language warning
- `sizeMultiplier` is hard-capped at `×0.25` regardless of direction confidence
- The Risk Assessment UI highlights the offending venue in red
- A `[blocked]` entry appears in the Execution Log showing original vs. final size
- The event is persisted to `crowd_events.json` with timestamp, exchange, FR deviation, and size cap applied

**Why it matters:** Crowd piling into one venue — visible as FR/OI divergence — is a leading indicator of forced liquidation cascades. Reducing size before the crowd unwinds is the alpha.

**Example (real cycle output):**
```
Binance FR = 0.031%
Cross-CEX Median = 0.009%
Deviation = 3.4× MAD → statistically anomalous

→ [blocked] Binance crowd concentration detected
→ Auditor receives: "Binance FR is 0.0310% vs cross-CEX median 0.0090%
   (3.4× MAD — statistically anomalous crowd concentration)"
→ Size capped: ×1.00 → ×0.25
→ [risk-mgmt] crowd risk prevented full exposure · original 72% → final 18%
```

**Validation status:** Crowd Risk outcomes (1h/3h/6h/12h post-event price tracking) are being collected live via `crowd_outcomes.json`. Historical validation is ongoing.

> PercepTrade doesn't just trade. It knows when *not* to trade at full size.

---

## Bitget-Exclusive Signals

Beyond execution, PercepTrade uses Bitget-specific market data unavailable on other exchanges:

| Signal | Endpoint | Usage |
|--------|----------|-------|
| Long/Short Position Ratio | `/api/v2/mix/market/position-long-short` | Injected into Architect prompt as crowd sentiment context |
| Funding Rate (with upper/lower bounds) | `/api/v2/mix/market/current-fund-rate` | Included in cross-CEX frZ baseline |
| Open Interest | `/api/v2/mix/market/open-interest` | OI momentum gate computation |

The Long/Short Ratio is displayed as a live gauge in the Analysis UI with a **BITGET EXCLUSIVE** label.

---

## Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js |
| LLM | OpenRouter → `gemini-2.5-flash-lite` |
| Perception | Bybit / OKX / Bitget / Binance / KuCoin / Hyperliquid |
| Execution | Bitget Futures API v2 (limit order + place-pos-tpsl) |
| UI | Vanilla HTML/CSS/JS |
| Process | systemd (`perceptrade-agent`) |
| Infra | VPS + nginx |

---

## UI

| Page | Path | Description |
|------|------|-------------|
| Landing | `/` | Project overview |
| Dashboard | `/app` | Live position (with TP/SL), Triple-A council log, execution log with `[blocked]` entries, **Risk Attribution** (CEX Spread / OI Momentum / Total Risk / Size Multiplier breakdown) |
| Analysis | `/analysis` | FR Z-Score gauge, OI momentum gate status, frRegime indicator, per-CEX FR/OI breakdown, Crowd Risk status, Bitget L/S Ratio gauge, **Cross-CEX Crowd Map** (FR/OI deviation heatmap across 6 venues), **Crowd Risk Event History** |
| History | `/history` | Trade history, FR Z-Score log, Crowd Outcomes (post-event 1h/3h/6h/12h tracking), Protection Log |

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
LEVERAGE=2
ENTRY_FEE_PCT=0.0006
EXIT_FEE_PCT=0.0006
FR_Z_THRESHOLD=1.5
FR_Z_EXTREME=2.0
```

> FR/OI perception uses public endpoints across all 6 sources. API keys are only required for Bitget execution.

> **Rate limits:** If running multiple instances simultaneously, some exchanges (particularly Binance and Hyperliquid) may rate-limit repeated requests from the same IP. In high-traffic deployments, routing perception requests through a proxy or using a dedicated IP per instance is recommended.

---

## File Structure

```
perceptrade/
├── main.js              # entry point
├── agent.js             # Triple-A council + execution logic
├── perception.js        # FR/OI/L-S collection (6 sources) + frZ computation
├── risk.js              # riskSignal + crowdRisk (Median/MAD) + riskAttribution
├── bitget.js            # Bitget API wrapper (order + market data)
├── server.js            # Express UI server
├── crowd_events.json    # Crowd Risk event log (auto-generated)
├── crowd_outcomes.json  # Post-event price outcome tracking 1h/3h/6h/12h (auto-generated)
├── snapshots.json       # Per-cycle FR/OI/frZ snapshots for backtesting (auto-generated)
└── public/
    ├── landing.html
    ├── app.html
    ├── analysis.html
    └── history.html
```

---

Built by [@cryptohakka](https://github.com/cryptohakka) / [a2aflow.space](https://a2aflow.space)  
Submitted to **Bitget Hackathon S1**
