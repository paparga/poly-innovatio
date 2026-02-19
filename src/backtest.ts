import type { Asset, Candle } from "./candles.js";

interface FiveMinWindow {
  startTime: number;
  open: number;
  close: number;
  high: number;
  low: number;
  direction: "Up" | "Down"; // close > open = Up
  candles: Candle[];
}

interface BacktestResult {
  asset: Asset;
  totalWindows: number;
  tradesEntered: number;
  wins: number;
  losses: number;
  winRate: number;
  totalProfit: number;
  avgProfit: number;
  maxConsecutiveLosses: number;
  profitByDay: Map<string, number>;
  winsByHour: number[];          // 24 entries (0-23 UTC)
  tradesByHour: number[];        // 24 entries (0-23 UTC)
  winsByHourDay: number[][];     // 24 × 7 (hour × day-of-week)
  tradesByHourDay: number[][];   // 24 × 7 (hour × day-of-week)
}

const BUY_PRICE = 0.60;
const WIN_PAYOUT = 1.00;
const MIN_CANDLES_PER_WINDOW = 3;

function aggregateToFiveMin(candles: Candle[]): FiveMinWindow[] {
  // Group candles into 5-min windows aligned to 300s boundaries
  const buckets = new Map<number, Candle[]>();

  for (const c of candles) {
    const boundaryMs = Math.floor(c.openTime / 300_000) * 300_000;
    const list = buckets.get(boundaryMs) ?? [];
    list.push(c);
    buckets.set(boundaryMs, list);
  }

  const windows: FiveMinWindow[] = [];
  const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);

  for (const key of sortedKeys) {
    const group = buckets.get(key)!;
    if (group.length < MIN_CANDLES_PER_WINDOW) continue;

    // Sort candles within window by openTime
    group.sort((a, b) => a.openTime - b.openTime);

    const open = group[0].open;
    const close = group[group.length - 1].close;
    const high = Math.max(...group.map((c) => c.high));
    const low = Math.min(...group.map((c) => c.low));
    const direction: "Up" | "Down" = close > open ? "Up" : "Down";

    windows.push({ startTime: key, open, close, high, low, direction, candles: group });
  }

  return windows;
}

function simulateStrategy(windows: FiveMinWindow[]): {
  trades: number;
  wins: number;
  losses: number;
  maxConsecutiveLosses: number;
  profitByDay: Map<string, number>;
  winsByHour: number[];
  tradesByHour: number[];
  winsByHourDay: number[][];
  tradesByHourDay: number[][];
} {
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let consecutiveLosses = 0;
  let maxConsecutiveLosses = 0;
  const profitByDay = new Map<string, number>();
  const winsByHour = Array(24).fill(0) as number[];
  const tradesByHour = Array(24).fill(0) as number[];
  const winsByHourDay: number[][] = Array.from({ length: 24 }, () => Array(7).fill(0));
  const tradesByHourDay: number[][] = Array.from({ length: 24 }, () => Array(7).fill(0));

  for (const w of windows) {
    if (w.candles.length < 2) continue;

    // Side selection: look at first 2 candles
    const pick: "Up" | "Down" =
      w.candles[1].close >= w.candles[0].open ? "Up" : "Down";

    trades++;

    const dt = new Date(w.startTime);
    const hour = dt.getUTCHours();
    const dow = dt.getUTCDay();
    const dayKey = dt.toISOString().slice(0, 10);
    const isWin = pick === w.direction;

    tradesByHour[hour]++;
    tradesByHourDay[hour][dow]++;

    if (isWin) {
      wins++;
      consecutiveLosses = 0;
      winsByHour[hour]++;
      winsByHourDay[hour][dow]++;
      const profit = WIN_PAYOUT - BUY_PRICE;
      profitByDay.set(dayKey, (profitByDay.get(dayKey) ?? 0) + profit);
    } else {
      losses++;
      consecutiveLosses++;
      if (consecutiveLosses > maxConsecutiveLosses) {
        maxConsecutiveLosses = consecutiveLosses;
      }
      profitByDay.set(dayKey, (profitByDay.get(dayKey) ?? 0) - BUY_PRICE);
    }
  }

  return { trades, wins, losses, maxConsecutiveLosses, profitByDay, winsByHour, tradesByHour, winsByHourDay, tradesByHourDay };
}

export function runBacktest(
  candleData: Map<Asset, Candle[]>
): BacktestResult[] {
  const results: BacktestResult[] = [];

  for (const [asset, candles] of candleData) {
    const windows = aggregateToFiveMin(candles);
    const sim = simulateStrategy(windows);

    const winRate = sim.trades > 0 ? (sim.wins / sim.trades) * 100 : 0;
    const totalProfit =
      sim.wins * (WIN_PAYOUT - BUY_PRICE) - sim.losses * BUY_PRICE;
    const avgProfit = sim.trades > 0 ? totalProfit / sim.trades : 0;

    results.push({
      asset,
      totalWindows: windows.length,
      tradesEntered: sim.trades,
      wins: sim.wins,
      losses: sim.losses,
      winRate,
      totalProfit,
      avgProfit,
      maxConsecutiveLosses: sim.maxConsecutiveLosses,
      profitByDay: sim.profitByDay,
      winsByHour: sim.winsByHour,
      tradesByHour: sim.tradesByHour,
      winsByHourDay: sim.winsByHourDay,
      tradesByHourDay: sim.tradesByHourDay,
    });
  }

  return results;
}

