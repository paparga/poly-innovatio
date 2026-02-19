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
} from "./strategy.js";
import { getTradeStats, closeDb } from "./db.js";

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

// Main trading loop
async function main() {
  console.log("=== PolyInnovatio - BTC 5-Min Paper Trader ===\n");

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

main().catch((err) => {
  console.error("Fatal error:", err);
  closeDb();
  process.exit(1);
});
