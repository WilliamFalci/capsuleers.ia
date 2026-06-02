"""Scraper for EVE-Survival (eve-survival.org): the canonical database of
PVE mission guides (enemies per pocket, damage types, triggers, blitz).

"Wikka" wiki engine: the 'MissionReports' index lists all mission pages
(URL ?wakka=Name). Stdlib only, rate-limited.

⚠️ License: community content with no explicit license. Fine for personal/
local use; for app DISTRIBUTION consider permission or on-demand fetching.
Each Document keeps `url` and `metadata['license']` for attribution.
"""

from __future__ import annotations

import html
import re
import time
import urllib.request
from collections.abc import Iterable, Iterator

from ..config import USER_AGENT
from ..models import Document

BASE = "https://eve-survival.org"
INDEX = f"{BASE}/wikka.php?wakka=MissionReports"
LICENSE = "eve-survival.org (community, nessuna licenza esplicita)"
DELAY_SECONDS = 0.4

# Index/category/guide pages NOT to be treated as missions (little content or meta).
_SKIP = {"MissionReports", "HomePage", "AgentDivisions", "RecentChanges",
         "TextSearch", "CategoryCategory", "SandBox"}


def _get(url: str, retries: int = 3) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    last = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "ignore")
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1 + attempt)
    raise RuntimeError(f"GET fallita: {url}") from last


def _content(page_html: str) -> str:
    m = re.search(r'<div id="content">(.*?)<div id="(?:comments|footer|smallprint)"', page_html, re.S)
    if not m:
        return ""
    body = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", m.group(1), flags=re.S)
    body = re.sub(r"<[^>]+>", " ", body)
    return re.sub(r"\s+", " ", html.unescape(body)).strip()


def _mission_names() -> list[str]:
    names = sorted(set(re.findall(r"wakka=([A-Za-z0-9]+)", _get(INDEX))))
    return [n for n in names if n not in _SKIP]


def mission_names() -> list[str]:
    """Public: the list of mission page names from the MissionReports index."""
    return _mission_names()


def doc_id(name: str) -> str:
    """Stable Document id for a mission page name (matches the Document.id below)."""
    return f"evesurvival:{name}"


def _doc(name: str, text: str) -> Document | None:
    """Builds the mission Document from a page name + scraped content (None if empty)."""
    if len(text) < 80:  # empty/non-mission page
        return None
    # Title = initial part before "Last edited"; the rest is the guide.
    title = re.split(r"\s+Last edited", text, maxsplit=1)[0].strip()[:120] or name
    body = re.sub(r"^.*?UTC\s*", "", text, count=1)  # removes "… Last edited … UTC"
    return Document(
        id=f"evesurvival:{name}", type="mission", title=title,
        text=f"{title}\n{body}", source="eve_survival",
        url=f"{BASE}/?wakka={name}",
        metadata={"license": LICENSE, "category": "Mission"},
    )


def scrape_named(names: Iterable[str], delay: float = DELAY_SECONDS) -> Iterator[Document]:
    """Scrapes ONLY the given mission page names (used by the incremental update)."""
    for name in names:
        try:
            text = _content(_get(f"{BASE}/wikka.php?wakka={name}"))
        except Exception:  # noqa: BLE001 — skip problematic pages
            continue
        time.sleep(delay)
        d = _doc(name, text)
        if d:
            yield d


def scrape_missions(limit: int | None = None, delay: float = DELAY_SECONDS) -> Iterator[Document]:
    """Iterates the mission guides as Documents (type='mission')."""
    count = 0
    for name in _mission_names():
        if limit and count >= limit:
            return
        for d in scrape_named([name], delay=delay):
            yield d
            count += 1
        count += 1
