import { fetchWithTimeout } from "./market.js";

export type Asset = "BTC" | "ETH" | "XRP" | "SOL";

export interface Candle {
  openTime: number;   // Unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;  // Unix ms
}

export const ASSETS: Asset[] = ["XRP"];

const ASSET_SYMBOLS: Record<Asset, string> = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  XRP: "XRPUSDT",
  SOL: "SOLUSDT",
};

const CANDLES_PER_REQUEST = 1000;
const INTER_REQUEST_DELAY = 100; // ms between paginated requests

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBinanceCandles(
  asset: Asset,
  startMs: number,
  endMs: number
): Promise<Candle[] | null> {
  const symbol = ASSET_SYMBOLS[asset];
  const candles: Candle[] = [];
  let cursor = startMs;

  while (cursor < endMs) {
    const url =
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m` +
      `&startTime=${cursor}&endTime=${endMs}&limit=${CANDLES_PER_REQUEST}`;

    let res: Response;
    try {
      res = await fetchWithTimeout(url, 15_000);
    } catch (err) {
      console.error(`[Candles] Binance request failed for ${asset}:`, err);
      return null;
    }

    if (!res.ok) {
      console.error(`[Candles] Binance API error for ${asset}: ${res.status} ${res.statusText}`);
      return null;
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      console.error(`[Candles] Failed to parse Binance response for ${asset}`);
      return null;
    }

    if (!Array.isArray(data) || data.length === 0) break;

    for (const row of data) {
      candles.push({
        openTime: row[0] as number,
        open: parseFloat(row[1] as string),
        high: parseFloat(row[2] as string),
        low: parseFloat(row[3] as string),
        close: parseFloat(row[4] as string),
        volume: parseFloat(row[5] as string),
        closeTime: row[6] as number,
      });
    }

    const lastClose = (data[data.length - 1] as number[])[6] as number;
    cursor = lastClose + 1;

    if (data.length < CANDLES_PER_REQUEST) break;

    await sleep(INTER_REQUEST_DELAY);
  }

  return candles;
}

async function fetchBybitCandles(
  asset: Asset,
  startMs: number,
  endMs: number
): Promise<Candle[] | null> {
  const symbol = ASSET_SYMBOLS[asset];
  const candles: Candle[] = [];
  let cursor = endMs;

  while (cursor > startMs) {
    const url =
      `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}` +
      `&interval=1&start=${startMs}&end=${cursor}&limit=${CANDLES_PER_REQUEST}`;

    let res: Response;
    try {
      res = await fetchWithTimeout(url, 15_000);
    } catch (err) {
      console.error(`[Candles] Bybit request failed for ${asset}:`, err);
      return null;
    }

    if (!res.ok) {
      console.error(`[Candles] Bybit API error for ${asset}: ${res.status} ${res.statusText}`);
      return null;
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      console.error(`[Candles] Failed to parse Bybit response for ${asset}`);
      return null;
    }

    const body = data as { retCode: number; result?: { list?: unknown[] } };
    if (body.retCode !== 0 || !body.result?.list || body.result.list.length === 0) break;

    const rows = body.result.list as string[][];
    // Bybit returns reverse chronological — reverse to chronological
    const batch: Candle[] = rows.reverse().map((row) => ({
      openTime: parseInt(row[0], 10),
      open: parseFloat(row[1]),
      high: parseFloat(row[2]),
      low: parseFloat(row[3]),
      close: parseFloat(row[4]),
      volume: parseFloat(row[5]),
      closeTime: parseInt(row[0], 10) + 60_000 - 1,
    }));

    candles.unshift(...batch);

    cursor = batch[0].openTime - 1;

    if (rows.length < CANDLES_PER_REQUEST) break;

    await sleep(INTER_REQUEST_DELAY);
  }

  return candles;
}

export async function fetchAllAssetCandles(
  days: number
): Promise<Map<Asset, Candle[]>> {
  const endMs = Date.now();
  const startMs = endMs - days * 24 * 60 * 60 * 1000;
  const result = new Map<Asset, Candle[]>();

  for (const asset of ASSETS) {
    console.log(`[Candles] Fetching ${asset} 1m candles (${days} days)...`);

    // Try Binance first
    let candles = await fetchBinanceCandles(asset, startMs, endMs);

    if (candles && candles.length > 0) {
      console.log(`[Candles] ${asset}: ${candles.length} candles from Binance`);
      result.set(asset, candles);
      continue;
    }

    // Fallback to Bybit
    console.log(`[Candles] Binance failed for ${asset}, trying Bybit...`);
    candles = await fetchBybitCandles(asset, startMs, endMs);

    if (candles && candles.length > 0) {
      console.log(`[Candles] ${asset}: ${candles.length} candles from Bybit`);
      result.set(asset, candles);
      continue;
    }

    console.warn(`[Candles] WARNING: No candle data for ${asset}, skipping`);
  }

  return result;
}
