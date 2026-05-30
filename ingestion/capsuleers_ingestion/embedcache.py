"""Persistent embedding cache (text hash → vector).

SDE updates change only a small part of the documents: with this cache only
what changed gets re-embedded, making updates fast instead of recomputing all
~59k vectors every time.

Key = sha256 of the chunk text. Value = float32 vector (BLOB).
"""

from __future__ import annotations

import hashlib
import sqlite3
from array import array
from pathlib import Path


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class EmbedCache:
    def __init__(self, path: str | Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(path)
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS embeddings (hash TEXT PRIMARY KEY, vec BLOB)"
        )
        self.conn.commit()

    def get_many(self, hashes: list[str]) -> dict[str, list[float]]:
        out: dict[str, list[float]] = {}
        for i in range(0, len(hashes), 900):  # SQLite variable limit
            batch = hashes[i:i + 900]
            q = ",".join("?" * len(batch))
            for h, blob in self.conn.execute(
                f"SELECT hash, vec FROM embeddings WHERE hash IN ({q})", batch
            ):
                out[h] = array("f", blob).tolist()
        return out

    def put_many(self, items: list[tuple[str, list[float]]]) -> None:
        self.conn.executemany(
            "INSERT OR REPLACE INTO embeddings (hash, vec) VALUES (?, ?)",
            [(h, array("f", vec).tobytes()) for h, vec in items],
        )
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()
