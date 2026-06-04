"""Crawler for a MediaWiki install via its read API (source-parameterised).

Two extraction modes, selected per WikiSource (see sources.py):
- "extracts": prop=extracts&explaintext → already-clean plain text. Used by the
  EVE University Wiki (https://wiki.eveuniversity.org/api.php — the real endpoint,
  not /w/). Resolves redirects.
- "parse_html": action=parse&prop=text → rendered article HTML, stripped to text
  here. Used by Fandom wikis (no TextExtracts extension).

Stdlib only (urllib + html.parser) → no extra dependencies.

⚠️ License: CC-BY-SA content. Each Document keeps `url` and `metadata["license"]`
so the API can ATTRIBUTE the source. MediaWiki policy: identifiable User-Agent +
rate-limiting.
"""

from __future__ import annotations

import time
from collections.abc import Iterable, Iterator

from ..htmltext import html_to_text
from ..models import Document
from .api import api_get, doc_id, page_url
from .sources import WikiSource

DELAY_SECONDS = 0.3  # gentle on the server


def _doc(source: WikiSource, resolved: str, text: str) -> Document:
    """Builds the indexable Document for a resolved page title + plain text."""
    return Document(
        id=doc_id(source, resolved),
        type="guide",
        title=resolved,
        text=f"{resolved}\n{text}",
        source=source.source,
        url=page_url(source, resolved),
        metadata={"license": source.license, "category": "WikiArticle"},
    )


def scrape_wiki(
    source: WikiSource, limit: int | None = None, delay: float = DELAY_SECONDS
) -> Iterator[Document]:
    """Iterates the content pages (namespace 0) of `source` as Documents.

    `limit`: maximum number of pages (None = all). Useful for tests.
    """
    count = 0
    for title in _iter_titles(source, limit):
        resolved, text = _fetch_extract(source, title)
        time.sleep(delay)
        if not text:
            continue
        yield _doc(source, resolved, text)
        count += 1
        if limit and count >= limit:
            return


def scrape_titles(
    source: WikiSource, titles: Iterable[str], delay: float = DELAY_SECONDS
) -> Iterator[Document]:
    """Scrapes ONLY the given page titles of `source` (used by the incremental
    update). Pages with no extract (deleted/blanked) are skipped — the caller
    removes their chunks."""
    for title in titles:
        resolved, text = _fetch_extract(source, title)
        time.sleep(delay)
        if not text:
            continue
        yield _doc(source, resolved, text)


def _iter_titles(source: WikiSource, limit: int | None) -> Iterator[str]:
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
        data = api_get(source, params)
        for p in data["query"]["allpages"]:
            yield p["title"]
            fetched += 1
            if limit and fetched >= limit:
                return
        cont = data.get("continue")
        if not cont:
            return
        apcontinue = cont["apcontinue"]


def _fetch_extract(source: WikiSource, title: str) -> tuple[str, str]:
    """Returns (resolved title, plain text). Resolves redirects. Dispatches on the
    source's fetch_mode; a missing/blanked page yields ("", "")-equivalent empty text."""
    if source.fetch_mode == "parse_html":
        return _fetch_parsed(source, title)
    return _fetch_textextract(source, title)


def _fetch_textextract(source: WikiSource, title: str) -> tuple[str, str]:
    """TextExtracts path (prop=extracts&explaintext) → already-clean plain text."""
    data = api_get(source, {
        "action": "query", "prop": "extracts", "explaintext": "1",
        "exsectionformat": "plain", "redirects": "1", "exlimit": "1",
        "titles": title, "format": "json",
    })
    pages = data["query"]["pages"]
    page = next(iter(pages.values()))
    return page.get("title", title), (page.get("extract") or "").strip()


def _fetch_parsed(source: WikiSource, title: str) -> tuple[str, str]:
    """action=parse path for wikis without TextExtracts (Fandom). Renders the
    article body to HTML and strips it. Missing pages → empty text (error JSON)."""
    try:
        data = api_get(source, {
            "action": "parse", "page": title, "prop": "text",
            "redirects": "1", "disabletoc": "1", "disablelimitreport": "1",
            "format": "json",
        })
    except RuntimeError:
        return title, ""
    parse = data.get("parse")
    if not parse:  # {"error": {"code": "missingtitle", ...}} for deleted/blank pages
        return title, ""
    html = parse.get("text", {}).get("*", "")
    return parse.get("title", title), html_to_text(html)
