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
