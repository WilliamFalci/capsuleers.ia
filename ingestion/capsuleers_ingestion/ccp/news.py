"""CCP patch notes and dev blogs, from eveonline.com's news archive.

Level L1 of the source hierarchy (desktop/src/source-tiers.mjs): CCP writing about
its own game. eveonline.com is Contentful-backed; the public Content Delivery API
(GraphQL) serves the whole archive, the same data the site renders. Stdlib only.

Two body formats coexist in the archive, and both are handled:
  * `richText` — Contentful Rich Text JSON (current articles and some old ones);
  * `content`  — Markdown with inline HTML (roughly 2019-2021).

WHY ONE DOCUMENT PER SECTION, not per article: a patch note is a single article
with hundreds of headings (Version 24.01: 39 h2 + 190 h3). Split blindly, a chunk
about the Procurer would carry no word saying it is about the Procurer. So the
article is cut at its h2/h3 headings into ~PIECE-character Documents (see PIECE),
and every Document's title names the article, its DATE and where it sits.

WHY THE DATE IS IN THE TITLE: a patch note describes a change as of its date and
may have been superseded by a later one — the SDE describes the current state. The
title is what reaches the model's context and the cited sources, with no index
schema change, so the model can see how old each block is.

WHY A DEFAULT WINDOW (2019+): the archive starts in 2003. Pre-2019 notes describe
balance numbers that have been rebalanced several times since; at L1 they would
out-rank current community guides with obsolete facts. `since` is a parameter.
"""

from __future__ import annotations

import html
import json
import re
import time
import urllib.error
import urllib.request
from collections.abc import Iterable, Iterator
from dataclasses import dataclass

from ..config import CONFIG, USER_AGENT
from ..models import Document

ENDPOINT = (f"https://graphql.contentful.com/content/v1/spaces/"
            f"{CONFIG.ccp_contentful_space}/environments/{CONFIG.ccp_contentful_env}")
ARTICLE_URL = "https://www.eveonline.com/news/view/{slug}"
LICENSE = "© CCP / Fenris Creations — contenuto EVE Online (Developer License)"
DEFAULT_SINCE = "2019-01-01"
DELAY_SECONDS = 0.25

# category (Contentful) -> (Document.source, Document.type, human label)
CATEGORIES: dict[str, tuple[str, str, str]] = {
    "patch-notes": ("ccp_patch_notes", "patch_notes", "CCP patch notes"),
    "dev-blogs": ("ccp_dev_blog", "dev_blog", "CCP dev blog"),
}

# Dev blogs that are mostly charts (images) with a paragraph of text around them:
# they would only add dated, number-free noise to economy questions.
_SKIP_SLUG = re.compile(r"^monthly-economic-report", re.I)

# Contentful "Content" entries used as a Table-of-Contents anchor, not content.
_TOC_MARKER = re.compile(r"Content used to indicate that a Table of Contents", re.I)


@dataclass(frozen=True)
class Article:
    id: str            # Contentful sys.id — stable, identical to the RSS guid
    slug: str
    title: str
    category: str
    date: str          # YYYY-MM-DD (publishingDate)
    published_at: str  # sys.publishedAt — changes on every edit: the change signal


# ── Contentful ──────────────────────────────────────────────────────────────
def _gql(query: str, retries: int = 5) -> dict:
    body = json.dumps({"query": query}).encode()
    last: Exception | None = None
    for attempt in range(retries):
        req = urllib.request.Request(ENDPOINT, data=body, headers={
            "content-type": "application/json",
            "authorization": f"Bearer {CONFIG.ccp_contentful_token}",
            "User-Agent": USER_AGENT,
        })
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.load(r)
        except urllib.error.HTTPError as e:
            last = e
            if e.code == 429 or e.code >= 500:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
            time.sleep(1.5 * (attempt + 1))
            continue
        # A GraphQL error with no data is a broken query (schema drift), not a
        # transient failure: surface it instead of returning an empty archive.
        if data.get("errors") and not data.get("data"):
            raise RuntimeError(f"Contentful: {json.dumps(data['errors'])[:300]}")
        return data.get("data") or {}
    raise RuntimeError("Contentful non raggiungibile") from last


