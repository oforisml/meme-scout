# Decision log

Phase gates and material scope changes are recorded here (FSD FR-G6).
Format: date · decision · evidence cited · made by.

## 2026-08-16 · Adopt gap-analysis items into Phase 2
Gaps identified: no written edge hypothesis, no backups, no heartbeat, no
tests/CI, no deployment target, competitive positioning unproven, tax export
missing, gate discipline unenforced.
Resolution: HYPOTHESIS.md created; FSD Module G added (FR-G1..G6 blocking
Phase 2 exit); FR-F0 gates Module F; ROADMAP Phase 2 split into workstreams
A (data) + B (hardening). Phase 3 recording window starts only when both are
live.
Made by: Operator + Claude.

## 2026-08-16 · Trader-lens gap analysis adopted
Findings (web-verified): pump.fun graduations go to PumpSwap since
2025-03-20, not Raydium; LetsBonk (Raydium LaunchLab) is the clear #2
launch venue; bundle/same-block-sniper forensics is the highest-value
missing filter; narrative/attention data is the main non-commoditised
alpha candidate; exits must encode power-law (barbell) economics; the
regime gauge is four concrete numbers, not abstract classification.
Resolution: listener now subscribes to pump.fun + PumpSwap + LaunchLab +
Raydium v4 with graduation kind tracking; FSD gains Modules H (bundle
forensics), I (narrative), J (meta gauge); FR-D2 defaults to barbell exits;
HYPOTHESIS.md gains H4-H6; traceability and open decisions updated.
Made by: Operator + Claude.

## 2026-08-16 · First-run hardening implemented
Motivation: ~20-30k launches/day would exhaust any RPC budget under
uniform treatment, and unversioned thresholds break auditability.
Changes: tiered ingestion (raw-only vs full-pipeline sources, policy in
versioned strategy.config.json whose sha256 is stored on every assessment);
decaying snapshot cadence (5s/15s/1m/5m bands); mint-level dedup with
launch→graduation linking; per-mint alert cooldown (60 min default);
minimal heartbeat warning + 6-hourly self-report; SOL/USD price cache
(Jupiter, 60s TTL); 12 unit tests covering all filters and pipeline
short-circuiting, runnable offline (config validation moved from import
time to startup). FR-G2 partially satisfied (log-level heartbeat; Telegram
dead-man ping remains a Phase 2 task). FR-G3 partially satisfied (tests
exist; CI pipeline remains Phase 2).
Made by: Operator + Claude.

## 2026-08-16 · Repository created (FR-G6 precondition)
Evidence: the project had never been under version control. The only git
repository was a stray root-owned /.git at the filesystem root containing two
unrelated commits; meme-scout/ was untracked. RUNBOOK's "edit
strategy.config.json and COMMIT it — never tweak live", FR-G6 phase-gate
discipline and NFR-7 reproducibility-from-config-hash were therefore all
unsatisfiable: the hash was computed but no history could resolve it back to a
threshold set.
Resolution: `git init` in meme-scout/, baseline commit of the Phase 1 tree.
data/, .env and node_modules stay ignored.
Made by: Operator + Claude.

## 2026-08-16 · Insufficient data is not a pass
Evidence: after ~25 minutes of live running, all 601 snapshots were 100% null
on liquidity_usd, price_usd, holder_count and lp_burned_pct. 14 of 27
assessments "passed" and alerted at scores around 53/100 on evidence reading
"Liquidity unknown — treat with caution" and "Holder concentration unknown" —
one of them on a token the creator filter simultaneously described as "a fresh
throwaway wallet — common rug pattern". Only mintAuthority could veto;
minLiquidityUsd and minHolders were dead thresholds because their inputs were
always null. `passed` meant "nothing could disprove it".
Resolution: null filter inputs now fail rather than degrade to a pass, with an
`insufficientData` discriminator on FilterResult so Phase 3 can separate "we
judged this and said no" from "we never knew". Unevaluable filters are excluded
from the score rather than averaging in a middling value. One exception, chosen
deliberately: a failed creator RPC lookup reports an infrastructure fault, not a
property of the token, so it does not veto — creator was non-null on all 35
recorded tokens, so failing closed on a null creator costs nothing real.
Consequence accepted: alert volume falls, possibly to near zero at first. That
is the honest signal.
Made by: Operator + Claude.

## 2026-08-16 · Four market fields wired (FR-A1..A4)
Findings from live probing, not documentation:
- Jupiter price v3 indexes brand-new mints. A sample of the 10 most recently
  observed tokens, aged 0.8–6.6 minutes, returned usdPrice AND liquidity for
  all 10. One request covers 50 mints and costs no Helius credits, so
  price_usd and liquidity_usd need no pool-vault reads at all. Observed
  liquidity spread $4–$69.6k, i.e. minLiquidityUsd=10000 is immediately
  discriminating (it would have rejected 7 of those 10).
- tokens.pool was null for 100% of rows. The pool is recoverable from the
  launch transaction already being fetched, but NOT by account index: across 4
  real graduation transactions the PumpSwap CreatePool instruction carries 18
  accounts and index 3 held WSOL in half of them. It is now identified
  structurally and confirmed by checking that its derived LP mint
  (PDA ["pool_lp_mint", pool]) exists — without that gate an unrelated wallet
  appearing in a PumpSwap instruction gets recorded as the pool, which was
  observed on live traffic.
- top10_holder_pct counted the pool's own vault. Measured on a real graduated
  mint: top-1 = 79.3%, top-10 = 99.99% against a 40% threshold. Excluding the
  vault moved one token from 87.5% to 27.7% — from rejected to passing. Under
  the new strict rule this would otherwise have rejected essentially every
  token. Concentration is now reported as unknown when the pool is
  unconfirmed, rather than as a number known to be wrong in one direction.
- holder_count comes from DAS getTokenAccounts (parameter object passed bare,
  NOT array-wrapped). It counts token accounts, but minHolders is about
  people, so distinct owners are stored instead. minHolders=50 has NOT been
  retuned against real distributions and should not be trusted yet.
- lp_burned_pct is derived from LP mint supply. An initial 2-pool sample
  suggested it was a structural 100% for all PumpSwap graduations; a wider
  sample disproved that (2 of 3 pools had non-zero LP supply), so the field is
  genuinely informative and is recorded for all venues. Limitation: a pool
  with outstanding supply is recorded as 0% burned even if part was burned —
  the conservative direction.
Made by: Operator + Claude.

