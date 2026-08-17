import { assessmentToAlert, notify, notifyOps, sendTelegram } from "./alerts/notifier.js";
import { meetsNotifyBar } from "./alerts/notifyBar.js";
import { evaluateBackupState, readBackupState, shouldAlert } from "./ops/backupWatch.js";
import {
  evaluateBudget,
  exceedsByteCeiling,
  pickVenueToShed,
  shouldAlertBudget,
  shouldPauseForBudget,
  utcDay,
  utcMonth,
} from "./ops/creditMeter.js";
import { projectMonthlyCredits, resolveVenues } from "./ingest/profile.js";
import { formatMetaVerdict, shouldAlertStateChange, shouldPauseArming, type MetaState } from "./ops/metaGauge.js";
import { tickMetaGauge } from "./ops/metaTick.js";
import { fetchEntryCost, persistEntryCost, sweepHorizonCosts } from "./ops/costSampler.js";
import { formatCost } from "./quotes.js";
import {
  type Counters,
  evaluateStall,
  formatAlivePing,
  shouldForceReconnect,
  LAST_EVENT_KEY,
  seedLastEventAt,
  shouldRealertStall,
  shouldSendAlivePing,
  windowDelta,
} from "./ops/heartbeat.js";
import {
  addCreditUsage,
  bytesOnDay,
  lastAlertAt,
  markGraduated,
  monthToDateCredits,
  closeIngestWindow,
  getOpsState,
  openIngestWindow,
  setOpsState,
  saveAssessment,
  saveToken,
  tokenObservedAt,
  touchIngestWindow,
} from "./db/db.js";
import { runPipeline } from "./filters/pipeline.js";
import { HeliusListener } from "./ingest/helius.js";
import { decodeCreateEvent, pumpFunDecodeFailures } from "./ingest/pumpfun.js";
import { hasPumpSwapCreatePool } from "./ingest/pumpswap.js";
import { installCrashHandlers, logger } from "./logger.js";
import { Recorder } from "./recorder/recorder.js";
import { assertRuntimeConfig, config } from "./config.js";
import { strategy, strategyHash } from "./strategy.js";
import type { TokenLaunch, TokenSnapshot } from "./types.js";

// Before anything can throw: a raw crash stack would otherwise go straight to
// stderr, and web3.js names the endpoint it failed on — key included.
installCrashHandlers();
assertRuntimeConfig();

const recorder = new Recorder();

