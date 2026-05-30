"""Indexing into Qdrant: creates the collection, upserts the chunks, manages aliases.

Supports:
  - an explicit target `collection` (for versioned builds);
  - an optional `EmbedCache` (re-embeds only new/changed chunks);
  - atomic alias swap for zero-downtime updates.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable

from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams

from .chunk import Chunk
from .config import CONFIG
from .embed import embed_texts
from .embedcache import EmbedCache, text_hash

BATCH = 64


def get_client() -> QdrantClient:
    return QdrantClient(url=CONFIG.qdrant_url)


def ensure_collection(client: QdrantClient, collection: str) -> None:
    if client.collection_exists(collection):
        return
    client.create_collection(
        collection_name=collection,
        vectors_config=VectorParams(size=CONFIG.embed_dim, distance=Distance.COSINE),
    )
    # Metadata indexes for fast filtering (type=skill/ship/...).
    for field in ("type", "category"):
        try:
            client.create_payload_index(collection, field_name=field, field_schema="keyword")
        except Exception:  # noqa: BLE001 — already present / different version
            pass


def index_chunks(
    client: QdrantClient,
    chunks: Iterable[Chunk],
    collection: str | None = None,
    cache: EmbedCache | None = None,
) -> int:
    """Embeds (with optional cache) and upserts the chunks in batches."""
    collection = collection or CONFIG.collection
    ensure_collection(client, collection)
    total, buf = 0, []
    for chunk in chunks:
        buf.append(chunk)
        if len(buf) >= BATCH:
            total += _flush(client, collection, buf, cache)
            buf = []
    if buf:
        total += _flush(client, collection, buf, cache)
    return total


def _flush(client: QdrantClient, collection: str, chunks: list[Chunk], cache: EmbedCache | None) -> int:
    vectors = _embed_with_cache([c.text for c in chunks], cache)
    points = [
        PointStruct(
            id=str(uuid.uuid5(uuid.NAMESPACE_URL, c.id)),
            vector=v,
            payload={"text": c.text, **c.metadata},
        )
        for c, v in zip(chunks, vectors)
    ]
    client.upsert(collection_name=collection, points=points)
    return len(points)


def _embed_with_cache(texts: list[str], cache: EmbedCache | None) -> list[list[float]]:
    if cache is None:
        return embed_texts(texts)
    hashes = [text_hash(t) for t in texts]
    cached = cache.get_many(hashes)
    missing_idx = [i for i, h in enumerate(hashes) if h not in cached]
    if missing_idx:
        fresh = embed_texts([texts[i] for i in missing_idx])
        new_items = [(hashes[i], vec) for i, vec in zip(missing_idx, fresh)]
        cache.put_many(new_items)
        for (h, vec) in new_items:
            cached[h] = vec
    return [cached[h] for h in hashes]


def swap_alias(client: QdrantClient, alias: str, collection: str) -> None:
    """Atomically points `alias` at `collection`, removing the old versions.

    If a *real* collection exists with the alias name (initial bootstrap),
    it is deleted first (an alias cannot be created with a name already in use).
    """
    from qdrant_client.models import (
        CreateAlias, CreateAliasOperation, DeleteAlias, DeleteAliasOperation,
    )

    aliases = _alias_names(client)
    if client.collection_exists(alias) and alias not in aliases:
        client.delete_collection(alias)

    # Delete (if the alias already exists) + create, applied atomically in order.
    ops = []
    if alias in aliases:
        ops.append(DeleteAliasOperation(delete_alias=DeleteAlias(alias_name=alias)))
    ops.append(CreateAliasOperation(
        create_alias=CreateAlias(collection_name=collection, alias_name=alias)))
    client.update_collection_aliases(change_aliases_operations=ops)

    # Delete versioned collections other than the one just activated.
    prefix = f"{alias}_"
    for name in [c.name for c in client.get_collections().collections]:
        if name.startswith(prefix) and name != collection:
            client.delete_collection(name)


def _alias_names(client: QdrantClient) -> set[str]:
    try:
        return {a.alias_name for a in client.get_aliases().aliases}
    except Exception:  # noqa: BLE001
        return set()
