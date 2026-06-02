"""Wormhole data (Anoikis): system effect and static connections for each
J-space system. Enrich the Documents of wormhole systems.

Source: https://anoikis.info/share/wormhole.json
  { "systemEffects": {"J123456": "Pulsar", ...},
    "systemStatics": {"J123456": ["Q003","Z006"], ...} }
"""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path

from ..config import CONFIG, USER_AGENT


def download_wormhole_data() -> str:
    """Download Anoikis' wormhole.json into CONFIG.wormhole_file. Returns the path."""
    req = urllib.request.Request(CONFIG.wormhole_url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    path = Path(CONFIG.wormhole_file)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return str(path)


def load_wormhole_data() -> dict:
    """Load the wormhole data if present on disk (otherwise an empty dict)."""
    path = Path(CONFIG.wormhole_file)
    if not path.exists():
        return {"systemEffects": {}, "systemStatics": {}}
    return json.loads(path.read_text(encoding="utf-8"))
