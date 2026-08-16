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

-- Execution-cost samples (FR-A6). Feeds FR-B3's "expectancy net of costs",
-- which is the entire Phase 3 question. Unbackfillable: you cannot ask later
-- what 0.5 SOL would have cost on a pool that no longer exists.
--
-- price_impact_pct is a TRUE PERCENT. Jupiter reports a decimal fraction; it
-- is converted once at parse time so this column means what its name says.
-- A value of 100 is legitimate and means the pool was dead/unroutable.
--
-- horizon_min = 0 is the at-alert pair. NOTE the t=0 sell row is a reference
-- point, NOT an observed exit cost: quoting straight back out hits the same
-- pool state and mirrors the entry impact by construction. Real exit cost is
-- the horizon rows.
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL,
  mint TEXT NOT NULL,
  side TEXT NOT NULL,
  horizon_min INTEGER NOT NULL,
  in_mint TEXT NOT NULL,
  out_mint TEXT NOT NULL,
  in_amount TEXT,
  out_amount TEXT,
  price_impact_pct REAL,
  route TEXT,
  slippage_bps INTEGER,
  latency_ms INTEGER,
  ok INTEGER NOT NULL,
  error TEXT,
  observed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quotes_mint ON quotes(mint, horizon_min);
-- Keyed on alert, not mint: the alert cooldown is 60 min but horizons run to
-- 240, so one mint can legitimately alert twice with overlapping windows. A
-- mint-keyed unique index would silently drop the second alert's series.
CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_alert ON quotes(alert_id, side, horizon_min);

-- Credit accounting. Helius bills websocket traffic at 20 credits/MB, which is
-- where effectively all spend goes: logsSubscribe delivers every transaction
-- touching a program and we use well under 1%. The free allowance was consumed
-- in ~10 hours on 2026-08-16 with nothing watching.
-- Keyed by UTC day + source so month-to-date survives restarts.
CREATE TABLE IF NOT EXISTS credit_usage (
  day TEXT NOT NULL,
  source TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  credits REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source)
);

-- When ingest was actually connected. Under a duty-cycled profile the stream is
-- deliberately sampled, so Phase 3 must be able to tell "nothing launched" from
-- "we were not looking" -- otherwise every rate derived from the data
-- (launches/venue, graduation rate, the whole FR-J1 gauge) is silently wrong.
CREATE TABLE IF NOT EXISTS ingest_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  venues TEXT NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_ingest_windows_time ON ingest_windows(opened_at);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL
);
