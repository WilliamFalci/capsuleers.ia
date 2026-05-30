"""Centralized configuration, read from environment variables / .env."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

try:
    from dotenv import load_dotenv
    # Load the .env from the project root (../.env relative to ingestion/).
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
except ModuleNotFoundError:
    # python-dotenv is optional: without .env the defaults / env vars are used.
    pass

DATA_DIR = Path(__file__).resolve().parents[1] / "data"


@dataclass(frozen=True)
class Config:
    qdrant_url: str = os.getenv("QDRANT_URL", "http://localhost:6333")
    ollama_url: str = os.getenv("OLLAMA_URL", "http://localhost:11434")
    embed_model: str = os.getenv("EMBED_MODEL", "bge-m3")
    embed_dim: int = int(os.getenv("EMBED_DIM", "1024"))
    collection: str = os.getenv("QDRANT_COLLECTION", "eve_knowledge")

    # SDE source: official Fenris Creations in JSON Lines.
    sde_latest_url: str = "https://developers.eveonline.com/static-data/tranquility/latest.jsonl"
    sde_zip_pattern: str = (
        "https://developers.eveonline.com/static-data/tranquility/"
        "eve-online-static-data-{build}-jsonl.zip"
    )
    sde_dir: str = str(DATA_DIR / "sde_official")  # folder with the extracted JSONL files

    wiki_api_url: str = "https://wiki.eveuniversity.org/api.php"

    # Wormhole data (system effects + statics) — Anoikis source.
    wormhole_url: str = "https://anoikis.info/share/wormhole.json"
    wormhole_file: str = str(DATA_DIR / "wormhole.json")


CONFIG = Config()
