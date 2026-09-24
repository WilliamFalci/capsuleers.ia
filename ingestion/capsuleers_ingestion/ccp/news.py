"""CCP patch notes and dev blogs, from eveonline.com's news archive.

Level L1 of the source hierarchy (desktop/src/source-tiers.mjs): CCP writing about
its own game. eveonline.com is Contentful-backed; the public Content Delivery API
(GraphQL) serves the whole archive, the same data the site renders.

Two body formats coexist in the archive, and both are handled (see common.py):
  * `richText` — Contentful Rich Text JSON (current articles and some old ones);
  * `content`  — Markdown with inline HTML (roughly 2019-2021).

WHY ONE DOCUMENT PER SECTION, not per article: a patch note is a single article
with hundreds of headings (Version 24.01: 39 h2 + 190 h3). Split blindly, a chunk
about the Procurer would carry no word saying it is about the Procurer.

WHY THE DATE IS IN THE TITLE: a patch note describes a change as of its date and
may have been superseded by a later one — the SDE describes the current state. The
title is what reaches the model's context and the cited sources, with no index
schema change, so the model can see how old each block is.

WHY A DEFAULT WINDOW (2019+): the archive starts in 2003. Pre-2019 notes describe
balance numbers that have been rebalanced several times since; at L1 they would
out-rank current community guides with obsolete facts.

The change signal is `sys.publishedAt`, which moves on every edit — and patch notes
ARE edited: one "Version 24.01" article gains a section at every hotfix.
"""

from __future__ import annotations

import re

from ..models import Document
from .common import Item, Provider, gql, markdown_blocks, rich_blocks, sectioned_documents

ARTICLE_URL = "https://www.eveonline.com/news/view/{slug}"
DEFAULT_SINCE = "2019-01-01"

# category (Contentful) -> (Document.source, Document.type, human label)
CATEGORIES: dict[str, tuple[str, str, str]] = {
    "patch-notes": ("ccp_patch_notes", "patch_notes", "CCP patch notes"),
    "dev-blogs": ("ccp_dev_blog", "dev_blog", "CCP dev blog"),
}

# Dev blogs that are mostly charts (images) with a paragraph of text around them:
# they would only add dated, number-free noise to economy questions.
_SKIP_SLUG = re.compile(r"^monthly-economic-report", re.I)


class NewsProvider(Provider):
    name = "news"
    description = "patch notes + dev blog (eveonline.com)"

    def __init__(self, since: str = DEFAULT_SINCE) -> None:
        self.since = since

    def list(self) -> list[Item]:
        out: list[Item] = []
        for cat in CATEGORIES:
            skip, total = 0, None
            while total is None or skip < total:
                data = gql(f'''{{ articleCollection(limit: 200, skip: {skip},
                    where: {{ category: "{cat}", publishingDate_gte: "{self.since}T00:00:00Z" }},
                    order: [publishingDate_DESC]) {{
                      total items {{ sys {{ id publishedAt }} slug title publishingDate }} }} }}''')
                col = data["articleCollection"]
                total = col["total"]
                for it in col["items"]:
                    if not it or not it.get("slug") or not it.get("title"):
                        continue
                    if _SKIP_SLUG.search(it["slug"]):
                        continue
                    out.append(Item(
                        key=it["sys"]["id"], stamp=it["sys"].get("publishedAt") or "",
                        label=it["slug"],
                        data={"slug": it["slug"], "title": it["title"].strip(), "category": cat,
                              "date": (it.get("publishingDate") or "")[:10]}))
                skip += 200
        return out

    def documents(self, item: Item) -> list[Document]:
        a = item.data
        body = gql(f'''{{ article(id: "{item.key}") {{ content richText {{ json links {{
            entries {{
              block {{ __typename sys {{ id }} ... on Content {{ headline body }} }}
              inline {{ __typename sys {{ id }} ... on Content {{ headline body }} }}
            }} }} }} }} }}''').get("article") or {}
        rich = body.get("richText") or {}
        nodes = (rich.get("json") or {}).get("content") or []
        if nodes:
            links = (rich.get("links") or {}).get("entries") or {}
            entries = {e["sys"]["id"]: e for e in (links.get("block") or []) + (links.get("inline") or []) if e}
            blocks = list(rich_blocks(nodes, entries))
        else:
            blocks = list(markdown_blocks(body.get("content") or ""))
        source, dtype, label = CATEGORIES[a["category"]]
        return sectioned_documents(
            f"ccp:{a['category']}:{a['slug']}", f"{a['title']} ({a['date']})", blocks,
            dtype=dtype, source=source, url=ARTICLE_URL.format(slug=a["slug"]),
            metadata={"category": label, "published": a["date"]})