// ---- daily self-report counters ----------------------------------------
const stats = {
  observedByVenue: new Map<string, number>(),
  rawOnly: 0,
  fullPipeline: 0,
  passed: 0,
  alerted: 0,
  cooldownSuppressed: 0,
  belowNotifyBar: 0,
  metaSuppressed: 0,
  since: Date.now(),
};
function bump(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

// ---- main event handler --------------------------------------------------
const listener = new HeliusListener(async (launch, rawLogs) => {
  try {
    bump(stats.observedByVenue, launch.source);

    // TIER 1 — record everything, cheaply (one insert, no RPC).
    // pump.fun alone does tens of thousands of launches/day; running the
    // full treatment on all of them burns the RPC budget for no edge.
    //
    // The CreateEvent in the logs gives us mint, creator and the on-chain
    // timestamp for free, so these are recorded as real tokens rather than as
    // raw log blobs with a null mint. They are deliberately NOT tracked or
    // assessed — that is what the raw-only tier exists to avoid.
    // A migration transaction mentions pump.fun as well as PumpSwap, so a
    // graduation is still detectable when the PumpSwap subscription is off —
    // which the default profile does, since it is 88% of the credit bill.
    if (launch.source === "pumpfun" && !listener.enabledVenues.includes("pumpswap")) {
      if (hasPumpSwapCreatePool(rawLogs)) {
        await handleGraduation({ ...launch, source: "pumpswap", kind: "graduation" });
        return;
      }
    }

    if (strategy.ingestion.rawOnlySources.includes(launch.source)) {
      const created = decodeCreateEvent(rawLogs);
      if (!created) return; // not a launch — a trade on an existing token
      saveToken({
        ...launch,
        mint: created.mint,
        creator: created.creator,
        name: created.name,
        symbol: created.symbol,
        uri: created.uri,
        chainTs: created.chainTs,
      });
      recorder.noteLaunch(created.mint, launch.slot);
      stats.rawOnly++;
      return;
    }

    // TIER 2 — full treatment for sources that earned it (graduations are
    // themselves a quality gate: most tokens die on the curve).
    await handleGraduation(launch);
  } catch (err) {
    logger.error({ err }, "pipeline error");
  }
},
// Swap stream (FR-A5 / FR-H1). Fires for EVERY notification, including the
// ~220/s of PumpSwap trades the launch gate used to discard — which is why
// H1's unique-buyer growth has never been measurable until now.
(source, logs, signature, slot) => {
  try {
    if (source === "pumpswap") recorder.onPumpSwapLogs(logs, signature, slot);
    else if (source === "pumpfun") recorder.onPumpFunLogs(logs, signature, slot);
  } catch (err) {
    logger.error({ err, source }, "swap ingest error");
  }
});

/**
 * Full-pipeline treatment: resolve, link the graduation to its recorded
 * launch, snapshot, track and assess.
 *
 * Extracted so the pump.fun stream can route migration transactions here when
 * the PumpSwap subscription is disabled.
 */
async function handleGraduation(launch: TokenLaunch): Promise<void> {
  stats.fullPipeline++;

  const resolved = await recorder.resolveAndRecord(launch);
  if (!resolved) return;

  // saveToken is INSERT OR IGNORE, so if the pump.fun launch was already
  // recorded its original observed_at survives and graduated_at - observed_at
  // is a genuine time on curve. markGraduated is idempotent.
  if (launch.kind === "graduation") {
    markGraduated(resolved.mint, resolved.signature, resolved.observedAt);
    const launchedAt = tokenObservedAt(resolved.mint);
    if (launchedAt !== null && resolved.observedAt - launchedAt > 1000) {
      logger.info(
        { mint: resolved.mint, minutesOnCurve: ((resolved.observedAt - launchedAt) / 60_000).toFixed(1) },
        "graduation linked to its recorded launch"
      );
    }
  }

  // Record the t=0 snapshot for the time series, but do NOT judge on it:
  // Helius DAS has not indexed a brand-new mint and reports a near-zero holder
  // count. The assessment runs on the metered refreshes instead.
  await recorder.snapshotNow(resolved.mint);
  recorder.track(resolved.mint, (mint, snapshot) => {
    assess(resolved, snapshot).catch((err) => logger.error({ err, mint }, "assessment error"));
  });
}

/** Judge a token against a snapshot whose metered fields were just refreshed. */
async function assess(launch: TokenLaunch, snapshot: TokenSnapshot): Promise<void> {
  const assessment = await runPipeline(launch, snapshot);
  saveAssessment(assessment);

  if (!assessment.passed) {
    logger.debug({ mint: launch.mint, score: assessment.totalScore.toFixed(0) }, "filtered out");
    return;
  }
  stats.passed++;

  // Alert cooldown per mint — re-assessments within the window stay silent.
  const last = lastAlertAt(launch.mint);
  const cooldownMs = strategy.alerts.cooldownMinutes * 60_000;
  if (last !== null && Date.now() - last < cooldownMs) {
    stats.cooldownSuppressed++;
    return;
  }

  // FR-A6: price the standard trade BEFORE sending, so the alert shows what
  // 0.5 SOL would actually cost right now. Measured ~400ms, and alerts already
  // arrive ~180s after graduation, so the added latency is immaterial.
  //
  // A quote failure must never suppress the alert: the candidate passed the
  // filters on its own evidence, and a Jupiter outage is not a fact about the
  // token. The failure is recorded instead (FR-A6 AC).
  const cost = await fetchEntryCost(launch.mint).catch((err) => {
    logger.error({ err, mint: launch.mint }, "entry cost sampling threw");
    return null;
  });

  const alert = assessmentToAlert(assessment);
  if (cost) alert.body += `\n\n${formatCost(cost.buy)}`;

  // Recorded regardless; Telegram only for the stricter notify bar.
  const bar = meetsNotifyBar(snapshot);
  if (!bar.notify) {
    stats.belowNotifyBar++;
    logger.debug({ mint: launch.mint, reason: bar.reason }, "passed, held below notify bar");
  }

  // FR-J1: a COLD meta reads as "this is not the week to be taking entries",
  // so delivery is withheld even from a candidate that cleared the bar. Only
  // delivery — the alerts row, the FR-A6 quotes and every snapshot still land,
  // because a cold market is exactly when the dataset most needs to show what
  // a cold market looked like. UNKNOWN never suppresses (operator decision).
  const cold = shouldPauseArming(metaState);
  if (cold && bar.notify) {
    stats.metaSuppressed++;
    logger.info({ mint: launch.mint, metaState }, "met the notify bar but held: meta is COLD");
  }

  const suppressedBy = cold ? `meta:${metaState}` : !bar.notify ? `notifyBar: ${bar.reason}` : null;
  const alertId = await notify(alert, bar.notify && !cold, suppressedBy);
  if (cost) persistEntryCost(alertId, launch.mint, cost);
  stats.alerted++;
}

// ---- heartbeat / dead-man switch (FR-G2) ---------------------------------
const startedAt = Date.now();
let backupAlertedAt: number | null = null;
let stallAlertedAt: number | null = null;
let stallReconnectedAt: number | null = null;
let lastAlivePingAt = Date.now();
let budgetAlertedAt: number | null = null;
let shedVenues: string[] = [];
// Two independent reasons ingest can be paused: the credit-pace guard and the
// hard byte ceiling. Held as a reason string rather than a boolean so resuming
// requires BOTH to be clear, and so the log says which one stopped it.
let pausedFor: string | null = null;
let currentWindowId: number | null = null;
// listener.eventCount is cumulative for the whole process and never resets, so
// the second and later windows of a run would otherwise inherit every event the
// first one saw. ingest_windows.events must mean "received during THIS window"
// — the meta gauge reads a zero there as proof we were blind.
let windowEventBaseline = 0;
const windowEvents = () => listener.eventCount - windowEventBaseline;
function beginWindow(reason: string): number {
  windowEventBaseline = listener.eventCount;
  return openIngestWindow(listener.enabledVenues, reason);
}
let pingBaseline: Counters = { ...stats };

// FR-J1. Held in memory and refreshed by the ops tick; the assess path reads
// it rather than recomputing, so a burst of graduations cannot turn one
// regime question into one database rollup per token.
let metaState: MetaState = "UNKNOWN";
let metaStateAlertedAt: number | null = null;
let metaTickAt = 0;
// Slower than the 60s ops tick. A regime does not turn over in a minute, and
// the rollup scans a day of tokens and swaps — cheap, but not free at
// ~60k rows/day. Fast enough that a state change is caught well inside the
// 6h re-alert window.
const META_TICK_MS = 5 * 60_000;

setInterval(() => {
  const now = Date.now();

  // --- websocket stall: alert AND heal --------------------------------
  const stall = evaluateStall(listener.lastEventAt, now);
  if (stall.stalled) {
    logger.warn({ silentMin: stall.silentMinutes.toFixed(1) }, "HEARTBEAT: no events — websocket may be stalled");
    if (shouldRealertStall(stallAlertedAt, now)) {
      stallAlertedAt = now;
      void notifyOps(
        "Ingest stalled",
        `No events for ${stall.silentMinutes.toFixed(0)} minutes. Forcing a websocket reconnect.\n\n` +
          `If this repeats, check the Helius key and plan limits.`
      );
    }
    // Detecting a stall and only logging it left a dead recorder dead.
    // Rate-limited so a persistently silent socket does not reconnect every tick.
    if (shouldForceReconnect(stallReconnectedAt, now)) {
      stallReconnectedAt = now;
      listener.forceReconnect("no events for 10m");
    }
  } else {
    stallAlertedAt = null;
    stallReconnectedAt = null;
  }

  // --- FR-G1 AC2: backup failure for >12h must reach the operator ------
  const verdict = evaluateBackupState(readBackupState(), now, startedAt, Boolean(config.BACKUP_RCLONE_REMOTE));
  if (verdict.stale && shouldAlert(backupAlertedAt, now)) {
    backupAlertedAt = now;
    void notifyOps(
      "Dataset backup is stale",
      `${verdict.reason}\n\nThe dataset is the project's single point of failure. Check ` +
        `logs/backup.log and the cron entry.`
    );
  }

  // Persist the dead-man clock so a restart cannot forgive an ongoing outage.
  try { setOpsState(LAST_EVENT_KEY, String(listener.lastEventAt)); } catch { /* non-fatal */ }

  // Advance the coverage mark. Written every tick rather than at shutdown,
  // because pm2 restarts and crashes never run a shutdown hook — which is why
  // the first windows recorded were all left claiming coverage forever.
  if (currentWindowId !== null) {
    try { touchIngestWindow(currentWindowId, windowEvents()); } catch { /* non-fatal */ }
  }

  // --- credit budget: find out BEFORE the allowance is gone --------------
  // On 2026-08-16 the recorder went blind for 22 minutes because the monthly
  // allowance ran out with nothing watching. Websocket traffic is billed at
  // 20 credits/MB and nothing knew how many bytes it was pulling.
  try {
    const drained = listener.meter.drain();
    if (drained.length) addCreditUsage(utcDay(now), drained);
    const mtd = monthToDateCredits(utcMonth(now));
    const verdict = evaluateBudget(mtd.total, config.HELIUS_MONTHLY_CREDITS);

    if (verdict.level !== "ok" && shouldAlertBudget(budgetAlertedAt, now)) {
      budgetAlertedAt = now;
      const top = Object.entries(mtd.bySource).sort((a, b) => b[1] - a[1])[0];
      void notifyOps(
        "Helius credit budget",
        `${verdict.message}\n\nTop consumer: ${top ? top[0] + " (" + Math.round(top[1]).toLocaleString() + ")" : "n/a"}` +
          `\nProfile: ${config.INGEST_PROFILE}, venues: ${listener.enabledVenues.join(", ") || "none"}`
      );
    }

    // Pace against the month. A profile that cannot afford a continuous
    // stream samples it instead — with the gaps recorded, never inferred.
    const pace = shouldPauseForBudget(mtd.total, config.HELIUS_MONTHLY_CREDITS, now);

    // The hard backstop, measured in bytes rather than credits. Everything
    // above depends on the 20-credits/MB rate being right, and that has never
    // been reconciled against Helius' own dashboard. This guard cannot be
    // defeated by that rate being wrong. It resets naturally at UTC midnight,
    // since the tally is per-day.
    const byteGuard = exceedsByteCeiling(bytesOnDay(utcDay(now)), config.MAX_STREAM_GB_PER_DAY);

    const reason = byteGuard.exceeded
      ? `Hard byte ceiling reached — ${byteGuard.reason}. Ingest is stopped until UTC midnight.`
      : pace.pause
        ? `Over budget pace — ${pace.reason}`
        : null;

    if (reason && !pausedFor && listener.enabledVenues.length > 0) {
      pausedFor = reason;
      if (currentWindowId !== null) { closeIngestWindow(currentWindowId, windowEvents()); currentWindowId = null; }
      listener.stop();
      logger.warn({ reason }, "ingest paused");
      void notifyOps(byteGuard.exceeded ? "Ingest stopped (byte ceiling)" : "Ingest paused (budget pace)", reason);
    } else if (!reason && pausedFor) {
      pausedFor = null;
      currentWindowId = beginWindow("resumed: within budget and byte ceiling");
      listener.start();
      logger.info("ingest resumed");
    }

    if (verdict.level === "critical95") {
      const shed = pickVenueToShed(mtd.bySource, listener.enabledVenues.filter((v) => !shedVenues.includes(v)));
      if (shed) {
        // Degraded ingest beats none. Never sheds the last venue.
        shedVenues.push(shed);
        logger.error({ shed, usedPct: verdict.usedPct.toFixed(1) }, "SHEDDING venue to preserve budget");
        void notifyOps("Shedding ingest venue", `${verdict.message}\n\nDisabled "${shed}" to preserve remaining credits.`);
      }
    }
  } catch (err) {
    logger.error({ err }, "credit meter failed");
  }

  // --- FR-J1 meta gauge --------------------------------------------------
  // Four local queries plus, at most once per UTC day, one Jupiter call. No
  // Helius credits, which is why this keeps working through an outage — and
  // why it must not mistake that outage for a cold market. See metaGauge.ts.
  if (now - metaTickAt >= META_TICK_MS) {
    metaTickAt = now;
    void tickMetaGauge(now)
      .then(({ day, verdict }) => {
        const previous = metaState;
        metaState = verdict.state;
        if (shouldAlertStateChange(previous, verdict.state, metaStateAlertedAt, now)) {
          metaStateAlertedAt = now;
          void notifyOps(
            `Meta state ${previous} → ${verdict.state}`,
            formatMetaVerdict(day, verdict) +
              (verdict.state === "COLD"
                ? `\n\nSignal arming is PAUSED — candidates are still recorded, but not delivered.`
                : previous === "COLD"
                  ? `\n\nSignal arming resumed.`
                  : ``)
          );
        }
      })
      .catch((err) => logger.error({ err }, "meta gauge failed"));
  }

  // --- FR-A6 exit-cost horizons -----------------------------------------
  // Derived from the alerts table, so a restart loses nothing and tokens long
  // past the 30-minute tracking window are handled normally.
  void sweepHorizonCosts(now).catch((err) => logger.error({ err }, "horizon cost sweep failed"));

  // --- daily alive ping: proves the alert path itself still works ------
  if (shouldSendAlivePing(lastAlivePingAt, now)) {
    lastAlivePingAt = now;
    const delta = windowDelta(stats, pingBaseline);
    pingBaseline = { ...stats };
    void sendTelegram(
      "meme-scout daily report",
      formatAlivePing(delta, (now - startedAt) / 3_600_000, {
        tracked: recorder.trackedCount,
        decodeFailures: pumpFunDecodeFailures(),
        backup: verdict.reason,
        meta: metaState,
        configHash: strategyHash,
      }),
      "info"
    );
  }
}, 60_000);

// ---- 6-hourly self-report (log only; the Telegram one is daily, above) ----
// Counters here are cumulative since process start, not per-window.
setInterval(() => {
  logger.info(
    {
      hours: ((Date.now() - stats.since) / 3_600_000).toFixed(1),
      byVenue: Object.fromEntries(stats.observedByVenue),
      rawOnly: stats.rawOnly,
      fullPipeline: stats.fullPipeline,
      passed: stats.passed,
      alerted: stats.alerted,
      cooldownSuppressed: stats.cooldownSuppressed,
      belowNotifyBar: stats.belowNotifyBar,
      // Should stay 0. A rise means pump.fun changed the CreateEvent layout
      // and we are silently dropping launches.
      pumpfunDecodeFailures: pumpFunDecodeFailures(),
      configHash: strategyHash,
    },
    "SELF-REPORT"
  );
}, 6 * 3_600_000);

logger.info(
  {
    configHash: strategyHash,
    fullPipeline: strategy.ingestion.fullPipelineSources,
    rawOnly: strategy.ingestion.rawOnlySources,
  },
  "meme-scout starting — tiered ingestion, decaying snapshots, cooldown alerts"
);
const projection = projectMonthlyCredits(resolveVenues(config.INGEST_PROFILE, strategy.ingestion.venues));
logger.info(
  {
    profile: config.INGEST_PROFILE,
    venues: listener.enabledVenues,
    projectedCreditsPerMonth: projection.total,
    monthlyBudget: config.HELIUS_MONTHLY_CREDITS,
    // Surfaced at startup so a misconfiguration is visible now rather than
    // when the allowance runs out ten hours later.
    withinBudget: projection.total <= config.HELIUS_MONTHLY_CREDITS,
    unmeasuredVenues: projection.unmeasured,
    hardByteCeilingGbPerDay: config.MAX_STREAM_GB_PER_DAY,
  },
  projection.total > config.HELIUS_MONTHLY_CREDITS
    ? "WARNING: projected credit burn EXCEEDS the configured monthly budget"
    : "projected credit burn is within budget"
);

// Restore the dead-man clock. Without this a crash-restart looks like a
// healthy start and the stall timer never elapses.
listener.lastEventAt = seedLastEventAt(
  listener.lastEventAt,
  Number(getOpsState(LAST_EVENT_KEY)) || null,
  Date.now()
);

if (listener.enabledVenues.length > 0) {
  currentWindowId = beginWindow(`profile=${config.INGEST_PROFILE}`);
}
listener.start();

// Release snapshot timers on shutdown so the process can exit and the single
// SQLite writer is given up cleanly.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    logger.info({ tracked: recorder.trackedCount }, "shutting down — releasing tracked tokens");
    if (currentWindowId !== null) {
      try { closeIngestWindow(currentWindowId, windowEvents()); } catch { /* best effort */ }
    }
    recorder.stop();
    process.exit(0);
  });
}
