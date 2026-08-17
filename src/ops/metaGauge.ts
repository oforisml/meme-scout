import { shouldRealert } from "./rearm.js";

/**
 * FR-J1 — the four-number regime thermometer.
 *
 * "The System shall record daily: (1) launches per venue, (2) graduation
 * rate, (3) aggregate PumpSwap volume, (4) SOL 7-day trend — and expose a
 * simple meta state: HOT / NORMAL / COLD. When COLD, signal arming pauses
 * automatically; state changes alert the Operator. Venue market share is
 * tracked over time."
 *
 * Everything here is pure. The whole value of a regime gauge is that it can
 * be wrong in a way you can reproduce at a desk rather than discover when it
 * silences your alerts.
 *
 * TWO BIASES THIS FILE EXISTS TO CANCEL. Both push toward a false COLD, and
 * COLD is the state with teeth, so both would silence the channel for the
 * wrong reason:
 *
 *  1. OUR OWN OUTAGE LOOKS LIKE A COLD MARKET. Ingest duty-cycles by design
 *     — the byte ceiling stops a `developer`-profile pump.fun stream after
 *     ~3.6 of every 24 hours — and it stops entirely when the allowance runs
 *     out, as it did on 2026-08-16. A count per DAY cannot tell "the market
 *     went quiet" from "we stopped looking". So every rate here is per
 *     COVERED HOUR. A rate is comparable across duty cycles; a count is not.
 *
 *  2. SAME-DAY GRADUATION RATE UNDERSTATES. A token launched at 20:00 has
 *     not had time to graduate by midnight. The ratio that feeds `classify`
 *     is therefore a COHORT rate over launches old enough to have had a fair
 *     chance. The same-day ratio is still recorded — it is the honest
 *     description of the day — but it is not given a vote.
 */

export type MetaState = "HOT" | "NORMAL" | "COLD" | "UNKNOWN";

/** Half-open [start, end) in epoch ms. */
export interface Window {
  openedAt: number;
  closedAt: number | null;
  /** Notifications actually received during THIS window. */
  events: number;
}

/**
 * Covered time within a day, in hours.
 *
 * A WINDOW THAT DELIVERED NOTHING IS NOT COVERAGE. This is the whole point,
 * and getting it wrong is not hypothetical: on 2026-08-17 the recorder held a
 * subscription open for 9.4 hours while the Helius allowance was exhausted,
 * receiving zero notifications. Counting that as coverage produced a launch
 * rate of 0/hour and a confident COLD — the system reading its own blindness
 * as a fact about the market, and silencing alerts over it. `schema.sql` had
 * already written the rule down: "a window with zero events is a BLIND
 * period, not a quiet market". This is where it gets enforced.
 *
 * Excluding a young open window that has not seen traffic yet is the safe
 * direction: less covered time means a HIGHER computed rate, which biases
 * away from a false COLD rather than toward one.
 *
 * Windows overlap in practice — the recorder opens a new one on resume before
 * older dangling rows are closed, and five such rows exist in the live
 * database from before the heartbeat maintained `closed_at`. Summing
 * durations would double-count them and inflate coverage. So they are merged.
 *
 * A still-open window is covered up to `now`, never to the end of the day: we
 * have not observed the future.
 */
export function coveredHours(windows: Window[], dayStart: number, dayEnd: number, now: number): number {
  const clipped = windows
    .filter((w) => w.events > 0)
    .map((w) => ({
      from: Math.max(w.openedAt, dayStart),
      to: Math.min(w.closedAt ?? now, dayEnd, now),
    }))
    .filter((w) => w.to > w.from)
    .sort((a, b) => a.from - b.from);

  let total = 0;
  let cursor = -Infinity;
  for (const w of clipped) {
    const from = Math.max(w.from, cursor);
    if (w.to > from) total += w.to - from;
    cursor = Math.max(cursor, w.to);
  }
  return total / 3_600_000;
}

export interface DayRows {
  /** kind='launch' rows observed in the day, by venue. */
  launchesByVenue: Record<string, number>;
  /** Launches in the day old enough to have had a fair chance to graduate. */
  cohortLaunches: number;
  /** How many of THOSE graduated — at any later time, not only same-day. */
  cohortGraduated: number;
  /** Graduations observed in the day, whenever the token launched. */
  graduationsInDay: number;
  /** Absolute SOL traded on PumpSwap in the day. */
  pumpswapSol: number;
}

