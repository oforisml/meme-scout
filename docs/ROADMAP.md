# Roadmap — how we finish this

Rule for every phase: build it in a session with Claude, run it for real,
let the recorded data decide whether the next phase deserves to exist.

## Phase 1 — Recorder + filters + alerts  ✅ shipped
Exit criteria: runs unattended for 48h without crashing; tokens and
snapshots accumulate; alerts arrive on Telegram.

## Phase 2 — Complete the data + harden operations (2–3 sessions)
Gap analysis (2026-08-16) added workstream B; it blocks Phase 2 exit.

### Workstream A — data completion
1. Wire real values for the stubbed snapshot fields — ✅ shipped 2026-08-16
   - price_usd + liquidity_usd: both from one batched Jupiter price v3 request
     (50 mints/request, no Helius credits). Pool vault balances turned out to
     be unnecessary for liquidity.
   - holder_count from Helius DAS, as distinct owners rather than token
     accounts. NOTE: DAS lags a fresh mint badly, so the first read and the
     first assessment are deliberately delayed to 180s.
   - lp_burned_pct from LP mint supply (PDA of the pool).
   Carried three prerequisites the plan had not anticipated: tokens.pool was
   never captured, concentration counted the pool's own vault, and the RPC
   budget was already ~9x over the free tier before adding anything. All three
   are addressed — see DECISIONS.md 2026-08-16.
   Still open from this item: `minHolders` is untuned against real
   distributions, and pool identification is validated for PumpSwap only.
2. Add a `swaps` recorder: subscribe to pool activity for tracked tokens so
   volume, buy/sell pressure and unique buyers become computable.
3. Record Jupiter quotes at alert time (0.5 SOL standard size) — the honest
   slippage dataset.
4. Graduation detection: DONE at listener level (PumpSwap create_pool);
   LaunchLab program ID verified against Raydium's published addresses and
   live traffic — open decision #8 CLOSED 2026-08-16.
4b. Launch-window swap capture, first 20 slots (FR-H1) — feeds bundle
   forensics in Phase 3.
4c. Meta gauge (FR-J1) — ✅ shipped 2026-08-17. Four numbers recorded daily to
   `meta_daily`, a HOT/NORMAL/COLD/UNKNOWN state, COLD suppresses Telegram
   delivery (never recording), state changes alert the operator, and venue
   market share falls out of the daily row (AC2).
   Two biases had to be cancelled first, both pushing toward a false COLD:
   (a) our own outage looks exactly like a quiet market, so every rate is per
   COVERED HOUR and a window that delivered zero notifications counts as
   blindness rather than coverage — building this surfaced that
   `ingest_windows.events` was recording a cumulative process total instead of
   that window's own traffic, and that a 9.4h blind window on 2026-08-17 was
   being read as a confident COLD; (b) a token launched at 20:00 cannot
   graduate before midnight, so the rate that votes is a cohort rate over
   launches old enough to have had a fair chance.
   Still open: the bands are anchored on one 5.5h day of one regime and carry
   no outcome evidence; the SOL trend is dark until seven daily prices exist.

### Workstream B — operational hardening (FSD Module G)
5. Off-machine DB backups + restore drill — ⚠️ BUILT, NOT YET LIVE (2026-08-16).
   6h cron, VACUUM INTO (47ms, no downtime), gzip 7.6x, integrity check before
   upload, remote-landing verification, filename-based GFS pruning (16 six-hourly
   + 31 daily). AC1 restore drill PASSED; AC2 >12h Telegram alert PASSED.
   **Blocked on the operator**: rclone is not installed and BACKUP_RCLONE_REMOTE
   is unset, so nothing has left this machine yet. Until then FR-G1 is unmet.
6. Heartbeat/dead-man switch — ✅ shipped 2026-08-16. Telegram alert on a
   10-minute stall, plus a forced reconnect (it previously only logged), plus a
   daily alive+stats ping to prove the alert path itself still works. Also
   fixed: subIdToSource leaked across reconnects, no ws-level keepalive, and
   scheduleReconnect could stack timers.
7. CI (FR-G3) — ⚠️ WRITTEN, CANNOT RUN (2026-08-17). `.github/workflows/ci.yml`
   runs typecheck + 147 tests on Node 22, plus a second `hermetic` job that
   runs the suite with the environment stripped and fails if a test needs a
   secret or creates a database. `npm run ci` is the same sequence locally.
   Proved hermetic by running it the way CI would — clean `git archive`
   checkout, `npm ci`, `env -i`: 147/147 pass, no database created.
   Remote created and pushed 2026-08-17: `github.com/oforisml/meme-scout`,
   private, branch `main` (the workflow triggers on both `main` and `master`).
   Audited what was published — 70 files, no `.env`, no database, and neither
   the Helius key nor the Telegram token anywhere in the history.
   **Awaiting first observed run**: the repo is private and `gh` is not
   installed, so the run result cannot be read from here. FR-G3 is met once
   a green run is confirmed at
   github.com/oforisml/meme-scout/actions.
