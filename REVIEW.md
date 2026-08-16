# Independent review of the GPT master specification

## Verdict
An impressive vision document that, built as written, guarantees a year of
infrastructure work before learning whether any edge exists. Keep it as a
north star; build almost none of it yet.

## 1. Over-engineered for a single developer
14 microservices, Kafka, Kubernetes, Terraform, Java/Spring + a separate
Python ML stack is a 10-engineer architecture. The spec itself concedes an
MVP could be consolidated, then never acts on it. Correct starting point:
one TypeScript monolith, SQLite/Postgres, a process manager. Also note the
spec silently switched the stack to Java 21/Spring Boot. Solana tooling
(Helius SDK, Jupiter, transaction parsing) is JavaScript-first; Java means
fighting the ecosystem for zero benefit at this scale.

## 2. The fatal flaw: the data does not exist
The spec correctly demands point-in-time backtesting, then ignores that
tick-level historical data for brand-new Solana meme coins essentially cannot
be bought. Most tokens live hours. Consequence: the FIRST deliverable must be
a recorder that captures launches, swaps, liquidity and holder snapshots with
observation timestamps. Months of self-recorded data is the prerequisite for
every downstream component (backtester, ML, strategy weights).

## 3. The latency contradiction
Meme momentum decays in seconds-to-minutes; competitors buy in the same block
as pool creation. A 14-stage pipeline ending in ML ranking structurally enters
after the fast money and suffers adverse selection: the fills a slow system
can get are disproportionately the ones fast players declined. The spec never
confronts where on the speed/selectivity frontier it intends to live. Decide
this before building strategy components.

## 4. Solana-specific corrections
- Reorg section is EVM thinking. Solana: processed → confirmed → finalized
  slot commitment; failure modes are dropped/expired transactions, not reorgs.
- "Honeypot detection" on Solana ≈ mint authority, freeze authority, and
  Token-2022 transfer hooks/fee extensions — not arbitrary EVM contract code.
- Priority fees and Jito tips belong in the execution-cost model.

## 5. Smart-money scores are adversarial
Wallet track records are actively farmed so copy-traders become exit
liquidity. Any smart-money score must assume the signal is gamed, decay fast,
and be validated against self-recorded outcomes, not vendor labels.

## 6. What to build now (and only this)
1. Recorder (point-in-time SQLite dataset) — the real product.
2. Safety filters: authority checks, liquidity/LP-burn, holder concentration,
   creator wallet heuristics.
3. Alerts (Telegram).
4. After ~3 months of data: measure hypothetical outcomes of alerted
   candidates net of realistic slippage. Only then decide whether strategy,
   risk and execution layers deserve to exist.

Everything else in the spec — Kafka, K8s, ML registry, correlation engine,
regime detection — is premature until the recorded data proves an edge worth
industrialising.
