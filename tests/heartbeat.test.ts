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
  const prev: Counters = { rawOnly: 1000, fullPipeline: 100, passed: 10, alerted: 5, cooldownSuppressed: 2 };
  const now: Counters = { rawOnly: 1500, fullPipeline: 140, passed: 13, alerted: 6, cooldownSuppressed: 4 };
  assert.deepEqual(windowDelta(now, prev), {
    rawOnly: 500, fullPipeline: 40, passed: 3, alerted: 1, cooldownSuppressed: 2,
  });
});

test("the ping body carries the numbers an operator would check", () => {
  const d: Counters = { rawOnly: 53000, fullPipeline: 2600, passed: 210, alerted: 190, cooldownSuppressed: 20 };
  const body = formatAlivePing(d, 24.5, { backup: "last backup 3.0h ago" });
  assert.match(body, /Alive\. Up 24\.5h/);
  assert.match(body, /launches recorded : 53000/);
  assert.match(body, /alerts sent {7}: 190/);
  assert.match(body, /backup {12}: last backup 3\.0h ago/);
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
