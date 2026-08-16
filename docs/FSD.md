# Functional Specification Document (FSD)
## meme-scout — Future Expansion
Version 1.0 · Status: Draft for review · Owner: you · Implementer: Claude

---

## 1. Purpose & scope

This FSD specifies the functional behaviour of every planned expansion of
meme-scout beyond the shipped Phase 1 (recorder + filters + alerts). It is
the contract for future build sessions: each requirement has an ID, a
priority, and acceptance criteria, so any session can pick up a requirement
and implement it without re-deriving intent.

In scope: data completion, swap intelligence, outcome measurement, creator &
wallet intelligence, paper trading, limited live execution, and the
multi-user product expansion.
Out of scope (indefinitely): microservices, Kafka, Kubernetes, ML models,
correlation/regime engines — see ROADMAP.md "Explicitly deferred".

Priorities: **M** = must have, **S** = should have, **C** = could have.
Each phase's requirements are gated by the previous phase's exit criteria.

---

## 2. Actors

| Actor | Description |
|---|---|
| Operator | You. Runs the system, receives alerts, makes go/no-go decisions between phases. |
| System | The meme-scout process(es). |
| Subscriber (future) | Third-party user receiving alerts in the multi-user expansion (Module F). |

---

## 3. Module A — Data completion (Phase 2)

### FR-A1 (M) Liquidity valuation
The System shall compute `liquidity_usd` for each tracked pool by reading
the pool's vault token balances and valuing them via SOL/USDC price.
- AC1: For a Raydium pool with known reserves, computed value is within 5%
  of DexScreener's displayed liquidity at the same minute.
- AC2: On RPC failure, the field is stored as null, never 0.

### FR-A2 (M) Price capture
The System shall record `price_usd` per snapshot via Jupiter Price API,
falling back to pool-reserve-implied price.
- AC: Nulls only when both sources fail; source is recorded per snapshot.

### FR-A3 (M) Holder count
The System shall record `holder_count` via Helius DAS getTokenAccounts.
- AC: Paginates correctly beyond 1,000 accounts; excludes zero-balance
  accounts.

### FR-A4 (M) LP burn detection
The System shall compute `lp_burned_pct` = LP tokens provably burned or
locked / total LP supply.
- AC: Detects transfers to the incinerator address and LP mint supply
  reduction; distinguishes "burned" from "still held by creator".

### FR-A5 (M) Swap recording
The System shall subscribe to swap activity for every tracked token and
persist rows to a `swaps` table: mint, signature, side, base amount, quote
amount, implied price, wallet, slot, observed_at.
- AC1: Buy/sell direction correct against DexScreener spot checks.
- AC2: Ingestion sustained at ≥50 swaps/sec across tracked tokens without
  falling behind (measured by observed_at minus block time < 5s p95).

### FR-A6 (M) Execution-cost sampling
At every alert, the System shall request a Jupiter quote for a standard
0.5 SOL buy and persist the implied price impact and route.
- AC: Quote stored within 2s of alert creation; failures recorded as such.

### FR-A7 (S) pump.fun graduation events
The System shall detect a token's migration from pump.fun to Raydium and
record it as a lifecycle event.

### FR-A8 (S) Derived market metrics
From `swaps`, the System shall compute per-token rolling metrics: 1/5/15/30
min returns, volume, unique buyers/sellers, buy pressure ratio.
- AC: Metrics computed on read or on a 30s tick; never backfilled with
  future information (feature_timestamp ≤ computation time).

**Exit criteria (Phase 2):** <10% null rate on FR-A1..A4 fields over 48h;
swap lag p95 < 5s.

---

## 4. Module B — Outcome measurement (Phase 3)

### FR-B1 (M) Outcome labeler
For every token with ≥1 assessment (passed OR rejected), the System shall
compute, at horizons 15/60/240 min from first assessment: return at horizon,
max return, max drawdown, and a rugged flag (liquidity −80% or freeze/mint
authority abuse observed).
- AC: Labels computed only from snapshots/swaps timestamped after the
  assessment (no look-ahead).

### FR-B2 (M) Filter precision report
The System shall produce a report: per filter and per threshold value —
pass rate, rug rate among passes, rug rate among rejects, distribution of
horizon returns for passes vs rejects.
- AC: Runnable as `npm run report`; outputs markdown + CSV.

