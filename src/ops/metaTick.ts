import {
  ingestCoverage,
  latestMetaDay,
  metaDayRows,
  saveMetaDay,
  solPriceSeries,
} from "../db/db.js";
import { logger } from "../logger.js";
import { solUsd } from "../prices.js";
import { strategy } from "../strategy.js";
import { utcDay } from "./creditMeter.js";
import {
  classify,
  coveredHours,
  rollupDay,
  solTrend,
  type MetaDay,
  type MetaVerdict,
} from "./metaGauge.js";

/**
 * The I/O half of FR-J1: read the day out of the database, hand it to the
 * pure gauge, persist the result.
 *
 * Split from `metaGauge.ts` on purpose — every judgement lives there and is
 * unit-testable without a database, while this file only moves data.
 */

export interface MetaReading {
  day: MetaDay;
  verdict: MetaVerdict;
  solUsd: number | null;
  solTrendPct: number | null;
}

function dayBounds(now: number): { day: string; start: number; end: number } {
  const day = utcDay(now);
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return { day, start, end: start + 86_400_000 };
}

/**
 * Recompute and persist today's row.
 *
 * Cheap enough to run on the 60s ops tick: four indexed local queries and, at
 * most once per UTC day, one Jupiter call that costs no Helius credits.
 */
export async function tickMetaGauge(now: number): Promise<MetaReading> {
  const t = strategy.meta;
  const { day, start, end } = dayBounds(now);

  const covered = coveredHours(ingestCoverage(start), start, end, now);
  const rows = metaDayRows(start, end, now, t.cohortMinAgeHours * 3_600_000);
  const metaDay = rollupDay(day, rows, covered);

  // One price reading per UTC day: the first one taken. Re-reading later would
  // make the "7-day trend" partly a measure of what time of day the recorder
  // happened to be up.
  const existing = latestMetaDay();
  const alreadyPriced = existing?.day === day ? existing.solUsd : null;
  const price = alreadyPriced ?? (await solUsd().catch(() => null));

  const series = solPriceSeries(t.solTrendMinDays, day);
  const trend = solTrend(price === null ? series : [...series, price], t.solTrendMinDays);

  const verdict = classify(metaDay, trend, t);

  saveMetaDay({
    day,
    coveredHours: metaDay.coveredHours,
    launchRateByVenue: metaDay.launchRateByVenue,
    totalLaunchRate: metaDay.totalLaunchRate,
    venueShare: metaDay.venueShare,
    sameDayGradRatio: metaDay.sameDayGradRatio,
    cohortGradRate: metaDay.cohortGradRate,
    pumpswapSolPerHour: metaDay.pumpswapSolPerHour,
    solUsd: price,
    solTrendPct: trend,
    state: verdict.state,
    abstained: verdict.abstained,
    reasons: verdict.reasons,
    computedAt: now,
  });

  logger.debug(
    { day, state: verdict.state, coveredHours: covered.toFixed(2), abstained: verdict.abstained },
    "meta gauge"
  );

  return { day: metaDay, verdict, solUsd: price, solTrendPct: trend };
}
