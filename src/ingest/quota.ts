/**
 * Telling "the allowance is gone" apart from "the socket is flaky".
 *
 * Both present identically at the websocket: an HTTP 429 on upgrade, then
 * silence. The recorder reconnected every 30 seconds for a day against an
 * exhausted Helius allowance, logging "reconnecting — socket closed" ~2,880
 * times and never once naming the actual cause, while the heartbeat reported
 * "no events — websocket may be stalled". Every word of that was true and
 * none of it was the problem.
 *
 * The distinction is cheap to make: the RPC endpoint answers in plain words.
 * A live key returns a result; an exhausted account returns "max usage
 * reached". So when the socket 429s, ask.
 *
 * This is the same principle as FR-G2 and the ingest_windows event count —
 * a monitoring system that cannot distinguish its own failure modes reports
 * silence and calls it information.
 */

export type QuotaState = "ok" | "exhausted" | "unknown";

/**
 * Classify a raw RPC response body.
 *
 * Deliberately string-matching the body rather than trusting a status code:
 * Helius answers "max usage reached" with a 200 in some paths and a 429 in
 * others, so the status alone is not the signal.
 */
export function classifyQuotaResponse(status: number, body: string): QuotaState {
  const text = body.toLowerCase();
  if (text.includes("max usage reached") || text.includes("credit limit") || text.includes("out of credits")) {
    return "exhausted";
  }
  // A 401/403 is a key problem, not a quota problem — do not mislabel it.
  if (status === 401 || status === 403) return "unknown";
  if (text.includes('"result"')) return "ok";
  if (status === 429) return "exhausted";
  return "unknown";
}

/** Whether a websocket failure looks like a rate/quota rejection worth probing. */
export function looksRateLimited(errMessage: string): boolean {
  return /\b429\b|too many requests/i.test(errMessage);
}

/**
 * Reconnect delay.
 *
 * An exhausted monthly allowance does not come back in thirty seconds — it
 * comes back at the billing reset. Hammering it changes nothing and buries
 * every other log line. Backing off to 15 minutes keeps the recorder ready to
 * resume the moment credits return, without pretending progress is possible.
 */
export const EXHAUSTED_BACKOFF_MS = 15 * 60_000;

export function reconnectDelay(normalBackoffMs: number, quota: QuotaState): number {
  return quota === "exhausted" ? EXHAUSTED_BACKOFF_MS : normalBackoffMs;
}

/** Probe at most this often — the probe itself costs a credit when there are any. */
export const QUOTA_PROBE_INTERVAL_MS = 5 * 60_000;

export function shouldProbeQuota(lastProbeAt: number | null, now: number): boolean {
  return lastProbeAt === null || now - lastProbeAt >= QUOTA_PROBE_INTERVAL_MS;
}
