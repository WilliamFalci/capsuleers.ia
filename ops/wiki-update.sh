#!/usr/bin/env bash
# Wrapper for the incremental EVE University wiki update (systemd timer / cron).
# Detects pages changed since the last run (recentchanges API) and re-indexes
# only those into the live Qdrant collection. Does NOT publish the desktop index
# (that's ops/publish-index.sh, run on a slower cadence).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO/ingestion"

if [ -x "$REPO/ingestion/.venv/bin/python" ]; then
  PY="$REPO/ingestion/.venv/bin/python"
else
  PY="python3"
fi

exec "$PY" -m capsuleers_ingestion.wiki_update "$@"
