import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classify,
  coveredHours,
  formatMetaVerdict,
  rollupDay,
  shouldAlertStateChange,
  shouldPauseArming,
  solTrend,
  type MetaThresholds,
} from "../src/ops/metaGauge.js";

const HOUR = 3_600_000;
const DAY_START = Date.UTC(2026, 7, 16);
const DAY_END = DAY_START + 24 * HOUR;

/** Mirrors the seeded bands in strategy.config.json. */
const T: MetaThresholds = {
  minCoveredHours: 1,
  cohortMinAgeHours: 6,
  solTrendMinDays: 7,
  minVotes: 2,
  launchRatePerHour: { hot: 2500, cold: 600 },
  cohortGradRate: { hot: 3.0, cold: 0.6 },
  pumpswapSolPerHour: { hot: 4500, cold: 1200 },
  solTrendPct: { hot: 8, cold: -8 },
};

/** A day sitting squarely in the NORMAL band on every component. */
function normalDay(coveredHrs: number) {
  return rollupDay(
    "2026-08-16",
    {
      launchesByVenue: { pumpfun: Math.round(1850 * coveredHrs), launchlab: Math.round(6 * coveredHrs) },
      cohortLaunches: 1000,
      cohortGraduated: 12,
      graduationsInDay: 12,
      pumpswapSol: 2800 * coveredHrs,
    },
    coveredHrs
  );
}

// ---- covered time --------------------------------------------------------

test("overlapping ingest windows are merged, not summed", () => {
  // Five windows in the live DB were left dangling open before the heartbeat
  // maintained closed_at. Summing their durations would inflate coverage,
  // which deflates every rate computed from it.
  const now = DAY_START + 10 * HOUR;
  const windows = [
    { openedAt: DAY_START + 1 * HOUR, closedAt: DAY_START + 5 * HOUR, events: 900 },
    { openedAt: DAY_START + 2 * HOUR, closedAt: DAY_START + 4 * HOUR, events: 400 }, // fully inside
    { openedAt: DAY_START + 4 * HOUR, closedAt: DAY_START + 6 * HOUR, events: 700 }, // overlaps
  ];
  assert.equal(coveredHours(windows, DAY_START, DAY_END, now), 5);
});

test("an open window is covered to now, never to the end of the day", () => {
  const now = DAY_START + 3 * HOUR;
  const windows = [{ openedAt: DAY_START + 1 * HOUR, closedAt: null, events: 50 }];
  assert.equal(coveredHours(windows, DAY_START, DAY_END, now), 2);
});

test("windows are clipped to the day they are being counted for", () => {
  const now = DAY_END + 5 * HOUR;
  const windows = [{ openedAt: DAY_START - 3 * HOUR, closedAt: DAY_END + 3 * HOUR, events: 10 }];
  assert.equal(coveredHours(windows, DAY_START, DAY_END, now), 24);
});

test("a window that delivered nothing is blindness, not coverage", () => {
  // 2026-08-17: a subscription held open for 9.4h with the Helius allowance
  // exhausted. Counting it as coverage yields 0 launches/hour and a confident
  // COLD — the recorder reading its own blindness as a market fact.
  const now = DAY_START + 12 * HOUR;
  const windows = [
    { openedAt: DAY_START, closedAt: DAY_START + 9.4 * HOUR, events: 0 },
    { openedAt: DAY_START + 10 * HOUR, closedAt: DAY_START + 12 * HOUR, events: 5000 },
  ];
  assert.equal(coveredHours(windows, DAY_START, DAY_END, now), 2);
});

test("a fully blind day is UNKNOWN, not COLD, even with windows wide open", () => {
  const now = DAY_START + 12 * HOUR;
  const blind = [{ openedAt: DAY_START, closedAt: null, events: 0 }];
  const covered = coveredHours(blind, DAY_START, DAY_END, now);
  assert.equal(covered, 0);
  const day = rollupDay(
    "2026-08-17",
    { launchesByVenue: {}, cohortLaunches: 0, cohortGraduated: 0, graduationsInDay: 0, pumpswapSol: 0 },
    covered
  );
  const verdict = classify(day, null, T);
  assert.equal(verdict.state, "UNKNOWN");
  assert.ok(!shouldPauseArming(verdict.state));
});

// ---- the duty-cycle trap -------------------------------------------------

test("a 15% duty cycle reads NORMAL, not UNKNOWN", () => {
  // THE case an absolute coverage PERCENTAGE floor would have broken. The
  // 2 GB/day byte ceiling stops a developer-profile pump.fun stream after
  // ~3.6 of 24 hours by design; that is a healthy day, not a degraded one.
  const day = normalDay(3.6);
  const verdict = classify(day, 0, T);
  assert.equal(verdict.state, "NORMAL");
  assert.notEqual(verdict.state, "UNKNOWN");
});

test("rates are identical whether the day was 15% or 100% covered", () => {
  // The whole reason rates are per covered hour rather than per day.
  const short = normalDay(3.6);
  const full = normalDay(24);
  assert.ok(Math.abs(short.totalLaunchRate - full.totalLaunchRate) < 5);
  assert.equal(classify(short, 0, T).state, classify(full, 0, T).state);
});

// ---- the outage trap -----------------------------------------------------

test("an outage is UNKNOWN, never COLD", () => {
  // The recorder went blind on 2026-08-16. Zero launches in an uncovered day
  // is a fact about us, not about the market — and COLD is the state that
  // silences alerts, so getting this wrong silences them for no reason.
  const blind = rollupDay(
    "2026-08-17",
    { launchesByVenue: {}, cohortLaunches: 0, cohortGraduated: 0, graduationsInDay: 0, pumpswapSol: 0 },
    0.2
  );
  const verdict = classify(blind, null, T);
  assert.equal(verdict.state, "UNKNOWN");
  assert.match(verdict.reasons[0], /coverage/);
  assert.ok(!shouldPauseArming(verdict.state), "a blind day must not silence the channel");
});