## 2026-08-16 · Snapshot horizon cut 1h → 30min; metered reads moved off the tick
Evidence: measured arrival was 1.82 full-pipeline tokens/min → ~109
concurrently tracked at a 1h horizon; ~59 snapshots/token/hour × 2 RPC calls
≈ 12,900 calls/hour ≈ 9.3M/month, against a Helius free tier of 1M
credits/month, 10 RPC req/s and 2 DAS req/s. The budget was already ~9x
oversubscribed BEFORE adding four fields, and a rate-limited field records as
null — which would have defeated the very exit criterion being chased.
Resolution: price/liquidity refresh every tick (batched, credit-free); chain
state and holder count refresh only at fixed token ages (0s/300s/1500s) and
are carried forward in between, stamped with chain_state_at / holder_count_at
so a carried value never looks fresher than it is. Horizon cut to 1800s.
Recorder gains untrack()/stop(), which never existed — nothing could stop
spending on a token that had already died, and there was no shutdown drain.
Snapshots in the 30–60 min band were chosen as the thing to lose: they sit in
the sparse cadence tail and Phase 3's shortest labelling horizon is 15 min.
Note this is still tight against 1M/month; if arrival rate rises materially the
next lever is the Developer plan.
Made by: Operator + Claude.

## 2026-08-16 · Assessment moved off t=0 onto the metered refreshes
Evidence: the first live run of the wired recorder returned holder_count = 2
for two freshly graduated tokens. Re-querying DAS for the same mints ten
minutes later returned 6 and 1404. Helius DAS has simply not indexed a
brand-new mint's token accounts at the moment we observe it, so a t=0 holder
count is not a small number — it is a wrong one. Combined with the new strict
rule, judging at t=0 would have rejected essentially every token for a reason
that was an artifact of indexing lag.
Second problem exposed by the same finding: the pipeline only ever ran once,
immediately after resolution. That meant the system could only ever judge a
token on the worst-quality data it would ever hold, and never revisited it.
Resolution: holdersAtSec now starts at 60s rather than 0 (chainStateAtSec stays
at 0 — plain RPC is accurate immediately). The t=0 snapshot is still recorded
for the time series but is no longer judged. The pipeline now re-runs on each
metered refresh (60s / 300s / 1500s) via a callback from the recorder, guarded
by the existing per-mint alert cooldown. Judging on every tick was rejected: it
would re-run the creator RPC ~50 times per token.
Consequence accepted: alerts now arrive at least ~60s after graduation. This is
consistent with the standing latency risk already recorded in ROADMAP — we
enter after block-zero bots by design, and Phase 3 measures whether edge
survives that rather than assuming it.
Made by: Operator + Claude.

## 2026-08-16 · Post-wiring verification run (28.6 min, 74 mints, 2155 snapshots)
Measured per field over the rows where that field was in scope — NOT naively over
all v2 rows, which can never hit the target because every token contributes
null-headed rows before Jupiter indexes it and before the 180s metered marks.
- holder_count: 0% null (736 rows in scope)
- top10_holder_pct and lp_burned_pct: 8.7% null each — the same 64 rows, i.e.
  exactly the tokens whose pool could not be confirmed. Under the 10% target.
- liquidity_usd by token age: 31.6% null under 30s, 1.9% at 30-120s, 0% past
  120s. Assessments run at 180s+, so liquidity is fully populated at decision
  time.
- price_usd: 35.2% / 9.5% / 17.0% across the same bands. The rise in the oldest
  band is real, not a regression: tokens that die lose their Jupiter route, and
  a token with no route has no honest price. No filter consumes price_usd.
- Pool confirmation: PumpSwap 69/69 (100%). LaunchLab 0/5, as expected and
  documented — extraction is not validated for that venue, so those tokens
  record unknown rather than a guess.
Assessment outcomes: 86 assessments over 63 mints, 7 passed, 6 alerts.
**Zero insufficientData across all 86** — every rejection was on evidence, so no
data source was silently failing. Liquidity was the dominant rejector (70 of
86), consistent with most graduations sitting below the $10k floor.
Pass rate fell from 52% on null data to 8%. That is the intended effect.
Claim being made: the wiring works and fields populate on matured rows. NOT the
Phase 2 exit criterion, which still requires the 7-day unattended run.
Made by: Operator + Claude.

## 2026-08-16 · raw_events retention — decode launches instead of storing logs
Evidence: `raw_events` held 4118 rows at 7.5 KB each — 30.4 MB of a 34 MB
database (89%), growing 443 MB/day — with `mint` NULL on every row because
`saveRawEvent` is called with null at both call sites. The table was
simultaneously the largest object in the database and unjoinable. Nothing in the
repo has ever read it. At that trajectory FR-G1 backups would have replicated
log spam, and ARCHITECTURE.md's "SQLite → Postgres above 10 GB" trigger would
have fired in ~23 days for noise rather than data.
Finding that reframed the task: pump.fun emits an Anchor CreateEvent in the logs
we already receive. Decoding it yields mint, creator, name/symbol/uri, the
on-chain timestamp and the bonding-curve reserves at ZERO RPC cost. Verified
across the stored corpus: 4172 CreateEvents decoded, 0 failures. So the change
is not "discard data" but "store ~250 bytes of queryable fields instead of
7.5 KB of unusable ones".
Resolution:
- pump.fun launches are recorded as real `tokens` rows (operator decision).
  4103 historical launches were recovered from stored logs by an additive
  backfill preserving their original observed_at.
- The ingest heuristic now asks the decoder. The old substring test matched
  "Instruction: Create", which also matches "CreateIdempotent" from ordinary
  buys: **27% of what we recorded as pump.fun launches were trades**. FR-J1's
  launches-per-venue was inflated by exactly that, and now derives from
  `tokens.source` rather than a parsed `raw_events.kind` string — a real column,
  and finally accurate.
- The launch→graduation link works for the first time. The old check called
  `tokenExists()` *after* `resolveAndRecord` had inserted the row, so it was
  always true and the branch was a no-op; with pump.fun raw-only there was also
  no launch row to link to. Verified on a copy: a graduation against a recorded
  launch preserves observed_at and yields a correct 47.0 min time on curve.
- `chain_ts` is stored beside `observed_at`. The gap is our observation latency,
  ROADMAP standing risk #1, now measured rather than assumed: **p50 2.6s, p90
  3.0s** over 4172 events.
- Existing rows were NOT modified or deleted. NFR-1 forbids overwriting stored
  observations, and reclaiming 30 MB is not worth that guarantee; growth was the
  problem and it is fixed going forward. No VACUUM.
Correction recorded: `b1310cd2a076a774` was initially accepted as a second
create-shaped discriminator. It is not one — its body begins with an i64 unix
timestamp rather than a length-prefixed name — and it produced 112 decode
failures against the corpus with zero extra launches. Only
sha256("event:CreateEvent") = `1b72a94ddeeb6376` is accepted. This is why the
corpus replay runs before any write.
Query semantics changed: "did it graduate" is now `graduated_at IS NOT NULL`,
never `kind='graduation'` — INSERT OR IGNORE means first observation wins, so a
token whose launch we saw keeps source='pumpfun', kind='launch'. Documented in
DATA_MODEL.md and RUNBOOK.md.
Made by: Operator + Claude.

