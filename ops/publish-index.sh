#!/usr/bin/env bash
# Publishes a new desktop RAG index from the current Qdrant collection.
#
# Pipeline (run on the ingestion host, AFTER wiki-update.sh / SDE update.sh have
# refreshed Qdrant):
#   1. export the flat index (index.vec + index.meta.jsonl) from Qdrant
#   2. regenerate names_index.json (name→typeID for the in-app prices)
#   3. compute size + sha256 of the 3 files
#   4. bump desktop/src/assets-manifest.json (index.version/baseUrl/files)
#   5. create the GitHub release  index-<version>  with the 3 files
#   6. commit + push the manifest  → desktop apps fetch it at launch (assets.mjs
#      INDEX_MANIFEST_URL) and re-download the index when the version changes.
#
# Version = today's UTC date (YYYY.MM.DD), matching the existing index-<date> tags.
# Requires: gh (authenticated), python3, a reachable Qdrant. Idempotent per day
# (re-run replaces the same release).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OWNER_REPO="WilliamFalci/capsuleers.ia"
VERSION="${INDEX_VERSION:-$(date -u +%Y.%m.%d)}"
TAG="index-${VERSION}"
BASE_URL="https://github.com/${OWNER_REPO}/releases/download/${TAG}"
DATA="$REPO/desktop/data"
MANIFEST="$REPO/desktop/src/assets-manifest.json"

command -v gh >/dev/null || { echo "ERRORE: gh non installato/auth."; exit 1; }

PY="python3"; [ -x "$REPO/ingestion/.venv/bin/python" ] && PY="$REPO/ingestion/.venv/bin/python"

echo "==> 1/5 Export flat index da Qdrant"
( cd "$REPO/desktop" && python3 export_index.py )

echo "==> 2/5 Rigenero names_index.json"
( cd "$REPO/ingestion" && "$PY" -m capsuleers_ingestion.run --names-index "$DATA/names_index.json" )

for f in index.vec index.meta.jsonl names_index.json; do
  [ -s "$DATA/$f" ] || { echo "ERRORE: $DATA/$f mancante o vuoto."; exit 1; }
done

echo "==> 3/5 Calcolo size + sha256 e aggiorno il manifest ($VERSION)"
"$PY" - "$MANIFEST" "$VERSION" "$BASE_URL" "$DATA" <<'PYEOF'
import hashlib, json, os, sys
manifest_path, version, base_url, data_dir = sys.argv[1:5]
files = []
for name in ("index.vec", "index.meta.jsonl", "names_index.json"):
    p = os.path.join(data_dir, name)
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for blk in iter(lambda: fh.read(1 << 20), b""):
            h.update(blk)
    files.append({"name": name, "size": os.path.getsize(p), "sha256": h.hexdigest()})
m = json.load(open(manifest_path))
m["index"]["version"] = version
m["index"]["baseUrl"] = base_url
m["index"]["files"] = files
json.dump(m, open(manifest_path, "w"), indent=2)
open(manifest_path, "a").write("\n")
print("  manifest aggiornato:", version, "→", base_url)
PYEOF

echo "==> 4/5 Creo/aggiorno la release ${TAG}"
if gh release view "$TAG" --repo "$OWNER_REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" "$DATA/index.vec" "$DATA/index.meta.jsonl" "$DATA/names_index.json" \
    --repo "$OWNER_REPO" --clobber
else
  gh release create "$TAG" "$DATA/index.vec" "$DATA/index.meta.jsonl" "$DATA/names_index.json" \
    --repo "$OWNER_REPO" --title "RAG index ${VERSION}" \
    --notes "Auto-published RAG index (SDE + EVE University wiki). Desktop apps pick it up at next launch."
fi

echo "==> 5/5 Commit + push del manifest"
cd "$REPO"
if ! git diff --quiet -- "$MANIFEST"; then
  git add "$MANIFEST"
  git commit -m "chore(index): publish index-${VERSION} (auto)"
  git push origin HEAD
else
  echo "  manifest invariato (stessa versione/hash) — niente commit."
fi
echo "Fatto: index ${VERSION} pubblicato."