test("a genuinely quiet but well-covered day IS allowed to be COLD", () => {
  // The converse guard: the outage protection must not make COLD unreachable.
  const quiet = rollupDay(
    "2026-08-18",
    {
      launchesByVenue: { pumpfun: 1000 },
      cohortLaunches: 1000,
      cohortGraduated: 2,
      pumpswapSol: 4000,
      graduationsInDay: 2,
    },
    10
  );
  const verdict = classify(quiet, -20, T);
  assert.equal(verdict.state, "COLD");
  assert.ok(shouldPauseArming(verdict.state));
});

// ---- the graduation-rate bias -------------------------------------------

test("a day of launches too young to have graduated abstains rather than reporting 0%", () => {
  const young = rollupDay(
    "2026-08-16",
    {
      launchesByVenue: { pumpfun: 5000 },
      cohortLaunches: 0, // nothing old enough yet
      cohortGraduated: 0,
      graduationsInDay: 0,
      pumpswapSol: 10000,
    },
    3
  );
  const verdict = classify(young, null, T);
  assert.ok(verdict.abstained.includes("cohortGradRate"));
  assert.ok(
    !verdict.reasons.some((r) => r.startsWith("graduation rate")),
    "an unmeasurable rate must not cast a vote"
  );
});

test("the same-day ratio is recorded but never votes", () => {
  const day = rollupDay(
    "2026-08-16",
    {
      launchesByVenue: { pumpfun: 10136 },
      cohortLaunches: 1000,
      cohortGraduated: 40, // a healthy 4% among mature launches
      graduationsInDay: 121, // the biased 1.2% same-day figure
      pumpswapSol: 15315,
    },
    5.5
  );
  assert.ok(day.sameDayGradRatio !== null && day.sameDayGradRatio < 0.02);
  assert.equal(day.cohortGradRate, 0.04);
  // The cohort rate is 4%, above the 3% hot band — the biased 1.2% would have
  // voted cold. Confirm the unbiased number is the one with teeth.
  const verdict = classify(day, null, T);
  assert.ok(verdict.reasons.some((r) => r.startsWith("graduation rate") && r.endsWith("(hot)")));
});

// ---- SOL trend -----------------------------------------------------------

test("solTrend is null below the minimum window, not zero", () => {
  // null means "we have not been running a week"; 0 means "SOL went nowhere".
  assert.equal(solTrend([150, 152, 149], 7), null);
  assert.equal(solTrend([], 7), null);
});

test("solTrend measures first-to-last once it has the window", () => {
  const t = solTrend([100, 101, 102, 103, 104, 105, 110], 7);
  assert.ok(t !== null && Math.abs(t - 10) < 0.001);
});

test("an absent SOL trend abstains instead of counting as neutral", () => {
  const day = normalDay(5);
  const withTrend = classify(day, 0, T);
  const without = classify(day, null, T);
  assert.ok(without.abstained.includes("solTrend"));
  assert.equal(without.votes.hot + without.votes.cold + without.votes.neutral, 3);
  assert.equal(withTrend.votes.hot + withTrend.votes.cold + withTrend.votes.neutral, 4);
});

test("too few voting components yields UNKNOWN", () => {
  const sparse = rollupDay(
    "2026-08-16",
    { launchesByVenue: {}, cohortLaunches: 0, cohortGraduated: 0, graduationsInDay: 0, pumpswapSol: 0 },
    5
  );
  // Only launch rate and pumpswap volume can vote here; raise the bar past them.
  assert.equal(classify(sparse, null, { ...T, minVotes: 3 }).state, "UNKNOWN");
});

// ---- arming --------------------------------------------------------------

test("only COLD pauses arming — UNKNOWN does not", () => {
  // The operator's call, 2026-08-16: the gauge being blind must not silence
  // the channel; only positive evidence of a cold market may.
  assert.equal(shouldPauseArming("COLD"), true);
  assert.equal(shouldPauseArming("UNKNOWN"), false);
  assert.equal(shouldPauseArming("NORMAL"), false);
  assert.equal(shouldPauseArming("HOT"), false);
});

// ---- state-change alerting ----------------------------------------------

test("state changes alert; a steady state does not", () => {
  const now = Date.now();
  assert.equal(shouldAlertStateChange("NORMAL", "COLD", null, now), true);
  assert.equal(shouldAlertStateChange("COLD", "COLD", null, now), false);
});

test("the first ever reading is not an alertable change", () => {
  assert.equal(shouldAlertStateChange(null, "COLD", null, Date.now()), false);
});

test("a flapping gauge is rate-limited", () => {
  const now = Date.now();
  assert.equal(shouldAlertStateChange("NORMAL", "COLD", now - 60_000, now), false);
  assert.equal(shouldAlertStateChange("NORMAL", "COLD", now - 7 * HOUR, now), true);
});

// ---- reporting -----------------------------------------------------------

test("the report names covered hours, the abstentions, and venue share", () => {
  const day = normalDay(3.6);
  const text = formatMetaVerdict(day, classify(day, null, T));
  assert.match(text, /Ingest coverage: 3\.60h/);
  assert.match(text, /No data yet: solTrend/);
  assert.match(text, /Venue share: pumpfun 99\.7%/);
});

test("venue share is a ratio, so the duty cycle cancels", () => {
  const a = normalDay(3.6).venueShare;
  const b = normalDay(24).venueShare;
  assert.ok(Math.abs(a.pumpfun - b.pumpfun) < 0.001);
});
