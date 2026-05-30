"""Chunking of Documents into indexable pieces.

- SDE documents (skill/module): usually short → 1 chunk, no split.
- Wiki/guide documents: long texts → split by paragraphs/sections with overlap.
The original Document's metadata propagates to all of its chunks.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass

from .models import Document

# Large chunk: keeps EVERY SDE entity (max ~4300 chars) in a single chunk, so
# retrieval never loses requirements/bonuses that ended up at the tail. bge-m3 handles ~8k tokens.
# Wiki articles, which are much longer, are split anyway.
CHUNK_SIZE = 4500   # characters ~ 1100 tokens
OVERLAP = 250


@dataclass
class Chunk:
    id: str
    text: str
    metadata: dict


def chunk_documents(docs: Iterable[Document]) -> Iterator[Chunk]:
    for doc in docs:
        base_meta = {
            "doc_id": doc.id,
            "type": doc.type,
            "title": doc.title,
            "source": doc.source,
            "url": doc.url,
            **doc.metadata,
        }
        if len(doc.text) <= CHUNK_SIZE:
            yield Chunk(id=f"{doc.id}#0", text=doc.text, metadata=base_meta)
            continue
        for i, piece in enumerate(_split(doc.text)):
            yield Chunk(id=f"{doc.id}#{i}", text=piece, metadata=base_meta)


def _split(text: str) -> list[str]:
    """Sliding-window split with overlap. TODO: split by semantic sections."""
    out, start = [], 0
    while start < len(text):
        end = start + CHUNK_SIZE
        out.append(text[start:end])
        start = end - OVERLAP
    return out
