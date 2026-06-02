#!/usr/bin/env bash
# Wrapper for the incremental Anoikis wormhole update (systemd timer / cron).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO/ingestion"
if [ -x "$REPO/ingestion/.venv/bin/python" ]; then PY="$REPO/ingestion/.venv/bin/python"; else PY="python3"; fi
exec "$PY" -m capsuleers_ingestion.wormhole_update "$@"
