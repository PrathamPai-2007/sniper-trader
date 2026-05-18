# Veloci-Buy: High-Performance Solana Discovery & Execution Engine

![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.19.0-blue)
![Solana](https://img.shields.io/badge/blockchain-Solana-black)
![License](https://img.shields.io/badge/license-MIT-green)

**Veloci-Buy** is an industry-grade, event-driven discovery and sniping engine engineered for the Solana ecosystem. Designed for professional traders and developers, it delivers sub-second reaction times by combining a high-concurrency ingestion pipeline with a sophisticated, multi-stage risk mitigation architecture.

> [!NOTE]
> **Performance & Precision**: Veloci-Buy bypasses traditional API latency by subscribing directly to program logs via WebSockets, ensuring your execution hits the chain before the crowd.

---

## Technical Architecture

Veloci-Buy is built on a decoupled, service-oriented architecture that prioritizes modularity and low-latency execution:

- **Orchestration (`bot.js`)**: Manages the high-precision loop watchdogs and system lifecycle.
- **Event Ingestion (`discovery.js`)**: A high-speed pipeline for real-time monitoring of Pump.fun, Raydium, and Meteora program logs.
- **Heuristic Decision Engine (`engine.js`)**: Filters candidates through complex scoring models, including momentum analysis and survival timeframes.
- **Security Audit Suite (`audit.js`)**: Performs deep on-chain inspection of mint/freeze authorities and holder concentration, integrated with external security signals.
- **Parallel Execution Adapter (`trading.js`)**: A zero-wait Jupiter integration that pre-builds transactions during the audit phase to shave hundreds of milliseconds off execution.
- **Risk Management (`monitor.js`)**: Automated position monitoring with dynamic TP/SL execution and trailing drawdown protection.

---

## Key Innovations (v2.0)

### Zero-Wait Sniping Architecture

The v2.0 engine implements **Parallel Quote Pre-fetching**. While the security audit performs deep-dive account inspections, the trading module simultaneously fetches Jupiter swap quotes. This ensures that the moment a token passes the final audit gate, a pre-signed transaction is ready for immediate broadcast.

### Scalable Multi-RPC Load Balancing

Support for a round-robin RPC pool architecture. By distributing requests across multiple providers (e.g., Helius, QuickNode, Triton), the bot maximizes throughput and eliminates provider-level rate limit bottlenecks.

### Priority-Aware Rate Limiting

A sophisticated 4-tier queuing system ensures that critical execution tasks (signature confirmation, transaction broadcast) always take precedence over background discovery and metadata fetching.

### Dynamic Trade Management

The bot now utilizes **Score-Based Profiles** to manage open positions. High-confidence candidates are granted wider trailing stops to capture parabolic moves, while lower-confidence entries utilize tight risk controls to lock in profits early.

---

## Staged Risk Mitigation Pipeline

Veloci-Buy employs a rigorous multi-gate audit strategy to protect capital:

1.  **Survival Delay**: Dynamic wait times (5s–25s) based on initial candidate quality to filter out instant rug-pulls.
2.  **Anti-FOMO Filters**: Prevents "buying the top" by detecting parabolic growth and entering a pullback recheck loop.
3.  **Liquidity Guard**: Continuous monitoring of pool depth; triggers emergency exits if liquidity collapses below the calculated floor.
4.  **FDV-to-Liquidity Analysis**: Rejects tokens with disproportionate valuations that are prone to extreme slippage and manipulation.

---

## Quick Start

### 1. Prerequisites

- **Node.js**: `>= 20.19.0`
- **Solana RPC**: Access to one or more high-quality RPC/WS endpoints.
- **Jupiter API**: Required for execution and price feeds.

### 2. Installation

```bash
npm install
cp .env.example .env
```

_Configure your RPC URLs and private keys in the `.env` file._

### 3. Execution

```bash
# Start the bot in Paper Trading mode (recommended for first run)
npm start

# Run the full CI validation suite
npm run ci
```

---

## Engineering Excellence

Veloci-Buy is maintained with high engineering standards to ensure reliability in volatile markets:

- **Atomic State Persistence**: Custom `atomicWriteFile` utility ensures state files remain corruption-proof on all operating systems.
- **Comprehensive Testing**: A full suite of unit and integration tests covering the entire trading lifecycle.
- **CI Pipeline**: Automated dependency audit, syntax, linting, formatting, and test validation on every commit.

---

## Verification & Test Coverage

The system is backed by a comprehensive validation suite covering critical path operations:

- **Engine Heuristics**: Candidate scoring from socials, liquidity tiers, launchpad profile bonuses, GMI-driven entry score adjustment, ATH protection logic, FDV-to-liquidity safety gates, and reduced-fidelity historical snapshot handling.
- **Bot Orchestration**: Score-based survival delay tiers, holder-count waitlists, indexing-lag retry caps, disabled-borderline behavior, and automated pullback recheck cancellation when price deterioration exceeds the configured threshold.
- **Execution Reliability**: Jupiter price payload normalization, per-mint fallback price lookups, explicit Jupiter API-key selection, paper round trips, live dry-run balance inspection, live swap bookkeeping, nested BigInt audit metadata persistence, and buy failure accounting.
- **Audit Resilience**: Mint-signal indexing-lag retries stop at the configured attempt limit instead of looping indefinitely.
- **Risk Management**: Mood-based sizing pauses, score-based trade profiles, take-profit fraction math, volatility-scaled stop-loss calculations, insider drift detection helpers, immediate stop-loss and liquidity exits before minimum hold time, and time-exit minimum-hold gating.
- **Quant Strategy Helpers**: GMI aggression changes, volatility-scaler stop-loss math, insider drift holder-delta detection, and spread/standard-deviation utility calculations.
- **Infrastructure**: Bounded concurrency ordering, standard deviation and spread utilities, pump.fun curve decoding, startup validation for explicit live-trading arming, and Windows-safe atomic file persistence.

---

## Changelog

### v2.x - Quant Strategy Upgrades

- **Decommissioned Backtesting**: Removed legacy `recorder.js` and `backtest.js` to focus on real-time execution and reduce codebase bloat.
- **Global Momentum Index (GMI)**: New market-wide filter tracking the success rate of the last 100 launches to dynamically adjust entry aggression.
- **Volatility-Adaptive Risk**: Introduced a **Volatility Scaler** that scales Stop-Loss levels based on price standard deviation during discovery.
- **Accelerated Trailing Stop**: Implemented a parabolic-style trailing stop that tightens as profit multiples increase beyond 1.8x.
- **Insider Drift Tracking**: Continuous post-entry monitoring of the top 5 holders; triggers a 40% de-risk sell if any insider sells >25%.
- **Spread Velocity Detection**: Emergency exit trigger that detects rapid bid/ask spread widening (>50% in <15s) to front-run liquidity removals.

---

## Disclaimer

**Financial Risk**: Trading cryptocurrencies, especially memecoins on Solana, involves significant risk of loss. This software is provided "as is" without warranty of any kind. Always test your strategies in `PAPER_TRADING=true` and `DRY_RUN=true` modes. Never deploy capital you cannot afford to lose.

---

_Developed with focus on speed, safety, and scalability. v2.1 - Quant Strategy Upgrade._
