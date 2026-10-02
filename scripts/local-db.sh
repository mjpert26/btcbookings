#!/usr/bin/env bash
# Starts a disposable local Postgres 16 cluster for development and integration tests.
# Usage: scripts/local-db.sh start|stop|reset
set -euo pipefail
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
DATA_DIR="${LOCAL_PG_DATA:-/tmp/btc-scheduler-pg}"
PORT="${LOCAL_PG_PORT:-54329}"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then RUN_AS=(runuser -u postgres --); fi

start() {
  if [ ! -d "$DATA_DIR" ]; then
    mkdir -p "$DATA_DIR"
    [ "$(id -u)" = "0" ] && chown postgres:postgres "$DATA_DIR"
    "${RUN_AS[@]}" "$PGBIN/initdb" -D "$DATA_DIR" -U postgres --auth=trust >/dev/null
  fi
  if ! "$PGBIN/pg_isready" -h 127.0.0.1 -p "$PORT" >/dev/null 2>&1; then
    "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$DATA_DIR" -o "-p $PORT -k /tmp" -l "$DATA_DIR/server.log" start >/dev/null
  fi
  for _ in $(seq 1 30); do "$PGBIN/pg_isready" -h 127.0.0.1 -p "$PORT" >/dev/null 2>&1 && break; sleep 0.5; done
  psql -h 127.0.0.1 -p "$PORT" -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='btc_scheduler'" | grep -q 1 \
    || psql -h 127.0.0.1 -p "$PORT" -U postgres -c "CREATE DATABASE btc_scheduler" >/dev/null
  echo "postgres://postgres@127.0.0.1:$PORT/btc_scheduler"
}

case "${1:-start}" in
  start) start ;;
  stop) "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$DATA_DIR" stop ;;
  reset) "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$DATA_DIR" stop >/dev/null 2>&1 || true; rm -rf "$DATA_DIR"; start ;;
  *) echo "usage: $0 start|stop|reset" >&2; exit 1 ;;
esac
