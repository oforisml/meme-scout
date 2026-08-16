import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { shouldRealert } from "./rearm.js";

/**
 * FR-G1 AC2 — "backup failure for >12h triggers a Telegram alert".
 *
 * Reads the marker that scripts/backup.sh writes. A marker file rather than a
 * database row on purpose: the backup job must not open the SQLite file for
 * writing while the recorder holds it (RUNBOOK, one writer only).
 *
 * Checking from the recorder also catches the failure a self-reporting backup
 * script structurally cannot — the cron job never firing at all. What it
 * cannot catch is the whole machine being off, which is exactly when you would
 * most want to know. That gap needs a third party; FR-G2's daily alive ping
 * narrows it by making silence itself the signal.
 */

export const STALE_AFTER_MS = 12 * 3_600_000;
/** While stale, re-alert at most this often. Otherwise: 720 messages a day. */
const REARM_MS = 6 * 3_600_000;

export interface BackupState {
  completedAt?: number;
  bytes?: number;
  remotePath?: string;
  rowCounts?: Record<string, number>;
  lastAttemptAt?: number;
  failedStep?: string;
  lastError?: string;
}

export function backupStatePath(): string {
  return join(dirname(config.DB_PATH), ".backup-state.json");
}

export function readBackupState(): BackupState | null {
  try {
    return JSON.parse(readFileSync(backupStatePath(), "utf8")) as BackupState;
  } catch {
    return null;
  }
}

export interface StalenessVerdict {
  stale: boolean;
  reason: string;
}

/**
 * Pure so it can be tested without a filesystem or a clock.
 *
 * `startedAt` suppresses the cold-start case: a missing marker really is a
 * failure (no backup exists), but firing the instant a fresh clone boots would
 * be noise rather than signal.
 */
export function evaluateBackupState(
  state: BackupState | null,
  now: number,
  startedAt: number,
  remoteConfigured: boolean
): StalenessVerdict {
  if (!remoteConfigured) {
    return { stale: false, reason: "backups not configured" };
  }
  if (now - startedAt < STALE_AFTER_MS) {
    // Not yet entitled to an opinion.
    if (!state?.completedAt) return { stale: false, reason: "within startup grace period" };
  }
  if (!state || !state.completedAt) {
    const why = state?.failedStep ? `last attempt failed at "${state.failedStep}"` : "no backup has ever completed";
    return { stale: true, reason: why };
  }

  const ageH = (now - state.completedAt) / 3_600_000;
  if (now - state.completedAt > STALE_AFTER_MS) {
    const detail = state.failedStep ? ` Last attempt failed at "${state.failedStep}".` : "";
    return { stale: true, reason: `last successful backup was ${ageH.toFixed(1)}h ago.${detail}` };
  }
  return { stale: false, reason: `last backup ${ageH.toFixed(1)}h ago` };
}

/** Rate-limits repeat alerts while the condition persists. */
export function shouldAlert(lastAlertedAt: number | null, now: number): boolean {
  return shouldRealert(lastAlertedAt, now, REARM_MS);
}
