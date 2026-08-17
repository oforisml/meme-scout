import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALIVE_PING_MS,
  STALL_AFTER_MS,
  type Counters,
  evaluateStall,
  formatAlivePing,
  shouldForceReconnect,
  shouldRealertStall,
  shouldSendAlivePing,
  windowDelta,
} from "../src/ops/heartbeat.js";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

// ---- stall detection --------------------------------------------------------
test("a live feed is not stalled", () => {
  assert.equal(evaluateStall(NOW - 30_000, NOW).stalled, false);
});

test("ten minutes of silence is a stall", () => {
  const v = evaluateStall(NOW - 11 * MIN, NOW);
  assert.equal(v.stalled, true);
  assert.equal(Math.round(v.silentMinutes), 11);
});

test("the stall boundary is exactly the documented threshold", () => {
  assert.equal(evaluateStall(NOW - STALL_AFTER_MS + 1, NOW).stalled, false);
  assert.equal(evaluateStall(NOW - STALL_AFTER_MS - 1, NOW).stalled, true);
});

test("FR-G2 AC: a killed websocket alerts within 12 minutes", () => {
  // The heartbeat ticks every 60s, so detection lands at 10-11 min, inside
  // the 12 minute acceptance window with a minute to spare.
  assert.equal(evaluateStall(NOW - 12 * MIN, NOW).stalled, true);
  assert.ok(STALL_AFTER_MS + MIN < 12 * MIN, "detection + one tick must fit inside 12 minutes");
});

// ---- re-arm -----------------------------------------------------------------
test("first stall alert fires, repeats are suppressed", () => {
  assert.equal(shouldRealertStall(null, NOW), true);
  assert.equal(shouldRealertStall(NOW - MIN, NOW), false);
});

test("a persistent stall re-alerts after the window", () => {
  assert.equal(shouldRealertStall(NOW - 31 * MIN, NOW), true);
});

// ---- daily alive ping -------------------------------------------------------
test("alive ping fires once a day, not sooner", () => {
  assert.equal(shouldSendAlivePing(NOW - 23 * 3_600_000, NOW), false);
  assert.equal(shouldSendAlivePing(NOW - ALIVE_PING_MS, NOW), true);
});

test("the ping reports the window, not cumulative totals", () => {
  // Otherwise "did anything happen today?" is unanswerable at a glance.
  const prev: Counters = { rawOnly: 1000, fullPipeline: 100, passed: 10, alerted: 5, cooldownSuppressed: 2, metaSuppressed: 1 };
  const now: Counters = { rawOnly: 1500, fullPipeline: 140, passed: 13, alerted: 6, cooldownSuppressed: 4, metaSuppressed: 7 };
  assert.deepEqual(windowDelta(now, prev), {
    rawOnly: 500, fullPipeline: 40, passed: 3, alerted: 1, cooldownSuppressed: 2, metaSuppressed: 6,
  });
});

test("the ping body carries the numbers an operator would check", () => {
  const d: Counters = { rawOnly: 53000, fullPipeline: 2600, passed: 210, alerted: 190, cooldownSuppressed: 20, metaSuppressed: 3 };
  const body = formatAlivePing(d, 24.5, { backup: "last backup 3.0h ago" });
  assert.match(body, /Alive\. Up 24\.5h/);
  assert.match(body, /launches recorded : 53000/);
  assert.match(body, /alerts sent {7}: 190/);
  assert.match(body, /backup {12}: last backup 3\.0h ago/);
  assert.match(body, /meta-COLD held {4}: 3/);
});

// ---- healing ---------------------------------------------------------------
test("reconnect is rate-limited independently of alerting", () => {
  // Healing should be more eager than nagging, but not every 60s tick.
  assert.equal(shouldForceReconnect(null, NOW), true);
  assert.equal(shouldForceReconnect(NOW - MIN, NOW), false);
  assert.equal(shouldForceReconnect(NOW - 6 * MIN, NOW), true);
  // ...and more eager than the 30 min alert re-arm.
  assert.equal(shouldRealertStall(NOW - 6 * MIN, NOW), false);
});

// ---- dead-man clock survives a restart --------------------------------------
import { seedLastEventAt } from "../src/ops/heartbeat.js";

test("a restart during an outage keeps counting instead of forgiving it", () => {
  // The 2026-08-16 failure: ingest died, the process restarted 15 min later,
  // lastEventAt reset to now, and the 10-minute timer never elapsed.
  const outageStart = NOW - 25 * MIN;
  const freshProcess = NOW;                       // what a new process sets
  const seeded = seedLastEventAt(freshProcess, outageStart, NOW);
  assert.equal(seeded, outageStart);
  assert.equal(evaluateStall(seeded, NOW).stalled, true, "the outage must still register");
});

test("a healthy restart is not made to look stalled", () => {
  const recent = NOW - 30_000;
  assert.equal(evaluateStall(seedLastEventAt(NOW, recent, NOW), NOW).stalled, false);
});

test("no persisted value falls back to the in-memory clock", () => {
  assert.equal(seedLastEventAt(NOW, null, NOW), NOW);
  assert.equal(seedLastEventAt(NOW, NaN, NOW), NOW);
});

test("a future timestamp is ignored rather than trusted", () => {
  // Clock skew or a restored backup must not push the clock forward and mask
  // a real outage.
  assert.equal(seedLastEventAt(NOW - 20 * MIN, NOW + 60 * MIN, NOW), NOW - 20 * MIN);
});
