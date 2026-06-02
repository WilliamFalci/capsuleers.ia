"""Incremental auto-update of the Anoikis wormhole data (J-space system effects +
static connections).

`wormhole.json` is a single community-mined file that enriches the SDE solar-system
Documents (see sde/universe.py). Detection is a **file hash**: if it changed, we
re-parse the universe and re-index ONLY the affected J-space system Documents IN
PLACE on the live collection — the systems present in the new data PLUS the ones
that were in the previous data (so a removed effect/static gets cleared). SDE/wiki/
mission content is untouched; embeddings run only for the changed system texts.

This deliberately does NOT go through the SDE rebuild (update.py), which swaps in a
fresh SDE-only collection and would drop wiki/missions.

Usage:
    python -m capsuleers_ingestion.wormhole_update --check
    python -m capsuleers_ingestion.wormhole_update
    python -m capsuleers_ingestion.wormhole_update --force
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import sys
from pathlib import Path

from .chunk import chunk_documents
from .config import CONFIG, DATA_DIR

STATE_FILE = DATA_DIR / "wormhole_state.json"


def local_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {}


def save_state(sha: str, keys: set[str]) -> None:
    STATE_FILE.write_text(json.dumps({
        "sha": sha, "keys": sorted(keys),
        "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }, indent=2))


def _refresh_and_hash() -> tuple[str, set[str]]:
    """Downloads the latest wormhole.json and returns (sha256, J-space system keys)."""
    from .sde.wormholes import download_wormhole_data, load_wormhole_data
    download_wormhole_data()
    sha = hashlib.sha256(Path(CONFIG.wormhole_file).read_bytes()).hexdigest()
    wh = load_wormhole_data()
    keys = set(wh.get("systemEffects", {})) | set(wh.get("systemStatics", {}))
    return sha, keys


def check(force: bool = False) -> tuple[bool, str, set[str], set[str]]:
    """Returns (changed, new_sha, new_keys, old_keys)."""
    sha, keys = _refresh_and_hash()
    st = local_state()
    changed = force or sha != st.get("sha")
    return changed, sha, keys, set(st.get("keys", []))


def _ensure_sde_dir() -> str:
    if Path(CONFIG.sde_dir).is_dir() and any(Path(CONFIG.sde_dir).iterdir()):
        return CONFIG.sde_dir
    from .sde.download import download_sde_jsonl
    print("SDE non estratto localmente: lo scarico…")
    return download_sde_jsonl()


def run_update(force: bool = False) -> None:
    changed, sha, new_keys, old_keys = check(force=force)
    if not changed:
        print(f"Wormhole già aggiornato ({len(new_keys)} sistemi J-space, hash invariato).")
        save_state(sha, new_keys)  # fill/refresh state on first run
        return

    affected = old_keys | new_keys  # new systems + ones that may have lost effect/statics
    print(f"wormhole.json cambiato: {len(new_keys)} sistemi correnti, "
          f"{len(affected)} da re-indicizzare.")

    from .sde import parse_all  # noqa: F401  (ensures package import side-effects)
    from .sde.common import Names
    from .sde.source import Sde
    from .sde.universe import parse_universe
    sde_dir = _ensure_sde_dir()
    sde = Sde(sde_dir)
    docs = [d for d in parse_universe(sde, Names(sde))
            if d.metadata.get("solarSystemID") is not None and d.title in affected]

    from .embedcache import EmbedCache
    from .index import delete_by_doc_ids, get_client, index_chunks, resolve_collection
    client = get_client()
    collection = resolve_collection(client, CONFIG.collection)
    delete_by_doc_ids(client, [d.id for d in docs], collection=collection)
    cache = EmbedCache(DATA_DIR / "embed_cache.sqlite")
    reindexed = index_chunks(client, chunk_documents(docs), collection=collection, cache=cache)
    cache.close()

    save_state(sha, new_keys)
    print(f"Fatto: {len(docs)} sistemi J-space re-indicizzati ({reindexed} chunk), "
          f"collection '{collection}'.")
    print("NB: l'indice flat del desktop si rigenera/pubblica con ops/publish-index.sh.")


def main() -> None:
    ap = argparse.ArgumentParser(description="Aggiornamento incrementale dati wormhole (Anoikis)")
    ap.add_argument("--check", action="store_true", help="solo controllo (exit 0=invariato, 1=cambiato)")
    ap.add_argument("--force", action="store_true", help="re-indicizza anche se l'hash è invariato")
    args = ap.parse_args()

    if args.check:
        changed, _sha, new_keys, old_keys = check(force=args.force)
        if changed:
            print(f"wormhole.json CAMBIATO: {len(new_keys)} sistemi correnti "
                  f"(prima {len(old_keys)}).")
            sys.exit(1)
        print(f"wormhole.json invariato ({len(new_keys)} sistemi J-space).")
        sys.exit(0)

    run_update(force=args.force)


if __name__ == "__main__":
    main()
