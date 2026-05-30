"""Facilities and production (official SDE): stations, PI schematics, certificates.

Stations in the new SDE have no explicit name: it is synthesized from
operation + owner + system.
"""

from __future__ import annotations

from collections.abc import Iterator

from ..models import Document
from .common import Names, clean
from .source import Sde, en

# Certificate levels (ascending order) found in skillTypes.
CERT_LEVELS = ["basic", "standard", "improved", "advanced", "elite"]


def parse_facilities(sde: Sde, names: Names) -> Iterator[Document]:
    yield from _stations(sde)
    yield from _planet_schematics(sde, names)
    yield from _certificates(sde, names)


def _stations(sde: Sde) -> Iterator[Document]:
    service_name = {k: en(r.get("serviceName")) for k, r in sde.by_key("stationServices").items()}
    operations = sde.by_key("stationOperations")
    corp_name = {k: en(r.get("name")) for k, r in sde.by_key("npcCorporations").items()}
    system_name = {k: en(r.get("name")) for k, r in sde.by_key("mapSolarSystems").items()}

    for sid, r in sde.by_key("npcStations").items():
        op = operations.get(r.get("operationID"), {})
        op_name = en(op.get("operationName"))
        owner = corp_name.get(r.get("ownerID"), "?")
        system = system_name.get(r.get("solarSystemID"), "?")
        title = f"{owner} {op_name}".strip() or f"Stazione {sid}"
        lines = [f"{title} (Stazione, sistema {system})"]
        services = [service_name.get(s) for s in op.get("services", []) if service_name.get(s)]
        if services:
            lines.append("Servizi: " + ", ".join(sorted(services)) + ".")
        yield Document(id=f"sde:station:{sid}", type="station", title=title,
                       text="\n".join(lines), source="ccp_sde",
                       metadata={"stationID": sid, "solarSystemID": r.get("solarSystemID"),
                                 "category": "Station"})


def _planet_schematics(sde: Sde, names: Names) -> Iterator[Document]:
    for sid, r in sde.by_key("planetSchematics").items():
        outputs = [(t["_key"], t["quantity"]) for t in r.get("types", []) if not t.get("isInput")]
        inputs = [(t["_key"], t["quantity"]) for t in r.get("types", []) if t.get("isInput")]
        lines = [f"{en(r.get('name'))} (Schematic Planetary Interaction)",
                 f"Tempo di ciclo: {r.get('cycleTime')}s."]
        if outputs:
            lines.append("Produce: " + ", ".join(f"{q}× {names.type(t)}" for t, q in outputs))
        if inputs:
            lines.append("Da: " + ", ".join(f"{q}× {names.type(t)}" for t, q in inputs))
        yield Document(id=f"sde:schematic:{sid}", type="schematic", title=en(r.get("name")),
                       text="\n".join(lines), source="ccp_sde",
                       metadata={"schematicID": sid, "category": "PISchematic"})


def _certificates(sde: Sde, names: Names) -> Iterator[Document]:
    for cid, r in sde.by_key("certificates").items():
        lines = [f"{en(r.get('name'))} (Certificato / Mastery)"]
        desc = clean(r.get("description"))
        if desc:
            lines.append(desc)
        # skillTypes: [{_key: skillID, basic, standard, improved, advanced, elite}]
        for level in CERT_LEVELS:
            reqs = [f"{names.type(s['_key'])} {s[level]}" for s in r.get("skillTypes", []) if s.get(level)]
            if reqs:
                lines.append(f"{level}: " + ", ".join(reqs))
        yield Document(id=f"sde:certificate:{cid}", type="certificate", title=en(r.get("name")),
                       text="\n".join(lines), source="ccp_sde",
                       metadata={"certID": cid, "category": "Certificate"})
