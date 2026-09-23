// SQLite storage using Node's built-in driver (Node 22.5+), so there is nothing native to compile.
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'var');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'orders.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    number TEXT,
    day TEXT,
    day_seq INTEGER,
    status TEXT NOT NULL,            -- pending | paid | ready | done | cancelled | expired
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    notes TEXT,
    pickup_type TEXT NOT NULL,       -- asap | scheduled
    pickup_at TEXT,                  -- ISO; for asap, set when paid (paid + prep minutes)
    items_json TEXT NOT NULL,
    subtotal_cents INTEGER NOT NULL,
    tax_cents INTEGER NOT NULL,
    total_cents INTEGER NOT NULL,
    stripe_session_id TEXT,
    payment_intent TEXT,
    refunded INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    paid_at TEXT,
    printed_at TEXT,
    ready_at TEXT,
    done_at TEXT,
    cancelled_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(stripe_session_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_number ON orders(number);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS sold_out (item_id TEXT PRIMARY KEY);
`);

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

function soldOutIds() {
  return db.prepare('SELECT item_id FROM sold_out').all().map((r) => r.item_id);
}
function setSoldOut(itemId, soldOut) {
  if (soldOut) db.prepare('INSERT OR IGNORE INTO sold_out(item_id) VALUES(?)').run(itemId);
  else db.prepare('DELETE FROM sold_out WHERE item_id = ?').run(itemId);
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, getSetting, setSetting, soldOutIds, setSoldOut, tx, dataDir };