export function printBacktestResults(results: BacktestResult[]): void {
  console.log("\n=== Strategy Backtest Results ===\n");
  console.log(`Buy price: $${BUY_PRICE.toFixed(2)} | Win payout: $${WIN_PAYOUT.toFixed(2)}`);
  console.log(`Break-even win rate: ${((BUY_PRICE / WIN_PAYOUT) * 100).toFixed(1)}%\n`);

  const header =
    "Asset | Windows | Trades | Wins | Losses | Win Rate | Total P&L | Avg P&L | Max Consec L";
  console.log(header);
  console.log("-".repeat(header.length));

  let totalTrades = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let totalPnL = 0;

  for (const r of results) {
    const pnlSign = r.totalProfit >= 0 ? "+" : "";
    const avgSign = r.avgProfit >= 0 ? "+" : "";
    console.log(
      `${r.asset.padEnd(5)} | ${String(r.totalWindows).padStart(7)} | ` +
      `${String(r.tradesEntered).padStart(6)} | ${String(r.wins).padStart(4)} | ` +
      `${String(r.losses).padStart(6)} | ${r.winRate.toFixed(1).padStart(7)}% | ` +
      `${pnlSign}$${r.totalProfit.toFixed(2).padStart(7)} | ` +
      `${avgSign}$${r.avgProfit.toFixed(4).padStart(7)} | ` +
      `${String(r.maxConsecutiveLosses).padStart(12)}`
    );
    totalTrades += r.tradesEntered;
    totalWins += r.wins;
    totalLosses += r.losses;
    totalPnL += r.totalProfit;
  }

  console.log("-".repeat(header.length));
  const aggWinRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
  const aggAvg = totalTrades > 0 ? totalPnL / totalTrades : 0;
  const pnlSign = totalPnL >= 0 ? "+" : "";
  const avgSign = aggAvg >= 0 ? "+" : "";
  console.log(
    `ALL   | ${" ".repeat(7)} | ` +
    `${String(totalTrades).padStart(6)} | ${String(totalWins).padStart(4)} | ` +
    `${String(totalLosses).padStart(6)} | ${aggWinRate.toFixed(1).padStart(7)}% | ` +
    `${pnlSign}$${totalPnL.toFixed(2).padStart(7)} | ` +
    `${avgSign}$${aggAvg.toFixed(4).padStart(7)} |`
  );

  // Best/worst asset
  if (results.length > 1) {
    const sorted = [...results].sort((a, b) => b.winRate - a.winRate);
    console.log(`\nBest asset:  ${sorted[0].asset} (${sorted[0].winRate.toFixed(1)}% win rate)`);
    console.log(`Worst asset: ${sorted[sorted.length - 1].asset} (${sorted[sorted.length - 1].winRate.toFixed(1)}% win rate)`);
  }

  // Per-asset win rate heatmap: hour (rows) × day-of-week (columns)
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  for (const r of results) {
    console.log(`\n--- ${r.asset} Win Rate Heatmap (%) ---\n`);

    const mHeader =
      "Hour  | " + dayNames.map((d) => d.padStart(7)).join(" ") + " |     Avg";
    console.log(mHeader);
    console.log("-".repeat(mHeader.length));

    for (let h = 0; h < 24; h++) {
      const hourLabel = `${String(h).padStart(2)}:00`;
      let rowWins = 0;
      let rowTrades = 0;
      const cells = dayNames.map((_, d) => {
        const t = r.tradesByHourDay[h][d];
        const w = r.winsByHourDay[h][d];
        rowWins += w;
        rowTrades += t;
        if (t === 0) return "    N/A";
        return `${((w / t) * 100).toFixed(0)}`.padStart(6) + "%";
      });
      const rowAvg = rowTrades > 0
        ? `${((rowWins / rowTrades) * 100).toFixed(0)}`.padStart(6) + "%"
        : "    N/A";
      console.log(`${hourLabel} | ${cells.join(" ")} | ${rowAvg}`);
    }

    // Column averages
    const colAvgs = dayNames.map((_, d) => {
      let w = 0;
      let t = 0;
      for (let h = 0; h < 24; h++) {
        w += r.winsByHourDay[h][d];
        t += r.tradesByHourDay[h][d];
      }
      if (t === 0) return "    N/A";
      return `${((w / t) * 100).toFixed(0)}`.padStart(6) + "%";
    });
    console.log("-".repeat(mHeader.length));
    console.log(`Avg   | ${colAvgs.join(" ")} |`);
  }

  // Daily P&L breakdown
  console.log("\n--- Daily P&L by Asset ---\n");
  const allDays = new Set<string>();
  for (const r of results) {
    for (const day of r.profitByDay.keys()) {
      allDays.add(day);
    }
  }
  const sortedDays = [...allDays].sort();

  const dayHeader = "Date       | " + results.map((r) => r.asset.padStart(10)).join(" | ");
  console.log(dayHeader);
  console.log("-".repeat(dayHeader.length));

  for (const day of sortedDays) {
    const cols = results.map((r) => {
      const val = r.profitByDay.get(day) ?? 0;
      const sign = val >= 0 ? "+" : "";
      return `${sign}$${val.toFixed(2)}`.padStart(10);
    });
    console.log(`${day} | ${cols.join(" | ")}`);
  }

  console.log("");
}
