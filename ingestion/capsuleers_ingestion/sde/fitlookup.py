"""Export the lookup table for fit analysis/validation (from the official SDE).

JSON output: { "ships": {name: {...}}, "modules": {name: {...}} }
A module's slot is inferred from its dogma effects; the fitSkill flag (weapon/shield)
lets the API apply level-V fitting skill bonuses.
"""

from __future__ import annotations

import json
from pathlib import Path

from .source import Sde, en

SLOT_BY_EFFECT = {12: "high", 13: "mid", 11: "low", 2663: "rig", 3772: "subsystem"}
WEAPON_EFFECTS = {42, 40}  # turretFitted, launcherFitted
SHIELD_PG_GROUPS = {"Shield Extender", "Shield Hardener", "Flex Shield Hardener",
                    "Shield Resistance Amplifier"}

A_MOD_CPU, A_MOD_PG, A_MOD_RIGSIZE = 50, 30, 1547
A_SHIP = {
    "cpuOutput": 48, "pgOutput": 11, "high": 14, "mid": 13, "low": 12,
    "rig": 1154, "turrets": 102, "launchers": 101,
    "droneCapacity": 283, "droneBandwidth": 1271, "calibration": 1132,
}


def _num(value):
    if value is None:
        return None
    return int(value) if float(value).is_integer() else round(value, 3)


def build_fit_lookup(sde: Sde) -> dict:
    types = sde.by_key("types")
    groups = sde.by_key("groups")
    categories = sde.by_key("categories")
    type_dogma = sde.by_key("typeDogma")

    ships: dict[str, dict] = {}
    modules: dict[str, dict] = {}

    for type_id, t in types.items():
        if not t.get("published"):
            continue
        td = type_dogma.get(type_id)
        if not td:
            continue
        attrs = {a["attributeID"]: a["value"] for a in td.get("dogmaAttributes", [])}
        effects = {e["effectID"] for e in td.get("dogmaEffects", [])}
        group = groups.get(t.get("groupID"), {})
        group_name = en(group.get("name"))
        category = en(categories.get(group.get("categoryID"), {}).get("name"))
        name = en(t.get("name"))

        if category in ("Ship", "Structure"):
            ships[name] = {"typeID": type_id, "group": group_name,
                           **{k: _num(attrs.get(a)) for k, a in A_SHIP.items()}}
            continue

        slot = next((SLOT_BY_EFFECT[e] for e in effects if e in SLOT_BY_EFFECT), None)
        if not slot:
            continue
        if effects & WEAPON_EFFECTS:
            fit_skill = "weapon"
        elif group_name in SHIELD_PG_GROUPS:
            fit_skill = "shield"
        else:
            fit_skill = None
        modules[name] = {
            "typeID": type_id, "group": group_name, "slot": slot,
            "cpu": _num(attrs.get(A_MOD_CPU)), "pg": _num(attrs.get(A_MOD_PG)),
            "rigSize": _num(attrs.get(A_MOD_RIGSIZE)), "fitSkill": fit_skill,
        }

    return {"ships": ships, "modules": modules}


def export_fit_lookup(sde_dir: str, out_path: str | Path) -> tuple[int, int]:
    """Build and export the lookup to JSON. Returns (n_ships, n_modules)."""
    data = build_fit_lookup(Sde(sde_dir))
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return len(data["ships"]), len(data["modules"])