def list_articles(since: str = DEFAULT_SINCE,
                  categories: Iterable[str] = tuple(CATEGORIES)) -> list[Article]:
    """Every article of the given categories published on/after `since`."""
    out: list[Article] = []
    for cat in categories:
        skip, total = 0, None
        while total is None or skip < total:
            data = _gql(f'''{{ articleCollection(limit: 200, skip: {skip},
                where: {{ category: "{cat}", publishingDate_gte: "{since}T00:00:00Z" }},
                order: [publishingDate_DESC]) {{
                  total items {{ sys {{ id publishedAt }} slug title publishingDate }} }} }}''')
            col = data["articleCollection"]
            total = col["total"]
            for it in col["items"]:
                if not it or not it.get("slug") or not it.get("title"):
                    continue
                if _SKIP_SLUG.search(it["slug"]):
                    continue
                out.append(Article(
                    id=it["sys"]["id"], slug=it["slug"], title=it["title"].strip(),
                    category=cat, date=(it.get("publishingDate") or "")[:10],
                    published_at=it["sys"].get("publishedAt") or ""))
            skip += 200
    return out


def _fetch_body(article_id: str) -> dict:
    data = _gql(f'''{{ article(id: "{article_id}") {{ content richText {{ json links {{
        entries {{
          block {{ __typename sys {{ id }} ... on Content {{ headline body }} }}
          inline {{ __typename sys {{ id }} ... on Content {{ headline body }} }}
        }} }} }} }} }}''')
    return data.get("article") or {}


# ── Body → blocks ───────────────────────────────────────────────────────────
# A block is ("h", level, text) for a heading or ("p", 0, text) for a line of body.
Block = tuple[str, int, str]


def _clean(s: str) -> str:
    return re.sub(r"[ \t ]+", " ", s).strip()


def _inline(node: dict, entries: dict) -> str:
    t = node.get("nodeType")
    if t == "text":
        return node.get("value", "")
    if t == "embedded-entry-inline":
        e = entries.get(((node.get("data") or {}).get("target") or {}).get("sys", {}).get("id"))
        return (e or {}).get("headline") or ""
    return "".join(_inline(c, entries) for c in node.get("content") or [])


def _is_anchor_only(node: dict) -> bool:
    """A list item whose only link points inside the page (#…): a table of contents."""
    links = []

    def walk(n: dict) -> None:
        if n.get("nodeType") == "hyperlink":
            links.append((n.get("data") or {}).get("uri", ""))
        for c in n.get("content") or []:
            walk(c)
    walk(node)
    return bool(links) and all(u.startswith("#") for u in links)


def _rich_blocks(nodes: list[dict], entries: dict, depth: int = 0) -> Iterator[Block]:
    for n in nodes:
        t = n.get("nodeType", "")
        if t.startswith("heading-"):
            text = _clean(_inline(n, entries))
            if text:
                yield ("h", int(t[-1]), text)
        elif t == "paragraph":
            text = _clean(_inline(n, entries))
            if text:
                yield ("p", 0, text)
        elif t in ("unordered-list", "ordered-list"):
            for item in n.get("content") or []:
                if _is_anchor_only(item):
                    continue
                nested = [c for c in item.get("content") or []
                          if c.get("nodeType") in ("unordered-list", "ordered-list")]
                own = [c for c in item.get("content") or [] if c not in nested]
                text = _clean(" ".join(_inline(c, entries) for c in own))
                if text:
                    yield ("p", 0, "  " * depth + "- " + text)
                yield from _rich_blocks(nested, entries, depth + 1)
        elif t == "table":
            for row in n.get("content") or []:
                cells = [_clean(_inline(c, entries)) for c in row.get("content") or []]
                if any(cells):
                    yield ("p", 0, " | ".join(cells))
        elif t == "blockquote":
            yield from _rich_blocks(n.get("content") or [], entries, depth)
        elif t == "embedded-entry-block":
            e = entries.get(((n.get("data") or {}).get("target") or {}).get("sys", {}).get("id"))
            if e and e.get("__typename") == "Content" and not _TOC_MARKER.search(e.get("body") or ""):
                for part in (e.get("headline"), e.get("body")):
                    if part and _clean(part):
                        yield ("p", 0, _clean(part))
        # hr, embedded assets (images), media embeds and galleries carry no text.


