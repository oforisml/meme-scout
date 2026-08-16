# Runbook

## Start
npm install
npm test               # must be green before any deploy
cp .env.example .env   # set HELIUS_API_KEY
npm run dev            # pretty logs, auto-restart on file change
npm start              # plain run

## Keep it running unattended
npx pm2 start "npm start" --name meme-scout
npx pm2 logs meme-scout
npx pm2 save

## Backups (FR-G1)

One-time setup:
```
curl https://rclone.org/install.sh | sudo bash    # Kali's package lags
rclone config                                     # create a B2/R2 remote
echo 'BACKUP_RCLONE_REMOTE=b2:meme-scout-backups' >> .env
```

Then:
```
npm run backup           # manual run; safe while the recorder is live
npm run restore-drill    # pull the newest remote backup and verify it
crontab -l               # the 6-hourly job should be listed
tail -f logs/backup.log
```

A backup takes ~50ms and needs **no downtime** — `VACUUM INTO` uses SQLite's online
backup machinery. Never `cp` the .db file instead: that silently drops the
several MB of uncheckpointed commits sitting in the -wal.

Retention is 16 six-hourly copies (~4 days) plus 31 dailies, pruned by the
timestamp in the filename. At ~7 MB per compressed snapshot that is ~1.5–2 GB.

### Restoring for real

```
rclone lsf b2:meme-scout-backups/6h | sort | tail -5    # pick one
rclone copyto b2:meme-scout-backups/6h/<name>.db.gz /tmp/restore.db.gz
gunzip /tmp/restore.db.gz
sqlite3 /tmp/restore.db 'PRAGMA integrity_check;'       # must say ok

npx pm2 stop meme-scout                                 # one writer only
mv data/meme-scout.db data/meme-scout.db.broken         # never delete the original
mv /tmp/restore.db data/meme-scout.db
rm -f data/meme-scout.db-wal data/meme-scout.db-shm     # stale WAL vs a new db file
npx pm2 start meme-scout
```

Keep `.broken` until you are certain: a partially-corrupt database usually still
holds most of its rows, and the dataset cannot be re-collected.

**If backups go stale for >12h the recorder sends a Telegram alert** naming the
step that failed. It cannot alert if the whole machine is off — that gap needs
FR-G2's daily alive ping.

## Check the external data sources still work
npm run probe            # read-only; hits every source for real mints from your DB

Run this before trusting recorder changes. API shapes drift, and a wrong
assumption silently reintroduces the nulls Phase 2 existed to remove.

