-- Point-in-time market recorder. observed_at is when WE saw the event.
-- This dataset is the real long-term asset: it's what makes honest
-- backtesting possible later, because you cannot buy this data.

CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY,
  pool TEXT,
  creator TEXT,
  source TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'launch',
  first_signature TEXT NOT NULL,
  first_slot INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  graduated_at INTEGER,
  graduation_signature TEXT
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  taken_at INTEGER NOT NULL,
  price_usd REAL,
  liquidity_usd REAL,
  holder_count INTEGER,
  top10_holder_pct REAL,
  mint_authority_active INTEGER,
  freeze_authority_active INTEGER,
  lp_burned_pct REAL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_mint_time ON snapshots(mint, taken_at);

CREATE TABLE IF NOT EXISTS raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  slot INTEGER,
  observed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_raw_events_time ON raw_events(observed_at);

CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  assessed_at INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  total_score REAL NOT NULL,
  results_json TEXT NOT NULL,
  config_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_assessments_mint ON assessments(mint);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL
);
