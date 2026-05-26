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

- **Orchestration (`bot.js`)**: Manages the high-precision loop watchdogs, system lifecycle, and global event coordination.
- **Scanner Service (`scanner.js`)**: Handles candidate identification, multi-stage audit scheduling, and re-audit logic for tokens discovered via polling or WebSocket.
- **Event Ingestion (`discovery.js`)**: A high-speed pipeline for real-time monitoring of program logs. Features direct log parsing for sub-second discovery.
- **Heuristic Decision Engine (`engine.js`)**: Filters candidates through complex scoring models, including momentum analysis and survival timeframes.
- **Security Audit Suite (`audit.js`)**: Performs deep on-chain inspection of mint/freeze authorities and holder concentration, integrated with external security signals.
- **Parallel Execution Adapter (`trading.js`)**: A zero-wait Jupiter integration that pre-builds transactions during the audit phase to shave hundreds of milliseconds off execution.
- **Risk Management (`monitor.js`)**: Automated position monitoring with dynamic TP/SL execution and trailing drawdown protection.
- **State Management (`store.js`)**: Centralized state store with incremental persistence to keep the event loop responsive during high-frequency operations.

---

## Key Innovations (v2.x)

### Sub-Second Discovery Engine

The bot now parses program logs directly for **Pump.fun**, extracting mint addresses the instant they are created. This bypasses the traditional 200ms–1s RPC indexing lag required for full transaction lookups, ensuring your bot sees the token before it even appears on most scanners.

### Batch Audit Inspection

By utilizing `getMultipleAccounts` for holder and authority audits, the bot consolidates dozens of RPC calls into a single high-speed request. This drastically reduces the "Full Audit" duration, which is critical for winning competitive snipes in low-liquidity environments.

### Smart RPC Failover & Health Tracking

A new unified RPC provider layer tracks the health of every endpoint in your pool. If a provider degrades or hits a rate limit, the bot automatically fails over to the next healthy candidate in real-time, ensuring zero downtime during volatile market conditions.

### API Circuit Breakers & Fail-Safe Logic

The security pipeline is now resilient to external API outages. If GoPlus or BubbleMaps experience downtime or timeouts, the bot automatically switches to stricter **Local On-Chain Heuristics**, protecting your capital even when third-party services fail.

### Incremental State Persistence

To maintain peak performance during long sessions, the bot utilizes a dual-track persistence model. Active trading state is saved frequently, while bulky historical data is offloaded lazily, preventing event loop "stutters" that can cause execution delays.

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
- **Dynamic Syntax Validation**: Recursive syntax validator (`check-syntax.js`) scans all JavaScript files automatically without requiring manual updates to package scripts.
- **Hardened ESLint Rules**: Strictly enforces `'use strict';` global declarations, modern block scoping (`no-var`, `prefer-const`), strict type-safe equality (`===`), and variable shadowing protection.
- **Comprehensive Testing**: A full suite of unit and integration tests covering the entire trading lifecycle.
- **CI Pipeline**: Automated dependency audit, dynamic syntax checking, hardened linting, formatting, and test validation on every commit.

---

## Verification & Modular Test Suite

Veloci-Buy uses a robust, modular test suite leveraging Node's native `node:test` runner. The monolithic `tests.js` has been refactored into focused files under the `tests/` directory:

- **[tests/\_test_helpers.js](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/_test_helpers.js)**: Reusable configurations, sandbox context states, `fetch` mockers, member patchers, and state seeds.
- **[tests/engine.test.js](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/engine.test.js)**: Evaluates decision engine scoring, GMI aggro modifications, memecoin filter matching, and candidate evaluation buffers.
- **[tests/scanner.test.js](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/scanner.test.js)**: Tests event schedules, survival delay tiers, indexing-lag wait caps, and slot reservations.
- **[tests/services.test.js](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/services.test.js)**: Exercises the high-level trade lifecycle including paper swaps, dry-runs, and token balance queries.
- **[tests/audit.test.js](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/audit.test.js)**: Exercises token authority safety audits, indexing lag retries, and GoPlus address scanning.
- **[tests/monitor.test.js](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/monitor.test.js)**: Focuses on dynamic TP/SL execution, volatility stop-loss bounds, insider drift, and emergency exits.
- **[tests/config.test.js](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/config.test.js)**: Validates startup constraints, live trading safety checks, and invalid bounds rejection.
- **[tests/utils.test.js](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/utils.test.js)**: Covers Windows EPERM write retries, safe JSON serialization, standard deviation, and curve decoders.

### Run Commands

```bash
# Run all modular tests
npm test

# Run dynamic syntax verification on all JS files
npm run check

# Verify coding guidelines using strict linter
npm run lint

# Validate Prettier formatting
npm run format:check

# Format all files in-place using Prettier
npm run format

# Run complete CI validation pipeline (audit -> check -> lint -> format:check -> test)
npm run ci
```

