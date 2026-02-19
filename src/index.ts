import "dotenv/config";
import {
  getCurrentMarketSlug,
  fetchMarket,
  fetchWithTimeout,
  getMarketEndTime,
  type MarketInfo,
} from "./market.js";
import { connectMarketWs } from "./ws.js";
import {
  handlePriceUpdate,
  getLatestPrices,
  hasBet,
  isMarketSettled,
  startResolutionLoop,
  stopResolutionLoop,
  clearMarketState,
  BUY_THRESHOLD,
} from "./strategy.js";
import { getTradeStats, insertLiveTrade, closeDb } from "./db.js";
import {
  loadFilterMatrix,
  shouldTrade,
  getCurrentCellInfo,
  type FilterMatrix,
} from "./filter.js";
import {
  initClobClient,
  getWalletAddress,
  placeDualOrders,
  waitForFill,
  cancelAllOrders,
  type DualOrderResult,
} from "./clob.js";
import readline from "node:readline";

// CLI flags
const IS_LIVE = process.argv.includes("--live");
const sizeIdx = process.argv.indexOf("--size");
const POSITION_SIZE = sizeIdx !== -1 ? parseFloat(process.argv[sizeIdx + 1]) : 1;

const MAX_SESSION_LOSS = 50; // halt trading if session losses exceed this

// --stats mode: print stats and exit
if (process.argv.includes("--stats")) {
  const stats = getTradeStats();

  console.log("\n=== Paper Trading Stats ===\n");
  console.log(`Total trades:  ${stats.total}`);
  console.log(`Wins:          ${stats.wins}`);
  console.log(`Losses:        ${stats.losses}`);
  console.log(`Pending:       ${stats.pending}`);
  console.log(`Timeouts:      ${stats.timeouts}`);
  console.log(
    `Total P&L:     ${stats.totalProfit >= 0 ? "+" : ""}$${stats.totalProfit.toFixed(2)}`
  );

  if (stats.total > 0) {
    const resolved = stats.wins + stats.losses;
    const winRateNum = resolved > 0 ? (stats.wins / resolved) * 100 : null;
    console.log(`Win rate:      ${winRateNum !== null ? winRateNum.toFixed(1) + "%" : "N/A"}`);

    if (stats.avgWin !== null && stats.avgLoss !== null && winRateNum !== null) {
      const avgLossAbs = Math.abs(stats.avgLoss);
      const breakEvenRate = (avgLossAbs / (stats.avgWin + avgLossAbs)) * 100;
      const edge = winRateNum - breakEvenRate;
      const sign = edge >= 0 ? "+" : "";

      console.log(`Avg win:       +$${stats.avgWin.toFixed(2)}`);
      console.log(`Avg loss:      -$${avgLossAbs.toFixed(2)}`);
      console.log(`Break-even:    ${breakEvenRate.toFixed(1)}%`);
      console.log(`Edge:          ${sign}${edge.toFixed(1)}pp`);
    }

    console.log("\n--- Recent Trades ---\n");
    console.log(
      "ID  | Side | Buy    | Outcome | Profit  | Market"
    );
    console.log("-".repeat(70));

    for (const t of stats.trades.slice(0, 20)) {
      const outcome = t.outcome ?? "pending";
      const profit =
        t.profit !== null
          ? `${t.profit >= 0 ? "+" : ""}$${t.profit.toFixed(2)}`
          : "   -";
      console.log(
        `#${String(t.id).padEnd(2)} | ${t.side.padEnd(4)} | $${t.buy_price.toFixed(2)} | ${outcome.padEnd(7)} | ${profit.padEnd(7)} | ${t.market_slug}`
      );
    }
  }

  console.log("");
  closeDb();
  process.exit(0);
}