_MD_IMG = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_HTML_H = re.compile(r"<h([1-6])[^>]*>(.*?)</h\1>", re.I | re.S)
_MD_H = re.compile(r"^(#{1,6})\s+(.*)$")
_TAG = re.compile(r"<[^>]+>")
_TABLE_RULE = re.compile(r"^\|?\s*:?-{3,}")
_ANCHOR_ITEM = re.compile(r"^\s*[-*]\s*\[[^\]]*\]\(#[^)]*\)\s*$")


def _md_text(s: str) -> str:
    s = _MD_LINK.sub(r"\1", _MD_IMG.sub("", s))
    s = html.unescape(_TAG.sub("", s))
    s = s.replace("__", "").replace("**", "")
    return _clean(s)


def _markdown_blocks(content: str) -> Iterator[Block]:
    # HTML headings may sit mid-line: give each its own line first.
    content = _HTML_H.sub(lambda m: f"\n\x00{m.group(1)}\x00{m.group(2)}\n", content)
    for raw in content.splitlines():
        # Blockquotes (developer comments) are content like any other line — and a
        # heading INSIDE one ("> ## Developer Comment:") is a label, not a section:
        # promoted to h2 it replaced the real path ("Ship Balance › Procurer") on
        # every section after it.
        quoted = bool(re.match(r"^\s*>", raw))
        raw = re.sub(r"^\s*(?:>\s?)+", "", raw)
        if quoted:
            text = _md_text(_MD_H.sub(r"\2", raw.strip()))
            if text:
                yield ("p", 0, text)
            continue
        if raw.startswith("\x00"):
            _, level, text = raw.split("\x00", 2)
            text = _md_text(text)
            if text:
                yield ("h", int(level), text)
            continue
        if _TABLE_RULE.match(raw.strip()) or _ANCHOR_ITEM.match(raw):
            continue
        m = _MD_H.match(raw.strip())
        if m:
            text = _md_text(m.group(2))
            if text:
                yield ("h", len(m.group(1)), text)
            continue
        indent = (len(raw) - len(raw.lstrip(" "))) // 4
        line = raw.strip()
        if line.startswith("|"):
            line = " | ".join(c.strip() for c in line.strip("|").split("|"))
        text = _md_text(line)
        if text and text not in ("|", "-"):
            yield ("p", 0, ("  " * indent + text) if line.startswith(("-", "*")) else text)


def body_blocks(body: dict) -> list[Block]:
    rich = body.get("richText") or {}
    nodes = (rich.get("json") or {}).get("content") or []
    if nodes:
        links = (rich.get("links") or {}).get("entries") or {}
        entries = {e["sys"]["id"]: e for e in (links.get("block") or []) + (links.get("inline") or []) if e}
        return list(_rich_blocks(nodes, entries))
    return list(_markdown_blocks(body.get("content") or ""))


