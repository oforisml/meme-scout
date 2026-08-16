import { assessmentToAlert, notify, notifyOps, sendTelegram } from "./alerts/notifier.js";
import { evaluateBackupState, readBackupState, shouldAlert } from "./ops/backupWatch.js";
import {
  type Counters,
  evaluateStall,
  formatAlivePing,
  shouldForceReconnect,
  shouldRealertStall,
  shouldSendAlivePing,
  windowDelta,
} from "./ops/heartbeat.js";
import { lastAlertAt, markGraduated, saveAssessment, saveToken, tokenObservedAt } from "./db/db.js";
import { runPipeline } from "./filters/pipeline.js";
import { HeliusListener } from "./ingest/helius.js";
import { decodeCreateEvent, pumpFunDecodeFailures } from "./ingest/pumpfun.js";
import { logger } from "./logger.js";
import { Recorder } from "./recorder/recorder.js";
import { assertRuntimeConfig, config } from "./config.js";
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
      recorder.noteLaunch(created.mint, launch.slot);
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

// ---- heartbeat / dead-man switch (FR-G2) ---------------------------------
const startedAt = Date.now();
let backupAlertedAt: number | null = null;
let stallAlertedAt: number | null = null;
let stallReconnectedAt: number | null = null;
let lastAlivePingAt = Date.now();
let pingBaseline: Counters = { ...stats };

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
