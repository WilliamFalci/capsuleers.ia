"""Universe (official SDE): regions, constellations, solar systems.

Adjacencies from mapStargates; planet/stargate counts from the system's own fields
(without reading the huge mapMoons/mapPlanets files).
"""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Iterator

from ..models import Document
from .common import Names, security_class
from .source import Sde, en
from .wormholes import load_wormhole_data


def parse_universe(sde: Sde, names: Names) -> Iterator[Document]:
    regions = sde.by_key("mapRegions")
    consts = sde.by_key("mapConstellations")
    systems = sde.by_key("mapSolarSystems")

    sys_per_region: Counter = Counter()
    sys_per_const: Counter = Counter()
    for s in systems.values():
        sys_per_region[s.get("regionID")] += 1
        sys_per_const[s.get("constellationID")] += 1

    neighbors: dict[int, set] = defaultdict(set)
    for g in sde.rows("mapStargates"):
        dest = g.get("destination", {}).get("solarSystemID")
        if dest:
            neighbors[g["solarSystemID"]].add(dest)

    wh = load_wormhole_data()  # effects + statics per J-space system (keyed by name)
    wh_effects, wh_statics = wh.get("systemEffects", {}), wh.get("systemStatics", {})

    for rid, r in regions.items():
        text = (f"{en(r.get('name'))} (Regione)\n"
                f"Costellazioni: {len(r.get('constellationIDs', []))}, "
                f"sistemi solari: {sys_per_region.get(rid, 0)}.")
        yield Document(id=f"sde:region:{rid}", type="region", title=en(r.get("name")),
                       text=text, source="ccp_sde", metadata={"regionID": rid, "category": "Region"})

    for cid, c in consts.items():
        region = en(regions.get(c.get("regionID"), {}).get("name"))
        text = (f"{en(c.get('name'))} (Costellazione, regione {region})\n"
                f"Sistemi solari: {sys_per_const.get(cid, 0)}.")
        yield Document(id=f"sde:constellation:{cid}", type="constellation", title=en(c.get("name")),
                       text=text, source="ccp_sde",
                       metadata={"constellationID": cid, "region": region, "category": "Constellation"})

    for sid, s in systems.items():
        sec_raw = s.get("securityStatus")
        sec = round(sec_raw, 1) if sec_raw is not None else None
        region = en(regions.get(s.get("regionID"), {}).get("name"))
        const = en(consts.get(s.get("constellationID"), {}).get("name"))
        lines = [
            f"{en(s.get('name'))} (Sistema solare)",
            f"Regione: {region}, costellazione: {const}.",
            f"Security: {sec} ({security_class(sec_raw)}).",
            f"Corpi celesti: {len(s.get('planetIDs', []))} pianeti, "
            f"{len(s.get('stargateIDs', []))} stargate.",
        ]
        adj = neighbors.get(sid)
        if adj:
            adj_names = ", ".join(en(systems[n].get("name")) for n in list(adj)[:12] if n in systems)
            lines.append(f"Sistemi adiacenti ({len(adj)}): {adj_names}.")

        # Wormhole (J-space) enrichment: system effect + static connections.
        name = en(s.get("name"))
        meta = {"solarSystemID": sid, "region": region, "constellation": const,
                "security": sec, "category": "SolarSystem"}
        effect = wh_effects.get(name)
        if effect:
            lines.append(f"Tipo: sistema wormhole (J-space). Effetto di sistema: {effect}.")
            meta["whEffect"] = effect
        statics = wh_statics.get(name)
        if statics:
            lines.append(f"Wormhole statici: {', '.join(statics)}.")

        yield Document(id=f"sde:system:{sid}", type="system", title=name,
                       text="\n".join(lines), source="ccp_sde", metadata=meta)
