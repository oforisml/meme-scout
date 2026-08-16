import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Point the DB at a throwaway file BEFORE importing db.ts, which opens
// config.DB_PATH at import time.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "scout-horizons-")), "test.db");
const { db, dueHorizons, saveQuote } = await import("../src/db/db.js");

const HORIZONS = [15, 60, 240];
const MIN = 60_000;
const NOW = 1_800_000_000_000;

function alertAt(mint: string, createdAt: number): number {
  const info = db
    .prepare(`INSERT INTO alerts (mint, created_at, severity, title, body) VALUES (?,?,?,?,?)`)
    .run(mint, createdAt, "high", "t", "b");
  return Number(info.lastInsertRowid);
}

function entryQuote(alertId: number, mint: string, ok: boolean, outAmount = "1000000"): void {
  saveQuote({
    alertId, mint, side: "buy", horizonMin: 0, inMint: "SOL", outMint: mint,
    inAmount: "500000000", outAmount: ok ? outAmount : null,
    priceImpactPct: ok ? 0.3 : null, route: "Pump.fun Amm", slippageBps: 100,
    latencyMs: 400, ok, error: ok ? null : "http 429", observedAt: NOW,
  });
}

test("a 16-minute-old alert is due for 15 but not 60", () => {
  const id = alertAt("A", NOW - 16 * MIN);
  entryQuote(id, "A", true);
  const due = dueHorizons(HORIZONS, NOW, 50).filter((d) => d.alertId === id);
  assert.deepEqual(due.map((d) => d.horizonMin), [15]);
});

test("the sell prices THAT alert's position, not a fixed amount", () => {
  const id = alertAt("B", NOW - 16 * MIN);
  entryQuote(id, "B", true, "123456789");
  const due = dueHorizons(HORIZONS, NOW, 50).find((d) => d.alertId === id)!;
  // A fixed token amount would make the horizon series incomparable across
  // tokens, since every token has a different supply and price.
  assert.equal(due.tokenAmount, "123456789");
});

test("an already-quoted horizon is not selected again", () => {
  const id = alertAt("C", NOW - 16 * MIN);
  entryQuote(id, "C", true);
  assert.equal(dueHorizons(HORIZONS, NOW, 50).filter((d) => d.alertId === id).length, 1);

  saveQuote({
    alertId: id, mint: "C", side: "sell", horizonMin: 15, inMint: "C", outMint: "SOL",
    inAmount: "1000000", outAmount: "490000000", priceImpactPct: 0.4, route: "r",
    slippageBps: 100, latencyMs: 300, ok: true, error: null, observedAt: NOW,
  });
  assert.equal(dueHorizons(HORIZONS, NOW, 50).filter((d) => d.alertId === id).length, 0);
});

test("an alert whose entry quote failed is skipped — there is no position to price", () => {
  const id = alertAt("D", NOW - 16 * MIN);
  entryQuote(id, "D", false);
  assert.equal(dueHorizons(HORIZONS, NOW, 50).filter((d) => d.alertId === id).length, 0);
});

test("an alert with no entry quote at all is skipped", () => {
  const id = alertAt("E", NOW - 16 * MIN);
  assert.equal(dueHorizons(HORIZONS, NOW, 50).filter((d) => d.alertId === id).length, 0);
});

test("a mint alerted twice keeps two independent horizon series", () => {
  // The cooldown is 60 min but horizons run to 240, so overlapping windows are
  // legitimate. Keying the unique index on mint would silently drop the second.
  const first = alertAt("F", NOW - 90 * MIN);
  entryQuote(first, "F", true, "111");
  const second = alertAt("F", NOW - 20 * MIN);
  entryQuote(second, "F", true, "222");

  const due = dueHorizons(HORIZONS, NOW, 50).filter((d) => d.mint === "F");
  const firstDue = due.filter((d) => d.alertId === first).map((d) => d.horizonMin).sort((a, b) => a - b);
  const secondDue = due.filter((d) => d.alertId === second).map((d) => d.horizonMin);
  assert.deepEqual(firstDue, [15, 60], "the older alert is due for both 15 and 60");
  assert.deepEqual(secondDue, [15], "the newer alert is only due for 15");
  assert.equal(due.find((d) => d.alertId === second)!.tokenAmount, "222");
});

test("nothing is due before the first horizon elapses", () => {
  const id = alertAt("G", NOW - 5 * MIN);
  entryQuote(id, "G", true);
  assert.equal(dueHorizons(HORIZONS, NOW, 50).filter((d) => d.alertId === id).length, 0);
});

test("the batch cap is respected so a backlog cannot burst the rate limit", () => {
  for (let i = 0; i < 12; i++) {
    const id = alertAt("H" + i, NOW - 16 * MIN);
    entryQuote(id, "H" + i, true);
  }
  assert.equal(dueHorizons(HORIZONS, NOW, 5).length, 5);
});

test("horizons from days ago are not chased after a long outage", () => {
  const id = alertAt("I", NOW - 3 * 24 * 3_600_000);
  entryQuote(id, "I", true);
  assert.equal(dueHorizons(HORIZONS, NOW, 50).filter((d) => d.alertId === id).length, 0);
});
