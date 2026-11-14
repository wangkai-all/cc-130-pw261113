import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
export const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'cashflow.db');

let db;

export function getDb() {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
  }
  return db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  -- JSON array of ISO dates that are non-working
  holidays TEXT NOT NULL DEFAULT '[]',
  -- weekend rule: 'none' | 'next' | 'prev' | 'nearest'
  weekend_rule TEXT NOT NULL DEFAULT 'next',
  -- can weekends be settlement dates at all
  weekend_enabled INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  delay_days INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('ar','ap')),
  doc_no TEXT NOT NULL,
  party TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers(id),
  currency TEXT NOT NULL,
  amount_original REAL NOT NULL,
  fx_rate REAL,                       -- rate to base currency, NULL = missing
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,             -- contractual (账面) due date
  expected_date TEXT NOT NULL,        -- planned settlement date (预计结算日)
  note TEXT,
  import_batch TEXT,
  import_key TEXT UNIQUE,             -- dedupe key for re-import
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('receipt','payment')),
  ref_no TEXT NOT NULL,
  party TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_original REAL NOT NULL,
  fx_rate REAL,
  received_date TEXT NOT NULL,
  note TEXT,
  import_batch TEXT,
  import_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  amount REAL NOT NULL,              -- in payment currency
  allocated_date TEXT NOT NULL,
  voided INTEGER NOT NULL DEFAULT 0,
  voided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scenarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  base INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scenario_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  expected_date TEXT NOT NULL,
  reason TEXT,
  UNIQUE (scenario_id, document_id)
);

CREATE TABLE IF NOT EXISTS scenario_customer_delays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  delay_days INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  UNIQUE (scenario_id, customer_id)
);

CREATE TABLE IF NOT EXISTS opening_balances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  currency TEXT NOT NULL,
  amount REAL NOT NULL,
  as_of TEXT NOT NULL,
  fx_rate REAL,
  UNIQUE (currency, as_of)
);

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  filename TEXT,
  rows_read INTEGER NOT NULL DEFAULT 0,
  rows_accepted INTEGER NOT NULL DEFAULT 0,
  rows_skipped INTEGER NOT NULL DEFAULT 0,
  rows_rejected INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_docs_due ON documents(due_date);
CREATE INDEX IF NOT EXISTS idx_docs_expected ON documents(expected_date);
CREATE INDEX IF NOT EXISTS idx_alloc_payment ON allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_alloc_doc ON allocations(document_id);
`;

export function initSchema() {
  getDb().exec(SCHEMA);
}

export function getSetting(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setSetting(key, value) {
  getDb()
    .prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));
}

export function newBatchId() {
  return 'IMP-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

/** Base currency conversion. Returns null when rate missing or non-positive. */
export function toBase(amount, rate) {
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return null;
  return round2(amount * rate);
}

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function round4(n) {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}
