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
