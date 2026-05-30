"""Unified data model: everything we index becomes a Document."""

from __future__ import annotations

from dataclasses import dataclass, field

# `type` is a free-form string to cover the entire SDE. Values used:
#   item, ship, module, skill, blueprint, effect, attribute, unit, activity,
#   marketgroup, region, constellation, system, faction, race, bloodline,
#   ancestry, corporation, agent, station, schematic, certificate, term, guide
DocType = str


@dataclass
class Document:
    """Knowledge unit ready for chunking/embedding.

    `text` is what gets embedded and shown as context to the model.
    `metadata` feeds Qdrant's filters (e.g. type=skill) and the citations.
    """

    id: str                      # stable id, e.g. "sde:type:587" or "wiki:Warp_Scrambler"
    type: DocType
    title: str
    text: str
    source: str                  # "sde" | "fuzzwork" | "eve_university_wiki"
    url: str | None = None       # for citation (mandatory for the CC-BY-SA wiki)
    metadata: dict = field(default_factory=dict)  # category, group, typeID, license...
