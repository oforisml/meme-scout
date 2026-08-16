/**
 * One-off: recover pump.fun launches from already-stored raw_events logs.
 *
 * Before the retention change, tier-1 pump.fun launches were written to
 * raw_events as a 7.5 KB log array with a null mint — unqueryable, and 89% of
 * the database. Those rows still contain their logs, so the launches inside
 * them can be decoded into real `tokens` rows rather than discarded.
 *
 * This is ADDITIVE ONLY. It never updates or deletes an existing row: NFR-1
 * says no stored observation may be overwritten or backfilled, and reclaiming
 * the ~30 MB already on disk is not worth trading that guarantee for. Growth
 * is what mattered, and that is fixed going forward.
 *
 *   npx tsx scripts/backfill-raw-events.ts          # dry run (default)
 *   npx tsx scripts/backfill-raw-events.ts --write  # actually insert
 *
 * Stop the recorder first — SQLite takes one writer.
 */
import { db, saveToken } from "../src/db/db.js";
import { decodeCreateEvent, pumpFunDecodeFailures } from "../src/ingest/pumpfun.js";
import type { TokenLaunch } from "../src/types.js";

const WRITE = process.argv.includes("--write");

const rows = db
  .prepare(`SELECT kind, payload, slot, observed_at FROM raw_events WHERE kind LIKE 'pumpfun%'`)
  .all() as { kind: string; payload: string; slot: number | null; observed_at: number }[];

console.log(`scanning ${rows.length} pump.fun raw_events rows (${WRITE ? "WRITE" : "dry run"})\n`);

let decoded = 0;
let notLaunch = 0;
let alreadyPresent = 0;
let inserted = 0;
let unparseable = 0;
const latencies: number[] = [];

const exists = db.prepare(`SELECT 1 FROM tokens WHERE mint = ?`);

for (const row of rows) {
  let logs: string[];
  try {
    logs = JSON.parse(row.payload).logs ?? [];
  } catch {
    unparseable++;
    continue;
  }

  const created = decodeCreateEvent(logs);
  if (!created) {
    notLaunch++;
    continue;
  }
  decoded++;
  if (created.chainTs) latencies.push((row.observed_at - created.chainTs) / 1000);

  if (exists.get(created.mint)) {
    alreadyPresent++;
    continue;
  }

  if (WRITE) {
    const launch: TokenLaunch = {
      mint: created.mint,
      pool: null,
      creator: created.creator,
      source: "pumpfun",
      kind: "launch",
      // The signature was not stored alongside these rows in a queryable
      // column, but the payload carries it.
      signature: safeSignature(row.payload),
      slot: row.slot ?? 0,
      // Preserve the ORIGINAL observation time. This is the whole point of
      // point-in-time discipline — do not stamp these with now().
      observedAt: row.observed_at,
      name: created.name,
      symbol: created.symbol,
      uri: created.uri,
      chainTs: created.chainTs,
    };
    saveToken(launch);
  }
  inserted++;
}

function safeSignature(payload: string): string {
  try {
    return JSON.parse(payload).signature ?? "";
  } catch {
    return "";
  }
}

latencies.sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.floor(latencies.length * p)]?.toFixed(1) ?? "n/a";

console.log(`decoded CreateEvents : ${decoded}`);
console.log(`not a launch (trades): ${notLaunch}`);
console.log(`unparseable payloads : ${unparseable}`);
console.log(`decode failures      : ${pumpFunDecodeFailures()}   <- must be 0`);
console.log(`already in tokens    : ${alreadyPresent}`);
console.log(`${WRITE ? "inserted" : "would insert"}         : ${inserted}`);
if (latencies.length) {
  console.log(`\nobservation latency vs chain (sec): p50 ${pct(0.5)} | p90 ${pct(0.9)}`);
}
if (!WRITE) console.log(`\ndry run — nothing written. Re-run with --write.`);
