"""Helpers shared across the SDE parsers: text cleanup, formatting, name resolvers."""

from __future__ import annotations

import html
import re

from .source import Sde, en

_TAG_RE = re.compile(r"<[^>]+>")


def clean(text) -> str:
    """Strip HTML tags (e.g. <a href=showinfo:...>) and normalize whitespace.

    Accepts both plain strings and localized fields {lang: str}.
    """
    text = en(text)
    if not text:
        return ""
    return re.sub(r"\s+", " ", html.unescape(_TAG_RE.sub(" ", text))).strip()


def fmt_num(value) -> str:
    """Format an SDE numeric value (integers without decimals) as a compact string."""
    if value is None:
        return ""
    if isinstance(value, float):
        if value.is_integer():
            return str(int(value))
        return f"{round(value, 3):g}"
    return str(value)


class Names:
    """ID → name resolver for types and groups, from the official SDE."""

    def __init__(self, sde: Sde) -> None:
        self.type_name = {k: en(r.get("name")) for k, r in sde.by_key("types").items()}
        self.group_name = {k: en(r.get("name")) for k, r in sde.by_key("groups").items()}

    def type(self, type_id: int | None) -> str:
        if not type_id:
            return ""
        return self.type_name.get(type_id, f"typeID {type_id}")

    def group(self, group_id: int | None) -> str:
        if not group_id:
            return ""
        return self.group_name.get(group_id, f"groupID {group_id}")


def security_class(sec: float | None) -> str:
    """Classify the security status of a solar system."""
    if sec is None:
        return "sconosciuta"
    if sec >= 0.45:
        return "high-sec"
    if sec > 0.0:
        return "low-sec"
    return "null-sec"
