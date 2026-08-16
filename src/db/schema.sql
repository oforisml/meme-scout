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
  lp_burned_pct REAL,
  -- When the slow-moving fields were actually read (they are carried forward
  -- between refreshes; these columns stop that from looking like fresh data).
  chain_state_at INTEGER,
  holder_count_at INTEGER,
  -- Bumped when the meaning of a column changes. Rows written before the
  -- Phase 2 field wiring are version 1 and are NOT comparable to later rows.
  schema_version INTEGER NOT NULL DEFAULT 1
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
  config_hash TEXT,
  -- Version 1 rows were produced when missing data counted as a pass; their
  -- `passed` values are artifacts of null inputs, not judgements. Phase 3
  -- precision analysis must filter on schema_version >= 2.
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_assessments_mint ON assessments(mint);

-- Raw per-swap rows, captured only inside the bounded launch windows in
-- strategy.config.json. Storing every swap for tracked tokens would be ~7M
-- rows/day; these windows are where per-wallet forensics actually matter.
--
-- Diverges from the shape originally sketched in DATA_MODEL.md: sol_amount and
-- token_amount are what the event reports, and price is left out because it is
-- derivable from the pair (a stored derived value only drifts from its inputs).
-- mint is NULLABLE on purpose: a freshly graduated pool trades before we have
-- resolved pool -> mint, and dropping those swaps would gut the very window
-- this table exists for. It is backfilled once the pool resolves.
CREATE TABLE IF NOT EXISTS swaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT,
  pool TEXT,
  venue TEXT NOT NULL,
  signature TEXT,
  slot INTEGER,
  side TEXT NOT NULL,
  sol_amount REAL NOT NULL,
  token_amount REAL NOT NULL,
  wallet TEXT NOT NULL,
  chain_ts INTEGER,
  observed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_swaps_mint_time ON swaps(mint, observed_at);
CREATE INDEX IF NOT EXISTS idx_swaps_pool ON swaps(pool);

-- Per-minute aggregates for tokens we actually assess. new_buyers across
-- successive buckets IS H1's "unique-buyer growth"; buyers_who_also_sold is a
-- cheap first-pass wash signal.
CREATE TABLE IF NOT EXISTS swap_buckets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  trades INTEGER NOT NULL,
  buys INTEGER NOT NULL,
  sells INTEGER NOT NULL,
  sol_in REAL NOT NULL,
  sol_out REAL NOT NULL,
  distinct_buyers INTEGER NOT NULL,
  new_buyers INTEGER NOT NULL,
  cumulative_buyers INTEGER NOT NULL,
  buyers_who_also_sold INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_buckets_mint_start ON swap_buckets(mint, bucket_start);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL
);
