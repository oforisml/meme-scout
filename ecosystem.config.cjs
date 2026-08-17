// FR-G4 — pm2 process definition for an always-on host.
//
// `.cjs` deliberately: package.json sets "type": "module", and pm2 loads this
// file with require().
//
// ONE APP, NOT TWO. The read-only dashboard is intentionally absent. It opens
// its own read-only handle and must stay startable and stoppable independently
// of the recorder — the recorder must never gain a second responsibility, and
// the dashboard has to remain usable while the recorder is down, which is
// exactly when someone wants to look at it. Start it separately when wanted:
//
//   pm2 start npm --name meme-scout-web -- run dashboard
//
// The recorder holds the ONLY write handle on the SQLite dataset. Never raise
// `instances` above 1 and never enable cluster mode: two writers would produce
// two divergent datasets, which for a Phase 3 verdict is unrecoverable.
module.exports = {
  apps: [
    {
      name: "meme-scout",
      script: "npm",
      args: "start",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",

      // A crash loop must not masquerade as a healthy process. The recorder
      // exits non-zero on an uncaught exception by design (see
      // installCrashHandlers in src/logger.ts), and these settings let it
      // recover from a transient fault while still coming to rest — and
      // therefore alerting via FR-G2's dead-man switch — if it cannot.
      autorestart: true,
      max_restarts: 10,
      // Restarts inside this window count toward max_restarts; survive it and
      // the counter resets. 60s is comfortably longer than a startup failure
      // takes and far shorter than a real run.
      min_uptime: "60s",
      restart_delay: 5000,
      exp_backoff_restart_delay: 1000,

      // The recorder is long-lived and holds tracked-token state in memory;
      // a timed restart would drop it for no reason. It is restarted by the
      // operator or by a crash, never by the clock.
      cron_restart: null,

      // ~73 MB database, tracked-token maps, and the swap aggregator. A ceiling
      // well above normal use catches a genuine leak without killing a healthy
      // process during a burst.
      max_memory_restart: "700M",

      time: true,
      merge_logs: true,
      out_file: "logs/meme-scout-out.log",
      error_file: "logs/meme-scout-error.log",

      // Deliberately NOT set here: HELIUS_API_KEY and the rest live in .env,
      // which is gitignored. Putting them in a committed file is how keys leak.
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
