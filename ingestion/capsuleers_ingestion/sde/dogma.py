"""Dogma and references (official SDE): effects, attribute definitions, units,
market groups. Useful as a glossary for the model.

Note: in the new SDE, effects no longer expose a description/displayName, only
an internal name (e.g. "shieldBoosting") + flags. The name is prettified.
"""

from __future__ import annotations

import re
from collections.abc import Iterator

from ..models import Document
from .common import clean
from .source import Sde, en

_CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")


def _prettify(name: str) -> str:
    return _CAMEL.sub(" ", name or "").replace("_", " ").strip().capitalize()


def parse_dogma(sde: Sde, names) -> Iterator[Document]:
    yield from _effects(sde)
    yield from _attributes(sde)
    yield from _units(sde)
    yield from _market_groups(sde)


def _effects(sde: Sde) -> Iterator[Document]:
    for eid, r in sde.by_key("dogmaEffects").items():
        if not r.get("published"):
            continue
        title = _prettify(r.get("name", ""))
        flags = []
        if r.get("isOffensive"):
            flags.append("offensivo")
        if r.get("isAssistance"):
            flags.append("di assistenza")
        if r.get("isWarpSafe"):
            flags.append("utilizzabile in warp")
        text = f"{title} (Effetto dogma)"
        if flags:
            text += "\nProprietà: " + ", ".join(flags) + "."
        yield Document(id=f"sde:effect:{eid}", type="effect", title=title or f"effect {eid}",
                       text=text, source="ccp_sde", metadata={"effectID": eid, "category": "Effect"})


def _attributes(sde: Sde) -> Iterator[Document]:
    for aid, r in sde.by_key("dogmaAttributes").items():
        if not r.get("published"):
            continue
        title = en(r.get("displayName")) or r.get("name")
        if not title:
            continue
        desc = clean(r.get("description"))
        text = f"{title} (Attributo dogma)" + (f"\n{desc}" if desc else "")
        yield Document(id=f"sde:attribute:{aid}", type="attribute", title=title,
                       text=text, source="ccp_sde", metadata={"attributeID": aid, "category": "Attribute"})


def _units(sde: Sde) -> Iterator[Document]:
    for uid, r in sde.by_key("dogmaUnits").items():
        title = r.get("name") or en(r.get("displayName"))
        desc = clean(r.get("description"))
        text = f"{title} (Unità di misura)" + (f"\n{desc}" if desc else "")
        yield Document(id=f"sde:unit:{uid}", type="unit", title=title or f"unit {uid}",
                       text=text, source="ccp_sde", metadata={"unitID": uid, "category": "Unit"})


def _market_groups(sde: Sde) -> Iterator[Document]:
    for mid, r in sde.by_key("marketGroups").items():
        name = en(r.get("name"))
        desc = clean(r.get("description"))
        text = f"{name} (Gruppo di mercato)" + (f"\n{desc}" if desc else "")
        yield Document(id=f"sde:marketgroup:{mid}", type="marketgroup", title=name,
                       text=text, source="ccp_sde", metadata={"marketGroupID": mid, "category": "MarketGroup"})