// --vol and/or --backtest mode: fetch candles, compute, print, exit
if (process.argv.includes("--vol") || process.argv.includes("--backtest")) {
  (async () => {
    const { fetchAllAssetCandles } = await import("./candles.js");
    const candleData = await fetchAllAssetCandles(7);

    if (candleData.size === 0) {
      console.error("No candle data retrieved. Check network connectivity.");
      process.exit(1);
    }

    if (process.argv.includes("--vol")) {
      const { buildVolMatrix, printVolMatrix } = await import("./volatility.js");
      const matrix = buildVolMatrix(candleData);
      printVolMatrix(matrix);
    }

    if (process.argv.includes("--backtest")) {
      const { runBacktest, printBacktestResults } = await import("./backtest.js");
      const results = runBacktest(candleData);
      printBacktestResults(results);
    }
  })()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Fatal error:", err);
      process.exit(1);
    });
} else {

// Main trading loop (paper)
async function main() {
  console.log("=== PolyInnovatio - XRP 5-Min Paper Trader ===\n");

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n\nShutting down...\n");
    stopResolutionLoop();
    const stats = getTradeStats();
    console.log(`Session summary: ${stats.total} trades, P&L: ${stats.totalProfit >= 0 ? "+" : ""}$${stats.totalProfit.toFixed(2)}`);
    console.log(`Run 'npm start -- --stats' for full history.\n`);
    closeDb();
    process.exit(0);
  });

  // Start background resolution loop — picks up pending trades from previous runs too
  startResolutionLoop();
  console.log("[Main] Background resolution loop started (every 10s)");

  const MAX_FETCH_RETRIES = 3;

  while (true) {
    const slug = getCurrentMarketSlug();
    const endTime = getMarketEndTime(slug);
    const now = Date.now();
    const remaining = endTime - now;

    if (remaining < 5000) {
      // Less than 5 seconds left, skip to next window
      console.log("[Main] Market window almost over, waiting for next...");
      await sleep(remaining + 1000);
      continue;
    }

    console.log(`\n[Main] Current market: ${slug}`);
    console.log(`[Main] Window ends in ${Math.round(remaining / 1000)}s`);

    // Discover market with retry cap
    let market: MarketInfo | "closed" | null = null;
    let fetchRetries = 0;

    while (!market) {
      market = await fetchMarket(slug);

      if (market === "closed") {
        console.log("[Main] Market already closed/resolved, skipping to next window...");
        const waitTime = getMarketEndTime(slug) - Date.now();
        if (waitTime > 0) await sleep(waitTime);
        break;
      }

      if (!market) {
        fetchRetries++;
        if (fetchRetries >= MAX_FETCH_RETRIES) {
          console.log("[Main] Market not found after 3 attempts, skipping to next window...");
          const waitTime = getMarketEndTime(slug) - Date.now();
          if (waitTime > 0) await sleep(waitTime);
          break;
        }
        console.log("[Main] Market not found, waiting 10s and retrying...");
        await sleep(10_000);
      }
    }

    if (!market || market === "closed") continue;

    console.log(`[Main] Up token:   ${market.upTokenId.slice(0, 16)}...`);
    console.log(`[Main] Down token: ${market.downTokenId.slice(0, 16)}...`);

    // Also fetch initial REST prices
    await fetchInitialPrices(market);

    // Connect WebSocket
    const ws = connectMarketWs(
      [market.upTokenId, market.downTokenId],
      (tokenId, price) => {
        handlePriceUpdate(market, tokenId, price);
        printStatus(market);
      }
    );

    // Wait until market window ends, but skip early if market settles
    let timeLeft = endTime - Date.now();
    while (timeLeft > 0) {
      await sleep(Math.min(1000, timeLeft));
      if (isMarketSettled()) {
        console.log(`\n[Main] Market settled early, moving to next window...`);
        break;
      }
      timeLeft = endTime - Date.now();
    }

    // Disconnect WS and clear per-market state
    ws.close();
    clearMarketState();

    // Brief pause before next market
    await sleep(2000);
  }
}