### FR-B3 (M) Hypothetical expectancy
The System shall compute "buy every alert at recorded Jupiter quote, exit at
horizon H" P&L net of: quoted impact ×2 (entry+exit), DEX fee, priority fee
estimate.
- AC: Every cost component itemised per trade; aggregate expectancy with
  95% bootstrap confidence interval.

### FR-B4 (S) Threshold tuning harness
The System shall re-run assessments against recorded history with alternate
thresholds and emit the FR-B2 report for each configuration.
- AC: Deterministic replay — same inputs, same outputs; configuration hash
  stored with every report.

**Exit criteria (Phase 3):** a written expectancy answer with CI. Negative →
iterate filters or stop; positive → Phase 4/5 unlocked.

---

## 5. Module C — Creator & wallet intelligence (Phase 4)

### FR-C1 (M) Creator registry
The System shall maintain a `creators` table keyed by address: tokens
launched (from our own recorded history), rug count, best outcome, funding
sources observed.
- AC: A creator with ≥1 recorded rug hard-blocks their future launches.

### FR-C2 (S) Funding-lineage heuristic
The System shall record the funding source of creator wallets (first SOL
inflow) and flag clusters sharing a funder.

### FR-C3 (S) Early-buyer performance
The System shall score wallets that appear within the first N minutes of
launches by subsequent token outcomes, with exponential decay (half-life
≤ 14 days) and a minimum sample size of 10 tokens before any score is used.
- AC: Score never a hard pass signal — only a score component; assumption of
  adversarial farming documented in evidence strings.

### FR-C4 (C) Wallet graph export
The System shall export creator/funder/early-buyer relationships as a graph
file (GraphML or JSON) for external visualisation.

---

## 6. Module D — Paper trading (Phase 5)

### FR-D1 (M) Simulated portfolio
The System shall run a paper portfolio: on alert, open a simulated position
at the recorded Jupiter quote (not spot price); apply the strategy's exit
rules; persist positions and P&L.
- AC: Fills never better than the recorded quote; sizes capped at 1% of
  recorded pool liquidity.

### FR-D2 (M) Exit rule engine — barbell by default
The System shall support configurable exits: stop %, trailing stop, time
stop, liquidity-collapse emergency exit, authority-change emergency exit.
The DEFAULT strategy shall encode power-law economics: the median winner
still dies, expectancy lives in the rare 10-50x tail. Default rules:
recover full cost basis at 2x (sell ~50%), let the remainder ride a wide
trailing stop, size positions small enough (fractional-Kelly) that a long
loss streak is survivable.
- AC: Every exit records which rule fired and the state that triggered it.
- AC2: Backtest comparison (FR-B4) of barbell vs symmetric exits is part of
  the Phase 5 go decision.

### FR-D3 (M) Daily report
The System shall send a daily Telegram summary: open positions, closed P&L,
win rate, cost drag, max drawdown.

### FR-D4 (M) Kill criteria
Paper trading shall auto-pause after: 10 consecutive losses, or −20%
simulated drawdown, pending Operator review.

**Exit criteria (Phase 5):** ≥100 closed paper trades over ≥1 month with
positive net expectancy.

---

## 7. Module E — Limited live execution (Phase 6)

Designed in its own session; requirements here are binding constraints.

### FR-E1 (M) Signer isolation
Signing shall occur in a separate process with its own keypair, receiving
only structured trade intents; the main app never touches key material.
- AC: Key exists only in the signer's environment; grep of repo, DB and logs
  finds no key material.

### FR-E2 (M) Hard limits as code
Per-trade max size, daily loss cap, max open positions, and a global kill
switch shall be enforced in the signer process (not only in the strategy).
- AC: Strategy process cannot exceed limits even if compromised/buggy.

### FR-E3 (M) Pre-trade simulation
Every transaction shall be simulated via RPC before signing; simulation
failure aborts the trade.

### FR-E4 (M) Reconciliation
After every fill, expected vs actual (tokens, cost, fees, price) shall be
compared; a material mismatch (>2%) pauses trading and alerts.

### FR-E5 (M) Disposable capital only
The live wallet shall be funded exclusively with capital the Operator has
pre-committed (in writing, in the config) to losing entirely.

---

## 8. Module F — Multi-user product expansion (post-Phase 3, optional track)

The "later other people can use it" goal. Gated on Phase 3 positive results
OR a pivot decision to ship it as a pure research/alerting product.

### FR-F1 (M) Alert subscriptions
The System shall support multiple Telegram subscribers with per-subscriber
filter thresholds.

