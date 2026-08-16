import assert from "node:assert/strict";
import { test } from "node:test";
import { STALE_AFTER_MS, evaluateBackupState, shouldAlert } from "../src/ops/backupWatch.js";

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const LONG_UPTIME = NOW - 48 * H;

test("a recent backup is not stale", () => {
  const v = evaluateBackupState({ completedAt: NOW - 2 * H }, NOW, LONG_UPTIME, true);
  assert.equal(v.stale, false);
});

test("a backup older than 12h is stale", () => {
  const v = evaluateBackupState({ completedAt: NOW - 13 * H }, NOW, LONG_UPTIME, true);
  assert.equal(v.stale, true);
  assert.match(v.reason, /13\.0h ago/);
});

test("the boundary is 12h, not 12h-ish", () => {
  assert.equal(evaluateBackupState({ completedAt: NOW - STALE_AFTER_MS + 1 }, NOW, LONG_UPTIME, true).stale, false);
  assert.equal(evaluateBackupState({ completedAt: NOW - STALE_AFTER_MS - 1 }, NOW, LONG_UPTIME, true).stale, true);
});

test("no backup ever completed is a failure once past the grace period", () => {
  const v = evaluateBackupState(null, NOW, LONG_UPTIME, true);
  assert.equal(v.stale, true);
  assert.match(v.reason, /has ever completed/);
});

test("a fresh start does not alert before the grace period elapses", () => {
  // Otherwise every new clone screams before a backup could possibly have run.
  const v = evaluateBackupState(null, NOW, NOW - 5 * H, true);
  assert.equal(v.stale, false);
});

test("unconfigured backups are disabled, not failing", () => {
  const v = evaluateBackupState(null, NOW, LONG_UPTIME, false);
  assert.equal(v.stale, false);
  assert.match(v.reason, /not configured/);
});

test("a failed attempt names the step that broke", () => {
  const v = evaluateBackupState(
    { completedAt: NOW - 20 * H, lastAttemptAt: NOW - H, failedStep: "upload" },
    NOW, LONG_UPTIME, true
  );
  assert.equal(v.stale, true);
  assert.match(v.reason, /upload/, "the alert should say what broke, not just 'stale'");
});

test("a never-succeeded backup still reports the failing step", () => {
  const v = evaluateBackupState({ lastAttemptAt: NOW - H, failedStep: "integrity_check" }, NOW, LONG_UPTIME, true);
  assert.equal(v.stale, true);
  assert.match(v.reason, /integrity_check/);
});

// ---- re-arm ----------------------------------------------------------------
test("first alert always fires", () => {
  assert.equal(shouldAlert(null, NOW), true);
});

test("repeat alerts are suppressed within the re-arm window", () => {
  // A 60s heartbeat against a broken backup would otherwise send 720/day.
  assert.equal(shouldAlert(NOW - 60_000, NOW), false);
  assert.equal(shouldAlert(NOW - 2 * H, NOW), false);
});

test("alerts resume after the re-arm window", () => {
  assert.equal(shouldAlert(NOW - 7 * H, NOW), true);
});
