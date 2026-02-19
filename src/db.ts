import Database from "better-sqlite3";
import path from "node:path";

const DB_PATH = path.join(process.cwd(), "trades.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market_slug TEXT NOT NULL,
    condition_id TEXT NOT NULL,
    token_id TEXT NOT NULL,
    side TEXT NOT NULL,
    buy_price REAL NOT NULL,
    outcome TEXT,
    payout REAL,
    profit REAL,
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT
  )
`);

// Idempotent migrations for live trading columns
const migrations = [
  "ALTER TABLE trades ADD COLUMN order_id TEXT",
  "ALTER TABLE trades ADD COLUMN cancel_order_id TEXT",
  "ALTER TABLE trades ADD COLUMN mode TEXT NOT NULL DEFAULT 'paper'",
  "ALTER TABLE trades ADD COLUMN size REAL NOT NULL DEFAULT 1.0",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch { /* column already exists */ }
}

export interface Trade {
  id: number;
  market_slug: string;
  condition_id: string;
  token_id: string;
  side: string;
  buy_price: number;
  outcome: string | null;
  payout: number | null;
  profit: number | null;
  created_at: string;
  resolved_at: string | null;
  order_id: string | null;
  cancel_order_id: string | null;
  mode: string;
  size: number;
}

const insertStmt = db.prepare(`
  INSERT INTO trades (market_slug, condition_id, token_id, side, buy_price)
  VALUES (?, ?, ?, ?, ?)
`);

export function insertTrade(
  marketSlug: string,
  conditionId: string,
  tokenId: string,
  side: string,
  buyPrice: number
): number {
  const result = insertStmt.run(marketSlug, conditionId, tokenId, side, buyPrice);
  return result.lastInsertRowid as number;
}

const insertLiveStmt = db.prepare(`
  INSERT INTO trades (market_slug, condition_id, token_id, side, buy_price, order_id, cancel_order_id, mode, size)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'live', ?)
`);

export function insertLiveTrade(
  marketSlug: string,
  conditionId: string,
  tokenId: string,
  side: string,
  buyPrice: number,
  orderId: string,
  cancelOrderId: string,
  size: number
): number {
  const result = insertLiveStmt.run(
    marketSlug, conditionId, tokenId, side, buyPrice, orderId, cancelOrderId, size
  );
  return result.lastInsertRowid as number;
}

const resolveStmt = db.prepare(`
  UPDATE trades
  SET outcome = ?, payout = ?, profit = (? - buy_price) * size, resolved_at = datetime('now')
  WHERE id = ?
`);

export function resolveTrade(id: number, outcome: "win" | "lose"): void {
  const payout = outcome === "win" ? 1.0 : 0.0;
  resolveStmt.run(outcome, payout, payout, id);
}

const openTradesStmt = db.prepare(`
  SELECT * FROM trades
  WHERE outcome IS NULL
    AND created_at > datetime('now', '-1 hour')
`);

export function getOpenTrades(): Trade[] {
  return openTradesStmt.all() as Trade[];
}

const tradesBySlugStmt = db.prepare(`
  SELECT * FROM trades WHERE market_slug = ?
`);

export function getTradesBySlug(slug: string): Trade[] {
  return tradesBySlugStmt.all(slug) as Trade[];
}

export function getTradeStats(): {
  total: number;
  wins: number;
  losses: number;
  pending: number;
  timeouts: number;
  totalProfit: number;
  avgWin: number | null;
  avgLoss: number | null;
  trades: Trade[];
} {
  const all = db.prepare("SELECT * FROM trades ORDER BY created_at DESC").all() as Trade[];
  const winTrades = all.filter((t) => t.outcome === "win");
  const loseTrades = all.filter((t) => t.outcome === "lose");
  const pending = all.filter((t) => t.outcome === null).length;
  const timeouts = all.filter((t) => t.outcome === "timeout").length;
  const totalProfit = all.reduce((sum, t) => sum + (t.profit ?? 0), 0);
  const avgWin = winTrades.length > 0
    ? winTrades.reduce((sum, t) => sum + (t.profit ?? 0), 0) / winTrades.length
    : null;
  const avgLoss = loseTrades.length > 0
    ? loseTrades.reduce((sum, t) => sum + (t.profit ?? 0), 0) / loseTrades.length
    : null;

  return {
    total: all.length,
    wins: winTrades.length,
    losses: loseTrades.length,
    pending,
    timeouts,
    totalProfit,
    avgWin,
    avgLoss,
    trades: all,
  };
}

export function closeDb(): void {
  db.close();
}