8. Deploy to an always-on host (FR-G4) — ⚠️ PREPARED, NO HOST (2026-08-17).
   `ecosystem.config.cjs` is now the canonical pm2 definition (one app, fork
   mode, backoff restarts, explicit log paths) and the recorder runs through
   it; pm2-logrotate is installed and configured (20M/14/compress).
   `scripts/migrate-host.sh` moves the dataset as a HANDOVER rather than a
   copy — stop, WAL checkpoint, VACUUM INTO, verify integrity and every
   table's row count on the target, then seal the source with
   `data/.migrated-to`, which `assertRuntimeConfig()` refuses to start past.
   Rehearsed locally: 12 tables, 84,126 rows, integrity ok both sides, guard
   confirmed to block and to release.
   The old bandwidth objection is withdrawn: 118 GB/day predates the byte
   ceiling, and `MAX_STREAM_GB_PER_DAY=2` caps it at ~60 GB/month.
   **Blocked on the operator**: no VPS exists. Until then FR-G4 is unmet.
9. Confirm HYPOTHESIS.md H1 — ✅ done 2026-08-17. H1 stands as written. H3 was
   RETIRED (it said graduations go to Raydium; they have gone to PumpSwap
   since 2025-03-20, and H4 already states the corrected claim with a
   measurable condition). The falsification protocol now measures the window
   in COVERED time from `ingest_windows` rather than wall-clock, reports gaps
   instead of interpolating them, and carries the FR-J1 `meta_daily` state
   alongside each outcome so a regime effect cannot masquerade as edge.

Workstream A is COMPLETE as of 2026-08-17. Workstream B is built out as far as
this machine allows. The git remote now exists (FR-G3 awaits only a confirmed
green run); what remains is `rclone config` (FR-G1) and a VPS (FR-G4).

Exit criteria: snapshots <10% null rate on the four wired fields; restore
drill passed; heartbeat verified by a forced stall; CI green; running
unattended on the VPS for 7 days.

## Phase 3 — Measurement, not trading (1–2 sessions, after ~2–4 weeks of data)
0. Bundle & sniper forensics (FR-H2..H4): bundled-supply %, deployer-funded
   sniper flags, sniper-saturation filter — computed from Phase 2 recorded
   launch windows, then evaluated like any other filter in the reports.
1. Outcome labeler: for every alerted AND rejected token, compute max return
   and return at 15/60/240 min horizons, and whether it rugged.
2. A small report script: precision of our filters (what % of passes rugged
   anyway? what did rejects do?), hypothetical P&L of "buy every alert" net
   of recorded Jupiter slippage and fees.
3. Tune thresholds against this data; version every threshold change in git.
Exit criteria: a written answer to "do alerts have positive expectancy net
of costs?" If NO — iterate filters or stop here with a great research tool.

## Phase 4 — Creator & wallet intelligence AND/OR narrative signals
(only if Phase 3 shows promise; choose track by what the Phase 3 evidence
says is missing)
Track B — narrative (FSD Module I): meme-family lexicon + tagging at
discovery, mention velocity from one social source, family-level volume
flow as a scanner feature, KOL watchlist (informational only). This is the
main non-commoditised alpha candidate — GMGN-class tools own on-chain
speed; nobody owns disciplined narrative timing.
Track A — wallets:
1. creators table: track repeat deployers across recorded history; serial
   rugger flag becomes a real filter instead of a wallet-age heuristic.
2. Early-buyer overlap: wallets that repeatedly appear in the first minutes
   of tokens that later did well — with fast score decay, assuming the
   signal is farmed/adversarial.

## Phase 5 — Paper trading (only if Phase 3/4 expectancy is positive)
Simulated fills using recorded Jupiter quotes at signal time. Position sizing
capped by recorded liquidity and fractional-Kelly. Default exits are barbell
(recover cost at 2x, trail the rest — FR-D2): the median winner still dies
and expectancy lives in the tail, so symmetric stop/target designs bleed out
by construction. Runs live alongside alerts for ≥1 month.
Exit criteria: paper P&L positive over ≥100 trades after costs.

## Phase 6 — Limited live execution (a separate, deliberate decision)
Only after Phase 5 passes. Separate signer process holding a wallet funded
with strictly disposable capital; per-trade and daily loss caps as code, not
discipline; global kill switch; reconciliation after every fill. We design
this together when — and only when — the data has earned it.

## Explicitly deferred indefinitely
Kafka, Kubernetes, microservices, ML models, correlation engines, regime
detection. Each may enter only when a measured problem demands it.

## Standing risks to keep honest about
- Latency: we enter after block-zero bots; Phase 3 measures whether edge
  survives that, rather than assuming it.
- Adversarial data: volume, holders and wallet track records are farmed.
- Most meme coins go to zero; a negative Phase 3 result is a success of the
  method, not a failure of the project.
- Single point of failure: until FR-G1 ships, the dataset lives in one file
  on one machine. Treat Phase 2 workstream B as urgent, not optional.
- Crowded market: GMGN/Photon/BullX/RugCheck exist. Personal edge = our own
  outcome dataset; product edge must be argued in FR-F0 before Module F.
- Operator discipline: phase gates are crossed only via a dated entry in
  docs/DECISIONS.md citing the evidence (FSD FR-G6). No exceptions during
  hype cycles — that is precisely when the rule matters.
