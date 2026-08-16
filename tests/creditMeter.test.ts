import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CreditAccumulator,
  DAS_CREDITS,
  RPC_CREDITS,
  evaluateBudget,
  pickVenueToShed,
  shouldAlertBudget,
  utcDay,
  utcMonth,
} from "../src/ops/creditMeter.js";
import {
  CREDITS_PER_MB,
  PROFILES,
  bytesToCredits,
  projectMonthlyCredits,
  resolveVenues,
} from "../src/ingest/profile.js";

// ---- the arithmetic that was missing when the allowance ran out -------------
test("websocket bytes cost 20 credits per MB", () => {
  assert.equal(CREDITS_PER_MB, 20);
  assert.equal(bytesToCredits(1_000_000), 20);
  assert.equal(bytesToCredits(100_000), 2); // the documented 2 credits per 0.1 MB
});

test("the measured firehose really does exhaust a free tier in about ten hours", () => {
  // 118 GB/day measured across pump.fun + PumpSwap.
  const perDay = bytesToCredits(118 * 1e9);
  assert.ok(perDay > 2_000_000, `expected >2M credits/day, got ${perDay}`);
  const hoursToBurn1M = (1_000_000 / perDay) * 24;
  assert.ok(hoursToBurn1M > 8 && hoursToBurn1M < 13, `expected ~10h, got ${hoursToBurn1M.toFixed(1)}h`);
});

test("RPC and DAS calls are priced separately", () => {
  assert.equal(RPC_CREDITS, 1);
  assert.equal(DAS_CREDITS, 10);
});

// ---- accumulator ------------------------------------------------------------
test("accumulates per venue and drains to credits", () => {
  const a = new CreditAccumulator();
  a.stream("pumpfun", 500_000);
  a.stream("pumpfun", 500_000);
  a.stream("pumpswap", 2_000_000);
  a.rpc(3);
  a.das(2);

  const rows = a.drain();
  const bySource = Object.fromEntries(rows.map((r) => [r.source, r.credits]));
  assert.equal(bySource.pumpfun, 20, "1 MB -> 20 credits");
  assert.equal(bySource.pumpswap, 40);
  assert.equal(bySource.rpc, 3);
  assert.equal(bySource.das, 20);
});

test("drain clears the buffer so totals are not double counted", () => {
  const a = new CreditAccumulator();
  a.stream("pumpfun", 1_000_000);
  assert.equal(a.drain().length, 1);
  assert.equal(a.drain().length, 0);
});

test("accumulates in memory rather than per message", () => {
  // At ~437 notifications/sec a row per message would cost more than the
  // thing it measures.
  const a = new CreditAccumulator();
  for (let i = 0; i < 10_000; i++) a.stream("pumpfun", 100);
  assert.equal(a.pending, 1_000_000);
  assert.equal(a.drain().length, 1);
});

// ---- budget thresholds -------------------------------------------------------
test("budget levels trip at 50, 80 and 95 percent", () => {
  assert.equal(evaluateBudget(10, 100).level, "ok");
  assert.equal(evaluateBudget(50, 100).level, "warn50");
  assert.equal(evaluateBudget(80, 100).level, "warn80");
  assert.equal(evaluateBudget(95, 100).level, "critical95");
  assert.equal(evaluateBudget(1000, 100).level, "critical95");
});

test("an unconfigured budget does not raise alarms", () => {
  assert.equal(evaluateBudget(999, 0).level, "ok");
});

test("budget alerts re-arm rather than repeating every heartbeat", () => {
  const now = 1_800_000_000_000;
  assert.equal(shouldAlertBudget(null, now), true);
  assert.equal(shouldAlertBudget(now - 60_000, now), false);
  assert.equal(shouldAlertBudget(now - 7 * 3_600_000, now), true);
});

// ---- load shedding -----------------------------------------------------------
test("sheds the most expensive venue first", () => {
  const usage = { pumpswap: 60_000, pumpfun: 8_000, rpc: 500 };
  assert.equal(pickVenueToShed(usage, ["pumpfun", "pumpswap"]), "pumpswap");
});

test("never sheds the last remaining venue", () => {
  // Degraded ingest beats none; no ingest is just a slower outage.
  assert.equal(pickVenueToShed({ pumpfun: 99_999 }, ["pumpfun"]), null);
  assert.equal(pickVenueToShed({}, []), null);
});

// ---- profiles ----------------------------------------------------------------
test("business enables every venue; developer and free drop the PumpSwap firehose", () => {
  assert.equal(PROFILES.business.pumpswap, true);
  assert.equal(PROFILES.developer.pumpswap, false);
  assert.equal(PROFILES.free.pumpswap, false);
  // pump.fun stays on in every profile: it is what launches come from.
  for (const p of Object.values(PROFILES)) assert.equal(p.pumpfun, true);
});

