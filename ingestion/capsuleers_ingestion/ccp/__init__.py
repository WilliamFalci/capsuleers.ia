"""CCP first-party sources (level L1 of the source hierarchy).

PROVIDERS is the registry ccp_update.py and run.py iterate: one entry per source.
"""

from __future__ import annotations

from .academy import AcademyProvider
from .common import Provider
from .devdocs import DevDocsProvider
from .news import NewsProvider
from .support import SupportProvider


def providers(only: str | None = None, since: str | None = None) -> list[Provider]:
    """All CCP providers, or the comma-separated subset `only`. `since` moves the
    news window (patch notes / dev blogs); the other sources are small and current."""
    news = NewsProvider(since) if since else NewsProvider()
    all_ = [news, SupportProvider(), AcademyProvider(), DevDocsProvider()]
    if only:
        wanted = {x.strip() for x in only.split(",")}
        unknown = wanted - {p.name for p in all_}
        if unknown:
            raise SystemExit(f"provider CCP sconosciuti: {sorted(unknown)} "
                             f"(disponibili: {[p.name for p in all_]})")
        all_ = [p for p in all_ if p.name in wanted]
    return all_
