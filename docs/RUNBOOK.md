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

## Inspect the data
sqlite3 data/meme-scout.db
  .tables
  SELECT COUNT(*) FROM tokens;
  SELECT mint, total_score, passed FROM assessments ORDER BY assessed_at DESC LIMIT 20;
  SELECT * FROM alerts ORDER BY created_at DESC LIMIT 10;

## Common issues
- No events arriving: check HELIUS_API_KEY; free-tier websockets can lag —
  the listener reconnects automatically with backoff (see logs).
- RPC 429s: too many tracked tokens; raise snapshot interval in
  recorder.track() or upgrade the Helius plan.
- DB locked: only run one process against the SQLite file (WAL helps, but
  two writers is still asking for trouble).

## Changing thresholds
Edit src/strategy.config.json and COMMIT it — never tweak live. Every
assessment stores the config hash; uncommitted edits break auditability.

## Invariants — never violate
1. Never overwrite observed_at / taken_at timestamps.
2. Never delete rejected tokens; they are the research control group.
3. No private keys anywhere in this codebase until Phase 6, by design.
