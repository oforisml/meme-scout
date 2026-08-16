import { bytesToCredits } from "../ingest/profile.js";
import { shouldRealert } from "./rearm.js";

/**
 * Credit accounting, so running out is never a surprise again.
 *
 * On 2026-08-16 the recorder went blind for 22 minutes before anyone noticed,
 * because the Helius monthly allowance was consumed in about ten hours and
 * nothing was watching. The cause was not the tier: it was that WebSocket
 * traffic is billed at 20 credits/MB and nothing in the system knew how many
 * bytes it was pulling.
 *
 * A plan choice decides WHEN you run out. This decides whether you find out
 * first.
 */

/** UTC day key, so daily totals do not shift with the operator's timezone. */
export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** UTC month prefix, used to sum month-to-date against the allowance. */
export function utcMonth(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

/** Helius pricing: standard RPC 1 credit, DAS 10 credits. */
export const RPC_CREDITS = 1;
export const DAS_CREDITS = 10;

export interface BudgetVerdict {
  usedPct: number;
  level: "ok" | "warn50" | "warn80" | "critical95";
  message: string;
}

/**
 * Pure, so the thresholds can be pinned in a test rather than discovered in
 * production at 3am.
 */
export function evaluateBudget(used: number, budget: number): BudgetVerdict {
  if (budget <= 0) return { usedPct: 0, level: "ok", message: "no budget configured" };
  const usedPct = (used / budget) * 100;
  const fmt = `${Math.round(used).toLocaleString()} / ${budget.toLocaleString()} credits (${usedPct.toFixed(1)}%)`;

  if (usedPct >= 95) {
    return { usedPct, level: "critical95", message: `Credit budget nearly gone — ${fmt}` };
  }
  if (usedPct >= 80) return { usedPct, level: "warn80", message: `Credit budget 80% used — ${fmt}` };
  if (usedPct >= 50) return { usedPct, level: "warn50", message: `Credit budget half used — ${fmt}` };
  return { usedPct, level: "ok", message: fmt };
}

/** Re-alert at most once every 6h per level, so a warning is not a firehose. */
const BUDGET_REARM_MS = 6 * 3_600_000;
export function shouldAlertBudget(lastAlertedAt: number | null, now: number): boolean {
  return shouldRealert(lastAlertedAt, now, BUDGET_REARM_MS);
}

/**
 * Which venue to drop when shedding load.
 *
 * Never returns the last enabled venue: degraded ingest beats none, but no
 * ingest at all is just a slower outage.
 */
export function pickVenueToShed(
  usageByVenue: Record<string, number>,
  enabled: string[]
): string | null {
  if (enabled.length <= 1) return null;
  const ranked = enabled
    .map((v) => ({ v, used: usageByVenue[v] ?? 0 }))
    .sort((a, b) => b.used - a.used);
  return ranked[0].used > 0 ? ranked[0].v : null;
}

/**
 * A hard ceiling on BYTES streamed per day.
 *
 * This is deliberately independent of every credit calculation above. All of
 * that arithmetic rests on one unverified assumption — that Helius bills
 * 20 credits/MB — and the meter has never been reconciled against their own
 * dashboard. If that rate is wrong, the meter under-counts, pacing lets too
 * much through, and the allowance burns exactly as it did on 2026-08-16.
 *
 * Bytes are a fact we measure directly. This guard therefore fails safe: it
 * cannot be defeated by the conversion being wrong, only by the operator
 * setting the number too high.
 */
export function exceedsByteCeiling(
  bytesToday: number,
  ceilingGb: number
): { exceeded: boolean; usedGb: number; reason: string } {
  const usedGb = bytesToday / 1e9;
  if (ceilingGb <= 0) return { exceeded: false, usedGb, reason: "no byte ceiling configured" };
  return {
    exceeded: usedGb >= ceilingGb,
    usedGb,
    reason: `${usedGb.toFixed(2)} GB streamed today against a hard ceiling of ${ceilingGb} GB`,
  };
}

/**
 * Budget pacing, which is what makes a "free" profile honest.
 *
 * No continuous subscription fits 1M credits/month — pump.fun alone is ~8x
 * over — so instead of pretending otherwise, ingest is paused whenever
 * month-to-date consumption runs ahead of a straight-line pace and resumed
 * when the clock catches up. The result is a deliberately SAMPLED dataset
 * rather than a few days of data followed by silence.
 *
 * This applies to every profile, not just free: it is a backstop against any
 * misconfiguration that would otherwise burn the month in a day.
 */
export function shouldPauseForBudget(
  monthToDate: number,
  monthlyBudget: number,
  now: number
): { pause: boolean; paceTarget: number; reason: string } {
  if (monthlyBudget <= 0) return { pause: false, paceTarget: 0, reason: "no budget configured" };

  const d = new Date(now);
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const msIntoMonth = now - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const fractionElapsed = msIntoMonth / (daysInMonth * 86_400_000);
  const paceTarget = monthlyBudget * fractionElapsed;

  if (monthToDate > paceTarget) {
    return {
      pause: true,
      paceTarget,
      reason:
        `${Math.round(monthToDate).toLocaleString()} credits used vs a pace target of ` +
        `${Math.round(paceTarget).toLocaleString()} — pausing ingest to stay inside the month`,
    };
  }
  return { pause: false, paceTarget, reason: "within pace" };
}

/**
 * In-memory accumulator.
 *
 * Deliberately NOT written per message: the streams run at ~437 notifications
 * per second, so a row per message would cost far more than the thing it is
 * measuring. Totals are flushed on an interval and on shutdown.
 */
export class CreditAccumulator {
  private streamBytes = new Map<string, number>();
  private calls = new Map<string, number>();

  stream(venue: string, bytes: number): void {
    this.streamBytes.set(venue, (this.streamBytes.get(venue) ?? 0) + bytes);
  }

  rpc(n = 1): void {
    this.calls.set("rpc", (this.calls.get("rpc") ?? 0) + n);
  }

  das(n = 1): void {
    this.calls.set("das", (this.calls.get("das") ?? 0) + n);
  }

  /** Credits accrued since the last drain, per source. Clears the buffer. */
  drain(): { source: string; bytes: number; calls: number; credits: number }[] {
    const out: { source: string; bytes: number; calls: number; credits: number }[] = [];
    for (const [venue, bytes] of this.streamBytes) {
      out.push({ source: venue, bytes, calls: 0, credits: bytesToCredits(bytes) });
    }
    for (const [kind, n] of this.calls) {
      out.push({
        source: kind,
        bytes: 0,
        calls: n,
        credits: n * (kind === "das" ? DAS_CREDITS : RPC_CREDITS),
      });
    }
    this.streamBytes.clear();
    this.calls.clear();
    return out;
  }

  get pending(): number {
    let n = 0;
    for (const b of this.streamBytes.values()) n += b;
    return n;
  }
}
