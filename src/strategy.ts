import { insertTrade, resolveTrade, resolveTradeTimeout, getTradesBySlug, getOpenTrades } from "./db.js";
import { checkResolution, type MarketInfo } from "./market.js";

const BUY_THRESHOLD = 0.6;
const BUY_MAX_PRICE = 0.85; // Reject prices above this — likely a settled/settling market
const RESOLUTION_POLL_INTERVAL = 5_000; // 5 seconds between polls
const RESOLUTION_MAX_RETRIES = 12; // 12 × 5s = 60s max wait

// Track which markets we've already bet on — seed from DB on import
const bettedMarkets = new Set<string>(
  getOpenTrades().map((t) => t.market_slug)
);

// Current prices per token
const prices = new Map<string, number>();

export function getLatestPrices(): Map<string, number> {
  return prices;
}

export function hasBet(slug: string): boolean {
  return bettedMarkets.has(slug);
}

export function handlePriceUpdate(
  market: MarketInfo,
  tokenId: string,
  price: number
): void {
  prices.set(tokenId, price);

  // Already bet on this market
  if (bettedMarkets.has(market.slug)) return;

  // Check if price meets threshold but isn't suspiciously high (settled market)
  if (price < BUY_THRESHOLD) return;
  if (price > BUY_MAX_PRICE) {
    console.log(`\n[Strategy] Skipping ${tokenId.slice(0, 8)}... @ $${price.toFixed(2)} — price too high, market likely settled`);
    return;
  }

  // Determine which side
  let side: string;
  if (tokenId === market.upTokenId) {
    side = "Up";
  } else if (tokenId === market.downTokenId) {
    side = "Down";
  } else {
    return;
  }

  // Place virtual trade
  bettedMarkets.add(market.slug);
  const tradeId = insertTrade(
    market.slug,
    market.conditionId,
    tokenId,
    side,
    price
  );

  console.log(
    `\n>>> VIRTUAL BUY: ${side} @ $${price.toFixed(2)} (trade #${tradeId}, market: ${market.slug})`
  );
}

export async function resolveMarketTrades(
  market: Pick<MarketInfo, "slug">
): Promise<void> {
  const trades = getTradesBySlug(market.slug);
  const pending = trades.filter((t) => t.outcome === null);

  if (pending.length === 0) return;

  console.log(`\n[Resolve] Polling resolution for ${market.slug}...`);

  for (let attempt = 0; attempt < RESOLUTION_MAX_RETRIES; attempt++) {
    const winner = await checkResolution(market.slug);

    if (winner) {
      for (const trade of pending) {
        const outcome = trade.side === winner ? "win" : "lose";
        resolveTrade(trade.id, outcome);
        const profit = outcome === "win" ? 1 - trade.buy_price : -trade.buy_price;
        console.log(
          `[Resolve] Trade #${trade.id} (${trade.side}): ${outcome.toUpperCase()} | profit: ${profit >= 0 ? "+" : ""}$${profit.toFixed(2)}`
        );
      }
      return;
    }

    await sleep(RESOLUTION_POLL_INTERVAL);
  }

  console.log(`[Resolve] Timed out waiting for resolution of ${market.slug}`);
  for (const trade of pending) {
    resolveTradeTimeout(trade.id);
    console.log(`[Resolve] Trade #${trade.id} marked as timeout (loss)`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
