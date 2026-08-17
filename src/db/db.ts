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
 * v3 — FR-J1. A COLD meta state can now suppress Telegram delivery, so
 *      `alerts.notified = 0` no longer implies "below the notify bar" —
 *      Phase 3 must read the reason, not infer it.
 */
export const SCHEMA_VERSION = 3;

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

// Notifications actually received during a coverage window. A window with zero
// events is a BLIND period, not a quiet market — the distinction Phase 3 needs
// and the one the credit outage made concrete.
addColumnIfMissing("ingest_windows", "events", "INTEGER NOT NULL DEFAULT 0");

// Why delivery was withheld (FR-J1). Rows written before the meta gauge that
// have notified = 0 were all held by the notify bar, which is the only reason
// that existed then — but they are left NULL rather than backfilled with a
// guess, so "unrecorded" stays distinguishable from "recorded as the bar".
addColumnIfMissing("alerts", "suppressed_by", "TEXT");

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

/**
 * Operational state that must outlive the process.
 *
 * Anything the dead-man switch depends on belongs here: state held only in
 * memory makes a crash-restart look like a healthy start, which is the one
 * failure mode a dead-man switch exists to rule out.
 */
export function setOpsState(key: string, value: string): void {
  db.prepare(
    `INSERT INTO ops_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, Date.now());
}

export function getOpsState(key: string): string | null {
  const row = db.prepare(`SELECT value FROM ops_state WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/**
 * Raw bytes streamed on a given UTC day, read straight from the stored byte
 * counts rather than derived from credits — the byte ceiling must not inherit
 * the credit conversion's assumptions. Persisted, so a restart cannot reset
 * the day's tally.
 */
export function bytesOnDay(day: string): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(bytes),0) b FROM credit_usage WHERE day = ?`)
    .get(day) as { b: number };
  return row?.b ?? 0;
}

export function openIngestWindow(venues: string[], reason: string): number {
  const info = db
    .prepare(`INSERT INTO ingest_windows (opened_at, venues, reason) VALUES (?, ?, ?)`)
    .run(Date.now(), venues.join(","), reason);
  return Number(info.lastInsertRowid);
}

/**
 * Advance a window's "observed through" mark.
 *
 * closed_at is maintained as a heartbeat rather than written once at shutdown:
 * a crash or a `pm2 restart` never runs a shutdown hook, and the first five
 * windows recorded were all left dangling as a result — claiming coverage that
 * ran to infinity. Updating it every tick means a hard kill still leaves an
 * accurate window, wrong by at most one heartbeat.
 */
export function touchIngestWindow(id: number, events: number): void {
  db.prepare(`UPDATE ingest_windows SET closed_at = ?, events = ? WHERE id = ?`).run(
    Date.now(),
    events,
    id
  );
}

export function closeIngestWindow(id: number, events = 0): void {
  db.prepare(`UPDATE ingest_windows SET closed_at = ?, events = ? WHERE id = ?`).run(
    Date.now(),
    events,
    id
  );
}

/** Coverage windows overlapping a period, for "were we even looking?". */
export function ingestCoverage(sinceMs: number): {
  openedAt: number;
  closedAt: number | null;
  events: number;
  venues: string;
}[] {
  return db
    .prepare(
      `SELECT opened_at AS openedAt, closed_at AS closedAt, events, venues
         FROM ingest_windows
        WHERE COALESCE(closed_at, opened_at) >= ?
        ORDER BY opened_at`
    )
    .all(sinceMs) as any;
}

export function lastAlertAt(mint: string): number | null {
  const row = db
    .prepare(`SELECT MAX(created_at) AS t FROM alerts WHERE mint = ? AND notified = 1`)
    .get(mint) as { t: number | null };
  return row?.t ?? null;
}

/**
 * Returns the new alert's rowid, which quotes.alert_id references.
 *
 * `suppressedBy` names WHY delivery was withheld. Before FR-J1 there was only
 * one reason, so `notified = 0` meant "below the notify bar" unambiguously.
 * Now a COLD meta state can withhold a candidate that cleared the bar, and
 * Phase 3 has to be able to tell those apart rather than infer.
 */
export function saveAlert(a: Alert, notified: boolean, suppressedBy: string | null = null): number {
  const info = db
    .prepare(
      `INSERT INTO alerts (mint, created_at, severity, title, body, notified, suppressed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(a.mint, a.createdAt, a.severity, a.title, a.body, notified ? 1 : 0, notified ? null : suppressedBy);
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

// ---- FR-J1 meta gauge ----------------------------------------------------

/**
 * The raw daily counts the gauge turns into rates.
 *
 * One statement per number rather than a single wide join, because the four
 * are over different tables with different time columns and a join would need
 * outer joins in three directions to keep a zero from vanishing.
 *
 * `cohortMinAgeMs` is what removes the same-day graduation bias: a token
 * launched at 20:00 has not had time to graduate before midnight, so counting
 * it in the denominator understates the rate and pushes the gauge toward a
 * false COLD.
 */
export function metaDayRows(
  dayStart: number,
  dayEnd: number,
  now: number,
  cohortMinAgeMs: number
): {
  launchesByVenue: Record<string, number>;
  cohortLaunches: number;
  cohortGraduated: number;
  graduationsInDay: number;
  pumpswapSol: number;
} {
  const launchRows = db
    .prepare(
      `SELECT source, COUNT(*) AS n FROM tokens
        WHERE kind = 'launch' AND observed_at >= ? AND observed_at < ?
        GROUP BY source`
    )
    .all(dayStart, dayEnd) as { source: string; n: number }[];

  const launchesByVenue: Record<string, number> = {};
  for (const r of launchRows) launchesByVenue[r.source] = r.n;

  // The mature cohort: launched in this day AND old enough by now to have had
  // a fair chance. graduated_at is not restricted to the day — a token that
  // launched at 09:00 and graduated at 02:00 the next morning still counts.
  const cohort = db
    .prepare(
      `SELECT COUNT(*) AS launches, SUM(graduated_at IS NOT NULL) AS graduated
         FROM tokens
        WHERE kind = 'launch' AND observed_at >= ? AND observed_at < ?
          AND observed_at <= ?`
    )
    .get(dayStart, dayEnd, now - cohortMinAgeMs) as { launches: number; graduated: number | null };

  const grads = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tokens
        WHERE graduated_at >= ? AND graduated_at < ?`
    )
    .get(dayStart, dayEnd) as { n: number };

  const vol = db
    .prepare(
      `SELECT COALESCE(SUM(ABS(sol_amount)), 0) AS sol FROM swaps
        WHERE venue = 'pumpswap' AND chain_ts >= ? AND chain_ts < ?`
    )
    .get(dayStart, dayEnd) as { sol: number };

  return {
    launchesByVenue,
    cohortLaunches: cohort?.launches ?? 0,
    cohortGraduated: cohort?.graduated ?? 0,
    graduationsInDay: grads?.n ?? 0,
    pumpswapSol: vol?.sol ?? 0,
  };
}

export interface MetaDayRow {
  day: string;
  coveredHours: number;
  launchRateByVenue: Record<string, number>;
  totalLaunchRate: number;
  venueShare: Record<string, number>;
  sameDayGradRatio: number | null;
  cohortGradRate: number | null;
  pumpswapSolPerHour: number;
  solUsd: number | null;
  solTrendPct: number | null;
  state: string;
  abstained: string[];
  reasons: string[];
  computedAt: number;
}

/** Upsert, because the tick recomputes the current day every time it runs. */
export function saveMetaDay(r: MetaDayRow): void {
  db.prepare(
    `INSERT INTO meta_daily
       (day, covered_hours, launch_rate_by_venue, total_launch_rate, venue_share,
        same_day_grad_ratio, cohort_grad_rate, pumpswap_sol_per_hour,
        sol_usd, sol_trend_pct, state, abstained, reasons, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET
       covered_hours = excluded.covered_hours,
       launch_rate_by_venue = excluded.launch_rate_by_venue,
       total_launch_rate = excluded.total_launch_rate,
       venue_share = excluded.venue_share,
       same_day_grad_ratio = excluded.same_day_grad_ratio,
       cohort_grad_rate = excluded.cohort_grad_rate,
       pumpswap_sol_per_hour = excluded.pumpswap_sol_per_hour,
       -- A day's SOL price is the first reading taken in it; later ticks must
       -- not overwrite it with an intraday move, or the trend measures noise.
       sol_usd = COALESCE(meta_daily.sol_usd, excluded.sol_usd),
       sol_trend_pct = excluded.sol_trend_pct,
       state = excluded.state,
       abstained = excluded.abstained,
       reasons = excluded.reasons,
       computed_at = excluded.computed_at`
  ).run(
    r.day,
    r.coveredHours,
    JSON.stringify(r.launchRateByVenue),
    r.totalLaunchRate,
    JSON.stringify(r.venueShare),
    r.sameDayGradRatio,
    r.cohortGradRate,
    r.pumpswapSolPerHour,
    r.solUsd,
    r.solTrendPct,
    r.state,
    JSON.stringify(r.abstained),
    JSON.stringify(r.reasons),
    r.computedAt
  );
}

function hydrate(row: any): MetaDayRow {
  return {
    day: row.day,
    coveredHours: row.covered_hours,
    launchRateByVenue: JSON.parse(row.launch_rate_by_venue),
    totalLaunchRate: row.total_launch_rate,
    venueShare: JSON.parse(row.venue_share),
    sameDayGradRatio: row.same_day_grad_ratio,
    cohortGradRate: row.cohort_grad_rate,
    pumpswapSolPerHour: row.pumpswap_sol_per_hour,
    solUsd: row.sol_usd,
    solTrendPct: row.sol_trend_pct,
    state: row.state,
    abstained: JSON.parse(row.abstained),
    reasons: JSON.parse(row.reasons),
    computedAt: row.computed_at,
  };
}

/** Most recent first. Feeds AC2 — venue market share over time. */
export function metaDays(limit: number): MetaDayRow[] {
  return (
    db.prepare(`SELECT * FROM meta_daily ORDER BY day DESC LIMIT ?`).all(limit) as any[]
  ).map(hydrate);
}

export function latestMetaDay(): MetaDayRow | null {
  const row = db.prepare(`SELECT * FROM meta_daily ORDER BY day DESC LIMIT 1`).get() as any;
  return row ? hydrate(row) : null;
}

/**
 * SOL closing prices, oldest first, for the trend window.
 *
 * Days with no recorded price are skipped rather than interpolated: a gap
 * means the recorder was down, and inventing a price to fill it would put a
 * fabricated number into a signal that can silence alerts.
 *
 * Excludes `beforeDay` so the caller can append today's live price without
 * double-counting the row it is about to upsert.
 */
export function solPriceSeries(days: number, beforeDay: string): number[] {
  const rows = db
    .prepare(
      `SELECT sol_usd FROM meta_daily
        WHERE sol_usd IS NOT NULL AND day < ?
        ORDER BY day DESC LIMIT ?`
    )
    .all(beforeDay, days) as { sol_usd: number }[];
  return rows.map((r) => r.sol_usd).reverse();
}
