"""Check and auto-update of the official Fenris Creations SDE.

Change detection: compares the current build number (from latest.jsonl, a few bytes)
with the saved one. If it changed, downloads the new SDE JSONL, rebuilds the
Documents and indexes into a NEW versioned collection, then moves the
`eve_knowledge` alias (zero-downtime). Unchanged embeddings are reused from the cache.

Usage:
    python -m capsuleers_ingestion.update --check     # just: is there an update?
    python -m capsuleers_ingestion.update             # update if changed
    python -m capsuleers_ingestion.update --force      # force the rebuild

Designed to be run from a daily timer/cron (see ops/).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys

from .chunk import chunk_documents
from .config import CONFIG, DATA_DIR
from .embedcache import EmbedCache
from .sde import parse_all
from .sde.download import download_sde_jsonl, latest_build

VERSION_FILE = DATA_DIR / "sde_version.json"


def local_state() -> dict:
    if VERSION_FILE.exists():
        return json.loads(VERSION_FILE.read_text())
    return {}


def save_state(state: dict) -> None:
    VERSION_FILE.write_text(json.dumps(state, indent=2))


def check() -> tuple[bool, int, int]:
    """Returns (update_available, remote_build, local_build)."""
    remote = latest_build()
    local = int(local_state().get("build", 0))
    return remote != local, remote, local


def run_update(force: bool = False) -> None:
    available, remote, local = check()
    if not available and not force:
        print(f"SDE già aggiornato (build {remote}). Nessuna azione.")
        return

    print(f"Aggiornamento SDE: locale={local or '—'} → remoto={remote}"
          + (" (forzato)" if force and not available else ""))

    # 1. Download and extract the new official SDE.
    sde_dir = download_sde_jsonl(remote)

    # 2. Index into a new versioned collection (embeddings via cache).
    from .index import get_client, index_chunks, swap_alias
    client = get_client()
    cache = EmbedCache(DATA_DIR / "embed_cache.sqlite")
    new_collection = f"{CONFIG.collection}_{remote}"
    print(f"Indicizzo nella collection {new_collection} (embedding con cache)…")
    total = index_chunks(client, chunk_documents(parse_all(sde_dir)),
                         collection=new_collection, cache=cache)
    cache.close()

    # 3. Atomic alias swap → new version active, old ones removed.
    #    (Fit math no longer ships a fit_lookup.json — the desktop app's fitting
    #    engine bundles its own version-pinned SDE via the eve-fit-engine package.)
    swap_alias(client, CONFIG.collection, new_collection)

    save_state({
        "build": remote,
        "collection": new_collection,
        "chunks": total,
        "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    })
    print(f"Fatto: {total} chunk indicizzati, alias '{CONFIG.collection}' → {new_collection}.")


def main() -> None:
    ap = argparse.ArgumentParser(description="Verifica/aggiorna l'SDE")
    ap.add_argument("--check", action="store_true", help="controlla soltanto (exit 0=aggiornato, 1=disponibile)")
    ap.add_argument("--force", action="store_true", help="ricostruisci anche se invariato")
    args = ap.parse_args()

    if args.check:
        available, remote, local = check()
        if available:
            print(f"Aggiornamento SDE DISPONIBILE: build {local or '—'} → {remote}")
            sys.exit(1)
        print(f"SDE aggiornato (build {remote}).")
        sys.exit(0)

    run_update(force=args.force)


if __name__ == "__main__":
    main()