export interface MetaDay {
  day: string;
  coveredHours: number;
  /** Launches per covered hour, per venue. */
  launchRateByVenue: Record<string, number>;
  totalLaunchRate: number;
  /** Share of launches per venue — a ratio, so the duty cycle cancels out. */
  venueShare: Record<string, number>;
  /** Graduations / launches within the day. Recorded, never given a vote. */
  sameDayGradRatio: number | null;
  /** The unbiased one: graduations among launches old enough to count. */
  cohortGradRate: number | null;
  /** PumpSwap SOL per covered hour. */
  pumpswapSolPerHour: number;
}

export function rollupDay(day: string, rows: DayRows, coveredHrs: number): MetaDay {
  // Guard the divisor rather than the caller: a day with no coverage yields
  // zero rates that classify() will refuse to read, which is the correct
  // outcome and one fewer branch at every call site.
  const per = (n: number) => (coveredHrs > 0 ? n / coveredHrs : 0);

  const launchRateByVenue: Record<string, number> = {};
  let totalLaunches = 0;
  for (const [venue, n] of Object.entries(rows.launchesByVenue)) {
    launchRateByVenue[venue] = per(n);
    totalLaunches += n;
  }

  const venueShare: Record<string, number> = {};
  for (const [venue, n] of Object.entries(rows.launchesByVenue)) {
    venueShare[venue] = totalLaunches > 0 ? n / totalLaunches : 0;
  }

  return {
    day,
    coveredHours: coveredHrs,
    launchRateByVenue,
    totalLaunchRate: per(totalLaunches),
    venueShare,
    sameDayGradRatio: totalLaunches > 0 ? rows.graduationsInDay / totalLaunches : null,
    cohortGradRate: rows.cohortLaunches > 0 ? rows.cohortGraduated / rows.cohortLaunches : null,
    pumpswapSolPerHour: per(rows.pumpswapSol),
  };
}

/**
 * Percent change across the series, or null when there is not enough of it.
 *
 * Returns null rather than 0 for a short series, because those mean opposite
 * things: 0 is "SOL went nowhere", null is "we have not been running long
 * enough to know". Conflating them is the same mistake as the alert-on-null
 * bug that let 100%-null snapshots pass every filter — insufficient data is
 * not a reading.
 *
 * Expects oldest-first. Dark for the first week of operation, by design.
 */
export function solTrend(series: number[], minDays: number): number | null {
  const usable = series.filter((v) => Number.isFinite(v) && v > 0);
  if (usable.length < minDays) return null;
  const first = usable[0];
  const last = usable[usable.length - 1];
  if (first <= 0) return null;
  return ((last - first) / first) * 100;
}

export interface MetaThresholds {
  minCoveredHours: number;
  /**
   * How old a launch must be before it counts against the graduation rate.
   * Read by the rollup rather than by classify(), but declared here so the
   * gauge has one canonical threshold shape rather than two.
   */
  cohortMinAgeHours: number;
  solTrendMinDays: number;
  launchRatePerHour: { hot: number; cold: number };
  cohortGradRate: { hot: number; cold: number };
  pumpswapSolPerHour: { hot: number; cold: number };
  solTrendPct: { hot: number; cold: number };
  /** How many components must vote before a state is claimed at all. */
  minVotes: number;
}

export interface MetaVerdict {
  state: MetaState;
  /** Human-readable, one per component that voted. */
  reasons: string[];
  /** Components that had no usable data. Named, never silently treated as neutral. */
  abstained: string[];
  votes: { hot: number; cold: number; neutral: number };
}

type Vote = "hot" | "cold" | "neutral";

function band(value: number, hot: number, cold: number): Vote {
  // Written to work in both directions so one helper covers a rising measure
  // (launch rate) and would still be correct if a band were ever inverted.
  if (hot >= cold) return value >= hot ? "hot" : value <= cold ? "cold" : "neutral";
  return value <= hot ? "hot" : value >= cold ? "cold" : "neutral";
}

/**
 * Combine the four numbers into a state.
 *
 * A simple majority of the components that actually voted. Deliberately not
 * a weighted score: there is no outcome data to fit weights against, and a
 * weighted model would look far more authoritative than the evidence behind
 * it. Revisit in Phase 3 against FR-B4.
 */
