"""Shared machinery for the CCP first-party sources (level L1).

Every CCP source is a PROVIDER: it lists its items with a version stamp (cheap —
no bodies), and turns one item into Documents. ccp_update.py drives all of them the
same way: diff the stamps against the saved state, fetch only what changed, and
remember which Document ids each item produced.

Bodies arrive in three shapes — Contentful Rich Text JSON, Markdown with inline
HTML, plain HTML (Zendesk) — and all three become the same list of BLOCKS, which
`sectioned_documents` cuts at h2/h3 into ~PIECE-character Documents. Stdlib only.
"""

from __future__ import annotations

import html
import json
import re
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from dataclasses import dataclass, field
from html.parser import HTMLParser

from ..config import CONFIG, USER_AGENT
from ..models import Document

LICENSE = "© CCP / Fenris Creations — contenuto EVE Online (Developer License)"
CONTENTFUL = (f"https://graphql.contentful.com/content/v1/spaces/"
              f"{CONFIG.ccp_contentful_space}/environments/{CONFIG.ccp_contentful_env}")
DELAY_SECONDS = 0.25


# ── HTTP ────────────────────────────────────────────────────────────────────
def http_get(url: str, headers: dict | None = None, retries: int = 4) -> bytes:
    last: Exception | None = None
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            last = e
            if e.code == 429 or e.code >= 500:
                time.sleep(float(e.headers.get("Retry-After") or 1.5 * (attempt + 1)))
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"GET fallita: {url}") from last


def http_json(url: str, headers: dict | None = None) -> dict:
    return json.loads(http_get(url, headers))


