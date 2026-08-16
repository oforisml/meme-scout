# External integrations

## Helius (required)
- **RPC**: https://mainnet.helius-rpc.com/?api-key=KEY — getParsedTransaction,
  getParsedAccountInfo, getTokenLargestAccounts, getSignaturesForAddress.
- **Websocket**: logsSubscribe with `mentions` on program IDs, commitment
  `confirmed`. Reconnect with exponential backoff (implemented).
- **DAS API** (Phase 2): getTokenAccounts for holder counts;
  getAssetsByOwner for creator portfolio analysis.
- Free tier is fine for development; watch the RPC credit budget once
  snapshotting many tokens (each tracked token ≈ 6 RPC calls/min).

## Program IDs watched
| Program | ID | Signal |
|---|---|---|
| pump.fun (bonding curve) | 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P | `InitializeMint2` / `Instruction: Create` = launch |
| PumpSwap AMM | pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA | `create_pool` = graduation (since 2025-03-20 graduations go HERE, not Raydium) |
| Raydium LaunchLab (LetsBonk) | LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj — VERIFY vs live traffic, open decision #8 | `Initialize` / `PoolCreateEvent` = launch |
| Raydium AMM v4 | 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 | `initialize2` = legacy/general new pool |

Venue notes (2026): pump.fun handles most launchpad activity with LetsBonk a
clear second; market share has flipped before and will again — FR-J1 tracks
it. Phase 2+ candidates: Raydium CPMM/CLMM, Meteora DBC, Moonshot, Believe.

## Jupiter (Phase 2)
- Price API for price_usd.
- Quote API (`/quote`) for realistic slippage measurement: ask for a quote of
  a standard size (e.g. 0.5 SOL) and record the implied impact — this becomes
  the honest execution-cost model for research, long before any trading.

## Social / narrative sources (Module I, Phase 4)
- X API (paid tiers) for ticker/keyword mention counts — check current
  pricing against NFR-5 before committing (open decision #7).
- Telegram public channel monitoring as a fallback signal.
- Lexicon of meme families is Operator-maintained at first; automation later.

## Telegram (optional, implemented)
Bot API sendMessage. Token via @BotFather, chat id via @userinfobot.

## Solana specifics to respect
- Commitment levels: processed → confirmed → finalized. We ingest at
  confirmed; treat finalized as settlement truth for research outcomes.
- Token-2022 (Phase 2): detect transfer hooks and transfer-fee extensions —
  these are the real "honeypot" mechanisms alongside freeze authority.
- No EVM-style reorg handling needed; handle dropped/expired transactions.
