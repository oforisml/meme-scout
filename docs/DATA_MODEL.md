# Data model

SQLite, WAL mode. File at DB_PATH (default ./data/meme-scout.db).

## tokens — one row per discovered launch
| column | meaning |
|---|---|
| mint (PK) | token mint address |
| pool | pool address if resolved (nullable) |
| creator | first signer of the launch tx (nullable) |
| source | raydium \| pumpfun |
| first_signature | launch transaction signature |
| first_slot | slot we observed it in |
| observed_at | unix ms when WE saw it |

## snapshots — time series of on-chain state per token
Taken immediately at discovery, then every 30s for 1h (Recorder.track).
Nullable columns are honest: null means "not knowable at that moment".
| column | meaning |
|---|---|
| mint, taken_at | key |
| price_usd | TODO (Jupiter price API / pool reserves) |
| liquidity_usd | TODO (pool vault balances) |
| holder_count | TODO (Helius DAS getTokenAccounts) |
| top10_holder_pct | from getTokenLargestAccounts vs supply |
| mint_authority_active | 1/0/null |
| freeze_authority_active | 1/0/null |
| lp_burned_pct | TODO (LP supply sent to burn address) |

## raw_events — replayable raw payloads
Launch logs and anything else worth keeping verbatim. `payload` is raw JSON.
This is the replay substrate: filters can be re-run against history exactly
as it was observed.

## assessments — every pipeline verdict, pass or fail
`results_json` stores the full FilterResult[] (name, passed, hardBlock,
score, evidence) so any alert can be explained months later.

## alerts — what was actually sent

## Future tables (do not create until needed)
- swaps(mint, signature, side, amount, price, observed_at) — Phase 2
- outcomes(mint, horizon_min, max_return, return_at_horizon, rugged) — Phase 3
- creators(address, tokens_launched, rug_count, first_seen) — Phase 3
