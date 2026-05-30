"""Embeddings via Ollama (bge-m3). Same model used by the API at query time."""

from __future__ import annotations

import time

import httpx

from .config import CONFIG


def embed_texts(texts: list[str], retries: int = 4) -> list[list[float]]:
    """Returns one vector per text using Ollama's /api/embed endpoint.

    Generous timeout + retry: on CPU, embedding can be slow when the machine is
    under load (e.g. concurrent LLM generation).
    """
    last: Exception | None = None
    for attempt in range(retries):
        try:
            resp = httpx.post(
                f"{CONFIG.ollama_url}/api/embed",
                json={"model": CONFIG.embed_model, "input": texts},
                timeout=httpx.Timeout(600.0),
            )
            resp.raise_for_status()
            return resp.json()["embeddings"]
        except (httpx.TimeoutException, httpx.TransportError) as e:
            last = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("Embedding fallito dopo i retry") from last
