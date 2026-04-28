# Solana Meme Sniper Bot

This project is a high-performance Node.js Solana trading bot consolidated into a single engine (`sniper-bot.js`) that handles both live and paper trading.

## Core Features

- **Unified Architecture**: Switch between Live and Paper trading with a single `.env` flag.
- **Hybrid Discovery**: Watches SPL token `InitializeMint` events via Solana websockets for speed, with Jupiter REST polling backfill for reliability.
- **Momentum Quality Engine**: Performs a "Stress Test" during the 30s survival delay:
    - **Stall Filter**: Rejects tokens with decelerating growth.
    - **Tape Filter**: Detects buy velocity decay.
    - **Flatline Filter**: Rejects "pump and flatline" exhaustion patterns.
    - **Consistency Check**: Ensures steady upward movement (60%+ green snapshots).
- **Advanced Exit Strategy**:
    - **Adaptive Profit Guard**: Dynamic trailing floor that arms after holding a midpoint for 10s.
    - **Partial Milestone TP**: Sells 65% at 1.5x (default).
    - **Moon Bag Trailing**: Monitors the remaining 35% balance every 30s.
    - **Hard Stop-Loss**: 40% protection.
    - **Liquidity Collapse**: Emergency exit if liquidity drops below 25% of entry.
- **Daily Mood Detector**: Automatically reduces trade size or pauses trading based on recent win/loss rates.

## Setup

### Prerequisites
- Node.js 18+ (Node 24 recommended).
- A Solana RPC URL (Websocket support required for fastest discovery).
- A Jupiter API Key.

### Installation
```bash
npm install @solana/web3.js@1 bs58
```

### Configuration
1. Copy `.env.example` to `.env`.
2. Configure your `RPC_URL` and `JUPITER_API_KEY`.
3. Set `PAPER_TRADING=true` for local simulation or `false` for live trading.
4. If live trading, add your `PRIVATE_KEY` or `PRIVATE_KEY_PATH`.

## Running the Bot

### Paper Trading (Default recommended for testing)
```bash
# Ensure PAPER_TRADING=true in .env
node sniper-bot.js
```

### Live Trading
```bash
# Ensure PAPER_TRADING=false and DRY_RUN=false in .env
node sniper-bot.js
```

### Dry Run (Analysis Only)
```bash
# Ensure DRY_RUN=true in .env
node sniper-bot.js
```

## Strategy Logic

### 1. Discovery & Audit
The bot monitors new launches and performs strict baseline checks:
- Minimum liquidity, holder count, and buy volume.
- Organic activity score and social link presence.
- On-chain safety (Mint/Freeze authority disabled).
- Concentration checks (Top holder percentage).

### 2. Survival Delay (30s)
The bot waits and collects snapshots to verify "Momentum Quality":
- **Acceleration Stability**: Growth in the final 10s must be at least 40% of the initial 10s growth.
- **Buy Velocity**: Buy pressure must remain consistent (last 15s vs first 15s).
- **Consistency**: At least 60% of snapshots must be positive price moves.

### 3. Position Management
Once entered, the position is managed by a multi-layer exit engine:
- **Noise-Filtered Adaptive Guard**: Once price hits the midpoint between entry and target, a 10s timer starts. If held, a trailing exit is armed at that midpoint.
- **Take-Profit**: 65% of the position is sold at 1.5x.
- **Moon Bag**: The remaining 35% is checked every 30s. If it drops 10% from the TP price, it exits.
- **Stop-Loss**: Immediate exit at 40% drawdown.
- **Time-Exit**: Exits stagnant positions after 60 minutes if below 1.25x.

## Risk Warning

Solana meme launches are extremely volatile and prone to manipulation. This bot includes advanced filters, but cannot guarantee protection against all rugs or market crashes. **Always test with `PAPER_TRADING=true` or `DRY_RUN=true` before committing capital.**
