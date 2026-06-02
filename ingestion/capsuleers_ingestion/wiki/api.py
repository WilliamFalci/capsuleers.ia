"""Shared low-level client for the EVE University MediaWiki API.

Single place for the HTTP GET (identifiable User-Agent + retry/backoff) and the
canonical page URL, reused by both the full scraper (scrape.py) and the
recent-changes detector (recentchanges.py).
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request

from ..config import CONFIG, USER_AGENT


def api_get(params: dict, retries: int = 3) -> dict:
    """One MediaWiki API GET → parsed JSON. Retries transient network errors."""
    url = f"{CONFIG.wiki_api_url}?{urllib.parse.urlencode(params)}"
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


def page_url(title: str) -> str:
    """Canonical wiki URL for a page title (matches the `url` stored on each chunk)."""
    return f"https://wiki.eveuniversity.org/{title.replace(' ', '_')}"


def doc_id(title: str) -> str:
    """Stable Document id for a wiki page title (matches scrape.py's Document.id)."""
    return f"wiki:{title.replace(' ', '_')}"
