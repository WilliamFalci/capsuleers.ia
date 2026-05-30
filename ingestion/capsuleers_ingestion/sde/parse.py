"""Parse ALL published types from the official SDE (JSONL) into Documents.

Each type (ship, module, skill, charge, drone, implant, blueprint, commodity,
SKIN, asteroid, structure, ...) produces a Document enriched with its description,
taxonomy (category/group/tier), dogma attributes, skill requirements and — for
ships — bonuses (typeBonus).
"""

from __future__ import annotations

from collections.abc import Iterator

from ..models import Document
from .common import Names, clean, fmt_num
from .source import Sde, en

CATEGORY_TO_DOCTYPE = {
    "Ship": "ship", "Module": "module", "Charge": "module", "Skill": "skill",
    "Drone": "module", "Implant": "module", "Subsystem": "module",
    "Deployable": "module", "Structure": "ship", "Structure Module": "module",
    "Fighter": "module", "Commodity": "item",
}

SKILL_REQ_PAIRS = [(182, 277), (183, 278), (184, 279),
                   (1285, 1286), (1289, 1287), (1290, 1288)]
_SKILL_REQ_ATTRS = {a for pair in SKILL_REQ_PAIRS for a in pair}
_SKIP_ATTRS = _SKILL_REQ_ATTRS | {275, 180, 181}

# Legacy fallback for training attributes (value → character attribute).
_CHAR_ATTR_LEGACY = {164: "Carisma", 165: "Intelligenza", 166: "Memoria",
                     167: "Percezione", 168: "Forza di volontà"}

_UNIT_SYMBOL = {
    1: "m", 9: "m³", 10: "m/s", 11: "m/s²", 102: "mm", 103: "MPa", 104: "x",
    105: "%", 106: "tf", 107: "MW", 113: "HP", 114: "GJ", 121: "%", 125: "N",
    126: "ly", 127: "%", 129: "h", 135: "AU",
}
_UNIT_GROUP, _UNIT_TYPE, _UNIT_ATTR = 115, 116, 119
_UNIT_MS, _UNIT_RESONANCE = 101, 108


def parse_types(sde: Sde, names: Names) -> Iterator[Document]:
    ctx = _Ctx(sde, names)
    groups = sde.by_key("groups")
    categories = sde.by_key("categories")

    for type_id, t in sde.by_key("types").items():
        if not t.get("published"):
            continue
        group = groups.get(t.get("groupID"), {})
        category_name = en(categories.get(group.get("categoryID"), {}).get("name"))
        if category_name == "Blueprint":
            continue  # blueprints are handled (richly) by industry.py
        group_name = en(group.get("name"))
        attrs = ctx.attrs.get(type_id, {})
        yield Document(
            id=f"sde:type:{type_id}",
            type=CATEGORY_TO_DOCTYPE.get(category_name, "item"),
            title=en(t.get("name")),
            text=_build_text(ctx, type_id, t, category_name, group_name, attrs),
            source="ccp_sde",
            metadata={
                "typeID": type_id,
                "group": group_name,
                "category": category_name,
                "tier": ctx.meta_group.get(t.get("metaGroupID"), "Tech I"),
            },
        )


class _Ctx:
    def __init__(self, sde: Sde, names: Names) -> None:
        self.names = names
        da = sde.by_key("dogmaAttributes")
        # Only displayName (like the classic schema): skips internal attributes with no user-facing name.
        self.attr_label = {k: en(r.get("displayName")) for k, r in da.items()}
        self.attr_unit = {k: r.get("unitID") for k, r in da.items()}
        self.meta_group = {k: en(r.get("name")) for k, r in sde.by_key("metaGroups").items()}
        self.char_attr = {k: en(r.get("name")) for k, r in sde.by_key("characterAttributes").items()} \
            if sde.exists("characterAttributes") else {}

        # Per-type attributes: typeDogma → {typeID: {attrID: value}}.
        self.attrs: dict[int, dict[int, float]] = {}
        for type_id, td in sde.by_key("typeDogma").items():
            self.attrs[type_id] = {a["attributeID"]: a["value"] for a in td.get("dogmaAttributes", [])}

        # Ship bonuses: typeBonus → {shipTypeID: [(bonus, text, skillID|None)]}.
        self.bonuses: dict[int, list] = {}
        for ship_id, tb in sde.by_key("typeBonus").items():
            items = []
            for rb in tb.get("roleBonuses", []):
                items.append((rb.get("bonus"), clean(rb.get("bonusText")), None))
            for per_skill in tb.get("types", []):
                skill_id = per_skill.get("_key")
                for b in per_skill.get("_value", []):
                    items.append((b.get("bonus"), clean(b.get("bonusText")), skill_id))
            self.bonuses[ship_id] = items