## Inspect the data
sqlite3 data/meme-scout.db
  .tables
  SELECT COUNT(*) FROM tokens;
  SELECT mint, total_score, passed FROM assessments ORDER BY assessed_at DESC LIMIT 20;
  SELECT * FROM alerts ORDER BY created_at DESC LIMIT 10;

  -- tokens now holds pump.fun bonding-curve launches too (~60k/day), so
  -- qualify anything that assumed one row = one pipeline candidate.
  SELECT source, kind, COUNT(*) FROM tokens GROUP BY 1, 2;

  -- "Did it graduate?" is graduated_at, NOT kind='graduation'. When we
  -- recorded the launch first, INSERT OR IGNORE keeps source='pumpfun',
  -- kind='launch' and only stamps graduated_at.
  SELECT COUNT(*) FROM tokens WHERE graduated_at IS NOT NULL;

  -- Time on curve, computable only where we saw the launch.
  SELECT mint, (graduated_at - observed_at)/60000.0 AS minutes_on_curve
  FROM tokens WHERE graduated_at IS NOT NULL ORDER BY 2 LIMIT 20;

  -- Our observation latency vs the chain (ROADMAP standing risk #1).
  SELECT AVG((observed_at - chain_ts)/1000.0) FROM tokens WHERE chain_ts IS NOT NULL;

  -- Pool capture — graduations only; launches legitimately have no pool.
  SELECT COUNT(*), SUM(pool IS NOT NULL) FROM tokens WHERE source != 'pumpfun';

  -- Field coverage. ALWAYS filter on schema_version: version 1 rows were
  -- written when the four market fields were null and missing data counted as
  -- a pass, so their `passed` values are artifacts and are not comparable.
  SELECT COUNT(*),
         SUM(price_usd IS NULL), SUM(liquidity_usd IS NULL),
         SUM(holder_count IS NULL), SUM(top10_holder_pct IS NULL)
  FROM snapshots WHERE schema_version >= 2;

## What alerts you, and when

| condition | channel | timing |
|---|---|---|
| candidate passes filters | Telegram + `alerts` table | immediate, 60 min per-mint cooldown |
| no ingest events for 10 min | Telegram, then forced reconnect | detected within 11 min; re-alerts every 30 min |
| no pong for 90s | forced reconnect | silent, log only |
| backup stale >12h | Telegram | re-alerts every 6h |
| all is well | Telegram daily report | every 24h |

**The daily report is load-bearing, not noise.** It is the only thing that
distinguishes "nothing has gone wrong" from "the alerting path itself is
broken". If it stops arriving, treat that as the alert.

Operational alerts go through `notifyOps` / `sendTelegram` and deliberately do
**not** write to the `alerts` table — that table means "a token we alerted on".

## Common issues
- No events arriving: check HELIUS_API_KEY; free-tier websockets can lag —
  the listener reconnects automatically with backoff (see logs).
- RPC 429s: too many tracked tokens. The budget is tight against the free tier
  by design (roughly 12 metered calls per token against 1M credits/month at
  ~110 new tokens/hour). Levers, in order: widen the cadence marks in
  strategy.config.json, shorten the snapshot horizon, then upgrade the plan.
  Do NOT make metered fields refresh every tick.
- No alerts at all: expected to be rare now, but check whether filters are
  rejecting on `insufficientData` rather than on evidence — that means a data
  source is failing, not that candidates are bad. `npm run probe` will say
  which one.
- Holder counts look implausibly low: DAS lags a freshly observed mint by
  minutes. Nothing before the first mark in `holdersAtSec` should be trusted.
- DB locked: only run one process against the SQLite file (WAL helps, but
  two writers is still asking for trouble).

## Credit budget — the thing that killed the recorder once

Helius bills websockets at **20 credits/MB**, and `logsSubscribe` hands over
every transaction touching a program. That, not RPC calls, is the entire cost.

| venue | GB/day | credits/month |
|---|---|---|
| PumpSwap | 104 | 62M |
| pump.fun | 13.5 | 8.1M |

Allowances: 1M free, 10M ($49), 100M ($499). The full set is ~71M/month, which
empties a free allowance in about ten hours — as it did on 2026-08-16.

Set scope with `INGEST_PROFILE` and the ceiling with `HELIUS_MONTHLY_CREDITS`.
The startup banner prints projected burn versus budget; if it says EXCEEDS,
believe it.

```sql
-- month-to-date spend by source
SELECT source, ROUND(SUM(credits)) FROM credit_usage
 WHERE day LIKE strftime('%Y-%m', 'now') || '%' GROUP BY source ORDER BY 2 DESC;

-- when were we actually connected? gaps here are NOT quiet markets
SELECT datetime(opened_at/1000,'unixepoch'), datetime(closed_at/1000,'unixepoch'), venues
  FROM ingest_windows ORDER BY opened_at DESC LIMIT 10;
```

If ingest pauses itself, that is the pacing logic keeping you inside the month,
not a fault. Raise the budget or the tier to widen coverage.

## Two bars, and why they are separate

`thresholds` decides what **passes** — and passing is what the dataset records:
every pass gets an `alerts` row and FR-A6 cost quotes. `alerts.notify` decides
only what reaches **Telegram**.

Do not collapse them. Alert volume is also the execution-cost sampling rate, so
raising the pass bar to quieten your phone silently shrinks the cost dataset by
the same factor — and shrinks it exactly at the marginal candidates that show
where liquidity gives out. Turn the `notify` block instead.

```sql
-- delivered vs merely recorded
SELECT notified, COUNT(*) FROM alerts GROUP BY notified;
```

## Changing thresholds
Edit src/strategy.config.json and COMMIT it — never tweak live. Every
assessment stores the config hash; uncommitted edits break auditability.

## Invariants — never violate
1. Never overwrite observed_at / taken_at timestamps.
2. Never delete rejected tokens; they are the research control group.
3. No private keys anywhere in this codebase until Phase 6, by design.
4. Insufficient data is never a pass. If a filter cannot evaluate, it rejects
   and marks `insufficientData` — do not "helpfully" default a missing value.
5. A carried-forward field must never look freshly observed. Slow-moving
   fields reuse their real observation time via chain_state_at /
   holder_count_at; do not stamp them with taken_at.
6. Bump SCHEMA_VERSION in src/db/db.ts whenever the meaning of a column
   changes, so earlier rows stay distinguishable rather than silently
   comparable.
