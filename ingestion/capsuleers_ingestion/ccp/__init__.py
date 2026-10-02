"""CCP first-party sources (level L1 of the source hierarchy) — and the registry of
every source that works as a Provider (listed with a version stamp, fetched only
when it changed). capsuleers.app's own articles (L3, see capsuleers_app/) live here
too: ccp_update.py and run.py --ccp iterate this registry, and so does the
rag-publish workflow. The tier of each Document comes from its `source`, not from
being in this list.
"""

from __future__ import annotations

from .academy import AcademyProvider
from .common import Provider
from .devdocs import DevDocsProvider
from .news import NewsProvider
from .support import SupportProvider


def providers(only: str | None = None, since: str | None = None) -> list[Provider]:
    """All providers, or the comma-separated subset `only`. `since` moves the
    news window (patch notes / dev blogs); the other sources are small and current."""
    # Imported here, not at module level: articles.py builds on ccp.common, and
    # importing it while this package initialises would be circular.
    from ..capsuleers_app.articles import ArticlesProvider
    news = NewsProvider(since) if since else NewsProvider()
    all_ = [news, SupportProvider(), AcademyProvider(), DevDocsProvider(), ArticlesProvider()]
    if only:
        wanted = {x.strip() for x in only.split(",")}
        unknown = wanted - {p.name for p in all_}
        if unknown:
            raise SystemExit(f"provider CCP sconosciuti: {sorted(unknown)} "
                             f"(disponibili: {[p.name for p in all_]})")
        all_ = [p for p in all_ if p.name in wanted]
    return all_
