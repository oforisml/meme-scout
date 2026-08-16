# Data model

SQLite, WAL mode. File at DB_PATH (default ./data/meme-scout.db).

## tokens — one row per discovered mint
Holds **both** bonding-curve launches and pool creations. Since 2026-08-16 the
pump.fun raw-only tier records real launches here (decoded from the CreateEvent
in the logs, no RPC), so this is no longer "things we pipeline" — most rows are
never snapshotted. Roughly 60k rows/day.

| column | meaning |
|---|---|
| mint (PK) | token mint address |
| pool | AMM pool, once confirmed via its derived LP mint (nullable) |
| creator | from the CreateEvent, or first signer of the launch tx |
| source | pumpfun \| pumpswap \| launchlab \| raydium |
| kind | launch \| graduation — of the FIRST observation |
| first_signature, first_slot | the transaction we saw it in |
| observed_at | unix ms when WE saw it |
| graduated_at, graduation_signature | set when the token reaches an AMM |
| name, symbol, uri | token metadata, when the venue gives it free |
| chain_ts | on-chain event time. `observed_at - chain_ts` is our latency |

**Querying it correctly — two traps.**

1. **"Did it graduate?" is `graduated_at IS NOT NULL`, never `kind = 'graduation'`.**
   `saveToken` is INSERT OR IGNORE, so when we recorded the launch first, the
   graduation only stamps `graduated_at`; `source`/`kind` keep their original
   values because first observation wins. `kind = 'graduation'` therefore selects
   only tokens whose launch we *missed*.
2. **Qualify anything that used to assume "one row = one pipeline candidate".**
   `sum(pool IS NOT NULL)` over the whole table is meaningless — bonding-curve
   launches legitimately have no pool. Arrival rate for RPC-budget purposes means
   full-pipeline arrivals (`source != 'pumpfun'`), which is ~25x smaller.

`graduated_at - observed_at` is **time on curve**, computable only for tokens
whose launch we recorded.

## snapshots — time series of on-chain state per token
Only for full-pipeline tokens. Decaying cadence to a 30 min horizon
(Recorder.track). Nullable columns are honest: null means "not knowable at that
moment", and under the current filter rules null is a rejection, not a pass.

Fields refresh on different cadences because they cost different amounts, so a
row mixes fresh and carried-forward values — the `*_at` columns say which.

| column | meaning |
|---|---|
| mint, taken_at | key |
| price_usd | Jupiter price v3, batched (every tick, no RPC credits) |
| liquidity_usd | Jupiter price v3 `liquidity`, same request |
| holder_count | distinct owners via Helius DAS (metered, see holdersAtSec) |
| top10_holder_pct | largest accounts vs supply, **pool vault excluded** |
| mint_authority_active | 1/0/null |
| freeze_authority_active | 1/0/null |
| lp_burned_pct | from LP mint supply (100 = fully burned) |
| chain_state_at | when the authority/concentration fields were really read |
| holder_count_at | when holder_count was really read |
| schema_version | 1 = pre-wiring rows, not comparable. Filter on >= 2 |

## raw_events — thin audit trail
One row per full-pipeline event, payload `{signature}` only.

**It is not a replay substrate.** It was described as one, but nothing has ever
read this table, and as of 2026-08-16 it no longer stores log arrays: at 7.5 KB
per row it was 89% of the database and 443 MB/day, with a null mint on every
row, so it could not be joined to anything. Replay is served by `assessments`
(full FilterResult[]) plus `snapshots`, which is what NFR-7 and FR-B4 actually
consume. Rows written before that change still contain their logs and are left
untouched — NFR-1 forbids rewriting stored observations.

## swaps — raw per-swap rows, launch windows only
Storing every swap for tracked tokens would be ~7.1M rows/day (measured), so
raw rows are kept only inside the bounded windows in `strategy.config.json`:
the first 60s of PumpSwap tracking, and the first 20 slots of a pump.fun curve
launch (FR-H1). This is where per-wallet forensics — bundles, deployer-funded
snipers, wash detection — actually needs individual trades.

Diverges from the shape sketched here originally (`amount`, `price`): we store
`sol_amount` **and** `token_amount` because those are what the event reports,
and omit `price` because it is derivable from the pair — a stored derived value
only drifts from its inputs. `wallet` and `pool` are added; both are needed.

`mint` is **nullable**: a pool trades before we have resolved pool → mint, and
those earliest swaps are exactly the launch window we care about. They are
buffered, replayed on resolution, and any already written are backfilled.

⚠ **PumpSwap pools exist in both orientations.** Usually (memecoin base / WSOL
quote), sometimes reversed. Swap events report the two amounts positionally, so
the orientation is read from the Pool account at confirmation. Assuming the
common case reported a token amount as 31,772 SOL on a fresh memecoin.

## swap_buckets — per-minute aggregates, the H1 series
One row per tracked mint per minute for the whole tracking window.

| column | meaning |
|---|---|
| trades, buys, sells | counts |
| sol_in, sol_out | volume each way |
| distinct_buyers | unique wallets buying this minute |
| **new_buyers** | wallets never seen buying this mint before |
| cumulative_buyers | distinct buyers ever, for this mint |
| buyers_who_also_sold | round-trippers this minute — a cheap wash tell |

**`new_buyers` across successive buckets IS H1's "unique-buyer growth".** Volume
is trivially faked; a stream of genuinely new wallets is expensive to fake. A
token whose trades keep coming from the same wallets shows constant volume and
`new_buyers` collapsing to zero — that is the wash-vs-organic distinction the
hypothesis rests on.

## assessments — every pipeline verdict, pass or fail
`results_json` stores the full FilterResult[] (name, passed, hardBlock,
score, evidence) so any alert can be explained months later.

## alerts — what was actually sent

## quotes — execution-cost samples (FR-A6)
What the standard 0.5 SOL trade would actually have cost, recorded at the alert
and again at exit horizons. Feeds FR-B3's "expectancy net of costs", which is
the entire Phase 3 question. Unbackfillable: you cannot ask later what a trade
would have cost on a pool that no longer exists.

| column | meaning |
|---|---|
| alert_id | the alert this prices — **not** the mint, see below |
| side | buy \| sell |
| horizon_min | 0 = at alert; otherwise minutes after it |
| in_amount, out_amount | raw amounts, as strings |
| price_impact_pct | **true percent**, converted from Jupiter's fraction |
| route | AMM labels joined, e.g. `HumidiFi>TesseraV` |
| latency_ms, ok, error | FR-A6 requires failures be recorded, not skipped |

⚠ **`price_impact_pct` is a true percent.** Jupiter reports a decimal fraction
despite the field name (SOL→USDC at 0.5 SOL returns `0.0000126`, i.e. 0.00126%).
It is converted once at parse time. **`100` is legitimate** and means the pool
was dead or unroutable at that size — a finding, not an error.

⚠ **The `horizon_min = 0` sell row is a reference point, not an observed exit
cost.** Quoting straight back out hits the same pool state and so mirrors the
entry impact by construction — that is FR-B3's ×2 assumption restated, not a
measurement of it. Observed exit cost is the `horizon_min > 0` rows, which is
the point of collecting them: memecoin liquidity decays fast, so the ×2 model
is expected to read optimistic.

Keyed on `alert_id` rather than mint because the alert cooldown is 60 min while
horizons run to 240, so one mint can legitimately alert twice with overlapping
windows.

## Future tables (do not create until needed)
- outcomes(mint, horizon_min, max_return, return_at_horizon, rugged) — Phase 3
- creators(address, tokens_launched, rug_count, first_seen) — Phase 3
