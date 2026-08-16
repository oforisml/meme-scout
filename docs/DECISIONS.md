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
