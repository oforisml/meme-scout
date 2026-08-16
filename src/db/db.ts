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

export function saveToken(t: TokenLaunch): void {
  db.prepare(
    `INSERT OR IGNORE INTO tokens (mint, pool, creator, source, kind, first_signature, first_slot, observed_at)
     VALUES (@mint, @pool, @creator, @source, @kind, @signature, @slot, @observedAt)`
  ).run(t);
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

/** Link a graduation to an already-recorded launch (never overwrites first observation). */
export function markGraduated(mint: string, signature: string, at: number): void {
  db.prepare(
    `UPDATE tokens SET graduated_at = ?, graduation_signature = ?
     WHERE mint = ? AND graduated_at IS NULL`
  ).run(at, signature, mint);
}

export function lastAlertAt(mint: string): number | null {
  const row = db.prepare(`SELECT MAX(created_at) AS t FROM alerts WHERE mint = ?`).get(mint) as { t: number | null };
  return row?.t ?? null;
}

export function saveAlert(a: Alert): void {
  db.prepare(
    `INSERT INTO alerts (mint, created_at, severity, title, body) VALUES (?, ?, ?, ?, ?)`
  ).run(a.mint, a.createdAt, a.severity, a.title, a.body);
}
