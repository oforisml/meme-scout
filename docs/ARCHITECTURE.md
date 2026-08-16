# Architecture

## Principle
One TypeScript monolith. Every component below is a module in one process,
communicating through direct function calls and a SQLite database. Nothing is
split into a service until measured load forces it.

## Current pipeline (Phase 2 workstream A — shipped 2026-08-16)

```
Helius websocket (pump.fun + PumpSwap + Raydium LaunchLab + Raydium AMM v4)
        |
        v
HeliusListener ── heuristic "looks like a launch?" check on logs
        |
        +── tier 1 (raw-only sources, e.g. pump.fun): one insert, no RPC. Stop.
        |
        v  tier 2 (full pipeline)
Recorder.resolveAndRecord ── parsed tx -> mint, creator, POOL
        |                    pool confirmed by deriving its LP mint and
        |                    checking that mint exists; LP supply gives lpBurnedPct
        v
Recorder.snapshotNow ── t=0 snapshot: RECORDED, NOT JUDGED
        |
        v
Recorder.track ── decaying cadence to a 30 min horizon
        |
        |  every tick   : price + liquidity, from a batched Jupiter sweep over
        |                 all tracked mints (no RPC credits)
        |  at fixed ages: authorities + concentration (RPC), holder count (DAS)
        |                 carried forward in between, stamped with when they
        |                 were really read
        v
   (only on a metered refresh, once every metered field has been read)
        |
        v
runPipeline ── ordered filters, hard block stops execution
        |
        v
notify ── SQLite + console + Telegram, per-mint cooldown
```

Everything observed is written to SQLite *before* any filtering decision,
with our own observation timestamp. Filtered-out tokens are recorded too —
they are the control group for later research.

**Why judgement is deferred.** Helius DAS has not indexed a freshly observed
mint, so a t=0 holder count is wrong rather than merely small (measured: 2 at
t=0 against 1404 ten minutes later). The t=0 snapshot still enters the dataset;
it is simply not something we are willing to decide on. Re-assessing at each
metered refresh also means a token is judged on maturing data instead of on the
worst data the system will ever hold.

## Module boundaries

| Module          | Responsibility | Must NOT do |
|-----------------|----------------|-------------|
| ingest/         | connect, reconnect, detect launch-shaped logs | parse transactions, touch DB |
| recorder/       | resolve launches, take snapshots, persist raw truth | make judgements |
| recorder/pool   | identify the AMM pool + its vault from a parsed tx; concentration maths | fetch anything (pure, tx in / addresses out) |
| prices.ts       | batched Jupiter price + liquidity, cached | know about tokens or filters |
| das.ts          | Helius DAS holder statistics | judge, persist |
| filters/        | pure judgements from (launch, snapshot) | fetch data (except creator lookup), persist |
| scoring/        | future weighted scorer | exist yet |
| alerts/         | deliver + persist alerts | decide what is alertable |
| db/             | schema + typed persistence helpers, guarded migrations | business logic |

## Design rules
1. **Point-in-time discipline**: every stored row carries the timestamp of
   when *we* observed it. No backfilled values may ever overwrite it.
2. **Hard blocks are vetoes**: no future scorer or ML may override a hard
   block (active freeze authority, etc.).
3. **Insufficient data is not a pass** (replaced "graceful degradation" on
   2026-08-16). A filter that cannot evaluate must reject and set
   `insufficientData`, never default a missing value to something benign. The
   old rule let a token with no liquidity data and no holder data alert at
   "53/100"; `passed` meant "nothing could disprove it". Recording still
   degrades gracefully — only *judgement* fails closed.
4. **A carried-forward value must not look fresh**: fields refreshed on a slow
   cadence keep their real observation time (`chain_state_at`,
   `holder_count_at`). This is design rule 1 applied per field rather than per
   row.
5. **Metered reads stay off the tick**: price and liquidity are free and batched,
   so they refresh constantly; anything costing per-mint RPC or DAS credits
   refreshes only at the ages in `strategy.config.json`. The budget is the
   binding constraint on the whole recorder.
6. **Record the rejects**: alerting is selective; recording is total.

## Evolution path (only when justified)
- SQLite → Postgres when concurrent writers or dataset size (>10 GB) hurt.
- setInterval snapshots → a proper job queue when tracked tokens > ~200.
- Single process → split ingest from analysis if websocket handling starves.
