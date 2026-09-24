"""CCP Support knowledge base (support.eveonline.com), via the public Zendesk
Help Center API.

Level L1: CCP's own documentation of gameplay rules, the client, account policy
and the EULA/ToS. ~310 articles in en-US; the listing endpoint already carries the
bodies, so a full crawl is 4 requests. The change signal is `updated_at`.

Every section is kept, account and payments included: "how do I recover my
account" is a legitimate question, and an article about PayPal is simply never
the nearest neighbour of a gameplay question.
"""

from __future__ import annotations

from ..models import Document
from .common import Item, Provider, html_blocks, http_json, sectioned_documents

BASE = "https://support.eveonline.com/api/v2/help_center/en-us"


class SupportProvider(Provider):
    name = "support"
    description = "CCP Support (support.eveonline.com)"

    def _sections(self) -> dict[int, str]:
        out, url = {}, f"{BASE}/sections.json?per_page=100"
        while url:
            data = http_json(url)
            out.update({s["id"]: s["name"] for s in data.get("sections", [])})
            url = data.get("next_page")
        return out

    def list(self) -> list[Item]:
        sections = self._sections()
        out, url = [], f"{BASE}/articles.json?per_page=100"
        while url:
            data = http_json(url)
            for a in data.get("articles", []):
                if a.get("draft") or not a.get("body"):
                    continue
                out.append(Item(
                    key=str(a["id"]), stamp=a.get("updated_at") or a.get("edited_at") or "",
                    label=a.get("title", ""),
                    data={"title": a["title"].strip(), "url": a["html_url"], "body": a["body"],
                          "section": sections.get(a.get("section_id"), "")}))
            url = data.get("next_page")
        return out

    def documents(self, item: Item) -> list[Document]:
        d = item.data
        head = f"{d['title']} · {d['section']}" if d["section"] else d["title"]
        return sectioned_documents(
            f"ccp:support:{item.key}", head, html_blocks(d["body"]),
            dtype="support", source="ccp_support", url=d["url"],
            metadata={"category": "CCP Support", "section": d["section"]})
