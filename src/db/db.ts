import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { strategyHash } from "../strategy.js";
import type { Alert, Assessment, TokenLaunch, TokenSnapshot } from "../types.js";

mkdirSync(dirname(config.DB_PATH), { recursive: true });
export const db = new Database(config.DB_PATH);
db.pragma("journal_mode = WAL");

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");
db.exec(readFileSync(schemaPath, "utf8"));

/**
 * Current snapshot/assessment semantics.
 *
 * v1 — Phase 1. The four market fields were hardcoded null and every filter
 *      degraded toward pass, so `assessments.passed` meant "nothing could
 *      disprove it". Those rows are not comparable to later ones.
 * v2 — Phase 2 workstream A. price/liquidity/holders/LP-burn are really
 *      populated, pool vaults are excluded from concentration, and missing
 *      data fails instead of passing.
 */
export const SCHEMA_VERSION = 2;

/**
 * schema.sql uses CREATE TABLE IF NOT EXISTS, which silently does nothing to
 * an existing table — so new columns need an explicit, idempotent ALTER.
 */
function addColumnIfMissing(table: string, column: string, definition: string): void {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (existing.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumnIfMissing("snapshots", "chain_state_at", "INTEGER");
addColumnIfMissing("snapshots", "holder_count_at", "INTEGER");
addColumnIfMissing("snapshots", "schema_version", "INTEGER NOT NULL DEFAULT 1");
addColumnIfMissing("assessments", "schema_version", "INTEGER NOT NULL DEFAULT 1");

// Token metadata, decoded from the pump.fun CreateEvent at no RPC cost.
// `name`/`symbol` are kept for FR-I1's narrative lexicon, which needs them.
addColumnIfMissing("tokens", "name", "TEXT");
addColumnIfMissing("tokens", "symbol", "TEXT");
addColumnIfMissing("tokens", "uri", "TEXT");
// On-chain event time. Distinct from observed_at on purpose: the difference IS
// our observation latency, which ROADMAP lists as standing risk #1 and which
// was previously assumed rather than measured.
addColumnIfMissing("tokens", "chain_ts", "INTEGER");

// raw_events never got a schema_version, and RUNBOOK invariant 6 requires one
// when a column changes meaning — `payload` no longer carries the log array.
addColumnIfMissing("raw_events", "schema_version", "INTEGER NOT NULL DEFAULT 1");

// Whether this alert was actually delivered to Telegram. Passing decides what
// the dataset records; a stricter notify bar decides what interrupts the
// operator. Existing rows predate the split and were all delivered, hence 1.
addColumnIfMissing("alerts", "notified", "INTEGER NOT NULL DEFAULT 1");

// tokens had no index beyond the mint PK. Fine at ~110 rows/hour; not fine now
// that bonding-curve launches land here at ~60k/day and every venue or
// time-range query would table-scan. markGraduated's WHERE mint = ? still uses
// the primary key.
db.exec(`CREATE INDEX IF NOT EXISTS idx_tokens_source_time ON tokens(source, observed_at)`);

export function saveToken(t: TokenLaunch): void {
  db.prepare(
    `INSERT OR IGNORE INTO tokens
       (mint, pool, creator, source, kind, first_signature, first_slot, observed_at,
        name, symbol, uri, chain_ts)
     VALUES (@mint, @pool, @creator, @source, @kind, @signature, @slot, @observedAt,
        @name, @symbol, @uri, @chainTs)`
  ).run({
    ...t,
    name: t.name ?? null,
    symbol: t.symbol ?? null,
    uri: t.uri ?? null,
    chainTs: t.chainTs ?? null,
  });
}

export function saveSnapshot(s: TokenSnapshot): void {
  db.prepare(
    `INSERT INTO snapshots (mint, taken_at, price_usd, liquidity_usd, holder_count,
       top10_holder_pct, mint_authority_active, freeze_authority_active, lp_burned_pct,
       chain_state_at, holder_count_at, schema_version)
     VALUES (@mint, @takenAt, @priceUsd, @liquidityUsd, @holderCount,
       @top10HolderPct, @mintAuthorityActive, @freezeAuthorityActive, @lpBurnedPct,
       @chainStateAt, @holderCountAt, @schemaVersion)`
  ).run({
    ...s,
    mintAuthorityActive: s.mintAuthorityActive === null ? null : Number(s.mintAuthorityActive),
    freezeAuthorityActive: s.freezeAuthorityActive === null ? null : Number(s.freezeAuthorityActive),
    schemaVersion: SCHEMA_VERSION,
  });
}

/** Fill in the pool once it has been resolved from the launch transaction. */
export function setTokenPool(mint: string, pool: string): void {
  db.prepare(`UPDATE tokens SET pool = ? WHERE mint = ? AND pool IS NULL`).run(pool, mint);
}

export interface SwapRow {
  mint: string | null;
  pool: string | null;
  venue: string;
  signature: string | null;
  slot: number | null;
  side: "buy" | "sell";
  solAmount: number;
  tokenAmount: number;
  wallet: string;
  chainTs: number | null;
  observedAt: number;
}

const insertSwapStmt = db.prepare(
  `INSERT INTO swaps (mint, pool, venue, signature, slot, side, sol_amount, token_amount, wallet, chain_ts, observed_at)
   VALUES (@mint, @pool, @venue, @signature, @slot, @side, @solAmount, @tokenAmount, @wallet, @chainTs, @observedAt)`
);

/** Batched: swap bursts arrive many-per-transaction and per-row commits hurt. */
export const saveSwaps = db.transaction((rows: SwapRow[]) => {
  for (const r of rows) insertSwapStmt.run(r);
});

/**
 * A pool's first swaps arrive before we have resolved pool -> mint, so those
 * rows land with a null mint and are stitched up here.
 */
export function backfillSwapMint(pool: string, mint: string): number {
  return db.prepare(`UPDATE swaps SET mint = ? WHERE pool = ? AND mint IS NULL`).run(mint, pool).changes;
}

export interface BucketRow {
  mint: string;
  bucketStart: number;
  trades: number;
  buys: number;
  sells: number;
  solIn: number;
  solOut: number;
  distinctBuyers: number;
  newBuyers: number;
  cumulativeBuyers: number;
  buyersWhoAlsoSold: number;
}

export function saveBucket(b: BucketRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO swap_buckets
       (mint, bucket_start, trades, buys, sells, sol_in, sol_out,
        distinct_buyers, new_buyers, cumulative_buyers, buyers_who_also_sold)
     VALUES (@mint, @bucketStart, @trades, @buys, @sells, @solIn, @solOut,
        @distinctBuyers, @newBuyers, @cumulativeBuyers, @buyersWhoAlsoSold)`
  ).run(b);
}

export function saveRawEvent(kind: string, payload: unknown, mint: string | null, slot: number | null): void {
  db.prepare(
    `INSERT INTO raw_events (mint, kind, payload, slot, observed_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(mint, kind, JSON.stringify(payload), slot, Date.now());
}

export function saveAssessment(a: Assessment): void {
  db.prepare(
    `INSERT INTO assessments (mint, assessed_at, passed, total_score, results_json, config_hash, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    a.mint,
    a.assessedAt,
    Number(a.passed),
    a.totalScore,
    JSON.stringify(a.results),
    strategyHash,
    SCHEMA_VERSION
  );
}

/** True if this mint has been seen before (dedup across launch/graduation). */
export function tokenExists(mint: string): boolean {
  return db.prepare(`SELECT 1 FROM tokens WHERE mint = ?`).get(mint) !== undefined;
}

/**
 * When we first observed this mint. For a token whose bonding-curve launch we
 * recorded, the gap to its graduation is time on curve.
 */
export function tokenObservedAt(mint: string): number | null {
  const row = db.prepare(`SELECT observed_at AS t FROM tokens WHERE mint = ?`).get(mint) as
    | { t: number }
    | undefined;
  return row?.t ?? null;
}

/** Link a graduation to an already-recorded launch (never overwrites first observation). */
export function markGraduated(mint: string, signature: string, at: number): void {
  db.prepare(
    `UPDATE tokens SET graduated_at = ?, graduation_signature = ?
     WHERE mint = ? AND graduated_at IS NULL`
  ).run(at, signature, mint);
}

/**
 * When we last actually MESSAGED about this mint.
 *
 * Filters on notified=1 deliberately. Alerts are now recorded even when held
 * below the notify bar, and counting those would let a held-back row silence a
 * later genuine notification — a token whose liquidity and holder count improve
 * between the 180s and 600s assessments is exactly the case worth hearing
 * about.
 */
/** Fold a drained batch of credit usage into the daily totals. */
export const addCreditUsage = db.transaction(
  (day: string, rows: { source: string; bytes: number; calls: number; credits: number }[]) => {
    const stmt = db.prepare(
      `INSERT INTO credit_usage (day, source, bytes, calls, credits) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(day, source) DO UPDATE SET
         bytes = bytes + excluded.bytes,
         calls = calls + excluded.calls,
         credits = credits + excluded.credits`
    );
    for (const r of rows) stmt.run(day, r.source, r.bytes, r.calls, r.credits);
  }
);

/** Credits consumed so far this UTC month, and the breakdown by source. */
export function monthToDateCredits(monthPrefix: string): {
  total: number;
  bySource: Record<string, number>;
} {
  const rows = db
    .prepare(`SELECT source, SUM(credits) c FROM credit_usage WHERE day LIKE ? GROUP BY source`)
    .all(monthPrefix + "%") as { source: string; c: number }[];
  const bySource: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    bySource[r.source] = r.c;
    total += r.c;
  }
  return { total, bySource };
}

export function openIngestWindow(venues: string[], reason: string): number {
  const info = db
    .prepare(`INSERT INTO ingest_windows (opened_at, venues, reason) VALUES (?, ?, ?)`)
    .run(Date.now(), venues.join(","), reason);
  return Number(info.lastInsertRowid);
}

export function closeIngestWindow(id: number): void {
  db.prepare(`UPDATE ingest_windows SET closed_at = ? WHERE id = ? AND closed_at IS NULL`).run(
    Date.now(),
    id
  );
}

export function lastAlertAt(mint: string): number | null {
  const row = db
    .prepare(`SELECT MAX(created_at) AS t FROM alerts WHERE mint = ? AND notified = 1`)
    .get(mint) as { t: number | null };
  return row?.t ?? null;
}

/** Returns the new alert's rowid, which quotes.alert_id references. */
export function saveAlert(a: Alert, notified: boolean): number {
  const info = db
    .prepare(
      `INSERT INTO alerts (mint, created_at, severity, title, body, notified) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(a.mint, a.createdAt, a.severity, a.title, a.body, notified ? 1 : 0);
  return Number(info.lastInsertRowid);
}

export interface QuoteRow {
  alertId: number;
  mint: string;
  side: "buy" | "sell";
  horizonMin: number;
  inMint: string;
  outMint: string;
  inAmount: string | null;
  outAmount: string | null;
  priceImpactPct: number | null;
  route: string | null;
  slippageBps: number | null;
  latencyMs: number | null;
  ok: boolean;
  error: string | null;
  observedAt: number;
}

export function saveQuote(q: QuoteRow): void {
  db.prepare(
    `INSERT OR IGNORE INTO quotes
       (alert_id, mint, side, horizon_min, in_mint, out_mint, in_amount, out_amount,
        price_impact_pct, route, slippage_bps, latency_ms, ok, error, observed_at)
     VALUES (@alertId, @mint, @side, @horizonMin, @inMint, @outMint, @inAmount, @outAmount,
        @priceImpactPct, @route, @slippageBps, @latencyMs, @okInt, @error, @observedAt)`
  ).run({ ...q, okInt: q.ok ? 1 : 0 });
}

export interface DueHorizon {
  alertId: number;
  mint: string;
  horizonMin: number;
  /** The entry position size to price: outAmount of that alert's buy quote. */
  tokenAmount: string;
}

/**
 * Alerts whose exit horizon has come due and which have no quote row for it.
 *
 * Derived from the alerts table rather than an in-memory timer set or a job
 * queue: horizons run to 240 min, far longer than the process typically goes
 * without a restart, and this is restart-safe by construction.
 *
 * Joins to the entry quote because the sell must price THAT alert's position
 * (0.5 SOL worth at alert time) — a fixed token amount would make the series
 * incomparable across tokens. Alerts whose entry quote failed have no position
 * to price and are skipped by the inner join.
 */
export function dueHorizons(horizons: number[], now: number, limit: number): DueHorizon[] {
  if (horizons.length === 0) return [];
  // SQLite names VALUES columns "column1"; alias it so the join reads clearly.
  const horizonRows = horizons.map(() => "(?)").join(",");
  return db
    .prepare(
      `SELECT a.id AS alertId, a.mint AS mint, h.horizonMin AS horizonMin,
              q.out_amount AS tokenAmount
         FROM alerts a
         JOIN quotes q
           ON q.alert_id = a.id AND q.side = 'buy' AND q.horizon_min = 0 AND q.ok = 1
         JOIN (SELECT column1 AS horizonMin FROM (VALUES ${horizonRows})) h
         LEFT JOIN quotes done
           ON done.alert_id = a.id AND done.side = 'sell' AND done.horizon_min = h.horizonMin
        WHERE done.id IS NULL
          AND a.created_at + h.horizonMin * 60000 <= ?
          -- Do not chase horizons from days ago after a long outage.
          AND a.created_at > ? - 86400000
        ORDER BY a.created_at
        LIMIT ?`
    )
    .all(...horizons, now, now, limit) as DueHorizon[];
}