---

## Configuration Optimization (`node analyze.js`)

To optimize the exit strategy parameters of your trading engine, Veloci-Buy includes a post-session **Trade Replay Analyzer** ([analyze.js](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/analyze.js)). This tool acts as a local parameter optimizer, backtesting historical trading journals across thousands of strategy permutations to isolate the highest-performing configurations.

### How It Works

1. **Trade Replay Ingestion**: The optimizer scans `logs/paper-trading/` to reconstruct complete historical trades from session journals (`paper-trade-journal.jsonl`, `trade-journal.jsonl`, and `metrics.json`).
2. **Synthetic Price Path Reconstruction**: Since full ticks can be storage-heavy, the engine reconstructs a synthetic price curve for each trade (`entryPriceUsd` → `highestPriceUsd` → `actualExitPrice`) mapped against the actual trade duration.
3. **Multi-Parameter Grid Search**: It replays each trade through a 7-parameter grid mapping **9,216 distinct exit rule configurations**:
   - `stopLossPct`: `[0.1, 0.15, 0.2, 0.25]` (10% to 25% Stop Loss)
   - `trailingDrawdownPct`: `[0.1, 0.15, 0.2, 0.25]` (Trailing Drawdown exit buffer)
   - `takeProfitMultiples`: `[[1.5], [1.3, 2.0], [1.5, 2.5]]` (1 target, 2 targets, etc.)
   - `takeProfitFraction`: `[0.5, 0.6, 0.75]` (What percentage of position to sell at each target)
   - `earlyPerformanceDropPct`: `[5, 10, 15, 20]` (Trigger for early performance guard)
   - `earlyPerformanceSellPct`: `[40, 60, 80, 100]` (Fraction to exit early if stalling)
   - `maxHoldMinutes`: `[10, 20, 30, 60]` (Maximum time-based hold durations)
4. **Calculated Metrics**: Each configuration combo is ranked based on:
   - **Win Rate (%)**
   - **Profit Factor** (Gross profit divided by gross loss)
   - **Average PnL per trade**
   - **Max Drawdown** (Maximum single trade loss)
   - **Total PnL** (Overall profitability)

### Usage

Replay and optimize your historical paper trading configurations by running:

```bash
node analyze.js
```

The console will display the overall sessions ingested, total trades, grid combos processed, and output the **top 10 configurations** ranked by profit factor and overall PnL, highlighting exactly which parameter values to adjust in your strategy config.

---

## Changelog

### v2.x - Code Quality & Maintainability Milestone

- **Dynamic Syntax Validation**: Introduced recursive `check-syntax.js` validator, ensuring no JS file bypasses CI syntax checks.
- **Strict ESLint Rules**: Enforced `'use strict';` global declarations, modern block scoping (`no-var`, `prefer-const`), strict type-safe equality (`===`), and variable shadowing protection.
- **Codebase Cleanups**: Fixed shadowing bugs in `audit.js` and `utils.js`, converted unassigned variables to `const` in `discovery.js`, `monitor.js`, and `trading.js`.
- **Prettier Dev Commands**: Added `npm run format` for developer ergonomics to format in-place.

### v2.x - Performance & Reliability Milestone

- **Sub-Second Discovery**: Optimized `discovery.js` with direct Pump.fun log parsing, bypassing RPC indexing lag.
- **Decoupled Orchestrator**: Extracted scanning and scheduling logic into a dedicated `scanner.js` service for better modularity.
- **Batch Audit Inspection**: Refactored `audit.js` to use `getMultipleAccounts`, reducing audit latency by consolidating RPC requests.
- **Smart RPC Failover**: Implemented a unified RPC provider layer with real-time health tracking and automatic failover.
- **API Circuit Breakers**: Added fail-safe modes for GoPlus and BubbleMaps to handle external API outages gracefully.
- **Incremental Persistence**: Refactored `store.js` to split state into frequent and lazy files, ensuring event loop responsiveness.
- **Granular WS Watchdog**: Enhanced WebSocket monitoring to track activity on a per-program basis, improving failure detection.

### v2.x - Trade Replay Analyzer & Logging Enhancements

- **Trade Replay Analyzer**: New `analyze.js` module for post-session parameter optimization via 7-variable grid scanning across 9,216 combos.
- **Enriched Trade Journaling**: `recordClosedTrade` now persists 18 fields including entry score, TP profile, volatility scaler, and launchpad for accurate replay analysis.
- **JSONL Journal Format**: Renamed `paper-trade-journal.json` to `.jsonl` for proper line-delimited parsing; added `journalClosedTrade` utility in `utils.js`.

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
