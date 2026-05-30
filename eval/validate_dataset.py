"""Validates the golden set against the knowledge base (JSONL dump).

For each question it checks that the expected facts (`expect`) actually appear
in the indexable corpus. This serves two purposes:
  1. ensure the golden set is correct (no made-up facts);
  2. prove COVERAGE: if an expected fact isn't in the corpus, the RAG can never
     answer it → it's either a gap in the data or an error in the golden set.

Requires no infrastructure: reads only the files produced by ingestion.

    python eval/validate_dataset.py            # use the default dumps
    python eval/validate_dataset.py --sde ingestion/data/docs_sde.jsonl \
                                    --wiki ingestion/data/docs_wiki.jsonl
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_corpus(path: Path) -> str:
    if not path.exists():
        return ""
    parts = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                parts.append(json.loads(line)["text"].lower())
    return "\n".join(parts)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=str(Path(__file__).with_name("dataset.jsonl")))
    ap.add_argument("--sde", default=str(ROOT / "ingestion/data/docs_sde.jsonl"))
    ap.add_argument("--wiki", default=str(ROOT / "ingestion/data/docs_wiki.jsonl"))
    args = ap.parse_args()

    sde = load_corpus(Path(args.sde))
    wiki = load_corpus(Path(args.wiki))
    corpus = sde + "\n" + wiki
    print(f"Corpus: SDE {len(sde):,} char | Wiki {len(wiki):,} char "
          f"({'parziale' if not wiki else 'presente'})\n")

    tests = [json.loads(l) for l in open(args.dataset, encoding="utf-8") if l.strip()]
    by_cat: dict[str, list[bool]] = defaultdict(list)
    missing = []

    for t in tests:
        absent = [e for e in t["expect"] if e.lower() not in corpus]
        ok = not absent
        by_cat[t["category"]].append(ok)
        status = "OK " if ok else "MISS"
        print(f"  [{status}] {t['id']:24} ({t['source']})"
              + ("" if ok else f"  mancano: {absent}"))
        if not ok:
            missing.append((t["id"], t["source"], absent))

    print("\n=== Copertura per categoria ===")
    for cat, results in sorted(by_cat.items()):
        n = len(results); passed = sum(results)
        print(f"  {cat:14} {passed}/{n}")

    total = sum(len(v) for v in by_cat.values())
    passed = sum(sum(v) for v in by_cat.values())
    print(f"\nTotale: {passed}/{total} domande con tutti i fatti attesi nel corpus.")
    if missing:
        wiki_miss = [m for m in missing if m[1] == "wiki"]
        if wiki_miss and not wiki:
            print(f"({len(wiki_miss)} mancanti sono di fonte wiki: crawl non ancora completato.)")


if __name__ == "__main__":
    main()
