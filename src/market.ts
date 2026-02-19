const GAMMA_API = "https://gamma-api.polymarket.com";

const FETCH_TIMEOUT = 10_000;

export async function fetchWithTimeout(url: string, timeout = FETCH_TIMEOUT): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(timeout) });
}

export interface MarketInfo {
  slug: string;
  conditionId: string;
  upTokenId: string;
  downTokenId: string;
}

export function getCurrentMarketSlug(): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const ts = Math.floor(nowSec / 300) * 300;
  return `btc-updown-5m-${ts}`;
}

export function getMarketEndTime(slug: string): number {
  const ts = parseInt(slug.split("-").pop()!, 10);
  return (ts + 300) * 1000; // end time in ms
}

export async function fetchMarket(slug: string): Promise<MarketInfo | "closed" | null> {
  const url = `${GAMMA_API}/events?slug=${slug}`;
  const res = await fetchWithTimeout(url);

  if (!res.ok) {
    console.error(`Gamma API error: ${res.status} ${res.statusText}`);
    return null;
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    console.error("[Market] Failed to parse fetchMarket response JSON");
    return null;
  }

  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  const event = data[0];
  const markets = event.markets;

  if (!markets || markets.length === 0) {
    return null;
  }

  // The event has one market with two outcomes (Up/Down)
  const market = markets[0];
  const conditionId: string = market.conditionId;

  // clobTokenIds is a JSON string like '["tokenId1","tokenId2"]'
  // outcomes is a JSON string like '["Up","Down"]'
  let clobTokenIds: string[];
  let outcomes: string[];
  try {
    clobTokenIds = JSON.parse(market.clobTokenIds);
    outcomes = JSON.parse(market.outcomes);
  } catch {
    console.error("[Market] Failed to parse token/outcome JSON in fetchMarket");
    return null;
  }

  let upTokenId = "";
  let downTokenId = "";

  for (let i = 0; i < outcomes.length; i++) {
    const label = outcomes[i].toLowerCase();
    if (label === "up") {
      upTokenId = clobTokenIds[i];
    } else if (label === "down") {
      downTokenId = clobTokenIds[i];
    }
  }

  if (!upTokenId || !downTokenId) {
    console.error("Could not find Up/Down token IDs in market data");
    return null;
  }

  // Skip markets that are already closed or resolved
  if (market.closed || market.resolved) {
    console.log(`[Market] Skipping ${slug} — already ${market.resolved ? "resolved" : "closed"}`);
    return "closed";
  }

  return { slug, conditionId, upTokenId, downTokenId };
}

export async function checkResolution(
  slug: string
): Promise<"Up" | "Down" | null> {
  const url = `${GAMMA_API}/events?slug=${slug}`;
  const res = await fetchWithTimeout(url);

  if (!res.ok) return null;

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  if (!Array.isArray(data) || data.length === 0) return null;

  const market = data[0].markets?.[0];
  if (!market) return null;

  let outcomes: string[];
  let outcomePrices: string[];
  try {
    outcomes = JSON.parse(market.outcomes);
    outcomePrices = JSON.parse(market.outcomePrices);
  } catch {
    return null;
  }

  if (outcomes.length !== outcomePrices.length) return null;

  // Market is resolved when: `resolved` flag is true, OR the market is
  // closed and one outcome price is >= 0.999 (Gamma sometimes leaves
  // `resolved` as null even after settlement, and prices may be "0.9999").
  const hasWinner = outcomePrices.some((p) => parseFloat(p) >= 0.999);
  if (!market.resolved && !(market.closed && hasWinner)) return null;

  for (let i = 0; i < outcomes.length; i++) {
    if (parseFloat(outcomePrices[i]) >= 0.999) {
      return outcomes[i] as "Up" | "Down";
    }
  }

  return null;
}
