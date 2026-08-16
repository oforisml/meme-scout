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
2. **Records** every observed launch and periodic on-chain snapshots
   (authorities, holder concentration, liquidity) into SQLite with *our*
   observation timestamps — the foundation for honest backtesting later.
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

## Known gaps (deliberate TODOs)

- `liquidityUsd`, `priceUsd`, `holderCount`, `lpBurnedPct` are stubbed `null`
  in `recorder.ts` — wire them to pool vault balances / Helius DAS API /
  Jupiter price API. Filters already degrade gracefully when data is missing.
- pump.fun launch log matching is heuristic; tighten against real traffic.
- No trading, no keys, no execution. That comes only after months of recorded
  data says any strategy actually has an edge.

## Testing

`npm test` — filters and pipeline are pure functions with full unit
coverage; a silent filter bug would poison months of assessment data.

## Philosophy

Record everything. Alert conservatively. Trade never — until the data earns it.
