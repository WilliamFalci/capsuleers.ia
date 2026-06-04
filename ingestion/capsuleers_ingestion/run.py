"""CLI orchestrator for the ingestion pipeline.

Phase 1 — fetch/parse (Python only, no infra):
    python -m capsuleers_ingestion.run --sde  --dump data/docs_sde.jsonl --sde-path data/sde.sqlite
    python -m capsuleers_ingestion.run --wiki --dump data/docs_wiki.jsonl

Phase 2 — embed + index (requires Ollama + Qdrant):
    python -m capsuleers_ingestion.run --from-dump data/docs_sde.jsonl
    python -m capsuleers_ingestion.run --all   # full pipeline in one shot
"""

from __future__ import annotations

import argparse
from collections.abc import Iterator

from .chunk import chunk_documents
from .models import Document
from .sde import parse_all
from .wiki.scrape import scrape_wiki
from .wiki.sources import WIKI_SOURCES, wiki_source


def _sde_docs(sde_dir: str | None) -> Iterator[Document]:
    if not sde_dir:
        from .sde.download import download_sde_jsonl
        sde_dir = download_sde_jsonl()
    # Wormhole data (Anoikis) — best-effort: enriches the J-space systems.
    try:
        from .sde.wormholes import download_wormhole_data
        download_wormhole_data()
    except Exception as e:  # noqa: BLE001
        print(f"[warn] dati wormhole non scaricati: {e}")
    yield from parse_all(sde_dir)


def main() -> None:
    ap = argparse.ArgumentParser(description="Ingestione dati EVE")
    ap.add_argument("--all", action="store_true", help="SDE + Wiki")
    ap.add_argument("--sde", action="store_true", help="solo SDE")
    ap.add_argument("--wiki", action="store_true",
                    help="solo wiki MediaWiki (tutte le fonti registrate)")
    ap.add_argument("--wiki-source", default=None,
                    help="limita il crawl wiki a una fonte (es. eveuni|sistersprobe; "
                         "default tutte)")
    ap.add_argument("--wiki-limit", type=int, default=None,
                    help="max pagine wiki PER FONTE (per test; default tutte)")
    ap.add_argument("--missions", action="store_true", help="solo guide missioni (eve-survival.org)")
    ap.add_argument("--missions-limit", type=int, default=None,
                    help="max guide missioni (per test; default tutte)")
    ap.add_argument("--riley", action="store_true",
                    help="solo guide Riley Entertainment (sito statico; NON in --all "
                         "per la licenza non esplicita)")
    ap.add_argument("--riley-limit", type=int, default=None,
                    help="max pagine Riley (per test; default tutte)")
    ap.add_argument("--sde-dir", default=None,
                    help="usa una cartella SDE JSONL già estratta (salta il download)")
    ap.add_argument("--dump", metavar="FILE",
                    help="scrivi i chunk su JSONL invece di indicizzare (no infra)")
    ap.add_argument("--from-dump", metavar="FILE",
                    help="indicizza i chunk da un JSONL già prodotto")
    ap.add_argument("--names-index", metavar="FILE",
                    help="esporta {nome→typeID} dei type pubblicati (per i prezzi nell'API) ed esci")
    args = ap.parse_args()

    if args.names_index:
        import json as _json
        from .sde.source import Sde, en
        sde_dir = args.sde_dir
        if not sde_dir:
            from .sde.download import download_sde_jsonl
            sde_dir = download_sde_jsonl()
        idx = {}
        for tid, t in Sde(sde_dir).by_key("types").items():
            if t.get("published"):
                idx[en(t.get("name")).lower()] = tid
        from pathlib import Path as _P
        _P(args.names_index).write_text(_json.dumps(idx, ensure_ascii=False), encoding="utf-8")
        print(f"Indice nomi esportato in {args.names_index}: {len(idx)} type.")
        return

    # Index-from-dump mode (requires Qdrant/Ollama).
    if args.from_dump:
        from .index import get_client, index_chunks  # lazy import (qdrant)
        from .store import load_chunks
        from .embedcache import EmbedCache
        from .config import DATA_DIR
        cache = EmbedCache(DATA_DIR / "embed_cache.sqlite")  # populate the cache for updates
        total = index_chunks(get_client(), load_chunks(args.from_dump), cache=cache)
        cache.close()
        print(f"Indicizzati {total} chunk da {args.from_dump}.")
        return

    if not (args.all or args.sde or args.wiki or args.missions or args.riley):
        ap.error("specifica una fonte (--all|--sde|--wiki|--missions|--riley) oppure --from-dump")

    wiki_sources = (
        [wiki_source(args.wiki_source)] if args.wiki_source else list(WIKI_SOURCES)
    )

    def sources() -> Iterator[Document]:
        if args.all or args.sde:
            yield from _sde_docs(args.sde_dir)
        if args.all or args.wiki:
            for src in wiki_sources:
                print(f"[wiki] crawl {src.label} ({src.api_url})")
                yield from scrape_wiki(src, limit=args.wiki_limit)
        if args.all or args.missions:
            from .missions.eve_survival import scrape_missions
            yield from scrape_missions(limit=args.missions_limit)
        if args.riley:  # opt-in only (not in --all): no explicit licence
            from .web.riley import scrape_riley
            print("[riley] crawl riley-entertainment.com/gaming/eve-online")
            yield from scrape_riley(limit=args.riley_limit)

    chunks = chunk_documents(sources())

    if args.dump:
        from .store import dump_chunks
        total = dump_chunks(chunks, args.dump)
        print(f"Scritti {total} chunk su {args.dump}.")
    else:
        from .index import get_client, index_chunks  # lazy import (qdrant)
        total = index_chunks(get_client(), chunks)
        print(f"Indicizzati {total} chunk nella collection.")


if __name__ == "__main__":
    main()
