"""Detects changed EVE University wiki pages via the MediaWiki recentchanges API.

This is the structured, paginated API equivalent of the human
`Special:RecentChanges` page — no HTML scraping. We list ns0 edits/new pages
(and delete/move log entries, so stale chunks get pruned), skipping bot edits,
back to the last-seen timestamp. The caller re-scrapes the touched titles and
removes the chunks of the pages that no longer exist.
"""

from __future__ import annotations

import datetime as dt
import time
from collections.abc import Iterator

from .api import api_get

# How far back to look on the very first run (no saved state). Kept modest: a cold
# start should do a full rebuild via run.py, not a giant recentchanges sweep.
DEFAULT_LOOKBACK_DAYS = 7


def _iso_days_ago(days: int) -> str:
    t = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def changed_titles_since(
    since_ts: str | None,
    *,
    include_bots: bool = False,
    namespace: int = 0,
) -> tuple[set[str], str | None]:
    """Returns (set of touched ns0 titles, newest timestamp seen).

    `since_ts`: ISO-8601 UTC (e.g. "2026-05-31T00:00:00Z"). None → last
    DEFAULT_LOOKBACK_DAYS. The newest timestamp is what the caller should persist
    as the next `since_ts` (exclusive lower bound for the following run).
    """
    rcend = since_ts or _iso_days_ago(DEFAULT_LOOKBACK_DAYS)
    titles: set[str] = set()
    newest: str | None = None
    rccontinue: str | None = None
    rcshow = None if include_bots else "!bot"
    while True:
        params = {
            "action": "query", "list": "recentchanges",
            "rcnamespace": str(namespace),
            "rctype": "edit|new|log",
            "rcprop": "title|timestamp|ids",
            "rclimit": "500", "rcdir": "older",  # newest → oldest
            "rcend": rcend, "format": "json",
        }
        if rcshow:
            params["rcshow"] = rcshow
        if rccontinue:
            params["rccontinue"] = rccontinue
        data = api_get(params)
        changes = data.get("query", {}).get("recentchanges", [])
        for c in changes:
            if newest is None:
                newest = c.get("timestamp")  # first row = newest (rcdir=older)
            t = c.get("title")
            if t:
                titles.add(t)
        cont = data.get("continue")
        if not cont:
            break
        rccontinue = cont["rccontinue"]
        time.sleep(0.3)
    return titles, newest


def _iter_recentchanges(limit: int = 20) -> Iterator[dict]:
    """Debug helper: yields the most recent N changes (for --check output)."""
    data = api_get({
        "action": "query", "list": "recentchanges", "rcnamespace": "0",
        "rctype": "edit|new|log", "rcshow": "!bot",
        "rcprop": "title|timestamp|ids", "rclimit": str(limit), "format": "json",
    })
    yield from data.get("query", {}).get("recentchanges", [])
