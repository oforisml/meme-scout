import { assessmentToAlert, notify } from "./alerts/notifier.js";
import { lastAlertAt, markGraduated, saveAssessment, saveToken, tokenObservedAt } from "./db/db.js";
import { runPipeline } from "./filters/pipeline.js";
import { HeliusListener } from "./ingest/helius.js";
import { decodeCreateEvent, pumpFunDecodeFailures } from "./ingest/pumpfun.js";
import { logger } from "./logger.js";
import { Recorder } from "./recorder/recorder.js";
import { assertRuntimeConfig } from "./config.js";
import { strategy, strategyHash } from "./strategy.js";
import type { TokenLaunch, TokenSnapshot } from "./types.js";

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
    //
    // The CreateEvent in the logs gives us mint, creator and the on-chain
    // timestamp for free, so these are recorded as real tokens rather than as
    // raw log blobs with a null mint. They are deliberately NOT tracked or
    // assessed — that is what the raw-only tier exists to avoid.
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
      stats.rawOnly++;
      return;
    }

    // TIER 2 — full treatment for sources that earned it (graduations are
    // themselves a quality gate: most tokens die on the curve).
    stats.fullPipeline++;

    const resolved = await recorder.resolveAndRecord(launch);
    if (!resolved) return;

    // The old `tokenExists()` check here was always true — resolveAndRecord
    // had just inserted the row — so the linking branch never did anything,
    // and with pump.fun raw-only there was no launch row to link to anyway.
    //
    // Now the link is real and needs no existence check: saveToken uses
    // INSERT OR IGNORE, so if the pump.fun launch was already recorded its
    // original observed_at survives, and graduated_at - observed_at is a
    // genuine time on curve. markGraduated is idempotent (AND graduated_at IS
    // NULL), so calling it unconditionally is safe.
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

    // Record the t=0 snapshot for the time series, but do NOT judge on it.
    // Helius DAS has not indexed a brand-new mint yet and reports a near-zero
    // holder count — measured 2 at t=0 against 1404 for the same token ten
    // minutes later. The assessment runs on the metered refreshes instead,
    // the first of which is a minute in.
    await recorder.snapshotNow(resolved.mint);
    recorder.track(resolved.mint, (mint, snapshot) => {
      assess(resolved, snapshot).catch((err) => logger.error({ err, mint }, "assessment error"));
    });
  } catch (err) {
    logger.error({ err }, "pipeline error");
  }
});

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

  await notify(assessmentToAlert(assessment));
  stats.alerted++;
}

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
listener.start();

// Release snapshot timers on shutdown so the process can exit and the single
// SQLite writer is given up cleanly.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    logger.info({ tracked: recorder.trackedCount }, "shutting down — releasing tracked tokens");
    recorder.stop();
    process.exit(0);
  });
}