## 2026-08-16 · FR-G1 backups implemented; open decision #6 half-closed
Motivation: after the field wiring and the retention change, the database holds
real market data, 4103 recovered pump.fun launches and the only record of our own
observation latency — and it existed in exactly one place, on one laptop, with no
backup. ROADMAP lists this as a standing risk and calls workstream B "urgent, not
optional".
Operator decisions: destination is **cloud object storage via rclone**; RPO is
**6h snapshots**, not continuous replication. That closes the backup half of open
decision #6; the VPS half stays open for FR-G4.
Design and the measurements behind it:
- `VACUUM INTO` measured **47ms** on the 55 MB live database, WAL unchanged and
  integrity clean, so backups need **no recorder downtime**. `.backup` measured
  36ms and would also do; VACUUM INTO was chosen because it defragments too. A
  plain `cp` would have been wrong — it drops the ~4 MB of uncheckpointed commits
  in the -wal.
- The database gzips **7.6x** (55 MB -> 7 MB), so 16 six-hourly plus 31 daily
  copies cost ~1.5-2 GB, inside the B2/R2 free tiers.
- Pruning is by the UTC timestamp in the filename, deliberately NOT
  `rclone delete --min-age`: object mtime is set at upload by most backends
  rather than preserved, so a re-uploaded daily copy would be aged wrongly.
- The script verifies the object actually landed (`rclone lsjson`, size match)
  before recording success. "rclone exited 0" is not the same as "it is in the
  bucket", and FR-G1 is specifically about being off-machine.
- The script is shell, not TypeScript, because importing `src/db/db.ts` opens a
  second read-write connection and runs DDL against a file that must have one
  writer.
- No encryption: the dataset is public on-chain observation and by RUNBOOK
  invariant 3 never contains keys, so gpg would add key-loss risk protecting
  nothing. `.env` is not backed up.
AC1 (restore drill) — **PASSED**, verified against a real artifact: integrity ok,
all five tables matching live (tokens 6591/6591, snapshots 17069/17070,
raw_events 6163, assessments 803, alerts 89), sidecar manifest consistent, and
the restored copy queryable (392 graduated tokens).
AC2 (>12h failure alerts) — **PASSED end-to-end**: a backdated marker produced
`stale: true` with the reason naming the failing step, and Telegram delivery
returned true. Re-arm confirmed: suppressed at +1min, fires again at +7h.
Bug found and fixed while doing this: the Telegram POST never checked the
response, and `fetch` does not throw on 4xx/5xx — so a revoked bot token or wrong
chat id failed **completely silently**. Both AC2 and FR-G2's "daily ping shall
confirm end-to-end delivery" rested on that call. The transport is now extracted
as `sendTelegram()` with a `res.ok` check, and `notifyOps()` sends operational
alerts without writing an `alerts` row (that table means "a token we alerted on",
and `alerts.mint` is NOT NULL).
Known limitation, recorded rather than papered over: the staleness check runs
inside the recorder, so it catches a broken cron job or failing uploads but
cannot fire if the machine is off — precisely when you would most want it. A true
dead-man needs a third party; FR-G2's daily alive ping narrows the gap.
Still outstanding for FR-G1 to be genuinely satisfied: rclone is not installed and
no remote is configured, so nothing has yet left this machine. Everything else is
built and tested; `BACKUP_RCLONE_REMOTE` is the only missing piece.
Made by: Operator + Claude.

## 2026-08-16 · FR-G2 heartbeat: detect, alert AND heal
Motivation: the heartbeat detected a 10-minute ingest stall and wrote a log
line — nothing more. Under pm2, unattended, that means a dead recorder stays
dead until somebody happens to look at the logs, which is exactly the scenario
the 7-day unattended run in the Phase 2 exit criteria depends on not happening.
Changes:
- Stall now alerts over Telegram (via the notifyOps path built for FR-G1) and
  forces a websocket reconnect. Alerting re-arms at 30 min, reconnecting at
  5 min: heal more eagerly than we nag, but not on every 60s tick.
- Daily alive+stats ping. Reports the last 24h as a window rather than
  ever-growing cumulative counters, so "did anything happen today" is
  answerable at a glance. This is the half that looks like noise and matters
  most: it is the only signal separating "nothing went wrong" from "the alert
  path is broken". It also narrows the FR-G1 limitation where a recorder-side
  check cannot tell you the machine is off — if the daily report stops, that
  IS the alert.
- The 6-hourly log SELF-REPORT was labelled "daily" in a comment; corrected.
Listener bugs found while doing this:
- `subIdToSource` was never cleared on reconnect, leaking entries and risking
  a fresh subscription id mapping onto a stale venue.
- No websocket-level keepalive. A TCP connection can die without ever emitting
  "close", which is precisely the "indistinguishable from a quiet market"
  failure FR-G2 describes. Added ping every 30s, terminate after 90s of no pong.
- `scheduleReconnect` could stack timers; now guarded by a single pending timer.
Design flaw caught before shipping: resetting `lastEventAt` on socket open would
have prevented reconnect loops, but it would also have masked the failure this
mechanism exists to catch — a socket that opens fine and then delivers nothing
(bad key, dropped subscription, silent server). `lastEventAt` is left untouched
on connect and the reconnect is rate-limited instead.
AC ("Killing the websocket produces a Telegram warning within 12 minutes") —
**PASSED, wall-clock verified**, not asserted. A second instance was run against
a throwaway database with a deliberately invalid Helius key so it could never
receive an event. Started 18:14:09, stall detected 18:24:09 at exactly
silentMin 10.0, Telegram "Ingest stalled" sent, forced reconnect logged. 28
reconnect attempts over the window with correctly capped backoff and no stacked
timers. 10m0s against a 12-minute requirement.
Made by: Operator + Claude.

## 2026-08-16 · Swap recording shipped (FR-A5 + FR-H1) — H1 becomes testable
Motivation: H1, the primary hypothesis, is stated as "unique-buyer growth
without wash signatures", and H4 as "continued 10-min unique-buyer growth".
Nothing recorded a single swap, so H1 was untestable no matter how long the
recorder ran. Every hour without it was an hour of data that could not answer
the main question.
Finding: both venues emit Anchor events on log subscriptions we already hold,
so this costs ZERO extra RPC — the same shape of finding as CreateEvent.
Measured live before building: PumpSwap 222.7 swap events/s (13,249/13,249
decoded, no failures), pump.fun 37.7 TradeEvents/s, and of the PumpSwap total
82/s belong to our ~52 tracked pools.
Storage is hybrid because raw-everything is not survivable: tracked-token swaps
alone are 7.1M rows/day (~568 MB), worse than the raw_events problem fixed
earlier the same day. Per-minute buckets carry the tracking window; raw rows
are kept only in bounded launch windows. `new_buyers` per bucket IS H1's
metric.
Rejected after testing: per-pool `logsSubscribe` as a bandwidth escape. Five
pools alone produced 12.6 GB/day, because our tracked tokens ARE the hot ones
(37% of all PumpSwap swap volume). The ~104 GB/day inbound is inherent.
Two failure modes designed against rather than discovered in production:
- A pool trades before we resolve pool → mint, so its earliest swaps — exactly
  the launch window — arrive unattributable. They are buffered and replayed on
  resolution; rows already written with a null mint are backfilled.
- Bucket flushing is driven by the snapshot timer, not swap arrival. A token
  that stops trading is the interesting case and an arrival-driven flush would
  never emit its final, most informative bucket.