export function classify(day: MetaDay, trend: number | null, t: MetaThresholds): MetaVerdict {
  const reasons: string[] = [];
  const abstained: string[] = [];

  // Below the floor there is not enough observed time to call anything a
  // rate. This is an absolute floor, NOT a percentage of the day: ingest
  // duty-cycles to ~15% by design on the developer profile, so a percentage
  // floor would leave the gauge permanently UNKNOWN on the tier in use.
  if (day.coveredHours < t.minCoveredHours) {
    return {
      state: "UNKNOWN",
      reasons: [
        `only ${day.coveredHours.toFixed(2)}h of ingest coverage on ${day.day} — ` +
          `below the ${t.minCoveredHours}h floor needed to measure a rate`,
      ],
      abstained: ["launchRate", "cohortGradRate", "pumpswapVolume", "solTrend"],
      votes: { hot: 0, cold: 0, neutral: 0 },
    };
  }

  const tally = { hot: 0, cold: 0, neutral: 0 };
  const cast = (name: string, vote: Vote, text: string) => {
    tally[vote]++;
    reasons.push(`${name}: ${text} (${vote})`);
  };

  cast(
    "launch rate",
    band(day.totalLaunchRate, t.launchRatePerHour.hot, t.launchRatePerHour.cold),
    `${day.totalLaunchRate.toFixed(0)}/covered-hour`
  );

  if (day.cohortGradRate === null) {
    abstained.push("cohortGradRate");
  } else {
    cast(
      "graduation rate",
      band(day.cohortGradRate * 100, t.cohortGradRate.hot, t.cohortGradRate.cold),
      `${(day.cohortGradRate * 100).toFixed(2)}% of the mature cohort`
    );
  }

  cast(
    "pumpswap volume",
    band(day.pumpswapSolPerHour, t.pumpswapSolPerHour.hot, t.pumpswapSolPerHour.cold),
    `${day.pumpswapSolPerHour.toFixed(0)} SOL/covered-hour`
  );

  if (trend === null) {
    abstained.push("solTrend");
  } else {
    cast("SOL trend", band(trend, t.solTrendPct.hot, t.solTrendPct.cold), `${trend >= 0 ? "+" : ""}${trend.toFixed(1)}%`);
  }

  const voted = tally.hot + tally.cold + tally.neutral;
  if (voted < t.minVotes) {
    return {
      state: "UNKNOWN",
      reasons,
      abstained,
      votes: tally,
    };
  }

  // A tie is NORMAL. The gauge only claims a regime when the evidence leans.
  let state: MetaState = "NORMAL";
  if (tally.cold > tally.hot && tally.cold * 2 > voted) state = "COLD";
  else if (tally.hot > tally.cold && tally.hot * 2 > voted) state = "HOT";

  return { state, reasons, abstained, votes: tally };
}

/**
 * Whether COLD should silence Telegram.
 *
 * UNKNOWN deliberately does NOT pause — the operator's call, made
 * 2026-08-16. Only positive evidence of a cold market silences the channel;
 * the gauge being blind does not. The first week (SOL trend dark) and every
 * low-coverage day therefore keep alerting.
 *
 * This suppresses NOTIFICATION only. Recording never depends on the regime:
 * the alert row, the FR-A6 cost quotes and every snapshot still land, because
 * a cold market is exactly when the dataset most needs to show what a cold
 * market looked like.
 */
export function shouldPauseArming(state: MetaState): boolean {
  return state === "COLD";
}

/** Re-alert cadence for the gauge, matching the other ops watchers. */
const META_REARM_MS = 6 * 3_600_000;

/**
 * Alert on a transition, not on a level — otherwise a long COLD spell sends a
 * message every tick. The rearm window only rate-limits repeats of the SAME
 * transition, so a genuine flip is never swallowed.
 */
export function shouldAlertStateChange(
  previous: MetaState | null,
  next: MetaState,
  lastAlertedAt: number | null,
  now: number
): boolean {
  if (previous === next) return false;
  // First ever reading is not a "change" worth interrupting anyone for.
  if (previous === null) return false;
  return shouldRealert(lastAlertedAt, now, META_REARM_MS);
}

export function formatMetaVerdict(day: MetaDay, verdict: MetaVerdict): string {
  const lines = [
    `Meta state: ${verdict.state} (${day.day})`,
    ``,
    `Ingest coverage: ${day.coveredHours.toFixed(2)}h`,
  ];
  for (const r of verdict.reasons) lines.push(`  ${r}`);
  if (verdict.abstained.length) {
    lines.push(``, `No data yet: ${verdict.abstained.join(", ")}`);
  }
  const share = Object.entries(day.venueShare)
    .sort((a, b) => b[1] - a[1])
    .map(([v, s]) => `${v} ${(s * 100).toFixed(1)}%`)
    .join(", ");
  if (share) lines.push(``, `Venue share: ${share}`);
  return lines.join("\n");
}
