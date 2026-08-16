# Architecture

## Principle
One TypeScript monolith. Every component below is a module in one process,
communicating through direct function calls and a SQLite database. Nothing is
split into a service until measured load forces it.

## Current pipeline (Phase 1 — shipped)

```
Helius websocket (Raydium AMM v4 + pump.fun program logs)
        |
        v
HeliusListener ── heuristic "looks like a launch?" check on logs
        |
        v
Recorder.resolveAndRecord ── fetch parsed tx, extract mint/creator, persist
        |
        v
Recorder.snapshotNow + track ── on-chain snapshot now, then every 30s for 1h
        |
        v
runPipeline ── ordered filters, hard block stops execution
        |
        v
notify ── SQLite + console + Telegram
```

Everything observed is written to SQLite *before* any filtering decision,
with our own observation timestamp. Filtered-out tokens are recorded too —
they are the control group for later research.

## Module boundaries

| Module      | Responsibility | Must NOT do |
|-------------|----------------|-------------|
| ingest/     | connect, reconnect, detect launch-shaped logs | parse transactions, touch DB |
| recorder/   | resolve launches, take snapshots, persist raw truth | make judgements |
| filters/    | pure judgements from (launch, snapshot) | fetch data (except creator lookup), persist |
| scoring/    | future weighted scorer | exist yet |
| alerts/     | deliver + persist alerts | decide what is alertable |
| db/         | schema + typed persistence helpers | business logic |

## Design rules
1. **Point-in-time discipline**: every stored row carries the timestamp of
   when *we* observed it. No backfilled values may ever overwrite it.
2. **Hard blocks are vetoes**: no future scorer or ML may override a hard
   block (active freeze authority, etc.).
3. **Graceful degradation**: filters must handle `null` fields — RPC gaps are
   normal — and say so in their evidence list.
4. **Record the rejects**: alerting is selective; recording is total.

## Evolution path (only when justified)
- SQLite → Postgres when concurrent writers or dataset size (>10 GB) hurt.
- setInterval snapshots → a proper job queue when tracked tokens > ~200.
- Single process → split ingest from analysis if websocket handling starves.
