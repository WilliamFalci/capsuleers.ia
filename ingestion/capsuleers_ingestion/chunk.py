"""Chunking of Documents into indexable pieces.

- SDE documents (ship/module/skill/...): atomic → kept whole in one chunk, so
  retrieval never loses requirements/bonuses that ended up at the tail.
- Long-form prose (wiki/missions): split into SMALL passages with overlap, each
  re-anchored to its title, so every embedding stays specific and several distinct
  hits fit the retrieval budget at once.
The original Document's metadata propagates to all of its chunks.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass

from .models import Document

# SDE entities (each ≤ ~4300 chars) stay whole: their requirements/bonuses are
# atomic. Long-form prose is split much finer — a single 1024-dim vector over
# ~1100 tokens is too diluted to retrieve precisely, and one 4500-char chunk alone
# already fills the query-time context budget (MAX_CONTEXT_CHARS), starving top-k.
KEEP_WHOLE_MAX = 4500   # SDE: kept in a single chunk below this size
PASSAGE_SIZE = 1400     # prose: split target (~350 tokens)
OVERLAP = 200

# Sources whose text is long-form prose and benefits from finer splitting.
_PROSE_SOURCES = {"eve_university_wiki", "eve_survival", "sisters_probe_wiki",
                  "eve_fandom_wiki", "riley_entertainment"}


@dataclass
class Chunk:
    id: str
    text: str
    metadata: dict


def _norm(text: str) -> str:
    """Normalize the stray Unicode line separators U+2028/U+2029 (common in
    MediaWiki text) to '\\n'. They are valid inside a JSON string, so json.dumps
    leaves them raw — but line-based JSONL readers (Node's readline, among others)
    treat them as line breaks and split a record mid-string. Normalizing here keeps
    the dump safe for any consumer."""
    return text.replace("\u2028", "\n").replace("\u2029", "\n")


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
        text = _norm(doc.text)
        size = PASSAGE_SIZE if doc.source in _PROSE_SOURCES else KEEP_WHOLE_MAX
        if len(text) <= size:
            yield Chunk(id=f"{doc.id}#0", text=text, metadata=base_meta)
            continue
        for i, piece in enumerate(_split(text, size)):
            # Chunk #0 already names its subject; sub-chunks don't. Re-anchor them to
            # the title so both the embedding AND the shown context stay self-describing.
            text = piece if i == 0 else f"{_norm(doc.title)}\n{piece}"
            yield Chunk(id=f"{doc.id}#{i}", text=text, metadata=base_meta)


def _split(text: str, size: int) -> list[str]:
    """Sliding-window split with overlap, snapping each cut to the nearest
    paragraph/sentence/word boundary so chunks don't break mid-word."""
    out, start, n = [], 0, len(text)
    while start < n:
        end = min(start + size, n)
        if end < n:
            end = _boundary(text, start, end)
        piece = text[start:end].strip()
        if piece:
            out.append(piece)
        if end >= n:
            break
        start = max(end - OVERLAP, start + 1)
    return out


def _boundary(text: str, start: int, end: int) -> int:
    """Best cut at/before `end` but not before the window midpoint (so a chunk never
    shrinks below half `size`): prefer a paragraph break, then sentence, then space."""
    lo = start + (end - start) // 2
    for sep in ("\n\n", "\n", ". ", " "):
        idx = text.rfind(sep, lo, end)
        if idx != -1:
            return idx + len(sep)
    return end
