"""Social/lore entities (official SDE): factions, races, bloodlines, ancestries,
NPC corporations, NPC characters (agents).

Note: the new SDE no longer exposes agent level/type (that data was moved elsewhere),
so NPC characters are indexed by name/corp/race only.
"""

from __future__ import annotations

from collections.abc import Iterator

from ..models import Document
from .common import clean
from .source import Sde, en


def parse_social(sde: Sde, names) -> Iterator[Document]:
    corp_name = {k: en(r.get("name")) for k, r in sde.by_key("npcCorporations").items()}
    system_name = {k: en(r.get("name")) for k, r in sde.by_key("mapSolarSystems").items()}
    race_name = {k: en(r.get("name")) for k, r in sde.by_key("races").items()}
    bloodline_name = {k: en(r.get("name")) for k, r in sde.by_key("bloodlines").items()}

    yield from _factions(sde, corp_name, system_name)
    yield from _races(sde)
    yield from _bloodlines(sde, race_name)
    yield from _ancestries(sde, bloodline_name)
    yield from _npc_corps(sde, corp_name)
    yield from _agents(sde, corp_name, race_name)


def _factions(sde, corp_name, system_name) -> Iterator[Document]:
    for fid, r in sde.by_key("factions").items():
        lines = [f"{en(r.get('name'))} (Fazione)"]
        desc = clean(r.get("description"))
        if desc:
            lines.append(desc)
        if r.get("corporationID"):
            lines.append(f"Corporazione: {corp_name.get(r['corporationID'], '?')}.")
        if r.get("solarSystemID"):
            lines.append(f"Sistema capitale: {system_name.get(r['solarSystemID'], '?')}.")
        yield Document(id=f"sde:faction:{fid}", type="faction", title=en(r.get("name")),
                       text="\n".join(lines), source="ccp_sde",
                       metadata={"factionID": fid, "category": "Faction"})


def _races(sde) -> Iterator[Document]:
    for rid, r in sde.by_key("races").items():
        desc = clean(r.get("description"))
        text = f"{en(r.get('name'))} (Razza giocabile)" + (f"\n{desc}" if desc else "")
        yield Document(id=f"sde:race:{rid}", type="race", title=en(r.get("name")),
                       text=text, source="ccp_sde", metadata={"raceID": rid, "category": "Race"})


def _bloodlines(sde, race_name) -> Iterator[Document]:
    for bid, r in sde.by_key("bloodlines").items():
        desc = clean(r.get("description"))
        lines = [f"{en(r.get('name'))} (Bloodline, razza {race_name.get(r.get('raceID'), '?')})"]
        if desc:
            lines.append(desc)
        yield Document(id=f"sde:bloodline:{bid}", type="bloodline", title=en(r.get("name")),
                       text="\n".join(lines), source="ccp_sde",
                       metadata={"bloodlineID": bid, "category": "Bloodline"})


def _ancestries(sde, bloodline_name) -> Iterator[Document]:
    for aid, r in sde.by_key("ancestries").items():
        desc = clean(r.get("description"))
        lines = [f"{en(r.get('name'))} (Ancestry, bloodline {bloodline_name.get(r.get('bloodlineID'), '?')})"]
        if desc:
            lines.append(desc)
        yield Document(id=f"sde:ancestry:{aid}", type="ancestry", title=en(r.get("name")),
                       text="\n".join(lines), source="ccp_sde",
                       metadata={"ancestryID": aid, "category": "Ancestry"})


def _npc_corps(sde, corp_name) -> Iterator[Document]:
    for cid, r in sde.by_key("npcCorporations").items():
        if r.get("deleted"):
            continue
        name = en(r.get("name"))
        lines = [f"{name} (Corporazione NPC)"]
        desc = clean(r.get("description"))
        if desc:
            lines.append(desc)
        if r.get("tickerName"):
            lines.append(f"Ticker: {r['tickerName']}.")
        yield Document(id=f"sde:corporation:{cid}", type="corporation", title=name,
                       text="\n".join(lines), source="ccp_sde",
                       metadata={"corporationID": cid, "category": "Corporation"})


def _agents(sde, corp_name, race_name) -> Iterator[Document]:
    for aid, r in sde.by_key("npcCharacters").items():
        name = en(r.get("name"))
        if not name:
            continue
        parts = [f"{name} (Personaggio NPC)"]
        if r.get("corporationID"):
            parts.append(f"Corporazione: {corp_name.get(r['corporationID'], '?')}.")
        if r.get("raceID"):
            parts.append(f"Razza: {race_name.get(r['raceID'], '?')}.")
        yield Document(id=f"sde:agent:{aid}", type="agent", title=name,
                       text=" ".join(parts), source="ccp_sde",
                       metadata={"agentID": aid, "category": "NPCCharacter"})
