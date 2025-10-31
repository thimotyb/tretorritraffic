#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/data/poller-daemon.pid"
LOG_FILE="$ROOT_DIR/data/poller.log"
INTERVAL_SECONDS="${1:-900}"
MAX_RUNS_VALUE="${2:-}"

if ! [[ "$INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || [[ "$INTERVAL_SECONDS" -le 0 ]]; then
  echo "Invalid polling interval: $INTERVAL_SECONDS" >&2
  exit 1
fi

if [[ -n "$MAX_RUNS_VALUE" ]]; then
  if ! [[ "$MAX_RUNS_VALUE" =~ ^[0-9]+$ ]] || [[ "$MAX_RUNS_VALUE" -le 0 ]]; then
    echo "Invalid max runs value: $MAX_RUNS_VALUE" >&2
    exit 1
  fi
fi

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

nohup env \
  ROOT_DIR="$ROOT_DIR" \
  LOG_FILE="$LOG_FILE" \
  INTERVAL_SECONDS="$INTERVAL_SECONDS" \
  MAX_RUNS_VALUE="$MAX_RUNS_VALUE" \
  PID_FILE="$PID_FILE" \
  bash -c '
    set -euo pipefail

    cleanup() {
      rm -f "$PID_FILE"
    }

    trap cleanup EXIT

    runs=0
    while true; do
      echo "----- $(date --iso-8601=seconds) -----" >> "$LOG_FILE"
      cd "$ROOT_DIR"
      npm run poll >> "$LOG_FILE" 2>&1
      runs=$((runs + 1))
      if [[ -n "$MAX_RUNS_VALUE" && $runs -ge $MAX_RUNS_VALUE ]]; then
        break
      fi
      sleep "$INTERVAL_SECONDS"
    done
  ' >/dev/null 2>&1 &

echo $! > "$PID_FILE"
if [[ -n "$MAX_RUNS_VALUE" ]]; then
  echo "Started polling daemon (PID $(cat "$PID_FILE")) with interval ${INTERVAL_SECONDS}s (max $MAX_RUNS_VALUE runs). Logs: $LOG_FILE"
else
  echo "Started polling daemon (PID $(cat "$PID_FILE")) with interval ${INTERVAL_SECONDS}s. Logs: $LOG_FILE"
fi
