# Solana Meme Sniper Bot

A high-performance, modular trading engine designed for high-frequency sniping of new SPL token launches on the Solana blockchain. This bot combines real-time websocket discovery with a multi-stage "Stress Test" audit pipeline and institutional-grade risk management.

## Project Vision

The bot is designed to solve the "first-minute volatility" problem in meme coin trading. By using a hybrid approach of speed (Websockets) and stability (REST polling), it identifies launches and then subjects them to a 30-second "Survival Delay" to verify momentum quality before committing capital.

## Tech Stack

- **Runtime**: Node.js 18+ (Optimized for Node 24).
- **Blockchain**: `@solana/web3.js` (v1) for on-chain interactions and log streaming.
- **DEX Aggregator**: Jupiter API (v6 Swap, v2 Tokens, v3 Price) for execution and pricing.
- **Security**: GoPlus Solana Security API and BubbleMaps for cluster analysis.
- **Persistence**: Event-driven JSON state management with machine-readable metrics.

## Quickstart Guide

### 1. Installation
```bash
npm install @solana/web3.js@1 bs58
```

### 2. Configuration
Create a `.env` file based on `.env.example`:
- `RPC_URL`: Your Solana RPC (Websocket support required).
- `JUPITER_API_KEY`: Required for swap execution.
- `PRIVATE_KEY`: Your wallet's private key (for live trading).
- `PAPER_TRADING`: Set to `true` to simulate trades without real SOL.

### 3. Execution
```bash
# Start the bot
node bot.js

# Run unit tests
node tests.js
```

## The Momentum Quality Engine

Instead of buying purely on price spikes, the bot analyzes the "texture" of the pump during a required 30-second observation window:

- **Stall Filter**: Compares acceleration across three time-segments. If growth in the final segment drops significantly below the initial burst, the trade is rejected.
- **Velocity Decay**: Monitors the "Tape" (Buy/Sell counts). Rejects tokens where buy pressure in the second half of the delay drops below a specific ratio of the first half.
- **Exhaustion Detection**: Identifies "Flatline" patterns where a vertical spike is followed by a tight, stagnant price range, indicating a potential top.
- **Consistency Check**: Calculates the ratio of positive price snapshots to negative ones to ensure a steady trend rather than a single manipulated tick.
- **Breakout Requirement**: Ensures the token has achieved a minimum 3% gain (1.03x) from discovery before entry.

## Institutional Risk Management

The bot employs multi-layer protection to secure capital and realize profits:

### 1. Global Profit Guard (Max TP)
A dynamic trailing stop-loss that is active throughout the entire trade lifecycle:
$$ExitPrice = PeakPriceSinceEntry \times 0.80$$
This formula ensures that as a token pumps, the exit floor "trails" the price upward, securing 80% of the maximum paper gains while allowing for unlimited upside.

### 2. Early Performance Guard
A high-frequency safety check executed in the first 20 seconds of a trade:
- If $Price < EntryPrice \times 0.90$ OR **Buy Pressure Collapses**, the bot immediately liquidates 60% of the position to mitigate "failed breakout" risk.

### 3. Dynamic Priority Fees
To ensure reliability during network congestion, the bot benchmarks the network in real-time:
- Uses `getRecentPrioritizationFees` to target a specific percentile of recent success.
- Applies a **Panic Multiplier** during emergency exits (Liquidity Collapse or Stop-Loss) to outbid other participants.

### 4. Milestone Take-Profit
- Automatically sells 60% of the position at a 1.5x milestone to secure the initial investment, leaving the remaining 40% to be managed by the Global Profit Guard.

## Modular Architecture

The project is refactored into a service-oriented structure for maintainability:

- **`bot.js`**: The Orchestrator. Manages lifecycle, state persistence, and the main execution loop.
- **`services.js`**: The Engine. Contains the heavy domain logic for Evaluation, Execution, and Risk.
- **`config.js`**: The Brain. Centralized environment handling and trading constants.
- **`utils.js`**: The Toolbox. Stateless helpers and a high-performance **Asynchronous Logging** system.
- **`tests.js`**: The Validator. Unit testing suite for verifying the math engines in isolation.

## Performance Features

- **Non-Blocking I/O**: Custom asynchronous logging system ensures disk writes never block the trading event loop.
- **Metrics Intelligence**: Generates a `metrics.json` file every session with a statistical breakdown of rejection reasons.
- **Hybrid Discovery**: Combines Solana's `onLogs` subscription with Jupiter's recent token feed for zero-miss detection.

---

### Risk Warning
Solana meme launches are extremely volatile. While this bot uses advanced filters and risk-reduction math, it cannot guarantee protection against all rugs or sudden market crashes. **Always test with Paper Trading or Dry Run mode before committing capital.**