**Bug found in live data and fixed: PumpSwap pool pair orientation is not
fixed.** Single swaps were being recorded as 31,772 SOL on fresh memecoins.
Most pools are (memecoin base / WSOL quote) but some are created reversed, and
swap events report the two amounts positionally — so a token amount was being
divided by 1e9 and stored as SOL. Caught by noticing the "amounts" drifted
slowly across consecutive sells, which is the signature of a reserve rather
than a trade size, then reading the Pool account and finding base_mint = WSOL.
The decoder no longer guesses: it returns raw positional amounts and
`denominate()` resolves them once the pair is known. Orientation is read from
the Pool account, folded into the existing confirmation round trip via
`getMultipleAccounts([pool, lpMint])`, so it REPLACES the getTokenSupply call
rather than adding one — no RPC budget change — and confirms the pool more
directly than the LP-mint existence check alone.
1845 PumpSwap swap rows and 60 buckets written by that bug were deleted rather
than left to poison the dataset. They were minutes old and provably wrong; this
is a deliberate, narrow exception to NFR-1, which protects valid observations,
not known-corrupt ones. pump.fun rows (single fixed layout) were unaffected and
kept. Post-fix amounts are plausible: buys avg 0.31 SOL, sells avg 0.43 SOL.
Volume: adds roughly 66-116 MB/day, a 6-10x increase in database growth, which
also enlarges every FR-G1 backup. The four dials in `strategy.config.json`
(bucketSec, pumpswapRawWindowSec, pumpfunRawWindowSlots, maxRawPerToken) exist
so this can be tuned; measured trades within 20 slots of a launch run mean
18.7 / median 8 / p90 35 / max 194, so maxRawPerToken=250 trims the tail
without touching the typical case. **Re-measure real growth after 24h.**
Flag recorded for FR-G4: ~104 GB/day inbound ≈ 3.1 TB/month exceeds the
included transfer on most VPS plans, and is not reducible while swap data comes
from logsSubscribe. That constrains the other half of open decision #6.
Made by: Operator + Claude.

## 2026-08-16 · FR-A6 execution-cost sampling shipped
Motivation: Phase 3's exit criterion is a written answer to "do alerts have
positive expectancy NET OF COSTS?". Swap recording made the return side
measurable earlier today; the cost side was not recorded at all. Like the rest
of this dataset it cannot be reconstructed later — you cannot ask what 0.5 SOL
would have cost on a pool that no longer exists.
Implementation: at each alert the standard 0.5 SOL buy is quoted BEFORE the
message is sent, so the Telegram alert carries the real cost, and both the buy
and an immediate sell are persisted. Measured latency 371-648ms against the 2s
AC. Failures are recorded rather than thrown (the AC requires this) and never
suppress the alert: the candidate passed the filters on its own evidence, and a
Jupiter outage is not a fact about the token.
Operator decision: capture REAL exit quotes at 15/60/240 min, not only FR-B3's
modelled "entry impact x2". Rationale: memecoin liquidity decays fast, so the
x2 model errs optimistic in exactly the direction that encourages trading, and
at ~1.2 quotes/min against a 60/min limit the measurement is nearly free.
Design notes worth keeping:
- The t=0 sell is recorded but labelled a REFERENCE POINT, not an observed exit
  cost. Quoting straight back out hits the same pool state, so it largely
  restates the entry impact rather than testing it. First live sample: buy
  impact 1.98%, sell-back 0.10%, round trip 0.5 -> 0.4896 SOL = 2.08% — versus
  FR-B3's x2 model of 3.96%. At t=0 the model over-estimates; whether it
  under-estimates at 60 and 240 minutes is precisely what the horizon rows will
  settle.
- Horizons are derived from the alerts table, not from in-memory timers or a
  job queue. 240 min far exceeds the interval between pm2 restarts, so this is
  restart-safe by construction and self-heals after downtime. It also handles
  tokens long past the 30-minute tracking window, which is the normal case for
  the later horizons rather than an error.
- The sell prices THAT alert's position (the entry quote's outAmount). A fixed
  token amount would make the series incomparable across tokens. Alerts whose
  entry quote failed are skipped — there is no position to price.
- The unique index is keyed on alert_id, NOT mint. The cooldown is 60 min but
  horizons run to 240, so one mint can legitimately alert twice with
  overlapping windows; a mint-keyed index would silently drop the second
  series.
Units discipline, applied after the swap-orientation bug earlier today: Jupiter
reports `priceImpactPct` as a decimal FRACTION despite the name. Calibrated
against a deep pair (SOL->USDC at 0.5 SOL returns 0.0000126 = 0.00126%) and
converted once at parse time, so the stored column means what it says. A value
of exactly 1 is 100% — a dead or unroutable pool, observed live — and is kept
as a finding rather than discarded.
First horizon results (n=2, an early signal, NOT a finding) already justify the
decision to measure exit cost rather than model it:
- `91jzP7JTAG`: entry impact 0.59%, so FR-B3 would model the exit at 0.59%.
  Measured at 15 min: **exit impact 99.999%** — selling the position returned
  7,836 lamports against 0.5 SOL in. The pool was gone. The x2 model does not
  merely under-estimate here, it misses the dominant execution risk entirely:
  that you cannot exit at all.
- `HGED1nwbXf`: entry 1.62%, measured 15-min exit impact 1.10%. Pool still
  liquid; the model slightly over-estimates. This is the benign case.
Caveat to carry into FR-B3: round-trip *value* loss (44% and 100% for these
two) conflates price movement with execution cost. The cost question is the
impact column; the value column belongs to the outcome labeler (FR-B1). Do not
report one as the other.
Made by: Operator + Claude.

## 2026-08-16 · Notify bar separated from pass bar (NOT a threshold tune)
Problem: the channel was firing ~415 times/day (~17/hour). A channel you learn
to ignore is worse than no alerting — the same argument FR-G2's daily ping
rests on.
Measured first, over 485 mints with complete data at decision time (~4h):
- liquidity p10 $0, p25 $4, p50 $5,978, p75 $9,514, p90 $29,444
- holders p10 12, p25 58, p50 216, p90 727
- top-10 concentration p10 7.8%, p25 17.3%, p50 53.1%, p90 99.9%
Current gates reject: liquidity <$10k → 365/485 (75%), top-10 >40% → 268/485
(55%), holders <50 → 113/485 (23%), authorities → 0/485. So liquidity is the
dominant gate and `minHolders: 50` sits near p22 — it is the loosest gate, not
a mis-set one as previously suspected.
**Rejected approach: raising the pass thresholds.** Alert volume is also the
FR-A6 execution-cost sampling rate, because quotes only fire on alerts.
Tightening the pass bar to quieten the phone would have cut the cost dataset by
the same factor, and cut it exactly at the marginal candidates that reveal
where the liquidity cliff is. It would also have committed threshold numbers
derived from four hours of a single market regime with no outcome evidence.
Resolution: passing still decides what the DATASET records — every pass gets an
alerts row and cost quotes, unchanged at ~415/day — and a new `alerts.notify`
block decides only what reaches Telegram. Set to $30,000 / 30% top-10 / 175
holders, which the same 485-mint sample puts at ~52 deliveries/day, inside the
operator's stated 40–70 target.
`alerts` gains a `notified` column. The per-mint cooldown now counts delivered
alerts only: a row held below the bar must not silence a later genuine
notification, since a token whose liquidity and holder count improve between
the 180s and 600s assessments is precisely the case worth hearing about.
**Explicitly NOT claimed:** that these numbers improve expectancy. They are a
capacity choice about how many messages are readable. Expectancy tuning
requires outcome data and belongs in Phase 3 (FR-B4), per ROADMAP. Revisit then
with the real distribution of horizon exit costs and outcomes.
Made by: Operator + Claude.