# ── Blocks → Documents ──────────────────────────────────────────────────────
def _sections(blocks: list[Block]) -> list[tuple[str, str, list[str]]]:
    """[(h2, h3, lines)] cut at every h1/h2/h3. Deeper headings stay as lines."""
    out: list[tuple[str, str, list[str]]] = []
    h2, h3, lines = "", "", []

    def flush() -> None:
        if lines:
            out.append((h2, h3, lines[:]))

    for kind, level, text in blocks:
        if kind == "h" and level <= 3:
            text = text.rstrip(": ").strip() or text   # "Ecosystem:" -> "Ecosystem"
            flush()
            lines.clear()
            if level <= 2:
                h2, h3 = text, ""
            else:
                h3 = text
        else:
            lines.append(text if kind == "p" else f"{text}:")
    flush()
    return out


# Target size of one CCP Document. Smaller than the wiki's PASSAGE_SIZE on purpose:
# a patch-note section is a LIST of unrelated changes, and every extra line dilutes
# the embedding of the one the question is about. Measured with bge-m3 on "When
# were ore quantities in asteroid belts doubled?" against the 19.11 Ecosystem
# section: cosine 0.38 on the 1 360-char block (with a header line), 0.47 without
# the header, 0.63 on its first 300 characters.
PIECE = 700


def _pieces(lines: list[str], size: int = PIECE) -> list[list[str]]:
    """Cut a section's lines into runs of ~size characters, never mid-line."""
    out: list[list[str]] = [[]]
    for line in lines:
        if out[-1] and sum(len(x) + 1 for x in out[-1]) + len(line) > size:
            out.append([])
        out[-1].append(line)
    return [p for p in out if p]


def article_documents(art: Article, blocks: list[Block]) -> list[Document]:
    source, dtype, _ = CATEGORIES[art.category]
    head = f"{art.title} ({art.date})"
    # Consecutive short sections of the same h2 are merged up to PIECE (a one-line
    # section is too thin to retrieve on its own); long ones are cut into PIECE-size
    # runs. Every Document keeps the path of where it STARTS in its title.
    groups: list[tuple[str, str, list[str]]] = []
    for h2, h3, lines in _sections(blocks):
        for i, piece in enumerate(_pieces(lines)):
            body = ([h3] if h3 and i == 0 else []) + piece
            size = sum(len(x) + 1 for x in body)
            if i == 0 and groups and groups[-1][0] == h2 and \
                    sum(len(x) + 1 for x in groups[-1][2]) + size <= PIECE:
                groups[-1][2].extend(body)
            else:
                groups.append((h2, h3, body))
    docs: list[Document] = []
    for n, (h2, h3, lines) in enumerate(groups):
        title = " › ".join(x for x in (head, h2, h3) if x)
        # No "CCP patch notes · date" header line: the date is in the title, the
        # source kind reaches the model through the tier tag, and the header alone
        # cost ~0.1 of cosine on the measurement above.
        docs.append(Document(
            id=f"ccp:{art.category}:{art.slug}:{n}", type=dtype, title=title,
            text=f"{title}\n" + "\n".join(lines),
            source=source, url=ARTICLE_URL.format(slug=art.slug),
            metadata={"license": LICENSE, "category": CATEGORIES[art.category][2],
                      "published": art.date, "article_id": art.id,
                      "published_at": art.published_at}))
    return docs


def fetch_documents(articles: Iterable[Article], delay: float = DELAY_SECONDS) -> Iterator[tuple[Article, list[Document]]]:
    """(article, its Documents) for each article; a failing article is skipped
    with a warning — one bad body must not cost the whole crawl."""
    for art in articles:
        try:
            docs = article_documents(art, body_blocks(_fetch_body(art.id)))
        except Exception as e:  # noqa: BLE001
            print(f"[ccp] salto {art.slug}: {e}")
            continue
        time.sleep(delay)
        yield art, docs


def scrape_ccp(since: str = DEFAULT_SINCE, limit: int | None = None) -> Iterator[Document]:
    arts = list_articles(since)
    print(f"[ccp] {len(arts)} articoli (patch notes + dev blog) dal {since}")
    if limit:
        arts = arts[:limit]
    for _, docs in fetch_documents(arts):
        yield from docs
