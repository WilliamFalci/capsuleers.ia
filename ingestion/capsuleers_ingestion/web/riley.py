"""Scraper for Riley Entertainment's EVE Online guides (static HTML site).

https://www.riley-entertainment.com/gaming/eve-online/ — hand-written guides:
combat-site ship fits per faction/hull, COSMOS constellation guides, and
hacking/relic/data-site loot statistics. No API and no sitemap, so we do a bounded
breadth-first crawl of the eve-online section, following only same-section .html
links. The article body lives in <section class="site-content"> (nav/header/footer
are stripped by class in htmltext); stdlib only, rate-limited.

⚠️ License: commercial site, NO explicit open license. Same posture as
eve-survival here — fine for personal/local use; for app DISTRIBUTION of the index
consider permission or on-demand fetching. Each Document keeps `url` +
`metadata["license"]` for attribution. To exclude it from a redistributed index,
drop --riley from the build (it is NOT part of --all by default).
"""

from __future__ import annotations

import re
import time
import urllib.request
from collections.abc import Iterator
from urllib.parse import urljoin, urlparse

from ..config import USER_AGENT
from ..htmltext import html_to_text
from ..models import Document

BASE = "https://www.riley-entertainment.com"
ROOT = f"{BASE}/gaming/eve-online/"
LICENSE = "riley-entertainment.com (commerciale, nessuna licenza esplicita)"
DELAY_SECONDS = 0.4
MAX_PAGES = 400  # safety cap on the crawl (the section has < 100 pages today)


def _get(url: str, retries: int = 3) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "ignore")
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1 + attempt)
    raise RuntimeError(f"GET fallita: {url}") from last


def _canon(url: str) -> str:
    """Normalize: strip fragment/query, map a directory URL to its index.html."""
    url = url.split("#", 1)[0].split("?", 1)[0]
    if url.endswith("/"):
        url += "index.html"
    return url


def _links(page_html: str, base_url: str) -> Iterator[str]:
    for href in re.findall(r'href=["\']([^"\']+)["\']', page_html):
        if href.startswith(("mailto:", "javascript:", "#")):
            continue
        absu = _canon(urljoin(base_url, href))
        if absu.startswith(ROOT) and absu.endswith(".html"):
            yield absu


def _crawl(limit: int | None = None) -> Iterator[tuple[str, str]]:
    """Breadth-first crawl of the eve-online section. Yields (url, html) ONCE per
    page (the same fetch drives both link discovery and content extraction)."""
    seen: set[str] = set()
    queue: list[str] = [_canon(ROOT)]
    produced = 0
    while queue and len(seen) < MAX_PAGES:
        url = queue.pop(0)
        if url in seen:
            continue
        seen.add(url)
        try:
            page = _get(url)
        except RuntimeError:
            continue
        time.sleep(DELAY_SECONDS)
        for link in _links(page, url):
            if link not in seen:
                queue.append(link)
        yield url, page
        produced += 1
        if limit and produced >= limit:
            return


def crawl_urls(limit: int | None = None) -> list[str]:
    """Discovery only: the list of reachable eve-online page URLs."""
    return [url for url, _ in _crawl(limit=limit)]


def doc_id(url: str) -> str:
    """Stable Document id for a page URL (matches the Document.id below)."""
    path = urlparse(url).path
    slug = path.split("/gaming/eve-online/", 1)[-1].removesuffix(".html").strip("/")
    return f"riley:{slug or 'index'}"


def _title(page_html: str, fallback: str) -> str:
    m = re.search(r"<title>(.*?)</title>", page_html, re.S)
    if not m:
        return fallback
    t = re.sub(r"\s+", " ", m.group(1)).strip()
    return re.sub(r"^Riley Entertainment\s*-\s*", "", t) or fallback


def _content(page_html: str) -> str:
    """Extract just the article body (<section class="site-content">…)."""
    m = re.search(r'<section class="site-content"[^>]*>(.*?)</section>', page_html, re.S)
    body = m.group(1) if m else page_html
    return html_to_text(body)


def _doc(url: str, page_html: str) -> Document | None:
    text = _content(page_html)
    if len(text) < 120:  # nav-only / empty page
        return None
    title = _title(page_html, doc_id(url))
    return Document(
        id=doc_id(url), type="guide", title=title,
        text=f"{title}\n{text}", source="riley_entertainment",
        url=url, metadata={"license": LICENSE, "category": "Guide"},
    )


def scrape_urls(urls: list[str], delay: float = DELAY_SECONDS) -> Iterator[Document]:
    """Scrape ONLY the given page URLs (re-fetches the body)."""
    for url in urls:
        try:
            page = _get(url)
        except RuntimeError:
            continue
        time.sleep(delay)
        d = _doc(url, page)
        if d:
            yield d


def scrape_riley(limit: int | None = None) -> Iterator[Document]:
    """Iterates Riley Entertainment's EVE guides as Documents (type='guide').
    Single-fetch crawl: each page is downloaded once for both link discovery and
    content extraction."""
    for url, page in _crawl(limit=limit):
        d = _doc(url, page)
        if d:
            yield d
