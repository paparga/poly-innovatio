import type { Asset, Candle } from "./candles.js";
import { ASSETS } from "./candles.js";

// VolMatrix: asset → hour (0-23) → day-of-week (0=Sun..6=Sat) → avg range%
export type VolMatrix = Map<Asset, number[][]>;

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function buildVolMatrix(
  candleData: Map<Asset, Candle[]>
): VolMatrix {
  const matrix: VolMatrix = new Map();

  for (const asset of ASSETS) {
    const candles = candleData.get(asset);
    if (!candles) continue;

    // 24 hours × 7 days: [sum, count]
    const sums: number[][] = Array.from({ length: 24 }, () =>
      Array(7).fill(0)
    );
    const counts: number[][] = Array.from({ length: 24 }, () =>
      Array(7).fill(0)
    );

    for (const c of candles) {
      if (c.open <= 0) continue;
      const rangePercent = ((c.high - c.low) / c.open) * 100;
      if (isNaN(rangePercent)) continue;

      const dt = new Date(c.openTime);
      const hour = dt.getUTCHours();
      const dow = dt.getUTCDay();

      sums[hour][dow] += rangePercent;
      counts[hour][dow]++;
    }

    // Compute averages
    const avg: number[][] = Array.from({ length: 24 }, (_, h) =>
      Array.from({ length: 7 }, (_, d) =>
        counts[h][d] > 0 ? sums[h][d] / counts[h][d] : 0
      )
    );

    matrix.set(asset, avg);
  }

  return matrix;
}

export function printVolMatrix(matrix: VolMatrix): void {
  console.log("\n=== Multi-Asset Volatility Heatmap (1-min candle avg range %) ===\n");

  for (const [asset, grid] of matrix) {
    console.log(`--- ${asset} ---\n`);

    // Header: Hour | Sun Mon Tue Wed Thu Fri Sat | Avg
    const header =
      "Hour  | " + DAY_NAMES.map((d) => d.padStart(7)).join(" ") + " |     Avg";
    console.log(header);
    console.log("-".repeat(header.length));

    const hourAvgs: number[] = [];

    for (let h = 0; h < 24; h++) {
      const hourLabel = `${String(h).padStart(2)}:00`;
      const cells = grid[h].map((v) => formatCell(v));
      const rowAvg =
        grid[h].reduce((s, v) => s + v, 0) /
        grid[h].filter((v) => v > 0).length || 0;
      hourAvgs.push(rowAvg);

      console.log(
        `${hourLabel} | ${cells.join(" ")} | ${formatCell(rowAvg)}`
      );
    }

    // Column averages
    const colAvgs = DAY_NAMES.map((_, d) => {
      const vals = grid.map((row) => row[d]).filter((v) => v > 0);
      return vals.length > 0
        ? vals.reduce((s, v) => s + v, 0) / vals.length
        : 0;
    });
    console.log(
      "-".repeat(header.length)
    );
    console.log(
      `Avg   | ${colAvgs.map((v) => formatCell(v)).join(" ")} |`
    );
    console.log("");
  }

  // Cross-asset summary
  console.log("--- Cross-Asset Summary ---\n");
  const summaryHeader = "Asset |  Avg Vol% | Peak Hour (UTC) | Peak Day";
  console.log(summaryHeader);
  console.log("-".repeat(summaryHeader.length));

  for (const [asset, grid] of matrix) {
    let totalSum = 0;
    let totalCount = 0;
    let peakVal = 0;
    let peakHour = 0;
    let peakDay = 0;

    for (let h = 0; h < 24; h++) {
      for (let d = 0; d < 7; d++) {
        if (grid[h][d] > 0) {
          totalSum += grid[h][d];
          totalCount++;
          if (grid[h][d] > peakVal) {
            peakVal = grid[h][d];
            peakHour = h;
            peakDay = d;
          }
        }
      }
    }

    const avgVol = totalCount > 0 ? totalSum / totalCount : 0;
    console.log(
      `${asset.padEnd(5)} | ${avgVol.toFixed(4).padStart(9)} | ` +
      `${String(peakHour).padStart(2)}:00`.padStart(15) +
      ` | ${DAY_NAMES[peakDay]}`
    );
  }

  console.log("");
}

function formatCell(val: number): string {
  return val.toFixed(4).padStart(7);
}