// Live trading loop
async function mainLive() {
  console.log("=== PolyInnovatio - XRP 5-Min LIVE Trader ===\n");

  // Init CLOB client
  const ok = await initClobClient();
  if (!ok) {
    console.error("[Main] Failed to initialize CLOB client. Is PRIVATE_KEY set in .env?");
    process.exit(1);
  }

  // Load hour/day filter matrix
  const filterMatrix = await loadFilterMatrix();
  if (!filterMatrix) {
    console.error("[Main] Failed to load filter matrix, aborting live mode");
    process.exit(1);
  }

  // Confirmation prompt
  const confirmed = await confirmLiveTrading();
  if (!confirmed) {
    console.log("[Main] Live trading aborted by user");
    closeDb();
    process.exit(0);
  }

  // Track active orders for SIGINT cleanup
  let activeOrders: DualOrderResult | null = null;
  let sessionPnL = 0;
  let sessionTrades = 0;
  let fillAbortController: AbortController | null = null;

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n\n[Main] Shutting down live trader...\n");

    // Abort any active fill polling
    if (fillAbortController) {
      fillAbortController.abort();
    }

    // Cancel active orders
    if (activeOrders) {
      console.log("[Main] Cancelling active orders...");
      await cancelAllOrders([activeOrders.upOrderId, activeOrders.downOrderId]);
    }

    stopResolutionLoop();
    const stats = getTradeStats();
    console.log(`Session: ${sessionTrades} trades, session P&L estimate: ${sessionPnL >= 0 ? "+" : ""}$${sessionPnL.toFixed(2)}`);
    console.log(`All-time: ${stats.total} trades, P&L: ${stats.totalProfit >= 0 ? "+" : ""}$${stats.totalProfit.toFixed(2)}`);
    console.log(`Run 'npm start -- --stats' for full history.\n`);
    closeDb();
    process.exit(0);
  });

  // Start background resolution loop
  startResolutionLoop();
  console.log("[Main] Background resolution loop started (every 10s)");

  const MAX_FETCH_RETRIES = 3;

  while (true) {
    // Check session loss limit
    if (sessionPnL <= -MAX_SESSION_LOSS) {
      console.log(`\n[Main] Session loss limit reached ($${MAX_SESSION_LOSS}). Halting live trading.`);
      console.log(`[Main] Session P&L: -$${Math.abs(sessionPnL).toFixed(2)} over ${sessionTrades} trades`);
      break;
    }

    const slug = getCurrentMarketSlug();
    const endTime = getMarketEndTime(slug);
    const now = Date.now();
    const remaining = endTime - now;

    // Need at least 15s for order placement + fill polling
    if (remaining < 15000) {
      console.log("[Main] Market window almost over (<15s), waiting for next...");
      await sleep(remaining + 1000);
      continue;
    }

    // Check hour/day filter
    const cellInfo = getCurrentCellInfo(filterMatrix);
    if (!shouldTrade(filterMatrix)) {
      console.log(
        `\n[Main] Skipping window — ${cellInfo.day} ${cellInfo.hour}:00 UTC win rate: ` +
        `${cellInfo.winRate !== null ? cellInfo.winRate.toFixed(0) + "%" : "N/A"} ` +
        `(${cellInfo.trades} samples, below 60% threshold)`
      );
      await sleep(remaining + 1000);
      continue;
    }

    console.log(
      `\n[Main] ${cellInfo.day} ${cellInfo.hour}:00 UTC — win rate: ` +
      `${cellInfo.winRate !== null ? cellInfo.winRate.toFixed(0) + "%" : "N/A"} ` +
      `(${cellInfo.trades} samples) — TRADING`
    );

    console.log(`[Main] Current market: ${slug}`);
    console.log(`[Main] Window ends in ${Math.round(remaining / 1000)}s`);

    // Discover market with retry cap
    let market: MarketInfo | "closed" | null = null;
    let fetchRetries = 0;

    while (!market) {
      market = await fetchMarket(slug);

      if (market === "closed") {
        console.log("[Main] Market already closed/resolved, skipping to next window...");
        const waitTime = getMarketEndTime(slug) - Date.now();
        if (waitTime > 0) await sleep(waitTime);
        break;
      }

      if (!market) {
        fetchRetries++;
        if (fetchRetries >= MAX_FETCH_RETRIES) {
          console.log("[Main] Market not found after 3 attempts, skipping to next window...");
          const waitTime = getMarketEndTime(slug) - Date.now();
          if (waitTime > 0) await sleep(waitTime);
          break;
        }
        console.log("[Main] Market not found, waiting 10s and retrying...");
        await sleep(10_000);
      }
    }

    if (!market || market === "closed") continue;

    console.log(`[Main] Up token:   ${market.upTokenId.slice(0, 16)}...`);
    console.log(`[Main] Down token: ${market.downTokenId.slice(0, 16)}...`);

    // Place dual orders at BUY_THRESHOLD
    const orders = await placeDualOrders(
      market.upTokenId,
      market.downTokenId,
      BUY_THRESHOLD,
      POSITION_SIZE
    );

    if (!orders) {
      console.log("[Main] Failed to place dual orders, skipping window...");
      const waitTime = getMarketEndTime(slug) - Date.now();
      if (waitTime > 0) await sleep(waitTime);
      continue;
    }

    activeOrders = orders;

    // Set up abort for when market window is about to end
    fillAbortController = new AbortController();
    const timeUntilEnd = endTime - Date.now() - 2000; // 2s safety margin
    const abortTimeout = setTimeout(() => fillAbortController!.abort(), Math.max(0, timeUntilEnd));

    // Wait for fill
    const fill = await waitForFill(
      orders,
      market.upTokenId,
      market.downTokenId,
      fillAbortController.signal
    );

    clearTimeout(abortTimeout);
    activeOrders = null;
    fillAbortController = null;

    if (fill) {
      // Record the trade
      const tokenId = fill.filledSide === "Up" ? market.upTokenId : market.downTokenId;
      const tradeId = insertLiveTrade(
        slug,
        market.conditionId,
        tokenId,
        fill.filledSide,
        fill.fillPrice,
        fill.filledOrderId,
        fill.cancelledOrderId,
        fill.fillSize
      );

      // Estimate session P&L (actual resolution happens via resolution loop)
      const estimatedCost = fill.fillPrice * fill.fillSize;
      sessionTrades++;

      console.log(
        `\n>>> LIVE BUY: ${fill.filledSide} @ $${fill.fillPrice.toFixed(2)} ` +
        `x ${fill.fillSize} = $${estimatedCost.toFixed(2)} ` +
        `(trade #${tradeId}, market: ${slug})`
      );
    } else {
      console.log(`[Main] No fill this window, orders cancelled`);
    }

    // Wait for market window to end
    const waitTime = endTime - Date.now();
    if (waitTime > 0) await sleep(waitTime);

    // Brief pause before next market
    await sleep(2000);
  }

  // Session ended (loss limit reached)
  stopResolutionLoop();
  closeDb();
}