## 2026-08-16 · Credit exhaustion outage; ingest scope made selectable
Incident: ingest stopped at 20:13:48 and the recorder was blind for 22 minutes
before it was noticed manually. Helius returned `HTTP 429: max usage reached` —
not a rate limit, but the monthly credit allowance consumed in about ten hours.
Root cause, and a correction to earlier work in this repo: **Helius meters
WebSocket usage at 2 credits per 0.1 MB streamed (20 credits/MB).** The RPC
budget analysis recorded earlier today counted CALLS and never counted the
stream, which is where effectively all the spend goes.
Measured inbound: PumpSwap 104 GB/day (62M credits/month), pump.fun 13.5 GB/day
(8.1M/month), total ~71M/month against allowances of 1M free / 10M at $49 /
100M at $499. That is 70x over the free tier, i.e. ~10 hours of life — matching
the observed outage almost exactly. PumpSwap alone is 88% of it, because
logsSubscribe delivers every transaction touching a program and we use well
under 1% of them. Per-pool subscriptions were tested as an escape and rejected:
five pools alone produced 12.6 GB/day, since our tracked tokens are the hot ones.
Operator decision: "make all of the options optional at setup" — so this is not
a tier choice, it is configurability plus instrumentation.
Resolution:
- `INGEST_PROFILE` (free | developer | business | custom) presets per-venue
  subscription toggles; `custom` defers to strategy.config.json. Startup logs
  projected monthly burn against `HELIUS_MONTHLY_CREDITS`, so a misconfiguration
  is visible immediately rather than ten hours later. Verified: the developer
  profile on a 1M budget logs "projected credit burn EXCEEDS the configured
  monthly budget", 8.1M vs 1M.