def gql(query: str, retries: int = 5) -> dict:
    """Contentful Content Delivery API (GraphQL). The token is the read-only one
    eveonline.com ships to every browser — see config.py."""
    body = json.dumps({"query": query}).encode()
    last: Exception | None = None
    for attempt in range(retries):
        req = urllib.request.Request(CONTENTFUL, data=body, headers={
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


# ── Providers ───────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Item:
    key: str        # stable id within the provider
    stamp: str      # changes whenever the item's content changes
    label: str      # for logs
    data: dict = field(default_factory=dict, compare=False, hash=False)


class Provider:
    """One CCP source. `name` is its key in ccp_state.json and on the CLI."""
    name = ""
    description = ""

    def list(self) -> list[Item]:
        raise NotImplementedError

    def documents(self, item: Item) -> list[Document]:
        raise NotImplementedError

    def fetch(self, items: list[Item], delay: float = DELAY_SECONDS) -> Iterator[tuple[Item, list[Document]]]:
        """(item, its Documents); a failing item is skipped with a warning — one
        bad body must not cost the whole crawl."""
        for it in items:
            try:
                docs = self.documents(it)
            except Exception as e:  # noqa: BLE001
                print(f"[ccp:{self.name}] salto {it.label}: {e}")
                continue
            # Provenance for ccp_update --seed-from-dump: which item made this
            # Document, and at which version.
            for d in docs:
                d.metadata.update({"ccp_provider": self.name, "ccp_item": it.key, "ccp_stamp": it.stamp})
            time.sleep(delay)
            yield it, docs


# ── Body → blocks ───────────────────────────────────────────────────────────
# A block is ("h", level, text) for a heading or ("p", 0, text) for a line of body.
Block = tuple[str, int, str]

# Contentful "Content" entries used as a Table-of-Contents anchor, not content.
TOC_MARKER = re.compile(r"Content used to indicate that a Table of Contents", re.I)


def clean(s: str) -> str:
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


def rich_blocks(nodes: list[dict], entries: dict, depth: int = 0) -> Iterator[Block]:
    """Contentful Rich Text JSON → blocks."""
    for n in nodes:
        t = n.get("nodeType", "")
        if t.startswith("heading-"):
            text = clean(_inline(n, entries))
            if text:
                yield ("h", int(t[-1]), text)
        elif t == "paragraph":
            text = clean(_inline(n, entries))
            if text:
                yield ("p", 0, text)
        elif t in ("unordered-list", "ordered-list"):
            for item in n.get("content") or []:
                if _is_anchor_only(item):
                    continue
                nested = [c for c in item.get("content") or []
                          if c.get("nodeType") in ("unordered-list", "ordered-list")]
                own = [c for c in item.get("content") or [] if c not in nested]
                text = clean(" ".join(_inline(c, entries) for c in own))
                if text:
                    yield ("p", 0, "  " * depth + "- " + text)
                yield from rich_blocks(nested, entries, depth + 1)
        elif t == "table":
            for row in n.get("content") or []:
                cells = [clean(_inline(c, entries)) for c in row.get("content") or []]
                if any(cells):
                    yield ("p", 0, " | ".join(cells))
        elif t == "blockquote":
            yield from rich_blocks(n.get("content") or [], entries, depth)
        elif t == "embedded-entry-block":
            e = entries.get(((n.get("data") or {}).get("target") or {}).get("sys", {}).get("id"))
            if e and e.get("__typename") == "Content" and not TOC_MARKER.search(e.get("body") or ""):
                for part in (e.get("headline"), e.get("body")):
                    if part and clean(part):
                        yield from markdown_blocks(part, headings=False)
        # hr, embedded assets (images), media embeds and galleries carry no text.


_MD_IMG = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_HTML_H = re.compile(r"<h([1-6])[^>]*>(.*?)</h\1>", re.I | re.S)
_MD_H = re.compile(r"^(#{1,6})\s+(.*)$")
_TAG = re.compile(r"<[^>]+>")
_TABLE_RULE = re.compile(r"^\|?\s*:?-{3,}")
_ANCHOR_ITEM = re.compile(r"^\s*[-*]\s*\[[^\]]*\]\(#[^)]*\)\s*$")
# MkDocs include directives (`--8<-- "snippets/…"`) and admonition openers (`!!! note`).
_MKDOCS = re.compile(r'^\s*(--8<--|!!!|\?\?\?)')


def md_text(s: str) -> str:
    s = _MD_LINK.sub(r"\1", _MD_IMG.sub("", s))
    s = html.unescape(_TAG.sub("", s))
    s = s.replace("__", "").replace("**", "")
    return clean(s)


def markdown_blocks(content: str, headings: bool = True) -> Iterator[Block]:
    """Markdown with inline HTML → blocks. `headings=False` flattens every heading
    into a line (used for fragments embedded inside an already-titled section)."""
    # HTML headings may sit mid-line: give each its own line first.
    content = _HTML_H.sub(lambda m: f"\n\x00{m.group(1)}\x00{m.group(2)}\n", content)
    in_code = False
    for raw in content.splitlines():
        if raw.strip().startswith("```"):
            in_code = not in_code
            continue
        if in_code or _MKDOCS.match(raw):
            continue
        # Blockquotes (developer comments) are content like any other line — and a
        # heading INSIDE one ("> ## Developer Comment:") is a label, not a section:
        # promoted to h2 it replaced the real path ("Ship Balance › Procurer") on
        # every section after it.
        quoted = bool(re.match(r"^\s*>", raw))
        raw = re.sub(r"^\s*(?:>\s?)+", "", raw)
        if raw.startswith("\x00"):
            _, level, text = raw.split("\x00", 2)
            text = md_text(text)
            if text:
                yield ("h", int(level), text) if headings and not quoted else ("p", 0, text)
            continue
        if _TABLE_RULE.match(raw.strip()) or _ANCHOR_ITEM.match(raw):
            continue
        m = _MD_H.match(raw.strip())
        if m:
            text = md_text(m.group(2))
            if text:
                yield ("h", len(m.group(1)), text) if headings and not quoted else ("p", 0, text)
            continue
        indent = (len(raw) - len(raw.lstrip(" "))) // 4
        line = raw.strip()
        if line.startswith("|"):
            line = " | ".join(c.strip() for c in line.strip("|").split("|"))
        text = md_text(line)
        if text and text not in ("|", "-"):
            yield ("p", 0, ("  " * indent + text) if line.startswith(("-", "*")) else text)


class _HtmlBlocks(HTMLParser):
    """Plain HTML (Zendesk article bodies) → blocks."""
    _LINE = {"p", "div", "li", "dt", "dd", "blockquote", "pre", "section", "article"}
    _DROP = {"script", "style"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[Block] = []
        self._buf: list[str] = []
        self._heading = 0
        self._cells: list[str] | None = None
        self._drop = 0
        self._li = 0

    def _flush(self) -> None:
        text = clean("".join(self._buf))
        self._buf = []
        if not text:
            return
        if self._cells is not None:
            self._cells.append(text)
        elif self._heading:
            self.blocks.append(("h", self._heading, text))
        else:
            self.blocks.append(("p", 0, ("- " + text) if self._li else text))

    def handle_starttag(self, tag, attrs):
        if tag in self._DROP:
            self._drop += 1
        elif re.fullmatch(r"h[1-6]", tag):
            self._flush()
            self._heading = int(tag[1])
        elif tag == "tr":
            self._flush()
            self._cells = []
        elif tag in ("td", "th"):
            self._flush()
        elif tag == "li":
            self._flush()
            self._li += 1
        elif tag in self._LINE or tag == "br":
            self._flush()

    def handle_endtag(self, tag):
        if tag in self._DROP:
            self._drop = max(0, self._drop - 1)
        elif re.fullmatch(r"h[1-6]", tag):
            self._flush()
            self._heading = 0
        elif tag in ("td", "th"):
            self._flush()
        elif tag == "tr":
            self._flush()
            if self._cells:
                self.blocks.append(("p", 0, " | ".join(self._cells)))
            self._cells = None
        elif tag == "li":
            self._flush()
            self._li = max(0, self._li - 1)
        elif tag in self._LINE:
            self._flush()

    def handle_data(self, data):
        if not self._drop:
            self._buf.append(data)


def html_blocks(body: str) -> list[Block]:
    p = _HtmlBlocks()
    p.feed(body or "")
    p._flush()
    return p.blocks


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


def sectioned_documents(id_prefix: str, head: str, blocks: list[Block], *, dtype: str,
                        source: str, url: str, metadata: dict) -> list[Document]:
    """Cut `blocks` at h2/h3 into ~PIECE Documents titled "head › h2 › h3".

    Consecutive short sections of the same h2 are merged up to PIECE (a one-line
    section is too thin to retrieve on its own); long ones are cut into PIECE-size
    runs. Every Document keeps the path of where it STARTS in its title. No header
    line in the text: the title carries the date where there is one, the source kind
    reaches the model through the tier tag, and the header alone cost ~0.1 cosine."""
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
        # A heading that repeats a segment already in the path ("EVE Academy › Heron
        # › Heron") adds nothing but length to the embedded text.
        path = head.split(" › ")
        for x in (h2, h3):
            if x and x.lower() not in {p.lower() for p in path}:
                path.append(x)
        title = " › ".join(path)
        docs.append(Document(
            id=f"{id_prefix}:{n}", type=dtype, title=title,
            text=f"{title}\n" + "\n".join(lines), source=source, url=url,
            metadata={"license": LICENSE, **metadata}))
    return docs