def _build_text(ctx: _Ctx, type_id, t, category, group_name, attrs) -> str:
    tier = ctx.meta_group.get(t.get("metaGroupID"))
    lines = [f"{en(t.get('name'))} ({tier + ' ' if tier else ''}{category} / {group_name})"]

    desc = clean(t.get("description"))
    if desc:
        lines.append(desc)

    tree = _skill_tree(ctx, type_id)
    if tree:
        lines.append("Requisiti skill (albero completo, prerequisiti ricorsivi):\n" + tree)

    if category in ("Ship", "Structure"):
        bonuses = _ship_bonuses(ctx, type_id)
        if bonuses:
            lines.append(f"Bonus: {bonuses}")

    if category == "Skill":
        lines.extend(_skill_lines(ctx, attrs))
    else:
        attr_line = _attr_line(ctx, attrs)
        if attr_line:
            lines.append(f"Attributi: {attr_line}")

    return "\n".join(lines)


def _g(v) -> str:
    if isinstance(v, float):
        v = round(v, 3)
        if v.is_integer():
            v = int(v)
    return f"{v:g}" if isinstance(v, float) else str(v)


def _fmt_value(ctx: _Ctx, attr_id: int, raw) -> str:
    uid = ctx.attr_unit.get(attr_id)
    if uid == _UNIT_GROUP:
        return ctx.names.group(int(raw))
    if uid == _UNIT_TYPE:
        return ctx.names.type(int(raw))
    if uid == _UNIT_ATTR:
        return ctx.attr_label.get(int(raw), f"attr {int(raw)}")
    if uid == _UNIT_MS:
        return f"{_g(raw / 1000)} s"
    if uid == _UNIT_RESONANCE:
        return f"{_g((1 - raw) * 100)}% (resist)"
    sym = _UNIT_SYMBOL.get(uid)
    return f"{_g(raw)} {sym}" if sym else _g(raw)


def _attr_line(ctx: _Ctx, attrs: dict) -> str:
    parts = []
    for attr_id, raw in attrs.items():
        if attr_id in _SKIP_ATTRS:
            continue
        label = ctx.attr_label.get(attr_id)
        if not label or raw in (None, 0, 0.0):
            continue
        val = _fmt_value(ctx, attr_id, raw)
        if val:
            parts.append(f"{label}: {val}")
    return ", ".join(parts[:40])


def _skill_lines(ctx: _Ctx, attrs: dict) -> list[str]:
    out = []
    rank = attrs.get(275)
    if rank:
        out.append(f"Rank (moltiplicatore tempo): {fmt_num(rank)}")
    primary, secondary = attrs.get(180), attrs.get(181)
    if primary or secondary:
        p = _char_attr(ctx, primary)
        s = _char_attr(ctx, secondary)
        out.append(f"Attributi di addestramento: primario {p}, secondario {s}")
    return out


def _char_attr(ctx: _Ctx, value) -> str:
    if not value:
        return "?"
    vid = int(value)
    return _CHAR_ATTR_LEGACY.get(vid) or ctx.char_attr.get(vid) or "?"


def _direct_reqs(ctx: _Ctx, type_id: int) -> list[tuple[int, float | None]]:
    """Direct skill requirements of a type: [(skillID, level)]."""
    a = ctx.attrs.get(type_id, {})
    out = []
    for skill_attr, level_attr in SKILL_REQ_PAIRS:
        sid = a.get(skill_attr)
        if sid:
            out.append((int(sid), a.get(level_attr)))
    return out


def _skill_tree(ctx: _Ctx, type_id: int, cap: int = 40) -> str:
    """Recursive tree of skill prerequisites (indented). Empty if there are none."""
    out: list[str] = []

    def walk(tid: int, level, depth: int, seen: frozenset) -> None:
        if len(out) >= cap:
            return
        lvl = fmt_num(level) if level is not None else "?"
        out.append("  " * depth + f"- {ctx.names.type(tid)} livello {lvl}")
        if tid in seen or depth >= 7:
            return
        for sid, lv in _direct_reqs(ctx, tid):
            walk(sid, lv, depth + 1, seen | {tid})

    for sid, lv in _direct_reqs(ctx, type_id):
        walk(sid, lv, 0, frozenset())
    return "\n".join(out)


def _ship_bonuses(ctx: _Ctx, type_id: int) -> str:
    parts = []
    for bonus, text, skill_id in ctx.bonuses.get(type_id, []):
        if not text:
            continue
        b = fmt_num(bonus)
        prefix = f"{b}% " if b and b != "0" else ""
        suffix = f" (per livello di {ctx.names.type(skill_id)})" if skill_id else ""
        parts.append(f"{prefix}{text}{suffix}".strip())
    return "; ".join(parts[:12])
