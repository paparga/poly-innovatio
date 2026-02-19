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

const resolveStmt = db.prepare(`
  UPDATE trades
  SET outcome = ?, payout = ?, profit = ? - buy_price, resolved_at = datetime('now')
  WHERE id = ?
`);

export function resolveTrade(id: number, outcome: "win" | "lose"): void {
  const payout = outcome === "win" ? 1.0 : 0.0;
  resolveStmt.run(outcome, payout, payout, id);
}

const timeoutStmt = db.prepare(`
  UPDATE trades
  SET outcome = 'timeout', payout = 0, profit = -buy_price, resolved_at = datetime('now')
  WHERE id = ?
`);

export function resolveTradeTimeout(id: number): void {
  timeoutStmt.run(id);
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
  trades: Trade[];
} {
  const all = db.prepare("SELECT * FROM trades ORDER BY created_at DESC").all() as Trade[];
  const wins = all.filter((t) => t.outcome === "win").length;
  const losses = all.filter((t) => t.outcome === "lose").length;
  const pending = all.filter((t) => t.outcome === null).length;
  const timeouts = all.filter((t) => t.outcome === "timeout").length;
  const totalProfit = all.reduce((sum, t) => sum + (t.profit ?? 0), 0);

  return { total: all.length, wins, losses, pending, timeouts, totalProfit, trades: all };
}

export function closeDb(): void {
  db.close();
}
