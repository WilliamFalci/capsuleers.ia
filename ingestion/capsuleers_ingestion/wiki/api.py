"""Shared low-level client for the MediaWiki read API.

Single place for the HTTP GET (identifiable User-Agent + retry/backoff) and the
canonical page URL / doc id, reused by the full scraper (scrape.py) and the
recent-changes detector (recentchanges.py). Every entry point takes a WikiSource
(see sources.py) so the same code drives multiple wikis (EVE University, Fandom…).
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request

from ..config import USER_AGENT
from .sources import WikiSource


def api_get(source: WikiSource, params: dict, retries: int = 3) -> dict:
    """One MediaWiki API GET → parsed JSON. Retries transient network errors."""
    url = f"{source.api_url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001 — retry on transient network errors
            last_err = e
            time.sleep(1 + attempt)
    raise RuntimeError(f"Richiesta API fallita: {url}") from last_err


def page_url(source: WikiSource, title: str) -> str:
    """Canonical wiki URL for a page title (matches the `url` stored on each chunk)."""
    return f"{source.page_base}{title.replace(' ', '_')}"


def doc_id(source: WikiSource, title: str) -> str:
    """Stable Document id for a wiki page title (matches scrape.py's Document.id)."""
    return f"{source.id_prefix}:{title.replace(' ', '_')}"
