#!/usr/bin/env bash
# Recreates a disposable database for the internal UI e2e suite: all migrations, then
# tests/e2e/internal-seed.sql. Prints the DATABASE_URL to start the app with.
# Usage: scripts/e2e-internal-db.sh [database name, default btc_e2e_internal]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${LOCAL_PG_PORT:-54329}"
DB="${1:-btc_e2e_internal}"
PG="postgres://postgres@127.0.0.1:$PORT"
export PGOPTIONS="-c client_min_messages=warning"

"$ROOT/scripts/local-db.sh" start >/dev/null
psql -q "$PG/postgres" -c "drop database if exists $DB with (force)"
psql -q "$PG/postgres" -c "create database $DB"
for f in "$ROOT"/supabase/migrations/*.sql; do
  psql -q -v ON_ERROR_STOP=1 "$PG/$DB" -f "$f" >/dev/null
done
psql -q -v ON_ERROR_STOP=1 "$PG/$DB" -f "$ROOT/tests/e2e/internal-seed.sql" >/dev/null
echo "$PG/$DB"
