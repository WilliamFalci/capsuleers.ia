"""Registry of the MediaWiki installs crawled into the index.

Each WikiSource describes one MediaWiki: its api.php endpoint, the canonical
page-URL prefix (for citations), the Document.source / id-prefix that namespace
its chunks (so two wikis never collide on doc_id), the content licence (for
attribution) and the extraction mode — because not every MediaWiki exposes the
same read APIs:

- "extracts": the wiki has the TextExtracts extension (prop=extracts&explaintext)
  → already-clean plain text. Used by the EVE University Wiki.
- "parse_html": no TextExtracts (typical of Fandom) → render the article via
  action=parse (prop=text) and strip the HTML ourselves (see scrape._html_to_text).

To add another wiki: append a WikiSource here. run.py (--wiki/--all) and
wiki_update.py (the daily incremental timer) both iterate WIKI_SOURCES, so a new
entry is picked up automatically by the full rebuild AND the incremental update.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..config import CONFIG


@dataclass(frozen=True)
class WikiSource:
    key: str          # short cli/state key, e.g. "eveuni" | "sistersprobe"
    api_url: str      # MediaWiki api.php endpoint
    page_base: str    # full URL prefix; page_url = page_base + title.replace(' ','_')
    source: str       # Document.source (also a chunk filter value)
    id_prefix: str    # doc id namespace; doc_id = f"{id_prefix}:{title}"
    license: str      # for citation/attribution
    label: str        # human-readable name (logs / docs)
    fetch_mode: str = "extracts"  # "extracts" | "parse_html"


# Primary source. api_url stays env-overridable via CONFIG (.env) for parity with
# the original single-wiki setup. doc_id prefix kept as the historical "wiki:" so
# already-indexed chunks + wiki_state.json remain valid.
EVE_UNIVERSITY = WikiSource(
    key="eveuni",
    api_url=CONFIG.wiki_api_url,
    page_base="https://wiki.eveuniversity.org/",
    source="eve_university_wiki",
    id_prefix="wiki",
    license="CC-BY-SA-4.0",
    label="EVE University Wiki",
    fetch_mode="extracts",
)

# EVE Sister Core Scanner Probe Wiki (Fandom, German). Exploration-site catalogue
# (anomalies / signatures / relic & data sites). Fandom has NO TextExtracts → the
# article body is fetched via action=parse and de-HTML'd. Content is German; bge-m3
# embeds cross-lingually so IT/EN queries still retrieve it. Licence: CC-BY-SA.
SISTERS_PROBE = WikiSource(
    key="sistersprobe",
    api_url="https://sistersprobe.fandom.com/de/api.php",
    page_base="https://sistersprobe.fandom.com/de/wiki/",
    source="sisters_probe_wiki",
    id_prefix="sistersprobe",
    license="CC-BY-SA",
    label="EVE Sister Core Scanner Probe Wiki (Fandom, DE)",
    fetch_mode="parse_html",
)

# EVE Wiki on Fandom (English). General EVE encyclopedia (~1900 articles). Same
# Fandom shape as SISTERS_PROBE: no TextExtracts → parse_html. Licence: CC-BY-SA.
EVE_FANDOM = WikiSource(
    key="evefandom",
    api_url="https://eve.fandom.com/api.php",
    page_base="https://eve.fandom.com/wiki/",
    source="eve_fandom_wiki",
    id_prefix="evefandom",
    license="CC-BY-SA",
    label="EVE Wiki (Fandom, EN)",
    fetch_mode="parse_html",
)

WIKI_SOURCES: tuple[WikiSource, ...] = (EVE_UNIVERSITY, SISTERS_PROBE, EVE_FANDOM)
DEFAULT_WIKI = EVE_UNIVERSITY


def wiki_source(key: str) -> WikiSource:
    """Look up a registered wiki by its cli/state key (raises on unknown)."""
    for s in WIKI_SOURCES:
        if s.key == key:
            return s
    keys = ", ".join(s.key for s in WIKI_SOURCES)
    raise KeyError(f"wiki sconosciuto: {key!r} (disponibili: {keys})")
