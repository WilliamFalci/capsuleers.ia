"""Community articles of capsuleers.app (news, event coverage, battle reports,
guides), via the public endpoint the site's own article list reads.

Level L3 (structured community), DATED like CCP news: an article describes the
game as of its publication date. Every article exists in English and, once the
site's translation job has run, in Italian; both are indexed, each cited with its
own localised URL, so an Italian question can land on the Italian text. bge-m3
puts the two translations close together, and the app's near-duplicate cap keeps
them from both taking a context slot.

The listing already carries the bodies (HTML) and `updated_at`, so a full crawl
is one request per 100 articles and the change signal is free. Drafts never reach
it: the endpoint serves `status=published` only.

It is a Provider like the CCP ones and sits in the same registry (ccp/__init__.py),
so ccp_update.py and run.py --ccp — and therefore the rag-publish workflow, full and
incremental — pick it up with no extra wiring.
"""

from __future__ import annotations

import urllib.parse

from ..ccp.common import Item, Provider, html_blocks, http_json, sectioned_documents
from ..config import CONFIG
from ..models import Document

LICENSE = "© capsuleers.app — articoli della community (Capsuleers)"
PAGE = 100


class ArticlesProvider(Provider):
    name = "articles"
    description = "capsuleers.app (articoli della community)"

    def __init__(self, site: str = CONFIG.capsuleers_site) -> None:
        self.site = site.rstrip("/")

    def list(self) -> list[Item]:
        out: list[Item] = []
        page, pages = 1, 1
        while page <= pages:
            q = urllib.parse.urlencode({"take": PAGE, "page": page, "status": "published"})
            data = http_json(f"{self.site}/api/articles?{q}")
            pages = data.get("totPages") or 1
            for a in data.get("elements") or []:
                if a.get("status") != "published" or not a.get("slug_eng"):
                    continue
                out.append(Item(
                    key=str(a["id"]),
                    stamp=a.get("updated_at") or a.get("published_at") or "",
                    label=a.get("titolo_eng") or a["slug_eng"],
                    data=a))
            page += 1
        return out

    def documents(self, item: Item) -> list[Document]:
        a = item.data
        date = (a.get("published_at") or "")[:10]
        meta = {"license": LICENSE, "category": "capsuleers.app", "published": date,
                "tags": a.get("tags") or [], "author": a.get("author_name") or ""}
        docs: list[Document] = []
        # (language, title, body, slug, URL prefix): EN is the site's default locale.
        for lang, title, body, slug, prefix in (
            ("en", a.get("titolo_eng"), a.get("content_eng"), a.get("slug_eng"), "/articles/"),
            ("it", a.get("titolo_ita"), a.get("content_ita"), a.get("slug_ita"), "/it/articles/"),
        ):
            if not (title and body and slug):
                continue   # Italian not translated yet: the English one still counts
            head = f"{title.strip()} ({date})" if date else title.strip()
            docs += sectioned_documents(
                f"capsuleers:article:{item.key}:{lang}", head, html_blocks(body),
                dtype="article", source="capsuleers_articles",
                url=f"{self.site}{prefix}{slug}", metadata={**meta, "lang": lang})
        return docs
