"""Incremental auto-update of the CCP first-party sources (level L1).

Four providers (see ccp/__init__.py): patch notes + dev blogs, CCP Support, EVE
Academy, and the guides of CCP's developer documentation. Each lists its items with
a version stamp WITHOUT fetching bodies — Contentful `sys.publishedAt`, Zendesk
`updated_at`, the git blob sha — so `--check` is a handful of cheap requests, and
only items that are new or whose stamp moved get their body fetched.

One item becomes MANY Documents (it is cut at its headings, see ccp/common.py) and
their count changes as the item grows — patch notes are edited at every hotfix —
so the state keeps the Document ids PER ITEM: re-indexing an item first deletes
exactly the ids it had.

State: `ccp_state.json` = {"providers": {name: {item_key: {"stamp", "doc_ids"}}}}.
Everything lands IN PLACE on the live collection (SDE/wiki/missions untouched).

Usage:
    python -m capsuleers_ingestion.ccp_update --check            # exit 0 = up to date, 1 = changes
    python -m capsuleers_ingestion.ccp_update                    # apply
    python -m capsuleers_ingestion.ccp_update --only news,support
    python -m capsuleers_ingestion.ccp_update --force            # re-index everything
    python -m capsuleers_ingestion.ccp_update --seed-from-dump data/docs_ccp.jsonl
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys

from .ccp import providers
from .ccp.common import Item, Provider
from .chunk import chunk_documents
from .config import CONFIG, DATA_DIR

STATE_FILE = DATA_DIR / "ccp_state.json"


def local_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text()).get("providers", {})
    return {}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps({
        "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "providers": state,
    }, indent=2))


def _plan(prov: Provider, old: dict, force: bool) -> tuple[list[Item], list[Item], list[str]]:
    """(current items, changed items, removed item keys) for one provider."""
    items = prov.list()
    changed = [it for it in items if force or old.get(it.key, {}).get("stamp") != it.stamp]
    current = {it.key for it in items}
    return items, changed, [k for k in old if k not in current]


def check(only: str | None, force: bool) -> bool:
    state, any_change = local_state(), False
    for prov in providers(only):
        items, changed, removed = _plan(prov, state.get(prov.name, {}), force)
        mark = "NOVITÀ" if changed or removed else "invariato"
        print(f"  {prov.name:8} {len(items):4} elementi · {len(changed)} nuovi/modificati · "
              f"{len(removed)} rimossi — {mark}")
        any_change |= bool(changed or removed)
    return any_change


def run_update(only: str | None = None, force: bool = False) -> None:
    state = local_state()
    client = collection = cache = None
    try:
        for prov in providers(only):
            old = state.get(prov.name, {})
            items, changed, removed = _plan(prov, old, force)
            if not changed and not removed:
                print(f"[{prov.name}] aggiornato ({len(items)} elementi).")
                continue
            print(f"[{prov.name}] {len(changed)} nuovi/modificati, {len(removed)} rimossi "
                  f"(totale {len(items)}).")
            if client is None:
                from .embedcache import EmbedCache
                from .index import get_client, resolve_collection
                client = get_client()
                collection = resolve_collection(client, CONFIG.collection)
                cache = EmbedCache(DATA_DIR / "embed_cache.sqlite")
            from .index import delete_by_doc_ids, index_chunks

            mine = {k: v for k, v in old.items() if k not in removed}
            stale = [d for k in removed for d in old[k].get("doc_ids", [])]
            if stale:
                delete_by_doc_ids(client, stale, collection=collection)
            reindexed = 0
            for it, docs in prov.fetch(changed):
                # Delete what the item had BEFORE, not what it has now: an item that
                # shrank would otherwise leave its old tail sections behind.
                prev = old.get(it.key, {}).get("doc_ids", [])
                if prev:
                    delete_by_doc_ids(client, prev, collection=collection)
                if docs:
                    reindexed += index_chunks(client, chunk_documents(docs),
                                              collection=collection, cache=cache)
                mine[it.key] = {"stamp": it.stamp, "doc_ids": [d.id for d in docs]}
                # Saved per item: an interrupted crawl keeps what it did.
                state[prov.name] = mine
                save_state(state)
            state[prov.name] = mine
            save_state(state)
            print(f"[{prov.name}] fatto: {reindexed} chunk, collection '{collection}'.")
    finally:
        if cache is not None:
            cache.close()


def seed_state_from_dump(path: str) -> None:
    """After a FULL rebuild (run.py --ccp --dump / --from-dump) the collection holds
    every item but the state file knows none: the next incremental run would
    re-fetch everything. This rebuilds the state from the dump itself — with the
    stamp AS DUMPED, so an item edited between the dump and now is still seen as
    changed by the next run."""
    state: dict = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            m = json.loads(line)["metadata"]
            prov, key = m.get("ccp_provider"), m.get("ccp_item")
            if not prov or not key:
                continue
            entry = state.setdefault(prov, {}).setdefault(key, {"stamp": m.get("ccp_stamp", ""), "doc_ids": []})
            if m["doc_id"] not in entry["doc_ids"]:
                entry["doc_ids"].append(m["doc_id"])
    save_state(state)
    print("Stato CCP ricostruito dal dump: " +
          ", ".join(f"{p} {len(v)}" for p, v in state.items()))


def main() -> None:
    ap = argparse.ArgumentParser(description="Aggiornamento incrementale delle fonti CCP (L1)")
    ap.add_argument("--check", action="store_true", help="solo conteggio (exit 0=aggiornato, 1=cambiamenti)")
    ap.add_argument("--force", action="store_true", help="re-indicizza tutto")
    ap.add_argument("--only", default=None, help="solo questi provider (es. news,support)")
    ap.add_argument("--seed-from-dump", metavar="FILE",
                    help="ricostruisce lo stato da un dump appena indicizzato (dopo un full)")
    args = ap.parse_args()

    if args.seed_from_dump:
        seed_state_from_dump(args.seed_from_dump)
        return
    if args.check:
        if check(args.only, args.force):
            print("Novità CCP DISPONIBILI.")
            sys.exit(1)
        print("Fonti CCP aggiornate (nessun cambiamento).")
        sys.exit(0)
    run_update(args.only, args.force)


if __name__ == "__main__":
    main()
