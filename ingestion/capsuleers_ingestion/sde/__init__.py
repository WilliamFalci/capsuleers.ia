"""Full parsing of the OFFICIAL Fenris Creations SDE (JSONL): covers everything as Documents.

Domains:
  - parse_types     : every published type (ships, modules, skills, ...)
  - parse_universe  : regions, constellations, solar systems
  - parse_industry  : blueprints (manufacturing/research/invention/reactions)
  - parse_dogma     : effects, attributes, units, market groups
  - parse_social    : factions, races, bloodlines, ancestries, NPC corps, NPC characters
  - parse_facilities: stations, PI schematics, certificates
  - parse_sites     : sites/anomalies/deadspace (dungeons, with DED rating)
"""

from __future__ import annotations

from collections.abc import Iterator

from ..models import Document
from .common import Names
from .dogma import parse_dogma
from .facilities import parse_facilities
from .industry import parse_industry
from .parse import parse_types
from .sites import parse_sites
from .social import parse_social
from .source import Sde
from .universe import parse_universe


def parse_all(sde_dir: str) -> Iterator[Document]:
    """Iterate over ALL Documents from the official SDE extracted into `sde_dir`."""
    sde = Sde(sde_dir)
    names = Names(sde)
    yield from parse_types(sde, names)
    yield from parse_universe(sde, names)
    yield from parse_industry(sde, names)
    yield from parse_dogma(sde, names)
    yield from parse_social(sde, names)
    yield from parse_facilities(sde, names)
    yield from parse_sites(sde, names)
