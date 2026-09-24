"""Incremental auto-update of the CCP patch notes and dev blogs.

Detection is Contentful's own `sys.publishedAt`, which changes on every edit — and
patch notes ARE edited: one "Version 24.01" article grows a new section at every
hotfix for months. So the check is two cheap listing queries (no bodies), and only
the articles that are new or whose `publishedAt` moved get their body fetched.

An article becomes MANY Documents (one per section group, see ccp/news.py) and the
section count changes as the article grows, so the state keeps the Document ids
per article: re-indexing an article first deletes exactly the ids it had.

State: `ccp_state.json` = {article_id: {"published_at", "doc_ids"}}. Everything
lands IN PLACE on the live collection (SDE/wiki/missions untouched).

Usage:
    python -m capsuleers_ingestion.ccp_update --check   # exit 0 = up to date, 1 = changes
    python -m capsuleers_ingestion.ccp_update
    python -m capsuleers_ingestion.ccp_update --force    # re-index every article
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys

from .ccp.news import DEFAULT_SINCE, fetch_documents, list_articles
from .chunk import chunk_documents
from .config import CONFIG, DATA_DIR

STATE_FILE = DATA_DIR / "ccp_state.json"


def local_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text()).get("articles", {})
    return {}


def save_state(articles: dict) -> None:
    STATE_FILE.write_text(json.dumps({
        "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "since": DEFAULT_SINCE,
        "articles": articles,
    }, indent=2))


def _plan(force: bool):
    """(current articles, changed articles, removed article ids, old state)."""
    old = local_state()
    arts = list_articles(DEFAULT_SINCE)
    changed = [a for a in arts
               if force or old.get(a.id, {}).get("published_at") != a.published_at]
    current = {a.id for a in arts}
    removed = [aid for aid in old if aid not in current]
    return arts, changed, removed, old


def run_update(force: bool = False) -> None:
    arts, changed, removed, old = _plan(force)
    if not changed and not removed:
        print(f"CCP già aggiornato ({len(arts)} articoli, nessun cambiamento).")
        return
    print(f"CCP: {len(changed)} articoli nuovi/modificati, {len(removed)} rimossi "
          f"(totale corrente {len(arts)}).")

    from .embedcache import EmbedCache
    from .index import delete_by_doc_ids, get_client, index_chunks, resolve_collection
    client = get_client()
    collection = resolve_collection(client, CONFIG.collection)

    new_state = {aid: v for aid, v in old.items() if aid not in removed}
    stale = [d for aid in removed for d in old[aid].get("doc_ids", [])]
    if stale:
        delete_by_doc_ids(client, stale, collection=collection)

    cache = EmbedCache(DATA_DIR / "embed_cache.sqlite")
    reindexed = 0
    try:
        for art, docs in fetch_documents(changed):
            # Delete what this article had BEFORE, not what it has now: an article
            # that shrank would otherwise leave its old tail sections behind.
            prev = old.get(art.id, {}).get("doc_ids", [])
            if prev:
                delete_by_doc_ids(client, prev, collection=collection)
            reindexed += index_chunks(client, chunk_documents(docs), collection=collection, cache=cache)
            # Saved per article: a crawl interrupted halfway keeps what it did, and
            # the next run only redoes the rest.
            new_state[art.id] = {"published_at": art.published_at,
                                 "doc_ids": [d.id for d in docs]}
            save_state(new_state)
    finally:
        cache.close()
    save_state(new_state)
    print(f"Fatto: {len(changed)} articoli re-indicizzati ({reindexed} chunk), "
          f"{len(removed)} rimossi, collection '{collection}'.")


def seed_state_from_dump(path: str) -> None:
    """After a FULL rebuild (run.py --ccp --dump / --from-dump) the collection holds
    every article but the state file knows none: the next incremental run would
    re-fetch everything. This rebuilds the state from the dump itself — including
    `published_at` AS DUMPED, so an article edited between the dump and now is
    still seen as changed by the next run."""
    doc_ids: dict[str, set] = {}
    stamp: dict[str, str] = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            m = json.loads(line)["metadata"]
            if m.get("article_id"):
                doc_ids.setdefault(m["article_id"], set()).add(m["doc_id"])
                stamp[m["article_id"]] = m.get("published_at", "")
    save_state({aid: {"published_at": stamp[aid], "doc_ids": sorted(ids)}
                for aid, ids in doc_ids.items()})
    print(f"Stato CCP ricostruito dal dump: {len(doc_ids)} articoli.")


def main() -> None:
    ap = argparse.ArgumentParser(description="Aggiornamento incrementale patch notes / dev blog CCP")
    ap.add_argument("--check", action="store_true", help="solo conteggio (exit 0=aggiornato, 1=cambiamenti)")
    ap.add_argument("--force", action="store_true", help="re-indicizza tutti gli articoli")
    ap.add_argument("--seed-from-dump", metavar="FILE",
                    help="ricostruisce lo stato da un dump appena indicizzato (dopo un full)")
    args = ap.parse_args()

    if args.seed_from_dump:
        seed_state_from_dump(args.seed_from_dump)
        return
    if args.check:
        _, changed, removed, _ = _plan(args.force)
        if changed or removed:
            print(f"Novità CCP DISPONIBILI: {len(changed)} nuovi/modificati, {len(removed)} rimossi.")
            sys.exit(1)
        print("CCP aggiornato (nessun cambiamento).")
        sys.exit(0)
    run_update(force=args.force)


if __name__ == "__main__":
    main()
