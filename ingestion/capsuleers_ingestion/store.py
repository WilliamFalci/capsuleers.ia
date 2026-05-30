"""Chunk persistence to JSONL.

Decouples the slow phase (download/parse/scrape, Python only) from the one that
requires infrastructure (embed+index on Ollama/Qdrant). Chunks are written to
disk once and re-read by the indexer when needed.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Iterator
from pathlib import Path

from .chunk import Chunk


def dump_chunks(chunks: Iterable[Chunk], path: str | Path) -> int:
    """Writes the chunks as JSON Lines. Returns the number written."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with open(path, "w", encoding="utf-8") as f:
        for c in chunks:
            f.write(json.dumps({"id": c.id, "text": c.text, "metadata": c.metadata},
                               ensure_ascii=False) + "\n")
            n += 1
    return n


def load_chunks(path: str | Path) -> Iterator[Chunk]:
    """Re-reads the chunks from a JSON Lines file."""
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            yield Chunk(id=obj["id"], text=obj["text"], metadata=obj["metadata"])
