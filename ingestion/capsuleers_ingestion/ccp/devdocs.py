"""CCP's developer documentation — the GUIDES only (developers.eveonline.com/docs/guides).

Level L1. The site is MkDocs built from github.com/esi/esi-docs, maintained by CCP.
Only `docs/guides/**` is taken: it documents game rules as CCP states them —
warp-in points, security-status rounding and classes, route calculation, fitting
formats, planetary interaction, SKINR, map data. The rest (ESI/SSO services,
community-tool listings) is documentation for programmers, not for players.

The change signal is the git blob sha from GitHub's tree API: one request lists
every file with a content hash. Set GITHUB_TOKEN to lift the anonymous 60/h limit
(one call per check is well inside it).
"""

from __future__ import annotations

import os
import re

from ..models import Document
from .common import Item, Provider, http_get, http_json, markdown_blocks, sectioned_documents

LICENSE = "esi/esi-docs (MIT) — documentazione CCP"

REPO = "esi/esi-docs"
TREE = f"https://api.github.com/repos/{REPO}/git/trees/main?recursive=1"
RAW = f"https://raw.githubusercontent.com/{REPO}/main/{{path}}"
SITE = "https://developers.eveonline.com/"


def _headers() -> dict:
    tok = os.getenv("GITHUB_TOKEN")
    return {"Authorization": f"Bearer {tok}"} if tok else {}


def _site_url(path: str) -> str:
    # docs/guides/fitting.md -> docs/guides/fitting/ ; docs/guides/map-data/index.md -> docs/guides/map-data/
    p = re.sub(r"(/index)?\.md$", "", path)
    return f"{SITE}{p}/"


class DevDocsProvider(Provider):
    name = "devdocs"
    description = "guide della documentazione CCP (esi/esi-docs)"

    def list(self) -> list[Item]:
        tree = http_json(TREE, _headers()).get("tree", [])
        return [Item(key=t["path"], stamp=t["sha"], label=t["path"], data={})
                for t in tree
                if t.get("type") == "blob" and t["path"].startswith("docs/guides/")
                and t["path"].endswith(".md")]

    def documents(self, item: Item) -> list[Document]:
        md = http_get(RAW.format(path=item.key)).decode("utf-8", "ignore")
        blocks = list(markdown_blocks(md))
        # The page title is its first h1; the path of every section hangs off it.
        h1 = next((t for k, lvl, t in blocks if k == "h" and lvl == 1), item.key)
        blocks = [b for b in blocks if not (b[0] == "h" and b[1] == 1 and b[2] == h1)]
        slug = re.sub(r"(/index)?\.md$", "", item.key).split("/")[-1]
        return sectioned_documents(
            f"ccp:devdocs:{slug}", h1, blocks, dtype="doc", source="ccp_devdocs",
            url=_site_url(item.key), metadata={"category": "CCP developer docs", "license": LICENSE})
