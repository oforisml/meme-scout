import { shouldRealert } from "./rearm.js";

/**
 * FR-G2 — heartbeat / dead-man switch.
 *
 * "The System shall track time-since-last-ingested-event and alert the
 * Operator if no events arrive for 10 minutes (websocket stall is otherwise
 * silent and indistinguishable from a quiet market). A daily 'alive + stats'
 * ping shall confirm end-to-end alert delivery."
 *
 * The daily ping is the half that is easy to dismiss as noise, and it is the
 * half that matters most: it is the only thing that distinguishes "nothing has
 * gone wrong" from "the alerting path itself is broken". Silence from a
 * monitoring system is not evidence of health.
 */

export const STALL_AFTER_MS = 10 * 60_000;
/** Re-alert cadence while a stall persists. */
const STALL_REARM_MS = 30 * 60_000;
export const ALIVE_PING_MS = 24 * 3_600_000;

export interface StallVerdict {
  stalled: boolean;
  silentMinutes: number;
}

export const LAST_EVENT_KEY = "lastEventAt";

/**
 * Where the stall clock should start after a restart.
 *
 * Takes the OLDER of the in-memory value and the persisted one. A fresh
 * process sets lastEventAt to now, which silently forgives however long the
 * recorder was actually blind — the exact reason a 22-minute outage on
 * 2026-08-16 produced no alert. Persisting it means a crash-restart during an
 * outage keeps counting instead of starting the clock over.
 *
 * A persisted value in the future (clock skew, a restored backup) is ignored
 * rather than trusted.
 */
export function seedLastEventAt(inMemory: number, persisted: number | null, now: number): number {
  if (persisted === null || !Number.isFinite(persisted)) return inMemory;
  if (persisted > now) return inMemory;
  return Math.min(inMemory, persisted);
}

export function evaluateStall(lastEventAt: number, now: number): StallVerdict {
  const silentMs = now - lastEventAt;
  return { stalled: silentMs > STALL_AFTER_MS, silentMinutes: silentMs / 60_000 };
}

export function shouldRealertStall(lastAlertedAt: number | null, now: number): boolean {
  return shouldRealert(lastAlertedAt, now, STALL_REARM_MS);
}

/**
 * Healing is rate-limited separately from alerting: reconnect more often than
 * we nag, but not on every 60s tick. `lastEventAt` is deliberately not reset
 * on connect, so a socket that opens and stays silent keeps reporting a stall
 * — this is what stops that from becoming a reconnect-per-minute loop.
 */
const RECONNECT_REARM_MS = 5 * 60_000;

export function shouldForceReconnect(lastReconnectAt: number | null, now: number): boolean {
  return shouldRealert(lastReconnectAt, now, RECONNECT_REARM_MS);
}

export function shouldSendAlivePing(lastPingAt: number, now: number): boolean {
  return now - lastPingAt >= ALIVE_PING_MS;
}

export interface Counters {
  rawOnly: number;
  fullPipeline: number;
  passed: number;
  alerted: number;
  cooldownSuppressed: number;
}

/**
 * Report activity for the window since the last ping, not since process start.
 * A cumulative counter that only ever grows makes "did anything happen today?"
 * unanswerable at a glance, which defeats the point of a daily ping.
 */
export function windowDelta(current: Counters, previous: Counters): Counters {
  return {
    rawOnly: current.rawOnly - previous.rawOnly,
    fullPipeline: current.fullPipeline - previous.fullPipeline,
    passed: current.passed - previous.passed,
    alerted: current.alerted - previous.alerted,
    cooldownSuppressed: current.cooldownSuppressed - previous.cooldownSuppressed,
  };
}

export function formatAlivePing(d: Counters, uptimeHours: number, extra: Record<string, unknown>): string {
  const lines = [
    `Alive. Up ${uptimeHours.toFixed(1)}h.`,
    ``,
    `Last 24h:`,
    `  launches recorded : ${d.rawOnly}`,
    `  full pipeline     : ${d.fullPipeline}`,
    `  passed filters    : ${d.passed}`,
    `  alerts sent       : ${d.alerted}`,
    `  cooldown silenced : ${d.cooldownSuppressed}`,
  ];
  for (const [k, v] of Object.entries(extra)) lines.push(`  ${k.padEnd(18)}: ${v}`);
  return lines.join("\n");
}
