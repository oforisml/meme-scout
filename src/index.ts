import { assessmentToAlert, notify } from "./alerts/notifier.js";
import { lastAlertAt, markGraduated, saveAssessment, saveRawEvent, tokenExists } from "./db/db.js";
import { runPipeline } from "./filters/pipeline.js";
import { HeliusListener } from "./ingest/helius.js";
import { logger } from "./logger.js";
import { Recorder } from "./recorder/recorder.js";
import { assertRuntimeConfig } from "./config.js";
import { strategy, strategyHash } from "./strategy.js";

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
    if (strategy.ingestion.rawOnlySources.includes(launch.source)) {
      saveRawEvent(`${launch.source}.${launch.kind}.observed`, { signature: launch.signature, logs: rawLogs }, null, launch.slot);
      stats.rawOnly++;
      return;
    }

    // TIER 2 — full treatment for sources that earned it (graduations are
    // themselves a quality gate: most tokens die on the curve).
    stats.fullPipeline++;
    const resolved = await recorder.resolveAndRecord(launch, rawLogs);
    if (!resolved) return;

    // Dedup / linking: a PumpSwap graduation of an already-recorded token
    // links to it rather than duplicating it.
    if (launch.kind === "graduation" && tokenExists(resolved.mint)) {
      markGraduated(resolved.mint, resolved.signature, resolved.observedAt);
      logger.info({ mint: resolved.mint }, "graduation linked to recorded launch");
    }

    const snapshot = await recorder.snapshotNow(resolved.mint);
    recorder.track(resolved.mint);

    const assessment = await runPipeline(resolved, snapshot);
    saveAssessment(assessment);

    if (!assessment.passed) {
      logger.debug({ mint: resolved.mint, score: assessment.totalScore.toFixed(0) }, "filtered out");
      return;
    }
    stats.passed++;

    // Alert cooldown per mint — re-assessments within the window stay silent.
    const last = lastAlertAt(resolved.mint);
    const cooldownMs = strategy.alerts.cooldownMinutes * 60_000;
    if (last !== null && Date.now() - last < cooldownMs) {
      stats.cooldownSuppressed++;
      return;
    }

    await notify(assessmentToAlert(assessment));
    stats.alerted++;
  } catch (err) {
    logger.error({ err }, "pipeline error");
  }
});

// ---- heartbeat (FR-G2, minimal version) ----------------------------------
setInterval(() => {
  const silentMin = (Date.now() - listener.lastEventAt) / 60_000;
  if (silentMin > 10) {
    logger.warn({ silentMin: silentMin.toFixed(1) }, "HEARTBEAT: no events — websocket may be stalled");
  }
}, 60_000);

// ---- daily self-report ----------------------------------------------------
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
listener.start();
