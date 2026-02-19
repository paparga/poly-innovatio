import { insertTrade, resolveTrade, getOpenTrades } from "./db.js";
import { checkResolution, type MarketInfo } from "./market.js";

export const BUY_THRESHOLD = 0.6;
const BUY_MAX_PRICE = 0.85; // Reject prices above this — likely a settled/settling market
const RESOLUTION_LOOP_INTERVAL = 10_000; // 10 seconds between resolution checks

// Track which markets we've already bet on — seed from DB on import
const bettedMarkets = new Set<string>(
  getOpenTrades().map((t) => t.market_slug)
);

// Current prices per token
const prices = new Map<string, number>();

// Track tokens that already logged "price too high" to avoid log spam
const priceHighLogged = new Set<string>();

// Settled detection — both sides above max means market is dead
let marketSettled = false;

// Background resolution loop handle
let resolutionTimer: ReturnType<typeof setInterval> | null = null;

export function getLatestPrices(): Map<string, number> {
  return prices;
}

export function hasBet(slug: string): boolean {
  return bettedMarkets.has(slug);
}

export function isMarketSettled(): boolean {
  return marketSettled;
}

/** Clear per-market state when moving to a new market window. */
export function clearMarketState(): void {
  priceHighLogged.clear();
  marketSettled = false;
}

export function handlePriceUpdate(
  market: MarketInfo,
  tokenId: string,
  price: number
): void {
  prices.set(tokenId, price);

  // Check if both sides are above max — market is settled/dead
  if (!marketSettled && !bettedMarkets.has(market.slug)) {
    const upPrice = prices.get(market.upTokenId);
    const downPrice = prices.get(market.downTokenId);
    if (upPrice !== undefined && downPrice !== undefined &&
        upPrice > BUY_MAX_PRICE && downPrice > BUY_MAX_PRICE) {
      marketSettled = true;
      console.log(`\n[Strategy] Both sides above max — market settled, skipping`);
      return;
    }
  }

  // Already bet on this market
  if (bettedMarkets.has(market.slug)) return;

  // Check if price meets threshold but isn't suspiciously high (settled market)
  if (price < BUY_THRESHOLD) return;
  if (price > BUY_MAX_PRICE) {
    const key = `${market.slug}:${tokenId}`;
    if (!priceHighLogged.has(key)) {
      priceHighLogged.add(key);
      console.log(`\n[Strategy] Skipping ${tokenId.slice(0, 8)}... @ $${price.toFixed(2)} — price too high, market likely settled`);
    }
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

/** Start the background resolution loop. Runs every 10s, resolving any open trades. */
export function startResolutionLoop(): void {
  if (resolutionTimer) return; // already running

  resolutionTimer = setInterval(async () => {
    try {
      const openTrades = getOpenTrades();
      if (openTrades.length === 0) return;

      // Group by slug
      const bySlug = new Map<string, typeof openTrades>();
      for (const trade of openTrades) {
        const list = bySlug.get(trade.market_slug) ?? [];
        list.push(trade);
        bySlug.set(trade.market_slug, list);
      }

      for (const [slug, trades] of bySlug) {
        const winner = await checkResolution(slug);
        if (!winner) continue;

        for (const trade of trades) {
          const outcome = trade.side === winner ? "win" : "lose";
          resolveTrade(trade.id, outcome);
          const profit = outcome === "win" ? 1 - trade.buy_price : -trade.buy_price;
          console.log(
            `\n[Resolve] Trade #${trade.id} (${trade.side}): ${outcome.toUpperCase()} | profit: ${profit >= 0 ? "+" : ""}$${profit.toFixed(2)}`
          );
        }
      }
    } catch (err) {
      console.error("[Resolve] Error in resolution loop:", err);
    }
  }, RESOLUTION_LOOP_INTERVAL);
}

/** Stop the background resolution loop (for shutdown). */
export function stopResolutionLoop(): void {
  if (resolutionTimer) {
    clearInterval(resolutionTimer);
    resolutionTimer = null;
  }
}
