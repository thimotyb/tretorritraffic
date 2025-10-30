#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/data/poller-daemon.pid"
LOG_FILE="$ROOT_DIR/data/poller.log"

mkdir -p "$ROOT_DIR/data"

if [[ -f "$PID_FILE" ]]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "Polling daemon already running with PID $PID"
    exit 0
  else
    echo "Removing stale PID file"
    rm -f "$PID_FILE"
  fi
fi

nohup bash -c "
  while true; do
    echo '----- ' \$(date --iso-8601=seconds) ' -----' >> '$LOG_FILE'
    cd '$ROOT_DIR'
    npm run poll >> '$LOG_FILE' 2>&1
    sleep 900
  done
" >/dev/null 2>&1 &

echo $! > "$PID_FILE"
echo "Started polling daemon (PID $(cat "$PID_FILE")). Logs: $LOG_FILE"
