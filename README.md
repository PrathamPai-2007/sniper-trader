# Veloci-Buy: A High-Performance Solana Discovery & Execution Engine

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.19.0-blue?style=for-the-badge&logo=node.js)](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/package.json)
[![Solana](https://img.shields.io/badge/blockchain-Solana-black?style=for-the-badge&logo=solana)](https://solana.com)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue?style=for-the-badge&logo=typescript)](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tsconfig.json)
[![License](https://img.shields.io/badge/license-MIT-green?style=for-the-badge)](https://opensource.org/licenses/MIT)

---

> [!CAUTION]
>
> ### 🛑 LEGAL & FINANCIAL DISCLAIMER
>
> **1. Financial Risk Warning**
> Trading digital assets, particularly highly volatile memecoins on the Solana blockchain (e.g., Pump.fun, Raydium), involves an extremely high level of risk and may not be suitable for all investors. You may lose all or more than your initial investment. Only trade with capital you can afford to lose.
>
> **2. No Warranties & Limitation of Liability**
> This software is provided "as is" and "as available", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and non-infringement. In no event shall the authors, developers, or copyright holders be liable for any claim, damages, or other liability, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with the software or the use or other dealings in the software.
>
> **3. Simulation & Sandboxing**
> Users are strongly advised to run the bot in paper-trading (`PAPER_TRADING=true`) and dry-run (`DRY_RUN=true`) modes extensively before risking actual capital. Past performance is not indicative of future results.
>
> **4. Tax and Regulatory Compliance**
> Cryptocurrency taxation and regulations vary by jurisdiction. You are solely responsible for identifying, declaring, and paying any taxes due to your local tax authorities. The authors and contributors do not provide legal, tax, or investment advice.

---

## 📖 The Evolutionary Journey: From Legacy Sniper to Quantitative Engine

Veloci-Buy was conceived as a lightweight script designed to snipe token liquidity pools on Solana. Today, it has matured into a production-grade, event-driven discovery and execution pipeline optimized for the most volatile trading environments.

### 🔹 v1.x: The Foundation

- **Architecture**: Designed around a monolithic polling structure that fetched token updates directly from standard RPC endpoints.
- **Limitations**: Suffered from indexing lag and rate-limiting blocks. State was saved in flat, corruption-prone `state.json` and `_mints.json` files. Strategies were hardcoded directly in code, preventing dynamic parameter tuning.

### 🔹 v2.0: The Performance Leap

- **Sub-Second WS Ingestion**: Integrated raw WebSocket subscription to Sol log streams, enabling Pump.fun mint address identification _before_ transaction indexing completes.
- **Quant Indicator Upgrades**: Added market "mood" filtering via the Global Momentum Index (GMI), volatility-adaptive risk metrics, and multiple different exits.
- **Major Refactor**: Refactored the monolithic bot into smaller files for modular coding and debugging.

### 🔹 v2.x (Current): Modern Execution & Resilience

- **Full TypeScript Transition**: Ported all core logic and utility scripts to strict TypeScript (`strict: true`), defining structured data contracts across the codebase.
- **MEV Protection & Smart Routing**: Built a multi-stage execution pipeline routing orders dynamically via Jito Bundles (100% MEV-proof) or Jupiter swap paths with smart slippage auto-retries.
- **Dynamic Jito Tip & Confirmation Engine**: Integrates real-time Block Engine JSON-RPC queries (`getTipFloor` and `getBundleStatuses`) to dynamically calculate percentile-based tips (with panic multipliers), monitor confirmation status, and execute transaction re-signing using fresh blockhashes on bundle retry loops.
- **Reactive Cooldown Expiry**: Replaced coarse polling loops with non-blocking, event-driven timers (`setTimeout` handlers) registered dynamically to State Store events (`coolDownStarted` and `coolDownRemoved`).
- **Parameter Sensitivity Analyzer**: Introduced a simulator to replay session journals across **9,216 grid combinations** of exit rules to find optimal configurations.
- **Modular Strategies**: Presets are externalized into YAML files in the [strategies/](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/strategies) directory, allowing hot-swapping configurations via CLI flags at runtime.
- **Legal PnL Reporting**: Generates compliant Markdown reports documenting USD and SOL gross profits, losses, and transaction histories.
- **ACID-Compliant State Store**: Replaced JSON writing with an active [SQLite](https://sqlite.org) engine operating in Write-Ahead Log (WAL) mode, achieving crash-resilient, non-blocking disk writes.

---

## 🏗️ Technical Architecture & Microservices

Veloci-Buy uses a decoupled, event-driven service architecture to isolate failure domains and maintain low latency under extreme network loads.

```
flowchart TD
    subgraph Ingestion["Log Ingestion Layer"]
        A[Solana WebSocket Stream] -->|RAW Log Events| B([src/services/discovery/discovery.service.ts])
    end

    subgraph Analysis["Security & Valuation Layer"]
        B -->|Mint Signal| C([src/services/scanner/scanner.service.ts])
        C -->|Batch Request| D([src/services/audit/audit.service.ts])
        D -->|On-Chain Audit Signals| E([src/services/engine/engine.service.ts])
    end

    subgraph Execution["Execution & Risk Layer"]
        E -->|Candidate Score > Threshold| F([src/services/trading/trading.service.ts])
        F -->|Jito Bundle / Jupiter Swap| G[Solana Blockchain / Simulated SQLite Store]
        G -->|Active Position Tracking| H([src/services/monitor/monitor.service.ts])
        H -->|TP / SL / Drawdown Trigger| F
    end

    subgraph State["Persistence Engine"]
        C -.->|Atomic State updates| I[([src/core/store.ts])]
        H -.->|Commit Position / PnL| I
    end
```

### Core Components

- **Orchestration ([src/index.ts](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/src/index.ts))**: Managed by the `VelociBuyBot` class, coordinating service lifecycles, RPC failover pools, and graceful shutdown handlers.
- **Event Ingestion ([discovery.service.ts](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/src/services/discovery/discovery.service.ts))**: Establishes high-speed WebSocket listeners tracking raw instruction logs to bypass Solana explorer latency.
- **Scanner Service ([scanner.service.ts](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/src/services/scanner/scanner.service.ts))**: Identifies candidates, schedules recheck loops, and gates tokens using survival delays.
- **Security Audit ([audit.service.ts](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/src/services/audit/audit.service.ts))**: Analyzes mint authorities and top holder concentrations. Falls back to **Local On-Chain Heuristics** if GoPlus or Bubblemaps experience service degradation.
- **Decision Engine ([engine.service.ts](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/src/services/engine/engine.service.ts))**: Evaluates candidate token metadata, social linking metrics, and volume momentum consistency.
- **Execution Adapter ([trading.service.ts](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/src/services/trading/trading.service.ts))**: Builds and signs transactions, using Jito Bundles to prevent front-running and MEV sandwich attacks.
- **Risk Monitor ([monitor.service.ts](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/src/services/monitor/monitor.service.ts))**: Tracks open positions using real-time price feeds. Manages trailing drawdowns, early performance exits, and emergency liquidity collapse shutdowns.
- **SQLite Store ([src/core/store.ts](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/src/core/store.ts))**: Encapsulates position tracking, completed trades, and operational statistics inside a transactional SQLite database.

---

## 🛡️ Staged Risk Mitigation Pipeline

Veloci-Buy filters out scams and high-risk setups through a series of automated check gates:

```
[MINT SIGNAL]
     │
     ▼
┌─────────────────────────┐
│ 1. Survival Delay Gate  │ ──► Dynamic wait times (5s–25s) filtering out instant developer rug-pulls
└─────────────────────────┘
     │
     ▼
┌─────────────────────────┐
│ 2. Security Audit Gate  │ ──► Checks freeze authority, token mint ownership, and top holder concentrations
└─────────────────────────┘
     │
     ▼
┌─────────────────────────┐
│ 3. FDV & Liquidity Gate │ ──► Rejects tokens with unbalanced pool depth or market caps > $10,000,000
└─────────────────────────┘
     │
     ▼
┌─────────────────────────┐
│  4. Anti-FOMO Guard     │ ──► Pauses execution if token is experiencing extreme parabolic growth
└─────────────────────────┘
     │
     ▼
[BUY EXECUTION]
```

---

## ⚡ Quick Start

### 1. Prerequisites

- **Node.js**: `>= 20.19.0`
- **RPC Endpoints**: High-quality Solana HTTP and WS endpoints (Node pool failover supported).
- **Jupiter API Access**: Required to calculate swap pricing and route orders.

### 2. Installation & Setup

```bash
# Install dependencies
npm install

# Configure environment secrets
cp .env.example .env
```

_Open [.env](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/.env) and populate the required RPC URLs, wallet private keys, and API tokens._

### 3. Running the Bot

```bash
# Start paper trading with the interactive CLI dashboard (Recommended for dry-runs)
npm start -- --tui

# Build and run the optimized production container
npm run build
npm run start:prod
```

> [!TIP]
> To explore advanced parameters, grid search analysis, and detailed testing commands, refer to the [COMMANDS.md](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/COMMANDS.md) command reference.

---

## 🧪 Modular Test & Validation Suite

Veloci-Buy maintains exceptional code quality and high test coverage (~84.6%) using a robust, modular test suite built entirely on Node.js's native testing framework (`node:test`). The suite is divided into logical test types:

### 1. Core Unit & Utility Validation

These tests target deterministic mathematical operations, format validations, internal caching mechanics, and OS-level file actions.

- **[tests/utils.test.ts](file:///c:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/utils.test.ts)**: Validates core mathematical utilities (standard deviation, spread calculations), Solana binary decoding (`decodePumpCurve`), safe JSON serialization (handling `BigInt` correctly), Windows-specific file locks/retries for atomic writes, priority token bucket scheduling, and `ShortTermCache` key evictions.
- **[tests/keystore.test.ts](file:///c:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/keystore.test.ts)**: Assures robust encryption/decryption of the operator private key, password integrity checks, and validation error paths.

### 2. Strategy & Configuration Constraints

Ensures the engine never launches with invalid boundaries, incorrect slippages, or broken strategies.

- **[tests/config.test.ts](file:///c:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/config.test.ts)**: Validates startup constraints (slippage limits, stop-loss percentages, fraction ranges), environment variable mapping, and invalid config rejections.
- **[tests/strategy.test.ts](file:///c:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/strategy.test.ts)**: Validates YAML strategy loading, fallback behaviors for missing or deleted presets, and parser error recovery.

### 3. State Persistence & Legacy Migration

Ensures transaction records, active positions, and session states are safely committed to the ACID-compliant SQLite store without data loss or race conditions.

- **[tests/store.test.ts](file:///c:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/store.test.ts)**: Validates database thread safety, WAL (Write-Ahead Log) configuration, atomic batch updates, and manual flush triggers.
- **[tests/migrate.test.ts](file:///c:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/migrate.test.ts)**: Exercises the conversion pipeline from legacy JSON-based storage (`state.json` and `_mints.json`) to the SQLite schema, ensuring data integrity and file backups are written safely.

### 4. Real-time Ingestion & WebSocket Discovery

Tests the core real-time log scanning that detects new liquidity pools and tokens before they are searchable on standard block explorers.

- **[tests/discovery.test.ts](file:///c:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/discovery.test.ts)**: Mocks WebSocket log notification channels to test parsing accuracy for Pump.fun, Raydium, and Meteora pools. Verifies debounced flush intervals and the connection watchdogs that auto-restart stale subscription streams.
- **[tests/scanner.test.ts](file:///c:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/scanner.test.ts)**: Verifies candidate sorting queues, retry parameters, candidate queue scheduling, survival delays, and index lag requeues.

### 5. Dynamic Risk Control & PnL Monitoring

Verifies the defensive safeguards that protect capital from rug-pulls and rapid market crashes.

- **[tests/monitor.test.ts](file:///c:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/monitor.test.ts)**: Validates dynamic stop-loss levels, trailing drawdowns, take-profit target executions, minimum holding periods, and insider-wallet drift sensors.
- **[tests/portfolio.test.ts](file:///c:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/portfolio.test.ts)**: Tests global risk controls including daily drawdown safety triggers, max open position counts, launchpad sector concentration limits, and dynamic position-size scaling during cold loss streaks.
- **[tests/audit.test.ts](file:///c:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/audit.test.ts)**: Asserts the functionality of mint authority audits, holder concentration metrics, and autonomous local-chain fallback audits when external APIs are down.

### 6. Execution, Jupiter Swap & Jito Routing

Ensures that buy/sell executions run with proper slippage routing, fee scaling, and Jito bundle handling.

- **[tests/trading.test.ts](file:///c:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/trading.test.ts)**: Validates priority fee scaling based on market congestion, Jupiter price caching, and swap order retries with dynamic slippage increments.
- **[tests/jito.test.ts](file:///c:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/jito.test.ts)**: Verifies dynamic Jito Block Engine tip percentile floor queries (with panic multipliers), confirmation status polling, and re-signing bundle retry logic.

### 7. End-to-End Simulation & UI Refresh Orchestration

Simulates the entire bot runtime loop under a mocked environment and ensures user feedback is instantaneous.

- **[tests/services.test.ts](file:///c:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/services.test.ts)**: Simulates complete transaction loops including mock paper trades (execution to monitor tracking), dry-runs for live swaps, and full database persistence verification.
- **[tests/index.test.ts](file:///c:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/index.test.ts)**: Tests orchestrator bootstrapping (decoding JSON/base58 private keys), error rate backpressure thresholds, automatic worker parallelism adjustments, and graceful process signals (SIGINT/SIGTERM) lifecycle termination.
- **[tests/tui.test.ts](file:///c:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/tui.test.ts)**: Verifies Blessed terminal UI event loops, dashboard data rendering refresh cycles, and user input throttles.

### Test Orchestration & Mocking Sandbox

- **[tests/\_test_helpers.ts](file:///c:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/_test_helpers.ts)**: Provides the core testing sandbox. Mocks HTTP RPC configurations, registers mock websocket channels, overrides fetch networks, and instantiates standardized mock configurations to ensure tests run fast and isolated without performing active external network calls.

```bash
# Execute the full testing suite
npm test

# Run tests with experimental test coverage metrics
node --import tsx --test --experimental-test-coverage tests/*.test.ts
```

---

_Developed with an emphasis on speed, reliability, and precision execution._
