# meme-scout

Solana meme-coin **monitoring, alerting and point-in-time market recorder**.

This is deliberately *not* a trading bot. It is the first honest phase of a
larger system: watch every new launch, record what the market looked like at
the moment we saw it, apply safety filters, and alert on candidates that pass.
The recorded dataset is the real asset — you cannot buy point-in-time data for
tokens that live for three hours, so we build it ourselves.

## What it does

1. **Listens** to Helius websocket logs across four venues: pump.fun
   launches, PumpSwap pool creations (= pump.fun graduations), Raydium
   LaunchLab (LetsBonk) launches, and Raydium AMM v4 pools.
2. **Records** every observed launch and periodic on-chain snapshots (price,
   liquidity, holder count, authorities, holder concentration, LP burn) into
   SQLite with *our* observation timestamps — the foundation for honest
   backtesting later. Cheap fields refresh every tick; metered ones refresh at
   fixed token ages and carry forward with `chain_state_at` / `holder_count_at`
   recording when they were really read.
3. **Filters** each candidate:
   - mint / freeze authority still active → hard block (Solana's honeypot)
   - minimum liquidity + LP burn heuristic
   - top-10 holder concentration
   - creator wallet age/activity heuristics
4. **Alerts** via console and optionally Telegram, with full evidence lists.

## Setup

```bash
npm install
cp .env.example .env   # add your HELIUS_API_KEY (free tier works)
npm test               # 12 unit tests, no network needed
npm run dev
```

## How ingestion is tiered (RPC budget survival)

The market does tens of thousands of launches/day. Policy lives in
`src/strategy.config.json` (versioned; its hash is stored on every
assessment):
- **raw-only sources** (default: pump.fun launches) → one cheap DB insert,
  no RPC. The dataset still sees everything.
- **full-pipeline sources** (default: PumpSwap graduations, LaunchLab,
  Raydium) → resolve, snapshot on a decaying cadence (5s → 15s → 1m → 5m),
  filter, alert. Graduation itself is the quality gate — most tokens die on
  the bonding curve.
Alerts have a per-mint cooldown; graduations link to their recorded launch
instead of duplicating it.

## Project structure

```
src/
  index.ts            wiring: listen → record → filter → alert
  config.ts           env config (zod-validated)
  types.ts            core domain types
  ingest/helius.ts    websocket listener with reconnect
  recorder/           launch resolution + periodic snapshots (the dataset)
  filters/            ordered safety filters, hard blocks stop the pipeline
  scoring/            (reserved for the future opportunity scorer)
  alerts/notifier.ts  console + Telegram alerts
  db/                 SQLite schema + persistence
```

## What "passed" means

A candidate must clear the bar on real data. **Insufficient data is not a
pass** — if a filter cannot evaluate, it rejects and marks the result
`insufficientData`, so Phase 3 can tell "we judged this and said no" from "we
never knew". Unevaluable filters are left out of the score rather than
averaging in a middling value.

This matters more than it sounds. Before the fields below were wired, every
filter degraded toward pass and alerts fired at "53/100" citing *"Liquidity
unknown"* and *"Holder concentration unknown"*. Expect far fewer alerts now;
that is the point.

## Known gaps (deliberate TODOs)

- Pool identification is validated for **PumpSwap only**. LaunchLab and
  Raydium tokens record an unconfirmed pool, and therefore unknown
  concentration, rather than a guess — which under the rule above means they
  do not alert.
- `minHolders` has not been retuned against real holder distributions; the
  first live samples sat close to the threshold, so treat it as provisional.
- `lpBurnedPct` reports 0% for a pool with any outstanding LP supply, even if
  part was burned. Conservative, but imprecise.
- pump.fun launch log matching is heuristic; tighten against real traffic.
- The RPC budget is tight against the Helius free tier — see the cadence notes
  in `strategy.config.json` before making anything refresh more often.
- No trading, no keys, no execution. That comes only after months of recorded
  data says any strategy actually has an edge.

## Testing

`npm test` — 22 unit tests, offline. Filters, the pipeline and the pool-vault
exclusion arithmetic are pure functions with unit coverage; a silent filter bug
would poison months of assessment data.

`npm run probe` — read-only check that every external data source still returns
the shape the recorder expects, run against real mints from your own database.
Run it before trusting recorder changes: API shapes drift, and a wrong
assumption silently reintroduces nulls.

## Philosophy

Record everything. Alert conservatively. Trade never — until the data earns it.
