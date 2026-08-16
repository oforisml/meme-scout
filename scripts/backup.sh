#!/usr/bin/env bash
#
# FR-G1 — off-machine dataset backup.
#
# Takes a consistent snapshot of the SQLite database, verifies it, compresses
# it, ships it to object storage via rclone, and prunes old copies.
#
#   ./scripts/backup.sh
#
# Runs against the LIVE database with no downtime: VACUUM INTO uses SQLite's
# online backup machinery and measured 47ms on a 55MB file, leaving the WAL
# untouched. Do not stop the recorder for this.
#
# Deliberately shell rather than TypeScript: importing src/db/db.ts would open
# a second read-write connection and run DDL against a database that must have
# exactly one writer (see RUNBOOK "DB locked").
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

# Config comes from .env, the same place the app reads it.
if [ -f .env ]; then set -a; . ./.env; set +a; fi
DB_PATH="${DB_PATH:-./data/meme-scout.db}"
REMOTE="${BACKUP_RCLONE_REMOTE:-}"

STATE_FILE="$ROOT/data/.backup-state.json"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="meme-scout-$STAMP"
WORK="$(mktemp -d)"
STEP="init"

# Keep the last N of each tier. 6-hourly runs => 16/day.
KEEP_6H=16          # ~4 days
KEEP_DAILY=31       # ~1 month, satisfies FR-G1's ">= 30 days"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# Any non-zero exit records WHICH step failed, so the >12h alert can name the
# cause instead of only reporting staleness.
fail() {
  local code=$?
  printf '{"lastAttemptAt":%s,"failedStep":"%s","lastError":"exit %s"}\n' \
    "$(date +%s000)" "$STEP" "$code" > "$STATE_FILE"
  echo "[$(date -u +%FT%TZ)] BACKUP FAILED at step: $STEP (exit $code)" >&2
  exit "$code"
}
trap fail ERR

echo "[$(date -u +%FT%TZ)] backup start ($NAME)"

# --- 1. consistent snapshot, no recorder downtime -------------------------
STEP="snapshot"
sqlite3 "$DB_PATH" "VACUUM INTO '$WORK/$NAME.db'"

# --- 2. verify BEFORE shipping -------------------------------------------
# A corrupt backup is worse than none: it looks like protection.
STEP="integrity_check"
INTEGRITY="$(sqlite3 "$WORK/$NAME.db" 'PRAGMA integrity_check;' | head -1)"
[ "$INTEGRITY" = "ok" ] || { echo "integrity_check said: $INTEGRITY" >&2; false; }

# --- 3. row counts, so the restore drill has something to compare against --
STEP="row_counts"
counts="{"
for t in tokens snapshots raw_events assessments alerts; do
  n="$(sqlite3 "$WORK/$NAME.db" "SELECT COUNT(*) FROM $t;")"
  counts="$counts\"$t\":$n,"
done
counts="${counts%,}}"
echo "$counts" > "$WORK/$NAME.json"
echo "  rows: $counts"

# --- 4. compress (measured ~7.6x on this dataset) -------------------------
STEP="compress"
gzip -6 "$WORK/$NAME.db"
BYTES="$(stat -c%s "$WORK/$NAME.db.gz")"
echo "  compressed: $BYTES bytes"

# --- 5/6/7. ship it -------------------------------------------------------
if [ -z "$REMOTE" ]; then
  echo "  BACKUP_RCLONE_REMOTE unset — snapshot verified but NOT shipped off-machine."
  echo "  This does not satisfy FR-G1. Set it in .env once rclone is configured."
  printf '{"lastAttemptAt":%s,"failedStep":"upload","lastError":"BACKUP_RCLONE_REMOTE unset"}\n' \
    "$(date +%s000)" > "$STATE_FILE"
  trap - ERR
  exit 0
fi

STEP="upload"
rclone copyto "$WORK/$NAME.db.gz" "$REMOTE/6h/$NAME.db.gz"
rclone copyto "$WORK/$NAME.json"  "$REMOTE/6h/$NAME.json"

# Midnight run is also kept as the daily copy.
if [ "$(date -u +%H)" = "00" ]; then
  STEP="upload_daily"
  rclone copyto "$WORK/$NAME.db.gz" "$REMOTE/daily/$NAME.db.gz"
  rclone copyto "$WORK/$NAME.json"  "$REMOTE/daily/$NAME.json"
fi

# --- 7. confirm it actually landed ----------------------------------------
# "rclone exited 0" is not the same as "the object is in the bucket", and
# FR-G1 is specifically about the copy being off-machine.
STEP="verify_remote"
REMOTE_BYTES="$(rclone lsjson "$REMOTE/6h/$NAME.db.gz" | grep -o '"Size":[0-9]*' | head -1 | cut -d: -f2)"
[ "$REMOTE_BYTES" = "$BYTES" ] || {
  echo "remote size $REMOTE_BYTES != local $BYTES" >&2; false;
}
echo "  verified at remote: $REMOTE/6h/$NAME.db.gz"

# --- 8. prune by the timestamp in the filename ----------------------------
# NOT `rclone delete --min-age`: that filters on object mtime, which backends
# set at upload time rather than preserving, so a re-uploaded daily copy would
# be aged from its upload date. The filename is backend-independent.
prune() {
  local dir="$1" keep="$2"
  rclone lsf "$REMOTE/$dir" --include "meme-scout-*.db.gz" 2>/dev/null \
    | sort | head -n -"$keep" | while read -r old; do
        [ -n "$old" ] || continue
        echo "  pruning $dir/$old"
        rclone deletefile "$REMOTE/$dir/$old" || true
        rclone deletefile "$REMOTE/$dir/${old%.db.gz}.json" || true
      done
}
STEP="prune"
prune 6h "$KEEP_6H"
prune daily "$KEEP_DAILY"

# --- 9. success marker: what the >12h staleness alert reads ---------------
STEP="write_state"
printf '{"completedAt":%s,"bytes":%s,"remotePath":"%s","rowCounts":%s}\n' \
  "$(date +%s000)" "$BYTES" "$REMOTE/6h/$NAME.db.gz" "$counts" > "$STATE_FILE"

trap - ERR
echo "[$(date -u +%FT%TZ)] backup ok"
