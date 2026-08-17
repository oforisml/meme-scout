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
   `minHolders` MEASURED 2026-08-17 and the open question is CLOSED: the 180s
   decision age holds up. Of 105 paired mints under 50 holders at 3 min that
   also had a 10 min read, only 2 reached 50; of the 16 reading exactly 0 at
   3 min, ZERO climbed above 0. The low group is genuinely sparse, not
   still-converging — the bar rejects dead tokens, not a DAS artifact, which
   is the opposite of what this item assumed. Distribution over 552 mints:
   p10 6, p25 18, median 167, p75 446, p90 707; 31% under the pass bar, 45%
   under the notify bar. Of the 485 mints with all three notify fields,
   LIQUIDITY is the binding constraint — 90% fail it, against 58% on top-10
   and 45% on holders, and holders is the sole failure for only 3%. Alert
   volume is set by `minLiquidityUsd`, not `minHolders`. Thresholds left UNCHANGED: nothing here is outcome
   evidence, and moving a bar on distribution alone would be the tuning this
   project has refused elsewhere.
   Found while measuring: holder counts saturate at 3000 (DAS 3x1000 pages)
   and `truncated` was computed then discarded, so a ceiling was stored as if
   it were a count. Now recorded in `snapshots.holder_count_truncated`;
   5 of 552 mints affected, all far above the floors in use. Top-10
   concentration is unaffected — it comes from `getTokenLargestAccounts`,
   not the paginated DAS list.
   Still open from this item: pool identification is validated for PumpSwap
   only.
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
   **Remote CI is blocked at the ACCOUNT level, not by this repository.**
   Both pushes produced a single `startup_failure` run with an empty workflow
   name and `path=BuildFailed`, no logs and no annotations — GitHub failed at
   the push event before dispatching to any workflow. Proven with a canary: a
   three-line workflow with no checkout, no actions and no expressions failed
   identically, and `actions/workflows/{ci,canary}.yml/runs` both report ZERO
   runs. actionlint is clean, Actions is enabled, `allowed_actions: all`.
   CAUSE CONFIRMED from the Actions UI: "The job was not started because
   recent account payments have failed or your spending limit needs to be
   increased." Escalated further on the next attempt to "your account is
   locked due to a billing issue." Nothing in any file, and no repository
   setting, can fix it — going public moved the failure from startup_failure
   to job-not-started but did NOT unblock it, and was reverted. It clears only
   in github.com/settings/billing. See DECISIONS.md 2026-08-17.
   FR-G3 is therefore met LOCALLY by `.githooks/pre-push` (npm run ci, 5s,
   verified to block a broken suite) and remains UNMET remotely until the
   account-level cause is cleared.
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
this machine allows. The git remote exists and pre-push enforcement is live;
what remains is an account-level Actions block (FR-G3, remote half),
`rclone config` (FR-G1) and a VPS (FR-G4).

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