test("custom leaves the configured toggles untouched", () => {
  const configured = { pumpfun: false, pumpswap: true, launchlab: true, raydium: false };
  assert.deepEqual(resolveVenues("custom", configured), configured);
  assert.notDeepEqual(resolveVenues("developer", configured), configured);
});

test("projection reflects why PumpSwap is the expensive one", () => {
  const full = projectMonthlyCredits(PROFILES.business).total;
  const dev = projectMonthlyCredits(PROFILES.developer).total;
  assert.ok(full > 60_000_000, `business should project >60M, got ${full}`);
  assert.ok(dev < 10_000_000, `developer should fit a 10M tier, got ${dev}`);
  assert.ok(full / dev > 5, "dropping PumpSwap should cut the bill several-fold");
});

test("unmeasured venues are reported rather than silently counted as zero", () => {
  const p = projectMonthlyCredits(PROFILES.business);
  assert.ok(p.unmeasured.includes("launchlab"));
  assert.ok(p.unmeasured.includes("raydium"));
});

// ---- date keys ---------------------------------------------------------------
test("day and month keys are UTC, not local", () => {
  const t = Date.UTC(2026, 7, 16, 23, 30);
  assert.equal(utcDay(t), "2026-08-16");
  assert.equal(utcMonth(t), "2026-08");
});

// ---- budget pacing (what makes the free profile honest) ---------------------
import { shouldPauseForBudget } from "../src/ops/creditMeter.js";

const MID_MONTH = Date.UTC(2026, 7, 16, 0, 0); // exactly halfway through August

test("pacing pauses when consumption runs ahead of the month", () => {
  // Half the month elapsed, so half the budget is the pace target.
  assert.equal(shouldPauseForBudget(600_000, 1_000_000, MID_MONTH).pause, true);
  assert.equal(shouldPauseForBudget(400_000, 1_000_000, MID_MONTH).pause, false);
});

test("the pace target tracks elapsed time, not calendar days", () => {
  const v = shouldPauseForBudget(0, 1_000_000, MID_MONTH);
  // 15 of 31 days elapsed at midnight on the 16th.
  assert.ok(Math.abs(v.paceTarget - 1_000_000 * (15 / 31)) < 1000, `got ${v.paceTarget}`);
});

test("burning the whole month in a day pauses almost immediately", () => {
  // This is the 2026-08-16 failure: ~2.36M credits/day against a 1M month.
  const dayTwo = Date.UTC(2026, 7, 2, 0, 0);
  assert.equal(shouldPauseForBudget(2_360_000, 1_000_000, dayTwo).pause, true);
});

test("an unconfigured budget never pauses ingest", () => {
  assert.equal(shouldPauseForBudget(9_999_999, 0, MID_MONTH).pause, false);
});

test("pacing resumes once the clock catches up", () => {
  const used = 500_000;
  assert.equal(shouldPauseForBudget(used, 1_000_000, Date.UTC(2026, 7, 10)).pause, true);
  assert.equal(shouldPauseForBudget(used, 1_000_000, Date.UTC(2026, 7, 20)).pause, false);
});

// ---- hard byte ceiling (backstop, independent of the credit rate) -----------
import { exceedsByteCeiling } from "../src/ops/creditMeter.js";

test("the ceiling trips on raw bytes, not on credits", () => {
  assert.equal(exceedsByteCeiling(1.9e9, 2).exceeded, false);
  assert.equal(exceedsByteCeiling(2.0e9, 2).exceeded, true);
  assert.equal(exceedsByteCeiling(50e9, 2).exceeded, true);
});

test("a wrong credit rate cannot defeat the ceiling", () => {
  // The whole point. Suppose Helius really bills 5x what we assume: the credit
  // meter would under-count and pacing would let the stream run. The byte
  // guard sees the same bytes either way and still stops.
  const bytesToday = 3e9;
  assert.equal(exceedsByteCeiling(bytesToday, 2).exceeded, true,
    "must trip on bytes regardless of any credits-per-MB assumption");
});

test("the measured firehose trips the default ceiling within the hour", () => {
  // 118 GB/day measured = ~4.9 GB/hour, against a 2 GB/day default.
  const bytesInOneHour = (118e9 / 24);
  assert.equal(exceedsByteCeiling(bytesInOneHour, 2).exceeded, true);
});

test("zero disables the ceiling rather than blocking everything", () => {
  // A 0 that meant "no bytes allowed" would silently stop all ingest.
  assert.equal(exceedsByteCeiling(999e9, 0).exceeded, false);
});

test("the reason states both the usage and the limit", () => {
  const v = exceedsByteCeiling(2.5e9, 2);
  assert.match(v.reason, /2\.50 GB/);
  assert.match(v.reason, /ceiling of 2 GB/);
  assert.equal(v.usedGb, 2.5);
});
