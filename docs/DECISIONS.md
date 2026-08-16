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
