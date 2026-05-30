"""Loader for the official Fenris Creations SDE in JSON Lines format (2025 rework).

Each `<name>.jsonl` file has one record per line with `_key` as primary key.
Localized fields are objects {lang: str}; `en()` extracts the English value.

Known differences from the "classic" schema (Fuzzwork): the data here is more
raw — no single names table, no pre-composed station names, no market group
hierarchy, and agent levels/types are not exposed.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path


def en(value) -> str:
    """Extract English from a localized field {lang: str}; passes plain strings through."""
    if isinstance(value, dict):
        return value.get("en", "") or ""
    return value or ""


class Sde:
    """Lazy access to the official SDE JSONL files."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self._cache: dict[str, dict] = {}

    def exists(self, name: str) -> bool:
        return (self.root / f"{name}.jsonl").exists()

    def rows(self, name: str) -> Iterator[dict]:
        """Iterate over a file's records (streaming, without loading it all into memory)."""
        path = self.root / f"{name}.jsonl"
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    yield json.loads(line)

    def by_key(self, name: str) -> dict[int, dict]:
        """Load a file, indexing it by `_key` (cached)."""
        if name not in self._cache:
            self._cache[name] = {r["_key"]: r for r in self.rows(name)}
        return self._cache[name]
