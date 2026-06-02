"""Incremental auto-update of the EVE University wiki content.

Change detection: queries the MediaWiki recentchanges API for ns0 edits/new
pages (and delete/move log entries) since the last-seen timestamp (saved in
wiki_state.json — a few bytes). For each touched page it removes the old chunks
(delete-by doc_id) and re-inserts the current content, IN PLACE on the live
collection — so SDE + missions content is untouched. Embeddings run only for the
changed pages (and the embed cache dedupes unchanged chunk text), so a typical
run is seconds, not the ~45 min of a full rebuild.

A full rebuild (the source of truth) is still `run.py --all`; this only keeps the
index fresh between rebuilds.

Usage:
    python -m capsuleers_ingestion.wiki_update --check   # just: how many pages changed?
    python -m capsuleers_ingestion.wiki_update           # apply the incremental update
    python -m capsuleers_ingestion.wiki_update --force    # ignore saved state, re-scan last 7 days

Designed to be run from a daily timer/cron (see ops/).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys

from .chunk import chunk_documents
from .config import CONFIG, DATA_DIR
from .wiki.api import doc_id as wiki_doc_id
from .wiki.recentchanges import changed_titles_since

STATE_FILE = DATA_DIR / "wiki_state.json"


def local_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2))


def check(force: bool = False) -> tuple[set[str], str | None, str | None]:
    """Returns (changed titles, newest timestamp, since timestamp used)."""
    since = None if force else local_state().get("last_ts")
    titles, newest = changed_titles_since(since)
    return titles, newest, since


def run_update(force: bool = False) -> None:
    titles, newest, since = check(force=force)
    if not titles:
        print(f"Wiki già aggiornato (nessuna pagina cambiata dal {since or 'ultimo periodo'}).")
        # Advance the watermark so the next run doesn't re-scan the same window.
        if newest:
            st = local_state(); st["last_ts"] = newest; st["checked_at"] = _now(); save_state(st)
        return

    print(f"Pagine wiki cambiate dal {since or '(ultimi 7 giorni)'}: {len(titles)}")

    # Scrape only the changed titles (deleted/blanked pages yield no Document).
    from .wiki.scrape import scrape_titles
    docs = list(scrape_titles(sorted(titles)))

    # doc_ids to purge = every touched title (raw) ∪ every resolved doc id. The raw
    # ids cover deletes/moves (no Document produced); the resolved ids cover
    # redirect-resolved edits. Deleting before re-insert prevents orphan chunks when
    # a page shrinks.
    touched = {wiki_doc_id(t) for t in titles} | {d.id for d in docs}

    from .embedcache import EmbedCache
    from .index import delete_by_doc_ids, get_client, index_chunks, resolve_collection
    client = get_client()
    collection = resolve_collection(client, CONFIG.collection)
    removed = delete_by_doc_ids(client, touched, collection=collection)
    cache = EmbedCache(DATA_DIR / "embed_cache.sqlite")
    reindexed = index_chunks(client, chunk_documents(docs), collection=collection, cache=cache)
    cache.close()

    save_state({
        "last_ts": newest or since,
        "updated_at": _now(),
        "changed_pages": len(titles),
        "reindexed_pages": len(docs),
        "purged_doc_ids": removed,
        "reindexed_chunks": reindexed,
        "collection": collection,
    })
    print(f"Fatto: {len(docs)} pagine re-indicizzate ({reindexed} chunk), "
          f"{len(titles) - len(docs)} rimosse/vuote, collection '{collection}'.")
    print("NB: l'indice flat del desktop si rigenera/pubblica con ops/publish-index.sh.")


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def main() -> None:
    ap = argparse.ArgumentParser(description="Aggiornamento incrementale del wiki EVE University")
    ap.add_argument("--check", action="store_true", help="solo conteggio (exit 0=aggiornato, 1=cambiamenti)")
    ap.add_argument("--force", action="store_true", help="ignora lo stato salvato e ri-scansiona gli ultimi 7 giorni")
    args = ap.parse_args()

    if args.check:
        titles, newest, since = check(force=args.force)
        if titles:
            sample = ", ".join(sorted(titles)[:10])
            print(f"Cambiamenti wiki DISPONIBILI dal {since or '(ultimi 7gg)'}: {len(titles)} pagine.")
            print(f"  es.: {sample}{' …' if len(titles) > 10 else ''}")
            sys.exit(1)
        print(f"Wiki aggiornato (nessun cambiamento dal {since or '(ultimi 7gg)'}).")
        sys.exit(0)

    run_update(force=args.force)


if __name__ == "__main__":
    main()
