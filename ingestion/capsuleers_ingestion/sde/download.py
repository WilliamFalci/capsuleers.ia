"""Download the official Fenris Creations SDE in JSON Lines format (2025 rework).

The current build number is in the record keyed 'sde' in latest.jsonl; the
versioned zip is downloaded and extracted into CONFIG.sde_dir.
"""

from __future__ import annotations

import json
import urllib.request
import zipfile
from pathlib import Path

from ..config import CONFIG, DATA_DIR

USER_AGENT = "Capsuleers.IA/0.1 (dedodj@gmail.com)"


def latest_build() -> int:
    """Return the build number of the most recent official SDE."""
    req = urllib.request.Request(CONFIG.sde_latest_url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as r:
        for line in r.read().decode("utf-8").splitlines():
            rec = json.loads(line)
            if rec.get("_key") == "sde":
                return int(rec["buildNumber"])
    raise RuntimeError("Build number 'sde' non trovato in latest.jsonl")


def download_sde_jsonl(build: int | None = None) -> str:
    """Download and extract the official JSONL zip. Returns the extracted folder."""
    build = build or latest_build()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    zip_path = DATA_DIR / f"sde_official_{build}.zip"
    out_dir = Path(CONFIG.sde_dir)

    url = CONFIG.sde_zip_pattern.format(build=build)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=300) as resp, open(zip_path, "wb") as f:
        while chunk := resp.read(1 << 20):
            f.write(chunk)

    out_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(out_dir)
    return str(out_dir)
