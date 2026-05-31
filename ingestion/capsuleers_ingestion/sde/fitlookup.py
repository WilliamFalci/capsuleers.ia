"""Export the lookup table for fit analysis/validation (from the official SDE).

JSON output: { "ships": {...}, "modules": {...}, "charges": {...}, "drones": {...} }
Beyond CPU/PG/slot validation, ships carry HP/resists/capacitor/mobility/bonuses and
modules carry the combat/tank/cap/prop dogma attributes, so the desktop app can
estimate DPS, EHP, speed and cap stability (All-V), and check ship-bonus usage.
"""

from __future__ import annotations

import json
import re
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

# Damage by type (on charges & drones): EM, Explosive, Kinetic, Thermal.
A_DMG = {"em": 114, "exp": 116, "kin": 117, "therm": 118}
# Resonance (= 1 - resist) per layer; used as ship base AND as resist-module multiplier.
A_RES = {
    "shield": {"em": 271, "exp": 272, "kin": 273, "therm": 274},
    "armor": {"em": 267, "exp": 268, "kin": 269, "therm": 270},
    "hull": {"em": 113, "exp": 111, "kin": 109, "therm": 110},
}
A_HP = {"shield": 263, "armor": 265, "hull": 9}
# Curated combat/tank/cap/prop attributes exported per module (read by the JS calculator).
A_MOD_KEEP = {
    6: "capNeed", 64: "dmgMult", 51: "rof", 73: "duration", 1255: "droneDmgBonus",
    68: "shieldBoost", 84: "armorRep", 72: "shieldHpAdd", 1159: "armorHpAdd",
    20: "speedFactor", 567: "speedBoostFactor", 796: "massAddition",
    # resist via direct resonance multipliers (e.g. Damage Control)
    267: "armorRes_em", 268: "armorRes_exp", 269: "armorRes_kin", 270: "armorRes_therm",
    271: "shieldRes_em", 272: "shieldRes_exp", 273: "shieldRes_kin", 274: "shieldRes_therm",
    974: "hullRes_em", 975: "hullRes_exp", 976: "hullRes_kin", 977: "hullRes_therm",
    # resist via percentage bonus (generic → layer from group; or explicit shield/armor)
    984: "resBonus_em", 985: "resBonus_exp", 986: "resBonus_kin", 987: "resBonus_therm",
    1465: "armorResBonus_em", 1468: "armorResBonus_exp", 1466: "armorResBonus_kin", 1467: "armorResBonus_therm",
    1489: "shieldResBonus_em", 1490: "shieldResBonus_exp", 1491: "shieldResBonus_kin", 1492: "shieldResBonus_therm",
}
_TAG = re.compile(r"<[^>]+>")


def _num(value):
    if value is None:
        return None
    return int(value) if float(value).is_integer() else round(value, 4)


def _res(attrs: dict, ids: dict) -> dict:
    out = {k: _num(attrs.get(a)) for k, a in ids.items()}
    return out if any(v is not None for v in out.values()) else None


def _ship_bonuses(tb: dict | None) -> list[dict]:
    """Flatten typeBonus into structured bonuses: {text, value, pct, perLevel}.
    perLevel bonuses come from per-skill traits (×5 at level V); role bonuses are flat."""
    if not tb:
        return []
    out = []
    def add(b, per_level):
        txt = _TAG.sub("", en(b.get("bonusText")) or "").strip()
        if not txt:
            return
        out.append({"text": txt, "value": _num(b.get("bonus")),
                    "pct": b.get("unitID") == 105, "perLevel": per_level})
    for b in tb.get("roleBonuses", []):
        add(b, False)
    for grp in (tb.get("types") or []):       # per-skill: [{_key: skillID, _value: [bonus...]}]
        for b in (grp.get("_value") or []):
            add(b, True)
    return out


def build_fit_lookup(sde: Sde) -> dict:
    types = sde.by_key("types")
    groups = sde.by_key("groups")
    categories = sde.by_key("categories")
    type_dogma = sde.by_key("typeDogma")
    type_bonus = sde.by_key("typeBonus") if sde.exists("typeBonus") else {}

    ships, modules, charges, drones = {}, {}, {}, {}

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
            ships[name] = {
                "typeID": type_id, "group": group_name,
                **{k: _num(attrs.get(a)) for k, a in A_SHIP.items()},
                "hp": {k: _num(attrs.get(a)) for k, a in A_HP.items()},
                "res": {layer: _res(attrs, ids) for layer, ids in A_RES.items()},
                "cap": {"capacity": _num(attrs.get(482)), "rechargeRate": _num(attrs.get(55))},
                "mob": {"maxVelocity": _num(attrs.get(37)), "mass": _num(t.get("mass")),
                        "agility": _num(attrs.get(70)), "sig": _num(attrs.get(552))},
                "bonuses": _ship_bonuses(type_bonus.get(type_id)),
            }
            continue

        if category == "Charge":
            dmg = {k: _num(attrs.get(a)) for k, a in A_DMG.items()}
            if any(v for v in dmg.values()):
                charges[name] = {"typeID": type_id, "group": group_name, "dmg": dmg}
            continue

        if category == "Drone":
            drones[name] = {
                "typeID": type_id, "group": group_name,
                "dmg": {k: _num(attrs.get(a)) for k, a in A_DMG.items()},
                "dmgMult": _num(attrs.get(64)), "rof": _num(attrs.get(51)),
                "bwUsed": _num(attrs.get(1272)),
            }
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
        mod_attrs = {name: _num(attrs[a]) for a, name in A_MOD_KEEP.items() if a in attrs}
        modules[name] = {
            "typeID": type_id, "group": group_name, "slot": slot,
            "cpu": _num(attrs.get(A_MOD_CPU)), "pg": _num(attrs.get(A_MOD_PG)),
            "rigSize": _num(attrs.get(A_MOD_RIGSIZE)), "fitSkill": fit_skill,
            "attrs": mod_attrs,
        }

    return {"ships": ships, "modules": modules, "charges": charges, "drones": drones}


def export_fit_lookup(sde_dir: str, out_path: str | Path) -> tuple[int, int]:
    """Build and export the lookup to JSON. Returns (n_ships, n_modules)."""
    data = build_fit_lookup(Sde(sde_dir))
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return len(data["ships"]), len(data["modules"])
