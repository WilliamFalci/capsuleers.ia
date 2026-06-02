"""Incremental auto-update of the eve-survival mission guides.

eve-survival is a "Wikka" wiki with no reliable change API, so detection is
**content-hash** based: we fetch the current mission set (cheap HTTP), hash each
page's text, and re-index only the pages whose hash changed since last run
(`missions_state.json` = {doc_id: sha256}). Pages that disappeared are dropped
(delete-by doc_id). Embeddings run only for changed pages (the embed cache dedupes
the rest), and everything lands IN PLACE on the live collection (SDE/wiki untouched).

Usage:
    python -m capsuleers_ingestion.missions_update --check   # how many changed?
    python -m capsuleers_ingestion.missions_update           # apply the incremental update
    python -m capsuleers_ingestion.missions_update --force    # re-index all (ignore saved hashes)
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import sys

from .chunk import chunk_documents
from .config import CONFIG, DATA_DIR
from .missions.eve_survival import doc_id as mission_doc_id
from .missions.eve_survival import mission_names, scrape_named

STATE_FILE = DATA_DIR / "missions_state.json"


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def local_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {}


def save_state(hashes: dict) -> None:
    STATE_FILE.write_text(json.dumps({
        "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "hashes": hashes,
    }, indent=2))


def _scan(force: bool) -> tuple[list, dict, list]:
    """Fetch the current missions; returns (changed Documents, full {id: sha},
    removed doc_ids). `force` re-indexes everything regardless of saved hashes."""
    old = {} if force else local_state().get("hashes", {})
    names = mission_names()
    changed, new_hashes = [], {}
    for doc in scrape_named(names):
        h = _sha(doc.text)
        new_hashes[doc.id] = h
        if old.get(doc.id) != h:
            changed.append(doc)
    removed = [d for d in old if d not in new_hashes]
    return changed, new_hashes, removed


def check(force: bool = False) -> tuple[int, int]:
    changed, _, removed = _scan(force)
    return len(changed), len(removed)


def run_update(force: bool = False) -> None:
    changed, new_hashes, removed = _scan(force)
    if not changed and not removed:
        print(f"Missioni già aggiornate ({len(new_hashes)} pagine, nessun cambiamento).")
        save_state(new_hashes)  # refresh updated_at / fill state on first run
        return

    print(f"Missioni: {len(changed)} cambiate, {len(removed)} rimosse "
          f"(totale corrente {len(new_hashes)}).")

    from .embedcache import EmbedCache
    from .index import delete_by_doc_ids, get_client, index_chunks, resolve_collection
    client = get_client()
    collection = resolve_collection(client, CONFIG.collection)
    # Purge changed (re-inserted below) + removed (gone for good) pages' chunks.
    purge = [d.id for d in changed] + removed
    delete_by_doc_ids(client, purge, collection=collection)
    reindexed = 0
    if changed:
        cache = EmbedCache(DATA_DIR / "embed_cache.sqlite")
        reindexed = index_chunks(client, chunk_documents(changed), collection=collection, cache=cache)
        cache.close()

    save_state(new_hashes)
    print(f"Fatto: {len(changed)} pagine re-indicizzate ({reindexed} chunk), "
          f"{len(removed)} rimosse, collection '{collection}'.")
    print("NB: l'indice flat del desktop si rigenera/pubblica con ops/publish-index.sh.")


def main() -> None:
    ap = argparse.ArgumentParser(description="Aggiornamento incrementale delle missioni eve-survival")
    ap.add_argument("--check", action="store_true", help="solo conteggio (exit 0=aggiornato, 1=cambiamenti)")
    ap.add_argument("--force", action="store_true", help="re-indicizza tutte le pagine (ignora gli hash salvati)")
    args = ap.parse_args()

    if args.check:
        n_changed, n_removed = check(force=args.force)
        if n_changed or n_removed:
            print(f"Cambiamenti missioni DISPONIBILI: {n_changed} cambiate, {n_removed} rimosse.")
            sys.exit(1)
        print("Missioni aggiornate (nessun cambiamento).")
        sys.exit(0)

    run_update(force=args.force)


if __name__ == "__main__":
    main()
