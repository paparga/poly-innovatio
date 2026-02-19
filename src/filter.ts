import { fetchAllAssetCandles, type Asset, type Candle } from "./candles.js";
import { runBacktest } from "./backtest.js";

const WIN_RATE_THRESHOLD = 60; // break-even at $0.60/$1.00
const BACKTEST_DAYS = 7;
const MIN_SAMPLES = 5; // need at least 5 trades in a cell to trust it

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface FilterMatrix {
  winsByHourDay: number[][];   // 24 × 7
  tradesByHourDay: number[][]; // 24 × 7
}

export async function loadFilterMatrix(): Promise<FilterMatrix | null> {
  console.log("[Filter] Loading XRP backtest data for hour/day filter...");

  const candleData = await fetchAllAssetCandles(BACKTEST_DAYS);
  const xrpCandles = candleData.get("XRP" as Asset);

  if (!xrpCandles || xrpCandles.length === 0) {
    console.error("[Filter] No XRP candle data available");
    return null;
  }

  // Build a single-asset map for runBacktest
  const xrpOnly = new Map<Asset, Candle[]>();
  xrpOnly.set("XRP" as Asset, xrpCandles);

  const results = runBacktest(xrpOnly);
  if (results.length === 0) {
    console.error("[Filter] Backtest returned no results");
    return null;
  }

  const xrpResult = results[0];
  console.log(
    `[Filter] XRP backtest: ${xrpResult.tradesEntered} trades, ${xrpResult.winRate.toFixed(1)}% win rate`
  );

  return {
    winsByHourDay: xrpResult.winsByHourDay,
    tradesByHourDay: xrpResult.tradesByHourDay,
  };
}

export function shouldTrade(matrix: FilterMatrix): boolean {
  const now = new Date();
  const hour = now.getUTCHours();
  const day = now.getUTCDay();

  const trades = matrix.tradesByHourDay[hour][day];
  const wins = matrix.winsByHourDay[hour][day];

  // Insufficient data — allow trading (benefit of the doubt)
  if (trades < MIN_SAMPLES) {
    return true;
  }

  const winRate = (wins / trades) * 100;
  return winRate >= WIN_RATE_THRESHOLD;
}

export function getCurrentCellInfo(matrix: FilterMatrix): {
  hour: number;
  day: string;
  winRate: number | null;
  trades: number;
} {
  const now = new Date();
  const hour = now.getUTCHours();
  const dow = now.getUTCDay();

  const trades = matrix.tradesByHourDay[hour][dow];
  const wins = matrix.winsByHourDay[hour][dow];
  const winRate = trades > 0 ? (wins / trades) * 100 : null;

  return {
    hour,
    day: DAY_NAMES[dow],
    winRate,
    trades,
  };
}
