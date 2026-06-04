"""Shared HTML → plain-text extractor (stdlib only).

Used by every source that has to strip rendered HTML to clean text: the Fandom
wikis (action=parse output, see wiki/scrape.py) and the static-HTML site scrapers
(see web/). Drops <script>/<style> and MediaWiki edit-section chrome; turns block
elements into line breaks; collapses whitespace. Suppression is depth-based so
nested elements inside a dropped subtree never unbalance the counter.
"""

from __future__ import annotations

import re
from html.parser import HTMLParser


class _TextExtractor(HTMLParser):
    _BLOCK = {"p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6",
              "blockquote", "table", "ul", "ol", "dl", "dd", "dt"}
    _DROP = {"script", "style"}
    _VOID = {"br", "img", "hr", "input", "meta", "link", "area", "base", "col",
             "embed", "param", "source", "track", "wbr"}
    # class substrings whose entire subtree is dropped (site chrome / edit links).
    _DROP_CLASSES = ("mw-editsection", "site-navigation", "site-header",
                     "site-footer", "breadcrumb")

    def __init__(self) -> None:
        super().__init__()
        self._out: list[str] = []
        self._depth = 0
        self._suppress: list[int] = []  # depths at which a suppressing element opened

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self._BLOCK or tag == "br":
            self._out.append("\n")
        if tag in self._VOID:
            return  # void element: no end tag → must not touch the depth counter
        self._depth += 1
        cls = dict(attrs).get("class") or ""
        if tag in self._DROP or any(c in cls for c in self._DROP_CLASSES):
            self._suppress.append(self._depth)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self._BLOCK or tag == "br":
            self._out.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self._VOID:
            return
        if self._suppress and self._suppress[-1] == self._depth:
            self._suppress.pop()
        self._depth = max(0, self._depth - 1)

    def handle_data(self, data: str) -> None:
        if not self._suppress:
            self._out.append(data)

    def text(self) -> str:
        return "".join(self._out)


def html_to_text(html: str) -> str:
    """Strip rendered HTML to clean, whitespace-collapsed plain text."""
    if not html:
        return ""
    p = _TextExtractor()
    p.feed(html)
    txt = p.text().replace("\xa0", " ")
    txt = re.sub(r"[ \t]+", " ", txt)
    txt = re.sub(r" *\n *", "\n", txt)
    txt = re.sub(r"\n{3,}", "\n\n", txt)
    return txt.strip()
