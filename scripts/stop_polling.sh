#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/data/poller-daemon.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "No polling daemon PID file found."
  exit 0
fi

PID=$(cat "$PID_FILE")
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "Stopped polling daemon (PID $PID)."
else
  echo "Process $PID not running. Removing stale PID file."
fi

rm -f "$PID_FILE"