- Dropping PumpSwap does NOT cost graduation detection. Migration transactions
  mention pump.fun too — verified against 112 stored rows carrying PumpSwap's
  CreatePoolEvent — so the pump.fun stream now routes them into the full
  pipeline. What the cheaper profiles genuinely lose is post-graduation swap
  capture (H4's continued unique-buyer growth). H1 remains testable on
  curve-phase buyer growth.
- Credit meter: counts streamed bytes per venue (accumulated in memory, not per
  message — at ~437 notifications/sec a row each would cost more than it
  measures), plus RPC at 1 and DAS at 10 credits; persists daily totals so
  month-to-date survives restarts; warns at 50/80/95% via notifyOps; sheds the
  most expensive venue at 95%, never the last one, because degraded ingest
  beats none.
- Budget pacing makes the `free` profile honest rather than aspirational: no
  continuous subscription fits 1M/month, so ingest pauses when month-to-date
  runs ahead of a straight-line pace and resumes when the clock catches up.
  Coverage is written to `ingest_windows` so Phase 3 can distinguish "nothing
  launched" from "we were not looking" — without that, sampling would silently
  corrupt every rate derived from the data, FR-J1's gauge included.
Bug caught during implementation and worth remembering: the listener's
`subscriptions` field initializer referenced a constructor parameter property.
Under ES2022 class fields the initializer runs before that property is
assigned, so it threw at construction. Typecheck passed; only running it found
it.
Still outstanding: the recorder cannot ingest until the allowance resets or the
account is upgraded, and the meter's calibration has NOT been checked against
Helius' own dashboard — until it has, treat its numbers as an estimate.
Disclosure: diagnostic probes run during this session opened several
short-lived firehose connections and consumed some credits; at 2.36M/day from
the recorder itself that is not the dominant cost, but it is not nothing.
Made by: Operator + Claude.

## 2026-08-16 · Dead-man clock persisted — the FR-G2 hole closed and verified
Evidence: FR-G2 shipped earlier today and its acceptance criterion was verified
at 10m0s wall clock. It still failed during the credit outage the same
afternoon. The stall detector kept "last event seen" in memory only, so the
restart at 20:28 reset the clock and the 10-minute timer never elapsed — the
recorder was blind from 20:13 and said nothing for 22 minutes. The AC was met
and the mechanism was defeated anyway, because the AC tested a single
uninterrupted process and the real failure involved a restart mid-outage.
Resolution: the clock is written to a new `ops_state` table on each heartbeat
and restored at startup, taking the OLDER of the in-memory and persisted
values. A persisted timestamp in the future — clock skew, or a database
restored from backup — is ignored rather than trusted, since believing it would
push the clock forward and mask a real outage.
Verified end-to-end against the live outage, not a fixture:
- clock survived a pm2 restart: 21:49:08 before and after, wall clock 21:50:45
- alert fired at 21:59:46 reporting **silentMin 10.6 on a process only ~9
  minutes old**. That number is the proof: under the old in-memory clock it
  would have read ~9 minutes, stayed under the threshold, and stayed silent.
- Telegram "Ingest stalled" delivered, and the self-heal forced a reconnect
  (which fails on, correctly retries against, the exhausted credit allowance)
Lesson worth keeping: an acceptance criterion that exercises the happy path of
a safety mechanism can pass while the mechanism remains defeatable by ordinary
operational events. The restart was not an exotic case — it is what pm2 does.
Made by: Operator + Claude.

## 2026-08-16 · Hard byte ceiling added beneath the credit meter
Motivation: every credit guard shipped today — the 50/80/95% warnings, the load
shedding, the month pacing — rests on a single unverified assumption, that
Helius bills 20 credits/MB. That number came from their documentation and has
never been reconciled against their own usage dashboard. It was flagged at the
time that a wrongly calibrated meter is worse than none: if the real rate is
higher, the meter under-counts, pacing lets the stream run, and the allowance
burns exactly as it did earlier today.
Resolution: a second guard that measures BYTES, which we observe directly
rather than infer. Ingest stops for the remainder of the UTC day once the daily
byte total crosses `MAX_STREAM_GB_PER_DAY` (default 2 GB, roughly the free
tier's 1.67 GB/day plus slack). The tally is read from the stored byte counts,
never derived from credits, and is persisted so a restart cannot reset the
day's usage. It resets naturally at UTC midnight.
The property that matters: this guard cannot be defeated by the credit
conversion being wrong. Only by the operator setting the ceiling too high.
Design note: pause state changed from a boolean to a reason string. Two
independent guards can now stop ingest, and with a boolean either one's
recovery would have silently un-paused the other — the pace guard clearing
could have restarted a stream the byte ceiling had stopped. Resuming requires
both to be clear, and the alert names which one fired.
Verified end-to-end against a copy of the database with today's tally seeded to
5 GB: the recorder started, logged hardByteCeilingGbPerDay 2, and paused at the
first heartbeat — "Hard byte ceiling reached — 5.00 GB streamed today against a
hard ceiling of 2 GB." Tests include a 5x-wrong credit rate still tripping the
ceiling, since bytes are bytes.
Outstanding and unchanged: the credit half of the meter remains uncalibrated.
Reconcile `credit_usage` against Helius' own figures as soon as they are
visible; until then the byte ceiling is doing the real work.
Made by: Operator + Claude.

## 2026-08-16 · Coverage windows fixed and surfaced; they were write-only
Evidence: `ingest_windows` was created so Phase 3 could distinguish "nothing
launched" from "we were not looking". Nothing ever read it — the same
write-only failure `raw_events` had — and inspecting it showed the data was
wrong in two ways:
- All five recorded windows were still `(open)`. A window is opened at startup
  and was only closed by the budget guards, so every `pm2 restart` and every
  crash left one claiming coverage that ran to infinity.
- Those windows overlapped hours when ingest was 429-ing and receiving nothing.
  "Connected" was being recorded as "covered", so a reader would conclude the
  market was dead rather than that we were blind.
Resolution:
- `closed_at` is now maintained as a heartbeat mark — "observed through" —
  rather than written once at shutdown, because a hard kill never runs a
  shutdown hook. A crash now leaves an accurate window, wrong by at most one
  tick. Clean shutdown still closes it explicitly.
- Windows record an `events` count. Zero events over a window is a blind
  period, and the dashboard colours it distinctly from a covered one.
- The dashboard shows coverage over the last 24h with the honest headline: it
  currently reads **0.0% of the last 24h produced events**, which is correct —
  every window since coverage tracking began has been a 429.
Pre-fix rows are left as stored. Their extent is inferred at DISPLAY time from
the start of the next window rather than backfilled with a guessed timestamp,
so the stored data stays as observed and the chart still reads correctly. The
page says which windows are inferred, and says that coverage tracking began
part-way through the day so the percentage understates history rather than
describing it.
Made by: Operator + Claude.

## 2026-08-16 · Credit meter calibration checked — bounded, not confirmed
Question: every credit guard depends on Helius billing 20 credits/MB, taken
from their documentation and never verified. What is that assumption worth?
What was found:
1. **The meter has never metered anything.** `credit_usage` is empty. It
   shipped around 21:00 and ingest has been 429 since 20:13, so the live path
   from listener bytes through to stored credits had never executed with real
   traffic. It was not merely uncalibrated — it was unexercised.
2. **The plumbing works.** Exercised end-to-end against a copy: one simulated
   minute of pump.fun traffic at the measured 56.2 notifications/s recorded
   9.3 MB and 186.8 credits, implying 0.33M credits/day, which reconciles with
   13.5 GB/day x 20 credits/MB plus call costs. Self-consistent.
3. **Helius' own figures are not reachable from here.** There IS a programmatic
   route — `getProjectUsage` on the admin API, and a `helius usage --json` CLI —
   but the admin API rejects an ordinary RPC key (401) and is feature-gated per
   project. Only the operator can read the ground truth.
4. **The rate is bounded empirically.** Today's exhaustion is itself a
   measurement: 316 minutes of streaming at a measured 118 GB/day is ~25,894 MB.
   At the documented 20 credits/MB that is ~518k credits, about half the 1M
   allowance — consistent, since the account carried prior usage from earlier
   runs. If the entire allowance had gone to this session the implied rate
   would be 38.6 credits/MB, which is therefore an UPPER BOUND. The true rate
   lies in roughly 20-38.6.
Conclusion: the documented figure is consistent with observed reality and is
not wrong by an order of magnitude. Worst case the meter under-counts by about
2x, which the hard byte ceiling already absorbs.
Action taken: `CREDITS_PER_MB` moved from a buried constant to an env setting,
so calibration becomes a config change rather than a code change once the real
number is visible.
Still outstanding: only the operator can run `helius usage --json` or read the
dashboard. Until then this is a bound, not a confirmation, and the byte ceiling
remains the guard actually doing the work.
Made by: Operator + Claude.

## 2026-08-16 · Open decision #8 closed — LaunchLab program ID verified
Evidence: LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj is confirmed by Raydium's
published program addresses and by Solscan, and corroborated by live traffic —
both observed launchlab launches resolved to `…bonk` vanity mints, the LetsBonk
convention. The low event count (2 in 25 minutes against 33 PumpSwap
graduations) is genuine venue volume, not a wiring fault: the log heuristic
over-matches rather than misses.
Caveat recorded: pool extraction is validated for PumpSwap only. LaunchLab
account layout was not dissected (too little traffic to sample), so LaunchLab
tokens record an unconfirmed pool and therefore unknown concentration, rather
than a guess.
Made by: Operator + Claude.

## 2026-08-16 · Scrub secrets at the logger, and route crashes through it
Motivation: the Helius key is embedded in `HELIUS_RPC` / `HELIUS_WS`, and
several call sites log `{ err }` on failure. Today's 429s happened not to
quote the failing URL, but that was the error type's choice, not a property
of the design — a web3.js `Connection` failure names the endpoint it failed
on. pino's `redact` cannot address this: it removes whole fields by path,
and the secret sits inside a URL string nested in a message, a stack, or a
non-enumerable `cause`.
Resolution: a `hooks.logMethod` value-walk scrubs every configured secret
out of everything logged, at any depth, so no call site has to remember to.
It fails closed — strings are scrubbed past the depth limit, and it is the
container that is dropped, never a string passed through unread.
`installCrashHandlers()` routes `uncaughtException` / `unhandledRejection`
through the same logger and then exits non-zero, because Node's default
prints a raw stack straight to stderr and because logging-and-continuing
would strand a zombie that pm2 never restarts — which FR-G2's dead-man
switch depends on. `String(err)` is scrubbed at the two places it escapes
the process: the quote error persisted to `quotes` and replayed into the
Telegram body, and the dashboard's 500 response.
Evidence: verified end-to-end, not just by unit test — a probe logged the
real key-bearing URL through six paths (message, error message, stack,
`cause`, an own property, a deeply nested field, and an unhandled
rejection); zero occurrences of the key in the output, exit code 1.
Audited what was already on disk: pm2 logs, all text columns of all eleven
tables, and the working tree are clean of the key.
Scope note: `BACKUP_RCLONE_REMOTE` is deliberately not scrubbed — it is a
remote name, not a credential, and listing it would mangle backup logs for
no gain. This reduces future exposure; it does not undo the earlier leak of
the key into a chat transcript, so rotation is still owed.
Made by: Operator + Claude.

## 2026-08-17 · FR-J1 meta gauge — and two biases that had to be cancelled first
Motivation: the last open Workstream A item, and the cheapest — every input
except the SOL price is already in the local database, and that comes from
`solUsd()`, which costs no Helius credits. It is therefore work that could be
finished with the allowance exhausted and ingest down.
Resolution: `src/ops/metaGauge.ts` (pure, unit-tested) plus `metaTick.ts` (the
I/O half) record four numbers per UTC day to a new `meta_daily` table and
expose HOT / NORMAL / COLD / UNKNOWN. A COLD state suppresses Telegram
delivery only — the alerts row, the FR-A6 quotes and every snapshot still
land, because a cold market is exactly when the dataset most needs to show
what a cold market looked like. State changes alert the operator; venue market
share falls out of the daily row, which is AC2.

Both biases the design had to cancel push the SAME way — toward a false COLD,
the one state with teeth:
(a) OUR OWN OUTAGE LOOKS LIKE A QUIET MARKET. Every rate is therefore per
COVERED HOUR rather than per day. The obvious guard — a minimum coverage
PERCENTAGE — was rejected on arithmetic: the 2 GB/day byte ceiling stops a
developer-profile pump.fun stream after ~3.6 of every 24 hours by design, so
any percentage floor above 15% would leave the gauge permanently UNKNOWN on
the tier actually in use. The floor is an absolute 1 covered hour instead.
(b) SAME-DAY GRADUATION RATE UNDERSTATES, because a token launched at 20:00
cannot graduate before midnight. The rate that votes is a cohort rate over
launches at least 6h old; the same-day ratio is still recorded as the honest
description of the day, but is given no vote.

Evidence: running it against the live database is what proved (a) was not yet
fixed. The first run returned a confident COLD for 2026-08-17 off 8.53 "covered"
hours — a subscription held open for 9.4h while the allowance was exhausted,
receiving zero notifications. `schema.sql` had already written the rule down
("a window with zero events is a BLIND period, not a quiet market"); nothing
enforced it. Two defects followed: `coveredHours` now requires `events > 0`,
and `ingest_windows.events` was recording `listener.eventCount`, a cumulative
PROCESS total that never resets, so every window after the first inherited the
traffic of the ones before it — it is now a per-window delta. After the fix the
same day reads UNKNOWN and does not pause arming. Rollup counts reconcile
exactly against hand-written SQL for 2026-08-16: 10,136 pump.fun + 35 LaunchLab
launches, 625 graduations, 15,315.24 PumpSwap SOL.

Operator decision (2026-08-16): UNKNOWN does NOT pause arming. Only positive
evidence of COLD silences the channel; the gauge being blind does not. The
first week (SOL trend dark until seven daily prices exist) and every
low-coverage day keep alerting.

Behaviour change worth stating plainly: `alerts.notified = 0` no longer implies
"below the notify bar", so a new `alerts.suppressed_by` column names the reason
and SCHEMA_VERSION goes to 3. Because `lastAlertAt()` filters on
`notified = 1`, a candidate silenced by COLD does not burn its own 60-minute
cooldown and may alert immediately once the regime lifts — intended, since
cooldown protects the operator's attention and none was spent.
Scope note: the bands are seeded from 2026-08-16, the only day measured
(5.5 covered hours, ~1,850 launches/h, ~2,800 PumpSwap SOL/h). They carry NO
outcome evidence and are a first calibration to be re-fitted in Phase 3 against
FR-B4, exactly like the notify bar. No dashboard tile was added; `/api/state`
carries the data so that stays a clean follow-up.
Made by: Operator + Claude.

## 2026-08-17 · Workstream B built out to the edge of what this machine allows
Motivation: Workstream A closed, and B (FSD Module G) blocks the Phase 2 exit.
Three of its four remaining items terminate in an action only the operator can
take — `rclone config` against their cloud account, creating a git remote
(`gh` is not installed), and provisioning a host. The goal was therefore not to
complete B but to reduce each blocker to a single command.

FR-G3 (CI): `.github/workflows/ci.yml` runs typecheck and the 147 tests on
Node 22, plus a separate `hermetic` job that runs the same suite with the
environment stripped and fails if a test needs a secret or leaves a database
behind. That second job exists because "the suite is offline-runnable" was an
assumption nobody had tested; it is now verified the way CI would — a clean
`git archive` checkout, `npm ci`, `env -i`, no `.env` — 147/147 pass and no
database appears. `npm run ci` is the same sequence locally, so the value
lands before a remote does. It cannot go green until one exists.

FR-G4 (deploy): `ecosystem.config.cjs` replaces the ad-hoc
`pm2 start "npm start"` and is now what the recorder runs under. One app
deliberately — the dashboard stays a separate process so it remains usable
while the recorder is down, which is exactly when it is wanted. Never cluster
mode: one write handle. pm2-logrotate installed (20M/14/compress); the out-log
had reached 865 KB in a single session with nothing rotating it.

The earlier bandwidth objection is WITHDRAWN. 118 GB/day (~3.1 TB/month) was
measured before the byte ceiling existed; `MAX_STREAM_GB_PER_DAY=2` caps
streaming at ~60 GB/month, which fits the cheapest VPS tier. FR-G4 has no cost
obstacle, only the absence of a box.

Migration is a HANDOVER, not a copy, and the guard matters more than the
transfer. `scripts/migrate-host.sh` stops the recorder, checkpoints the WAL,
takes a `VACUUM INTO` snapshot, verifies integrity and every table's row count
ON THE TARGET, and only then writes `data/.migrated-to`. `assertNotMigrated()`
in `src/config.ts` refuses to start against a sealed dataset and names the host
it went to. Without it, both machines hold a complete writable database after
any copy, and running both yields two datasets diverging from a common
ancestor — for a Phase 3 verdict, unrecoverable and undetectable after the
fact. Rehearsed locally: 12 tables, 84,126 rows, integrity ok on both sides;
the guard was confirmed to block startup with the marker present and to release
when removed. One defect found and fixed in the rehearsal: the target-side
verifier was built as a command string, and word-splitting mangled the SQL
identifier quoting so every count came back empty — it failed loudly rather
than passing silently, and is now a shell function.

Item 9 (confirm H1): H1 stands. H3 is RETIRED rather than edited — it claimed
graduations go to Raydium, when they have gone to PumpSwap since 2025-03-20,
and H4 already states the corrected claim with a measurable condition. Retired
rather than corrected because the protocol requires a hypothesis to be written
before it is coded, so the record of what was believed when is itself evidence;
no data was ever collected against H3 as written. The falsification protocol
now measures its window in COVERED time from `ingest_windows` instead of
wall-clock — ingest duty-cycles by design and has already been blind for hours,
so four weeks of calendar is not four weeks of observation — reports gaps
rather than interpolating them, and carries the FR-J1 `meta_daily` state
alongside each outcome so a regime effect cannot masquerade as edge.

FR-G1 stays unmet and nothing pretends otherwise: `backup.sh` still records
`"failedStep":"upload"` with the remote unset, verified again today.
Made by: Operator + Claude.

## 2026-08-17 · FR-G3 met locally; remote CI blocked above this repository
Motivation: the CI workflow was written and the remote created, but run #1
returned `startup_failure` — no job, no logs, no annotations, `created_at ==
updated_at`, `path=BuildFailed`, empty workflow name — and GitHub refuses to
retry a startup failure.

Everything checkable from here cleared the file: `actionlint` 1.7.12 against
the real Actions schema found no errors; the file is byte-clean (no BOM, CRLF,
NBSP or tabs) and identical to `origin/main`; the workflow is registered and
`active` at the correct path; Actions is enabled with `allowed_actions: all`;
the repo is not archived or disabled. The human-readable reason is not exposed
by any REST endpoint tried, and the billing endpoint needs a `user` scope the
token does not carry.

Resolution: rather than keep theorising, a canary settled it in one push — the
smallest workflow GitHub accepts, with no checkout, no setup-node, no
concurrency, no permissions, no expressions and no third-party actions. It
failed identically. The push produced ONE `BuildFailed` run for the whole
event, and `actions/workflows/ci.yml/runs` and `.../canary.yml/runs` both
report zero runs. GitHub therefore fails before dispatching to any workflow:
**nothing in any file is the cause, and no change to this repository can fix
it.** The canary was deleted in the same commit that recorded its answer.

Separately, and more usefully: FR-G3 asks that "a refactor cannot silently
break the recorder". GitHub Actions is one way to deliver that, not the
requirement itself. `.githooks/pre-push` now runs `npm run ci` (typecheck +
147 tests, measured 5s) before any push completes, installed via a `prepare`
script pointing `core.hooksPath` at the committed hooks directory — the husky
pattern without the dependency, because the suite must stay offline and
dependency-light. Verified the way a guard has to be: a deliberately broken
assertion was refused at push time with the failing count and the
`--no-verify` escape named, then the push succeeded once restored. The escape
hatch is advertised rather than hidden, since a guard nobody can bypass in an
emergency gets deleted instead of respected.

Cause confirmed the same day, from the Actions UI (the one place it is
surfaced): "The job was not started because recent account payments have
failed or your spending limit needs to be increased." So it is the billing
case, not the unverified-email case that was ranked first on the theory that a
pre-dispatch failure fits an account-wide switch better than a quota — that
reasoning was wrong; GitHub reports a failed payment before workflow dispatch
too. Private-repo Actions are metered, and this repo had consumed none of the
allowance itself, so the block is account-wide rather than anything this
project did. It clears in github.com/settings/billing.

Follow-up the same day, worth recording because it cost something: the repo was
made public on the reasoning that Actions is unmetered for public repos. That
is true but INCOMPLETE, and the advice should have carried the caveat. Going
public did move the failure — workflows began dispatching, both jobs were
created, and the run reported `failure` rather than `startup_failure` — but the
jobs still could not start, with a new and more specific annotation: "The job
was not started because your account is locked due to a billing issue." A
LOCKED account blocks jobs regardless of repository visibility, so the change
bought the dispatch stage and nothing else. It also revealed that the first
message ("spending limit needs to be increased") understated the state.
Reverted to private within minutes; zero forks, stars and watchers, so no copy
was taken. Repository visibility is orthogonal to an account lock — only
settling the billing clears it.

Honest limit: a hook proves the code works on a machine where it already
works. Only a clean-machine `npm ci` from the lockfile proves the dependency
graph still resolves — which is the half only remote CI can give, and the half
that stays unmet. The workflow file is retained, unchanged and lint-clean, so
it runs the moment the account-level block clears.
Made by: Operator + Claude.

## 2026-08-17 · minHolders measured: the 180s decision age rejects dead tokens, not an artifact
Motivation: the last open question from Workstream A item 1. ROADMAP recorded
`minHolders` as "untuned against real distributions", and the snapshot config
warned that judging holders too early "rejects tokens for an artifact" of DAS
indexing lag. That warning was written from three hand-picked examples at 60s;
it had never been tested at the 180s age actually in use. It needs no credits
and no ingest, so it was doable with the recorder still down.

Method: pair each mint's holder reads by AGE AT READ, bucketing on
`holder_count_at` rather than snapshot time — carried-forward values reuse
their real observation timestamp, so this cannot mistake a copy for a
measurement.

Result, and it is the OPPOSITE of what the item assumed. Of 105 paired mints
reading under 50 holders at 3 min that also had a 10 min read, only 2 reached
50 by 10 min. Of the 16 reading exactly 0 at 3 min, ZERO climbed above 0 —
so even the group that looks most like an indexing failure is stable rather
than converging. The low group is genuinely sparse. At 180s the artifact the
comment feared has largely gone, and the bar is rejecting dead tokens.

Distribution at first read, 552 mints: p10 6, p25 18, median 167, p75 446,
p90 707. 31% fall under the pass bar of 50; 45% under the notify bar of 175.

Which condition actually binds, over the 485 mints with all three notify
fields present: liquidity < $30k fails 437 (90%), top-10 > 30% fails 281
(58%), holders < 175 fails 219 (45%) — but holders is the SOLE failing
condition for just 15 mints (3%), and only 6 mints clear all three. So
LIQUIDITY is overwhelmingly the binding constraint at the notify bar, and
`minHolders` is very nearly free to move without changing alert volume.
An earlier draft of this entry said holders "alone account for about half"
of what the bar withholds; that read a marginal distribution as if it were
a conjunction and was wrong by more than an order of magnitude. The bar is
an AND of three conditions and most mints fail several at once.
Medians do grow across the paired subset (178 -> 292), but that growth is
concentrated in tokens that already had traction at 3 min.

THRESHOLDS DELIBERATELY UNCHANGED. This is distribution evidence, not outcome
evidence, and moving a bar on it would be exactly the tuning-without-outcomes
this project has refused for the notify bar and the meta gauge. What the
measurement buys is confidence that the 180s age is sound, not a new number.

Defect found while measuring: holder counts saturate at 3000 (das.ts
MAX_PAGES 3 x PAGE_LIMIT 1000). `holderStats` has always returned `truncated`
and every caller discarded it, so a capped read was stored as a plain number
indistinguishable from a real one — the same class of error as a
carried-forward value that looks freshly observed. Now recorded in
`snapshots.holder_count_truncated`. Deliberately NOT fixed by raising
MAX_PAGES: DAS costs 10 credits a call on a system that died of credit
exhaustion. 5 of 552 mints sit at the ceiling, all far above the floors in
use, so no filter decision was affected.

SCHEMA_VERSION deliberately NOT bumped (RUNBOOK invariant 6): `holder_count`
always meant "unique owners up to the page cap", so its meaning is unchanged —
this records when the cap bit, and NULL on older rows is honestly "unrecorded"
rather than "not truncated". Same reasoning as `alerts.suppressed_by`.

Also checked and cleared: top-10 concentration does NOT come from the
paginated DAS list. It is computed from `getTokenLargestAccounts`
(recorder.ts:481), so the 3000 ceiling cannot distort `maxTop10HolderPct` —
which would have been a far more serious bug in a filter with real teeth.
Made by: Operator + Claude.
