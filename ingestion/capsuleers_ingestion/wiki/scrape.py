"""Crawler for the EVE University Wiki via the MediaWiki API (TextExtracts).

The API is at https://wiki.eveuniversity.org/api.php (the real endpoint, not /w/).
Uses prop=extracts&explaintext to get already-clean text (no HTML),
resolving redirects. Stdlib only (urllib) → no extra dependencies.

⚠️ License: CC-BY-SA content. Each Document keeps `url` and
`metadata["license"]` to let the API ATTRIBUTE the source.
MediaWiki policy: identifiable User-Agent + rate-limiting.
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from collections.abc import Iterator

from ..config import CONFIG
from ..models import Document

USER_AGENT = "Capsuleers.IA/0.1 (RAG bot; contatto: dedodj@gmail.com)"
LICENSE = "CC-BY-SA-4.0"
DELAY_SECONDS = 0.3  # gentle on the server


def scrape_wiki(limit: int | None = None, delay: float = DELAY_SECONDS) -> Iterator[Document]:
    """Iterates the content pages (namespace 0) as Documents.

    `limit`: maximum number of pages (None = all, ~4500). Useful for tests.
    """
    count = 0
    for title in _iter_titles(limit):
        resolved, text = _fetch_extract(title)
        time.sleep(delay)
        if not text:
            continue
        yield Document(
            id=f"wiki:{resolved.replace(' ', '_')}",
            type="guide",
            title=resolved,
            text=f"{resolved}\n{text}",
            source="eve_university_wiki",
            url=_page_url(resolved),
            metadata={"license": LICENSE, "category": "WikiArticle"},
        )
        count += 1
        if limit and count >= limit:
            return


def _iter_titles(limit: int | None) -> Iterator[str]:
    """Enumerates the article titles (ns0, excluding redirects) with pagination."""
    apcontinue = None
    fetched = 0
    while True:
        params = {
            "action": "query", "list": "allpages", "apnamespace": "0",
            "aplimit": "500", "apfilterredir": "nonredirects", "format": "json",
        }
        if apcontinue:
            params["apcontinue"] = apcontinue
        data = _api_get(params)
        for p in data["query"]["allpages"]:
            yield p["title"]
            fetched += 1
            if limit and fetched >= limit:
                return
        cont = data.get("continue")
        if not cont:
            return
        apcontinue = cont["apcontinue"]


def _fetch_extract(title: str) -> tuple[str, str]:
    """Returns (resolved title, plain text). Resolves redirects."""
    data = _api_get({
        "action": "query", "prop": "extracts", "explaintext": "1",
        "exsectionformat": "plain", "redirects": "1", "exlimit": "1",
        "titles": title, "format": "json",
    })
    pages = data["query"]["pages"]
    page = next(iter(pages.values()))
    return page.get("title", title), (page.get("extract") or "").strip()


def _api_get(params: dict, retries: int = 3) -> dict:
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


def _page_url(title: str) -> str:
    return f"https://wiki.eveuniversity.org/{title.replace(' ', '_')}"
