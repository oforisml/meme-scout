#!/usr/bin/env bash
#
# FR-G4 — move the dataset to another host, once.
#
#   ./scripts/migrate-host.sh user@vps:/srv/meme-scout/data/meme-scout.db
#   ./scripts/migrate-host.sh /tmp/drill/meme-scout.db      # local dry run
#
# THIS IS NOT A BACKUP. scripts/backup.sh copies the database while the
# recorder keeps running; this hands over the write role and then STOPS the
# source from ever writing again. The difference matters:
#
# The recorder holds the only write handle on this dataset. After a copy, two
# hosts each hold a complete and writable database. Start both and you get two
# datasets that diverge from a common ancestor, with no way to reconcile them
# and no way to tell afterwards which rows came from where — for a Phase 3
# verdict that is unrecoverable. So this script writes data/.migrated-to on the
# source, and assertRuntimeConfig() refuses to start against it. The guard is
# the point; the copy is the easy part.
#
# Reuses the mechanics already proven in backup.sh (VACUUM INTO, integrity
# check, per-table row counts) rather than inventing a second way to move this
# file.
#
set -euo pipefail

cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
DB_PATH="${DB_PATH:-./data/meme-scout.db}"

TARGET="${1:-}"
[ -n "$TARGET" ] || { echo "usage: $0 <user@host:/path/to/meme-scout.db | /local/path.db>" >&2; exit 1; }

MARKER="$(dirname "$DB_PATH")/.migrated-to"
[ -e "$MARKER" ] && {
  echo "This dataset has already been migrated to: $(cat "$MARKER")" >&2
  echo "Remove $MARKER only if you are certain no recorder runs there." >&2
  exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Every table, discovered rather than hardcoded, so a table added later is not
# silently left out of the comparison.
tables() { sqlite3 "$1" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"; }
counts() { local db="$1"; tables "$db" | while read -r t; do printf '%s=%s\n' "$t" "$(sqlite3 "$db" "SELECT COUNT(*) FROM \"$t\";")"; done; }

echo "=== migrate $DB_PATH -> $TARGET ==="

# --- 1. the source must be idle -------------------------------------------
# Unlike a backup, this is a handover: anything written after the snapshot
# would be stranded on a host that is about to be sealed.
if npx pm2 pid meme-scout 2>/dev/null | grep -qE '^[0-9]+$'; then
  echo "  stopping the recorder"
  npx pm2 stop meme-scout >/dev/null
  STOPPED=1
else
  echo "  recorder is not running under pm2"
  STOPPED=0
fi

# --- 2. fold the WAL back in ----------------------------------------------
# VACUUM INTO already reads committed WAL content, so this is belt and braces
# — but a 4 MB -wal left beside a "finished" migration invites someone to copy
# the .db alone and lose it.
echo "  checkpointing WAL"
sqlite3 "$DB_PATH" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null

# --- 3. consistent snapshot -----------------------------------------------
sqlite3 "$DB_PATH" "VACUUM INTO '$WORK/migrate.db'"
echo "  snapshot: $(stat -c%s "$WORK/migrate.db") bytes"

# --- 4. verify BEFORE shipping --------------------------------------------
INTEGRITY="$(sqlite3 "$WORK/migrate.db" 'PRAGMA integrity_check;' | head -1)"
[ "$INTEGRITY" = "ok" ] || { echo "  FAIL: integrity_check said: $INTEGRITY" >&2; exit 1; }
echo "  integrity: ok"

counts "$WORK/migrate.db" > "$WORK/expected.txt"
echo "  tables: $(wc -l < "$WORK/expected.txt"), rows: $(awk -F= '{s+=$2} END {print s}' "$WORK/expected.txt")"

# --- 5. ship ---------------------------------------------------------------
case "$TARGET" in
  *:*)
    echo "  copying over ssh"
    REMOTE_HOST="${TARGET%%:*}"
    REMOTE_PATH="${TARGET#*:}"
    ssh "$REMOTE_HOST" "mkdir -p '$(dirname "$REMOTE_PATH")'"
    scp -q "$WORK/migrate.db" "$TARGET"
    # A function, not a command string: building one and word-splitting it
    # mangles the quoting that SQL identifiers need.
    target_sql() { ssh "$REMOTE_HOST" sqlite3 "$REMOTE_PATH" "$1"; }
    ;;
  *)
    echo "  copying locally (dry run)"
    mkdir -p "$(dirname "$TARGET")"
    cp "$WORK/migrate.db" "$TARGET"
    target_sql() { sqlite3 "$TARGET" "$1"; }
    ;;
esac

# --- 6. verify ON THE TARGET ----------------------------------------------
# "scp exited 0" is not "the database is intact and complete over there" — the
# same distinction backup.sh draws before it trusts an upload.
echo "  verifying at the target"
T_INTEGRITY="$(target_sql 'PRAGMA integrity_check;' | head -1)"
[ "$T_INTEGRITY" = "ok" ] || { echo "  FAIL: target integrity_check said: $T_INTEGRITY" >&2; exit 1; }

: > "$WORK/actual.txt"
while IFS='=' read -r t _; do
  printf '%s=%s\n' "$t" "$(target_sql "SELECT COUNT(*) FROM \"$t\";")" >> "$WORK/actual.txt"
done < "$WORK/expected.txt"

if ! diff -u "$WORK/expected.txt" "$WORK/actual.txt" > "$WORK/diff.txt"; then
  echo "  FAIL: row counts differ between source and target" >&2
  cat "$WORK/diff.txt" >&2
  exit 1
fi
echo "  target verified: integrity ok, all $(wc -l < "$WORK/expected.txt") tables match"

# --- 7. seal the source ----------------------------------------------------
# Written LAST, and only after the target is proven — a failed migration must
# leave this host able to keep recording.
printf '%s\nmigrated %s\n' "$TARGET" "$(date -u +%FT%TZ)" > "$MARKER"
echo "  sealed: $MARKER"
echo
echo "This host will now REFUSE to start the recorder."
echo "Bring it up on the target, then confirm it is recording before deleting anything here."
[ "$STOPPED" = "1" ] && echo "(the local pm2 process was stopped and deliberately not restarted)"