### FR-F2 (M) Web dashboard
A read-only web UI: live candidate feed, token detail (snapshot time series,
assessment evidence), historical filter performance.
- AC: No wallet connection, no trading actions in v1; auth via magic link.

### FR-F3 (S) Public API
REST endpoints: /candidates, /tokens/:mint, /assessments/:mint, rate-limited,
API-key authed.

### FR-F4 (M) Migration to Postgres
Multi-user load moves storage to Postgres; the SQLite schema is the source
of truth for the migration.

### FR-F0 (M) Competitive positioning
Before any Module F build, a one-page positioning doc shall answer why a
user would pay for this over GMGN, Photon, BullX, RugCheck, DexScreener —
grounded in something they cannot copy cheaply (e.g. our recorded outcome
dataset and published filter precision, per FR-B2). No differentiator, no
Module F.

### FR-F5 (M) Compliance posture
The product ships as an informational/research tool: no financial advice, no
custody, no execution for third parties. Executing trades for others is out
of scope permanently for this product (it triggers licensing regimes we will
not enter).

---

## 8b. Module H — Bundle & sniper forensics (Phase 2/3, high priority)

Trader gap analysis (2026-08-16): insider supply mapping is the single most
predictive filter class in current practice. Coordinated same-block buys let
insiders accumulate at the lowest price and exit into the retail liquidity
that follows. All computable from our own recorded swaps — no vendor needed.

### FR-H1 (M) Launch-window swap capture
For every discovered token, the System shall record ALL swaps in the first
20 slots (extends FR-A5 with a launch-window priority path).
- AC: First-20-slot capture rate ≥95% verified against a block explorer
  sample.

### FR-H2 (M) Bundled-supply metric
The System shall compute bundled_supply_pct = share of supply bought in the
same slot as deployment + the next 3 slots, grouped by wallet cluster.
- AC: Matches Bubblemaps-style bundle readings within 10% on a 20-token
  sample; stored per token as a point-in-time feature.

### FR-H3 (M) Deployer-funded sniper detection
The System shall trace SOL transfers from the deployer (and its funding
source) to wallets that sniped the launch window; flagged wallets mark the
token as insider-coordinated. Same-block snipes are inherently suspicious on
Solana (no public mempool).
- AC: Flag stored with evidence (transfer signatures); zero false positives
  on a manual 20-token audit for the "direct transfer" rule.

### FR-H4 (M) Sniper-saturation filter
A new filter shall score launch-window composition: bundled supply %, count
of known bot wallets among first buyers, and same-block buy count. Hard
block above a configurable bundled-supply threshold (initial: 15%).
- AC: Unit-tested; threshold tunable via FR-B4 harness.

---

## 8c. Module I — Narrative & attention signals (Phase 4 alternative track)

Meme coins are attention assets that pump in narrative waves, with meme
families rotating together. A purely on-chain system cannot distinguish a
token riding this week's meme from random noise. This module is the main
non-commoditised alpha candidate.

### FR-I1 (M) Narrative lexicon
The System shall maintain a versioned lexicon of active meme families
(keywords, ticker patterns), updated weekly by the Operator (manually at
first), and tag every discovered token with matched families.
- AC: Tagging runs at discovery time; lexicon version stored per tag
  (point-in-time discipline — retroactive lexicon edits never retag old
  rows).

### FR-I2 (S) Mention-velocity ingestion
The System shall ingest ticker/keyword mention counts from at least one
social source (X API tier, or a Telegram channel-scrape fallback) and
compute mention velocity/acceleration per token.
- AC: Cost within NFR-5 budget; source outages degrade to null, never to 0.

### FR-I3 (S) Narrative-momentum feature
Family-level aggregate flow (sum of volume across tokens sharing a family
tag) shall be a scanner feature: a new token in a family that is currently
absorbing volume scores higher.

### FR-I4 (C) KOL wallet watchlist
A manually curated list of KOL/influencer wallets; their entries into a
tracked token generate an informational alert (never an auto-buy signal).

---

## 8d. Module J — Meta gauge (Phase 2, cheap)

### FR-J1 (M) Four-number regime thermometer
The System shall record daily: (1) launches per venue, (2) graduation rate,
(3) aggregate PumpSwap volume, (4) SOL 7-day trend — and expose a simple
meta state: HOT / NORMAL / COLD.
- AC: When COLD (thresholds configurable), signal arming pauses
  automatically; state changes alert the Operator.