async function confirmLiveTrading(): Promise<boolean> {
  const wallet = getWalletAddress();

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║           LIVE TRADING CONFIRMATION              ║");
  console.log("╠══════════════════════════════════════════════════╣");
  console.log(`║  Wallet:    ${wallet.slice(0, 10)}...${wallet.slice(-8)}`.padEnd(51) + "║");
  console.log(`║  Size:      $${POSITION_SIZE} per order`.padEnd(51) + "║");
  console.log(`║  Loss limit: $${MAX_SESSION_LOSS} per session`.padEnd(51) + "║");
  console.log("║                                                  ║");
  console.log("║  This will place REAL orders with REAL money!    ║");
  console.log("╠══════════════════════════════════════════════════╣");
  console.log("║  Type CONFIRM to proceed, anything else to abort ║");
  console.log("╚══════════════════════════════════════════════════╝");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise<boolean>((resolve) => {
    rl.question("\n> ", (answer) => {
      rl.close();
      resolve(answer.trim() === "CONFIRM");
    });
  });
}

async function fetchInitialPrices(market: MarketInfo) {
  try {
    const [upRes, downRes] = await Promise.all([
      fetchWithTimeout(
        `https://clob.polymarket.com/price?token_id=${market.upTokenId}&side=BUY`
      ),
      fetchWithTimeout(
        `https://clob.polymarket.com/price?token_id=${market.downTokenId}&side=BUY`
      ),
    ]);

    if (upRes.ok) {
      const data = await upRes.json();
      const price = parseFloat(data.price);
      if (!isNaN(price)) {
        handlePriceUpdate(market, market.upTokenId, price);
      }
    }

    if (downRes.ok) {
      const data = await downRes.json();
      const price = parseFloat(data.price);
      if (!isNaN(price)) {
        handlePriceUpdate(market, market.downTokenId, price);
      }
    }

    printStatus(market);
  } catch (err) {
    console.error("[Main] Failed to fetch initial prices:", err);
  }
}

function printStatus(market: MarketInfo) {
  const prices = getLatestPrices();
  const upPrice = prices.get(market.upTokenId);
  const downPrice = prices.get(market.downTokenId);
  const bet = hasBet(market.slug) ? " [BET PLACED]" : "";
  const remaining = Math.max(0, getMarketEndTime(market.slug) - Date.now());

  process.stdout.write(
    `\r[${market.slug}] Up: $${upPrice?.toFixed(2) ?? "?.??"} | Down: $${downPrice?.toFixed(2) ?? "?.??"}${bet} | ${Math.round(remaining / 1000)}s left   `
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (IS_LIVE) {
  mainLive().catch((err) => {
    console.error("Fatal error:", err);
    closeDb();
    process.exit(1);
  });
} else {
  main().catch((err) => {
    console.error("Fatal error:", err);
    closeDb();
    process.exit(1);
  });
}

} // end else (--vol / --backtest guard)
