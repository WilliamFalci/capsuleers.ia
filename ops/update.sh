#!/usr/bin/env bash
# Wrapper for the SDE update job (invoked by a systemd timer / cron).
# Runs the check + optional rebuild+reindex with a Qdrant alias swap.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO/ingestion"

# Use the venv if present, otherwise the system python3 (with the deps installed).
if [ -x "$REPO/ingestion/.venv/bin/python" ]; then
  PY="$REPO/ingestion/.venv/bin/python"
else
  PY="python3"
fi

exec "$PY" -m capsuleers_ingestion.update "$@"
