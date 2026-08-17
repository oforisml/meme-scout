import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyQuotaResponse,
  EXHAUSTED_BACKOFF_MS,
  looksRateLimited,
  reconnectDelay,
  shouldProbeQuota,
} from "../src/ingest/quota.js";

test("the real exhaustion response is recognised", () => {
  // Verbatim from the live endpoint on 2026-08-17, which is the whole point:
  // Helius says it in plain words and nothing was reading them.
  assert.equal(classifyQuotaResponse(200, "max usage reached"), "exhausted");
});

test("a healthy response is ok", () => {
  assert.equal(classifyQuotaResponse(200, '{"jsonrpc":"2.0","result":362817263,"id":1}'), "ok");
});

test("status alone is not the signal", () => {
  // Helius returns "max usage reached" with a 200 on some paths, so a
  // status-only classifier would call an exhausted account healthy.
  assert.equal(classifyQuotaResponse(200, "max usage reached"), "exhausted");
  assert.equal(classifyQuotaResponse(429, "slow down"), "exhausted");
});

test("an auth failure is NOT reported as exhausted", () => {
  // A revoked or wrong key needs a different fix entirely; mislabelling it
  // would send the operator to the billing page for a config problem.
  assert.equal(classifyQuotaResponse(401, "unauthorized"), "unknown");
  assert.equal(classifyQuotaResponse(403, "forbidden"), "unknown");
});

test("an unrecognised response stays unknown rather than guessing", () => {
  assert.equal(classifyQuotaResponse(500, "bad gateway"), "unknown");
  assert.equal(classifyQuotaResponse(200, ""), "unknown");
});

test("a 429 on the socket is what triggers a probe", () => {
  assert.equal(looksRateLimited("Unexpected server response: 429"), true);
  assert.equal(looksRateLimited("Too Many Requests"), true);
  assert.equal(looksRateLimited("socket hang up"), false);
  // Must not fire on an unrelated number that happens to contain 429.
  assert.equal(looksRateLimited("slot 1429300 processed"), false);
});

test("an exhausted allowance backs off to 15 minutes, not 30 seconds", () => {
  // 30s retries against a spent monthly allowance produced ~2,880 useless
  // reconnects a day and buried every other log line.
  assert.equal(reconnectDelay(30_000, "exhausted"), EXHAUSTED_BACKOFF_MS);
  assert.equal(reconnectDelay(30_000, "ok"), 30_000);
  // Unknown must keep the normal backoff — a failed probe is not evidence.
  assert.equal(reconnectDelay(2_000, "unknown"), 2_000);
});

test("the probe is rate limited, because it costs a credit when there are any", () => {
  const now = Date.now();
  assert.equal(shouldProbeQuota(null, now), true);
  assert.equal(shouldProbeQuota(now - 60_000, now), false);
  assert.equal(shouldProbeQuota(now - 6 * 60_000, now), true);
});
