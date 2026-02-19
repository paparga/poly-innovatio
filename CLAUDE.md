# PolyInnovatio

Bitcoin 5-minute paper trading POC for Polymarket. CLI app that monitors BTC Up/Down markets via WebSocket, places virtual trades when a side hits 60 cents, and tracks P&L in SQLite.

## Commands

```bash
npm install              # Install dependencies
npm start                # Run the trading loop (paper)
npm start -- --stats     # Show trade history and stats
npm start -- --vol       # Multi-asset volatility heatmap (7 days, 1m candles)
npm start -- --backtest  # Backtest strategy across BTC, ETH, XRP, SOL
npm start -- --live             # Live trading (requires PRIVATE_KEY in .env)
npm start -- --live --size 25   # Live trading with custom position size ($25/order)
```

No build step required -- `tsx` executes TypeScript directly.

## Architecture

```
src/
  index.ts       - Entry point, main trading loop, graceful shutdown (SIGINT)
  market.ts      - Polymarket Gamma API: market discovery, slug generation, resolution checking
  ws.ts          - WebSocket connection to CLOB price stream with auto-reconnect
  strategy.ts    - Trading logic: threshold check (>=0.60), bet placement, resolution polling
  db.ts          - SQLite layer (better-sqlite3, WAL mode): trades table, stats queries
  candles.ts     - Data fetching: Binance primary, Bybit fallback, 1m candle pagination
  backtest.ts    - 5-min window aggregation, strategy simulation, result rendering
  volatility.ts  - Volatility computation, hour×day heatmap rendering
  filter.ts      - Hour/day win rate filter: loads BTC backtest, skips low-winrate cells
  clob.ts        - CLOB client wrapper: dual-order placement, fill polling, cancellation
```

**Data flow:** `index.ts` orchestrates the cycle: compute 5-min market slug → fetch market from Gamma API → subscribe to WebSocket prices → `strategy.ts` evaluates each price tick → records trades in `db.ts` → polls resolution after window ends.

**Key APIs:**
- Gamma REST: `https://gamma-api.polymarket.com/events?slug=...`
- WebSocket: `wss://ws-subscriptions-clob.polymarket.com/ws/market`

## Code Conventions

- **Naming:** camelCase for functions/variables, PascalCase for types/interfaces, UPPER_SNAKE_CASE for constants
- **Imports:** Use `.js` extensions in import paths (required by NodeNext module resolution)
- **Types:** Explicit type annotations; strict mode enabled
- **Async:** async/await for all async operations; callback pattern only for WebSocket price events (`PriceCallback` type)
- **Logging:** Module-level prefixes in brackets: `[Main]`, `[WS]`, `[Resolve]`
- **State:** Module-scoped `Map` and `Set` for runtime state; no global mutable singletons beyond the DB connection

## Patterns to Follow

- **New module:** Export pure functions. Keep module-level state minimal. Use the same log prefix convention.
- **Database changes:** Add prepared statements as module-level constants in `db.ts`. Export typed functions, cast results with `as Type[]`.
- **New API calls:** Follow `market.ts` pattern — check `res.ok`, parse JSON, return `null` on failure, never throw.
- **WebSocket events:** Handle new event types inside the existing `ws.on("message")` handler in `ws.ts`. Always `parseFloat` and guard with `!isNaN`.
- **Strategy parameters:** Define as module-level `UPPER_SNAKE_CASE` constants at the top of `strategy.ts`.
- **Shutdown:** Any new resource that needs cleanup must be handled in the SIGINT handler in `index.ts`.

## Tech Stack

- TypeScript 5.7, ES2022 target, NodeNext modules
- `tsx` for dev execution (no compile step)
- `better-sqlite3` for storage (WAL mode, singleton connection)
- `ws` for WebSocket streams
- `dotenv` for environment variables

## Environment

- `.env` contains `API_KEY` (reserved for future live trading)
- `PRIVATE_KEY` — Polygon wallet private key (required for `--live` mode)
- `FUNDER_ADDRESS` — Polymarket proxy wallet address (required for `--live` mode; sets `maker` on orders so the exchange uses the funded proxy wallet instead of the signer EOA)
- `trades.db` is created at project root on first run (gitignored)
- No test framework, linter, or CI configured yet
