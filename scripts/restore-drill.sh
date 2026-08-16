#!/usr/bin/env bash
#
# FR-G1 AC1 — "a restore drill from backup succeeds and row counts match".
#
#   ./scripts/restore-drill.sh              # newest object from the remote
#   ./scripts/restore-drill.sh path/to.db.gz  # a specific local artifact
#
# An untested backup is a hypothesis. This pulls a real backup, verifies it,
# and compares it against the live database. Read-only against live; the
# restored copy lands in a temp dir and is discarded.
#
set -euo pipefail

cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
DB_PATH="${DB_PATH:-./data/meme-scout.db}"
REMOTE="${BACKUP_RCLONE_REMOTE:-}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILED=0
note_fail() { echo "  FAIL: $1"; FAILED=1; }

# --- 1. obtain an artifact -------------------------------------------------
if [ $# -ge 1 ]; then
  SRC_DESC="local file $1"
  cp "$1" "$WORK/restored.db.gz"
else
  [ -n "$REMOTE" ] || { echo "BACKUP_RCLONE_REMOTE unset and no local file given" >&2; exit 1; }
  NEWEST="$(rclone lsf "$REMOTE/6h" --include 'meme-scout-*.db.gz' | sort | tail -1)"
  [ -n "$NEWEST" ] || { echo "no backups found at $REMOTE/6h" >&2; exit 1; }
  SRC_DESC="$REMOTE/6h/$NEWEST"
  echo "pulling $SRC_DESC"
  rclone copyto "$REMOTE/6h/$NEWEST" "$WORK/restored.db.gz"
  rclone copyto "$REMOTE/6h/${NEWEST%.db.gz}.json" "$WORK/expected.json" 2>/dev/null || true
fi

echo "=== restore drill: $SRC_DESC ==="

# --- 2. decompress ---------------------------------------------------------
gunzip "$WORK/restored.db.gz"
echo "  restored size: $(stat -c%s "$WORK/restored.db") bytes"

# --- 3. integrity ----------------------------------------------------------
INTEGRITY="$(sqlite3 "$WORK/restored.db" 'PRAGMA integrity_check;' | head -1)"
echo "  integrity_check: $INTEGRITY"
[ "$INTEGRITY" = "ok" ] || note_fail "restored database is corrupt"

# --- 4. row counts vs live -------------------------------------------------
# The backup is older than live, so lower counts are expected and fine.
# Higher counts, or zero, mean something is genuinely wrong.
printf "\n  %-14s %12s %12s   %s\n" "table" "restored" "live" "verdict"
for t in tokens snapshots raw_events assessments alerts; do
  R="$(sqlite3 "$WORK/restored.db" "SELECT COUNT(*) FROM $t;")"
  L="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM $t;")"
  if [ "$R" -gt "$L" ]; then
    V="FAIL (more than live)"; FAILED=1
  elif [ "$R" -eq 0 ] && [ "$L" -gt 0 ]; then
    V="FAIL (empty)"; FAILED=1
  else
    V="ok"
  fi
  printf "  %-14s %12s %12s   %s\n" "$t" "$R" "$L" "$V"
done

# --- 5. does it match what the backup job claimed it wrote? ----------------
if [ -f "$WORK/expected.json" ]; then
  echo
  EXPECTED_TOKENS="$(grep -o '"tokens":[0-9]*' "$WORK/expected.json" | cut -d: -f2)"
  ACTUAL_TOKENS="$(sqlite3 "$WORK/restored.db" 'SELECT COUNT(*) FROM tokens;')"
  if [ "$EXPECTED_TOKENS" = "$ACTUAL_TOKENS" ]; then
    echo "  sidecar manifest matches restored content ($ACTUAL_TOKENS tokens)"
  else
    note_fail "sidecar claimed $EXPECTED_TOKENS tokens, restored has $ACTUAL_TOKENS"
  fi
fi

# --- 6. can it actually be queried? ---------------------------------------
# Integrity check passing does not prove the schema is usable.
SAMPLE="$(sqlite3 "$WORK/restored.db" "SELECT COUNT(*) FROM tokens WHERE graduated_at IS NOT NULL;" 2>&1)" \
  && echo "  queryable: yes ($SAMPLE graduated tokens in the restored copy)" \
  || note_fail "restored database is not queryable: $SAMPLE"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "RESTORE DRILL PASSED"
else
  echo "RESTORE DRILL FAILED"; exit 1
fi
