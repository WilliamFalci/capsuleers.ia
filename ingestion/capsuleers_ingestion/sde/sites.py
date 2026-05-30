"""Sites/dungeons (official SDE): anomalies, deadspace, DED complexes, pirate bases.

From dungeons.jsonl — name, description (often with the DED rating) and faction.
Covers questions about anomalies and sites (the narrative explanations come from the wiki).
"""

from __future__ import annotations

from collections.abc import Iterator

from ..models import Document
from .common import clean
from .source import Sde, en


def parse_sites(sde: Sde, names) -> Iterator[Document]:
    if not sde.exists("dungeons"):
        return
    factions = {k: en(r.get("name")) for k, r in sde.by_key("factions").items()}
    for did, r in sde.by_key("dungeons").items():
        name = en(r.get("name"))
        desc = clean(r.get("description"))
        if not name and not desc:
            continue
        lines = [f"{name or f'Sito {did}'} (Sito / Anomalia / Deadspace)"]
        if desc:
            lines.append(desc)
        if r.get("factionID"):
            lines.append(f"Fazione: {factions.get(r['factionID'], '?')}.")
        yield Document(id=f"sde:dungeon:{did}", type="site", title=name or f"Sito {did}",
                       text="\n".join(lines), source="ccp_sde",
                       metadata={"dungeonID": did, "category": "Site"})