- AC2: Venue market share (pump.fun vs LetsBonk vs others) tracked over
  time — the meta rotates between launchpads and the system must see it.

---

## 8e. Module G — Operational hardening (Phase 2, blocking)

Gap analysis (2026-08-16) promoted these to must-haves in the NEXT phase.
FR-G1..G4 block the Phase 2 exit; data collected without them is at risk or
untrustworthy.

### FR-G1 (M) Dataset backups
The System shall back up the SQLite database off-machine at least every 6h
(e.g. Litestream continuous replication to object storage, or scheduled
snapshot upload), retaining ≥30 days.
- AC1: A restore drill from backup succeeds and row counts match.
- AC2: Backup failure for >12h triggers a Telegram alert.

### FR-G2 (M) Heartbeat / dead-man switch
The System shall track time-since-last-ingested-event and alert the Operator
if no events arrive for 10 minutes (websocket stall is otherwise silent and
indistinguishable from a quiet market). A daily "alive + stats" ping shall
confirm end-to-end alert delivery.
- AC: Killing the websocket produces a Telegram warning within 12 minutes.

### FR-G3 (M) Test suite + CI
Unit tests shall cover: every filter (pass/block/null-data paths), pipeline
hard-block short-circuiting, outcome labeler look-ahead protection (once
built), and DB round-trips. CI (GitHub Actions) runs typecheck + tests on
every push.
- AC: Filters at 100% branch coverage; a seeded fixture launch replays
  deterministically through the pipeline.

### FR-G4 (M) Deployment target
The System shall run on an always-on host (small VPS), deployed via a
documented script, secrets injected via environment (never committed), with
pm2 restart-on-crash and log rotation.
- AC: RUNBOOK updated; machine reboot resumes recording within 2 minutes
  unattended.

### FR-G5 (S) Trade record export (activates with Module D/E)
All simulated and real fills shall be exportable as CSV with timestamps,
amounts, cost basis and proceeds in USD — accountant-ready. Tax treatment of
swaps varies by jurisdiction; the Operator shall confirm local rules before
Phase 6 (open decision #5).

### FR-G6 (M, process) Phase-gate discipline
Phase gates in section 10 may only be crossed via a written go decision
recorded in docs/DECISIONS.md (date, evidence cited, decision). The most
likely failure mode of this project is skipping gates during a hype cycle;
this requirement exists to make that visible and deliberate.

---

## 9. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | Point-in-time integrity: no stored observation may ever be overwritten or backfilled. |
| NFR-2 | Availability: unattended operation ≥7 days; crash-restart via pm2 loses no committed data. |
| NFR-3 | Latency: launch observed → alert delivered p95 < 15s (Phases 1–3). |
| NFR-4 | Auditability: every alert reconstructible (evidence + snapshot + quote) ≥6 months later. |
| NFR-5 | Cost ceiling: Helius + infra ≤ a defined monthly budget before Module F revenue. |
| NFR-6 | Security: no private keys in repo/DB/logs before Module E; then FR-E1 applies. |
| NFR-7 | Determinism: replays and reports are reproducible from recorded data + config hash. |

---

## 10. Traceability

| Phase | Requirements | Gate |
|---|---|---|
| 2 | FR-A1..A8, FR-G1..G4 (blocking), FR-H1, FR-J1 | Phase 1 stable 48h ✅ |
| 3 | FR-B1..B4, FR-H2..H4 | Phase 2 exit criteria |
| 4 | FR-C1..C4 and/or FR-I1..I4 (choose by Phase 3 evidence) | Phase 3 positive or promising |
| 5 | FR-D1..D4 | Phase 3 positive |
| 6 | FR-E1..E5 | Phase 5 exit criteria + explicit Operator decision |
| F | FR-F1..F5 | Phase 3 done (either result) + product decision |

## 11. Open decisions (to resolve before their phase)
1. Exit-rule defaults for paper trading (FR-D2) — decide from FR-B2 data.
2. Which additional launchpads/DEXes to watch in Module A (Meteora? Orca?).
3. Module F business model (free tier + paid thresholds? flat sub?).
4. Postgres hosting choice for Module F.
5. Tax treatment of swaps in the Operator's jurisdiction (before Phase 6).
6. VPS provider + backup storage target for FR-G1/G4 (start of Phase 2).
7. Social data source for FR-I2: X API tier vs Telegram scrape (cost/TOS).
8. Verify Raydium LaunchLab program ID against live traffic (Phase 2, day 1).
