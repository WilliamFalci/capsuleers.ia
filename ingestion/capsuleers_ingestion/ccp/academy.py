"""EVE Academy (www.eveonline.com/eve-academy) — CCP's own player guides.

Level L1: combat mechanics, careers, ship primers, industry, exploration, written
by CCP for players. Lives in the same Contentful space as the news, as `Page`
entries whose slug contains "eve-academy"; each page is a list of `Section`s
(headline + Markdown body) holding `Content` fragments (headline + body).

URLs have to be DISCOVERED, not derived. The site answers 200 to any path under
/eve-academy (a client-side not-found shell of ~37 KB), and the slug does not
spell the path: "eve-academy-article-combat-mechanics" lives at
/eve-academy/combat-mechanics, "eve-academy-careers-explorer" at
/eve-academy/careers/explorer. So each changed page probes a few candidates and
accepts one only if it is a real render (big, and carrying the page's title).
Measured 2026-09-24: 21 of 76 pages have a URL of their own; the rest (single-ship
primers, activity cards) are fragments embedded in hub pages. Those are still CCP
text and are indexed, cited with the EVE Academy home.
"""

from __future__ import annotations

import time

from ..models import Document
from .common import Block, Item, Provider, gql, http_get, markdown_blocks, sectioned_documents

SITE = "https://www.eveonline.com"
HUB = f"{SITE}/eve-academy"
_REAL_PAGE_BYTES = 45_000   # not-found shell ~37 KB, real pages ~60 KB


def _resolve_url(slug: str, title: str) -> str:
    rest = slug.removeprefix("eve-academy").lstrip("-")
    if not rest:
        return HUB
    grp, _, tail = rest.partition("-")
    cands = [f"/eve-academy/{grp}/{tail}", f"/eve-academy/{tail}"] if tail else []
    cands.append(f"/eve-academy/{rest}")
    needle = title.lower()[:12]
    for path in dict.fromkeys(cands):
        try:
            page = http_get(SITE + path).decode("utf-8", "ignore")
        except Exception:  # noqa: BLE001
            continue
        time.sleep(0.25)
        if len(page) > _REAL_PAGE_BYTES and needle and needle in page.lower():
            return SITE + path
    return HUB


def _fragment_blocks(entry: dict, level: int) -> list[Block]:
    out: list[Block] = []
    if entry.get("headline"):
        out.append(("h", level, entry["headline"]))
    for field in ("teaser", "body"):
        if entry.get(field):
            out.extend(markdown_blocks(entry[field], headings=False))
    return out


class AcademyProvider(Provider):
    name = "academy"
    description = "EVE Academy (eveonline.com/eve-academy)"

    def list(self) -> list[Item]:
        data = gql('''{ pageCollection(limit: 200, where: { slug_contains: "eve-academy" }) {
            items { sys { id publishedAt } slug metaTitle } } }''')
        out = []
        for p in data["pageCollection"]["items"]:
            if not p or not p.get("slug"):
                continue
            title = (p.get("metaTitle") or p["slug"]).split("|")[0].strip()
            out.append(Item(key=p["sys"]["id"], stamp=p["sys"].get("publishedAt") or "",
                            label=p["slug"], data={"slug": p["slug"], "title": title}))
        return out

    def documents(self, item: Item) -> list[Document]:
        d = item.data
        page = gql(f'''{{ page(id: "{item.key}") {{ sectionsCollection(limit: 40) {{ items {{
            ... on Section {{ headline teaser body contentCollection(limit: 25) {{ items {{
                __typename ... on Content {{ headline body }} ... on Section {{ headline teaser body }} }} }} }}
        }} }} }} }}''').get("page") or {}
        blocks: list[Block] = []
        for sec in (page.get("sectionsCollection") or {}).get("items") or []:
            if not sec:
                continue
            blocks.extend(_fragment_blocks(sec, 2))
            for frag in (sec.get("contentCollection") or {}).get("items") or []:
                if frag:
                    blocks.extend(_fragment_blocks(frag, 3))
        if not any(b[0] == "p" for b in blocks):
            return []
        return sectioned_documents(
            f"ccp:academy:{d['slug']}", f"EVE Academy › {d['title']}", blocks,
            dtype="guide", source="ccp_academy", url=_resolve_url(d["slug"], d["title"]),
            metadata={"category": "EVE Academy"})
