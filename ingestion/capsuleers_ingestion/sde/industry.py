"""Industry (official SDE): blueprints with named activities (manufacturing,
research, copying, invention, reaction), materials/products/time/skills.
"""

from __future__ import annotations

from collections.abc import Iterator

from ..models import Document
from .common import Names
from .source import Sde

ACT_LABEL = {
    "manufacturing": "Manifattura", "copying": "Copia",
    "research_material": "Ricerca ME", "research_time": "Ricerca TE",
    "invention": "Invenzione", "reaction": "Reazione",
}


def parse_industry(sde: Sde, names: Names) -> Iterator[Document]:
    for bp_id, bp in sde.by_key("blueprints").items():
        tid = bp.get("blueprintTypeID", bp_id)
        lines = [f"{names.type(tid)} (Blueprint)"]
        for act_key, act in bp.get("activities", {}).items():
            seg = [f"[{ACT_LABEL.get(act_key, act_key)}]"]
            if act.get("time"):
                seg.append(f"tempo base {_fmt_time(act['time'])}")
            if act.get("products"):
                seg.append("produce " + ", ".join(
                    f"{p['quantity']}× {names.type(p['typeID'])}" for p in act["products"][:10]))
            if act.get("materials"):
                seg.append("materiali: " + ", ".join(
                    f"{m['quantity']}× {names.type(m['typeID'])}" for m in act["materials"][:20]))
            if act.get("skills"):
                seg.append("skill: " + ", ".join(
                    f"{names.type(s['typeID'])} {s['level']}" for s in act["skills"]))
            if len(seg) > 1:
                lines.append(" — ".join(seg))
        yield Document(id=f"sde:blueprint:{tid}", type="blueprint", title=names.type(tid),
                       text="\n".join(lines), source="ccp_sde",
                       metadata={"typeID": tid, "category": "Blueprint",
                                 "maxRuns": bp.get("maxProductionLimit")})


def _fmt_time(seconds: int) -> str:
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m"
    h, rem = divmod(seconds, 3600)
    return f"{h}h{rem // 60:02d}m"
