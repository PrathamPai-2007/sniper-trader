# Veloci-Buy: High-Performance Solana Discovery & Execution Engine

![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.19.0-blue)
![Solana](https://img.shields.io/badge/blockchain-Solana-black)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Disclaimer

> [!WARNING]
> **Financial Risk**: Trading cryptocurrencies, especially memecoins on Solana, involves significant risk of loss. This software is provided "as is" without warranty of any kind. Always test your strategies in `PAPER_TRADING=true` and `DRY_RUN=true` modes. Never deploy capital you cannot afford to lose.
>
> **Tax Responsibility**: Ensure you know the tax laws in your country and pay taxes responsibly. The developers and contributors of Veloci-Buy are not responsible for your tax obligations or compliance.

---

**Veloci-Buy** is an industry-grade, event-driven discovery and sniping engine engineered for the Solana ecosystem. Designed for professional traders and developers, it delivers sub-second reaction times by combining a high-concurrency ingestion pipeline with a sophisticated, multi-stage risk mitigation architecture.

> [!NOTE]
> **Performance & Precision**: Veloci-Buy bypasses traditional API latency by subscribing directly to program logs via WebSockets, ensuring your execution hits the chain before the crowd.

---

## Technical Architecture

Veloci-Buy is built on a decoupled, service-oriented architecture that prioritizes modularity and low-latency execution:

- **Orchestration ([src/index.ts](src/index.ts))**: Encapsulated within the `VelociBuyBot` class, managing high-precision loop watchdogs, system lifecycle, and global event coordination with resilient shutdown handlers.
- **Scanner Service ([src/services/scanner/scanner.service.ts](src/services/scanner/scanner.service.ts))**: Handles candidate identification, multi-stage audit scheduling, and re-audit loops.
- **Event Ingestion ([src/services/discovery/discovery.service.ts](src/services/discovery/discovery.service.ts))**: A high-speed log ingestion and parsing pipeline for real-time WebSocket discovery.
- **Heuristic Engine ([src/services/engine/engine.service.ts](src/services/engine/engine.service.ts))**: Scores candidates using organic traction metrics, GMI filters, and momentum analysis.
- **Security Audit ([src/services/audit/audit.service.ts](src/services/audit/audit.service.ts))**: Direct RPC-based authority audits and smart holder concentration checks.
- **Execution Adapter ([src/services/trading/trading.service.ts](src/services/trading/trading.service.ts))**: Jupiter swap builder supporting paper simulations, dry-runs, and live orders.
- **Risk Monitor ([src/services/monitor/monitor.service.ts](src/services/monitor/monitor.service.ts))**: Dynamic profit targets, trailing stop-losses, insider drift guards, and spread velocity exit checks.
- **State Store ([src/core/store.ts](src/core/store.ts))**: Atomically persists runtime states, cool-downs, and historical stats.
- **Toolkit ([src/core/utils.ts](src/core/utils.ts))**: Shared logging, serialization, notification, and async flow pools.

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

- **[tests/\_test_helpers.js](tests/_test_helpers.js)**: Reusable configurations, sandbox context states, `fetch` mockers, member patchers, and state seeds.
- **[tests/engine.test.js](tests/engine.test.js)**: Evaluates decision engine scoring, GMI aggro modifications, memecoin filter matching, and candidate evaluation buffers.
- **[tests/scanner.test.js](tests/scanner.test.js)**: Tests event schedules, survival delay tiers, indexing-lag wait caps, and slot reservations.
- **[tests/services.test.js](tests/services.test.js)**: Exercises the high-level trade lifecycle including paper swaps, dry-runs, and token balance queries.
- **[tests/audit.test.js](tests/audit.test.js)**: Exercises token authority safety audits, indexing lag retries, and GoPlus address scanning.
- **[tests/monitor.test.js](tests/monitor.test.js)**: Focuses on dynamic TP/SL execution, volatility stop-loss bounds, insider drift, and emergency exits.
- **[tests/config.test.js](tests/config.test.js)**: Validates startup constraints, live trading safety checks, and invalid bounds rejection.
- **[tests/utils.test.js](tests/utils.test.js)**: Covers Windows EPERM write retries, safe JSON serialization, standard deviation, and curve decoders.

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

To optimize the exit strategy parameters of your trading engine, Veloci-Buy includes a post-session **Trade Replay Analyzer** ([analyze.js](analyze.js)). This tool acts as a local parameter optimizer, backtesting historical trading journals across thousands of strategy permutations to isolate the highest-performing configurations.

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

## v2.x Changelog

### Persistence Resilience & Class-Based Refactor

- **Class-Based Orchestration**: Refactored the main entry point into a unified `VelociBuyBot` class, eliminating module-level globals and improving modularity and testability.
- **Resilient State Persistence**: Implemented a mandatory `flush()` mechanism in `StateStore` to ensure all pending state changes are committed to disk during shutdowns.
- **Enhanced Audit Reliability**: Added exponential backoff and retry logic for security audits to handle RPC indexing lag when verifying token holder concentration.
- **Persistent Trade History**: Transitioned trade statistics to an append-only `trades.jsonl` format, preserving the complete history of all trades across multiple sessions.

### Type Hardening & Migration Finalization

- **Complete TypeScript Transition**: Migrated the final major logic block, `analyze.js` (Post-Session Optimizer), to `src/core/analyze.ts` with full type safety for trade replays and grid search.
- **Comprehensive Type Hardening**: Hardened over 50 core interfaces (`Position`, `Context`, `State`, `SwapOrder`) and audit signal structures. Removed dozens of `any` casts and intersection types across all services (`monitor`, `trading`, `scanner`, `audit`).
- **Strict Data Contracts**: Established formal interfaces for financial transactions and security signals, ensuring compile-time verification of the entire trading pipeline.
- **Architectural Cleanup**: Formalized the `StateStore` interface to resolve circular dependencies while maintaining strict typing for the global context.

### TypeScript Migration & Code Quality Overhaul

- **Full TypeScript Migration**: Ported codebase to TypeScript with strict validation flags enabled (`strict: true`, `noImplicitAny: true`). Established central type declarations in [src/types/index.ts](src/types/index.ts).
- **Decoupled Layout**: Reorganized core codebase into a `src/` directory layout separated into `core` and `services`.
- **Backward-Compatible Wrappers**: Built backwards-compatible CommonJS exports resolving to the compiled `dist/` directory outputs, allowing legacy CJS scripts and modular test suites to run unmodified.
- **Prettier & ESLint Guardrails**: Re-configured ESLint flat config with global ignores for compiled and artifact paths. Formatted codebase using Prettier rules.

### Performance, Quant Strategy & Parameter Optimization

- **Quant Strategy Upgrades**: Added **Global Momentum Index (GMI)** market filter, **Volatility-Adaptive Risk** scaling Stop-Loss, **Accelerated Trailing Stop**, **Insider Drift Tracking** de-risk sold positions on large dumps, and **Spread Velocity Widened Exits**. Decommissioned legacy backtester.
- **Post-Session Parameter Optimizer**: Created `analyze.js` trade replay analyzer to run 9,216 strategy combo backtests over JSONL journals. Enriched trade logs with 18 fields.
- **Sub-Second Discovery**: Direct log parsing for Pump.fun log events, bypassing indexing RPC delays.
- **Batch Audits & RPC Health**: Consolidated audits using `getMultipleAccounts` and added unified RPC failover health trackers.
- **API Circuit Breakers**: Built local on-chain heuristic fallbacks for GoPlus/BubbleMaps outages.
- **Decoupled Orchestration**: Split scanner and audit scheduling logic from core watchdog loops.

---

_Developed with focus on speed and safety._
