# Veloci-Buy CLI & Command Reference

This document provides a comprehensive guide to all command-line interfaces, execution scripts, and environment variable configurations supported by the Veloci-Buy engine.

---

## 🚀 Execution & Operational Commands

Veloci-Buy uses a unified set of npm scripts defined in [package.json](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/package.json) to control the bot's lifecycle.

| Command              | Target Script        | Description                                                                                                                       |
| :------------------- | :------------------- | :-------------------------------------------------------------------------------------------------------------------------------- |
| `npm start`          | `tsx src/index.ts`   | Launches the orchestrator in development mode with hot-reloading capability.                                                      |
| `npm run build`      | `tsc`                | Compiles the TypeScript source files into the `dist/` directory.                                                                  |
| `npm run start:prod` | `node dist/index.js` | Launches the compiled JavaScript application for maximum production performance.                                                  |
| `npm run ci`         | _Complex Pipeline_   | Runs a complete CI checks suite: dependency audits, syntax checks, linting, formatting checks, builds, and test runner execution. |

### 🛠️ CLI Options

The main bot entry point supports direct command-line arguments to override strategy loading and modify logging/UI behavior.

```bash
# General syntax
npm start -- [options]
```

- **`-s, --strategy <strategy_name>`**
  - **Description**: Loads a specific strategy configuration profile from the `strategies/` directory.
  - **Syntax**: `npm start -- --strategy degens-only` (resolves to [strategies/degens-only.yaml](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/strategies/degens-only.yaml)).
  - **Fallback**: Defaults to `standard` if not specified or if the requested file is missing/invalid.
- **`--tui`**
  - **Description**: Launches the interactive Terminal User Interface (TUI) dashboard powered by `blessed`. This displays real-time log outputs, active positions, wallet balances, and system health status.
  - **Syntax**: `npm start -- --tui`

---

## 📊 Analytics & Reporting Commands

These utilities analyze historical trading session outputs located in `logs/` to optimize strategies and generate financial reports.

### 1. PnL Analyzer (`npm run analyze-pnl`)

Generates structured, legally compliant reports containing native SOL and USD gross profits, lost value, and net gains.

```bash
# Syntax
npm run analyze-pnl <session_directory>

# Example
npm run analyze-pnl logs/paper-trading/2026-05-27_22-30-00
```

- **Behavior**: Parses `trade-journal.jsonl` (live) or `paper-trade-journal.jsonl` (simulated).
- **Output**: Generates a clean Markdown report named `pnl-report.md` inside the target session directory containing:
  - Executive summary tables (Gross Profit, Lost Value, Net PnL, Total Trades).
  - Detailed trade log table with entry/exit timestamps, reasons, and realized gains.

### 2. Parameter Sensitivity Analyzer & Replay Optimizer (`npm run analyze`)

Runs a parameter grid search using historical logs to find the mathematically optimal exit targets and safety thresholds.

```bash
# Syntax
npm run analyze
```

- **Behavior**: Automatically scans `logs/paper-trading/` to ingest trading session journals, reconstructs synthetic tick curves, and evaluates **9,216 distinct exit configurations** (Stop-Loss, Trailing Drawdown, Take-Profit targets, etc.).
- **Output**:
  - Prints the **top 10 configurations** ranked by Profit Factor and Net PnL to the terminal.
  - Outputs a complete grid search report to `analysis-results.json` in the project root directory.

---

## 🛡️ Verification & Code Quality Commands

Maintain code stability and type safety using the built-in validation suite.

```bash
# Run modular tests
npm test

# Run dynamic syntax verification on all JS/TS files
npm run check

# Verify coding guidelines using ESLint
npm run lint

# Validate formatting rules
npm run format:check

# Auto-format all codebase files (Prettier)
npm run format
```

- **Native Test Runner (`npm test`)**: Uses Node.js's native test module to execute files matching `tests/*.test.ts` (e.g. [tests/engine.test.ts](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/tests/engine.test.ts)).
- **Syntax Check (`npm run check`)**: Runs [scripts/check-syntax.ts](file:///C:/Users/prath/OneDrive/Desktop/projects/veloci-buy/scripts/check-syntax.ts) to verify syntax using the Node engine `--check` flag on JS files and `tsc --noEmit` on TS files.

---

## ⚙️ Environment Configuration (`.env`)

Secrets and global overrides are declared in a `.env` file in the project root. Refer to `.env.example` for a complete template.

### Core Parameters

| Key                | Type   | Default       | Description                                                                     |
| :----------------- | :----- | :------------ | :------------------------------------------------------------------------------ |
| `RPC_URL`          | String | _Required_    | Comma-separated list of HTTP Solana RPC endpoints (supports failover).          |
| `WS_RPC_URL`       | String | _Optional_    | Comma-separated list of WebSocket Solana RPC endpoints (auto-derived if blank). |
| `JUPITER_API_KEY`  | String | _Required_    | API key for routing swaps via Jupiter.                                          |
| `PRIVATE_KEY`      | String | _Conditional_ | Wallet private key as a Base58 string or JSON byte array.                       |
| `PRIVATE_KEY_PATH` | String | _Conditional_ | Local file path containing the wallet private key.                              |

### Execution Mode Controls

| Key                    | Type    | Default | Description                                                          |
| :--------------------- | :------ | :------ | :------------------------------------------------------------------- |
| `PAPER_TRADING`        | Boolean | `false` | Enables paper-trading simulation (executes against virtual balance). |
| `DRY_RUN`              | Boolean | `true`  | Prevents writing actual transactions to the blockchain network.      |
| `LIVE_TRADING_ENABLED` | Boolean | `false` | Required to be set to `true` to execute live on-chain trades.        |
| `INITIAL_PAPER_SOL`    | String  | `'0.1'` | Starting balance for paper-trading simulations.                      |

### Risk & Transaction Scaling

| Key                           | Type    | Default   | Description                                          |
| :---------------------------- | :------ | :-------- | :--------------------------------------------------- |
| `BUY_AMOUNT_SOL`              | String  | `'0.05'`  | Size of each sniper entry order in SOL.              |
| `SLIPPAGE_BPS`                | Number  | `500`     | Transaction slippage in basis points (500 = 5%).     |
| `USE_JITO`                    | Boolean | `false`   | Submits transactions as Jito MEV bundles.            |
| `JITO_TIP_SOL`                | String  | `'0.001'` | Tip paid to Jito validators when bundles are used.   |
| `MAX_AUTO_SLIPPAGE_RETRY`     | Number  | `3`       | Number of times to auto-retry slippage-failed swaps. |
| `AUTO_SLIPPAGE_INCREMENT_BPS` | Number  | `100`     | Slippage basis points increment per execution retry. |

### Third-Party API Keys

| Key                   | Type   | Default | Description                                    |
| :-------------------- | :----- | :------ | :--------------------------------------------- |
| `GOPLUS_ACCESS_TOKEN` | String | `""`    | Access token for the GoPlus security API.      |
| `BUBBLEMAPS_API_KEY`  | String | `""`    | API key for Bubblemaps smart wallet detection. |
| `TELEGRAM_BOT_TOKEN`  | String | `""`    | Bot token for Telegram notifications.          |
| `TELEGRAM_CHAT_ID`    | String | `""`    | Chat ID for Telegram notifications.            |
| `DISCORD_WEBHOOK_URL` | String | `""`    | Discord webhook integration channel URL.       |
