# Capsuleers.IA — Ingestion pipeline

Transforms EVE Online data sources into vectors indexed on Qdrant.

## Flow

```
download → parse → chunk → embed → index
  SDE      model     text    bge-m3   Qdrant
  Wiki     unified   +meta   (Ollama)
```

## Commands

```bash
python -m capsuleers_ingestion.run --all          # full pipeline
python -m capsuleers_ingestion.run --sde          # SDE only
python -m capsuleers_ingestion.run --wiki         # EVE Uni Wiki only
python -m capsuleers_ingestion.run --reindex      # re-embed + re-index without re-downloading
```

## Modules

- `config.py` — configuration from `.env`.
- `sde/source.py` — loader for the official Fenris Creations SDE JSONL files (`_key`, localized fields).
- `sde/download.py` — finds the current build (latest.jsonl) and downloads/extracts the official JSONL zip.
- `sde/parse.py` + `universe/industry/dogma/social/facilities.py` — build the Documents
  for each domain (skills, ships, modules, attributes/dogma, requirements, bonuses, universe, etc.).
- `update.py` — daily check (build number) and zero-downtime re-index (see `ops/`).
- `wiki/scrape.py` — MediaWiki crawler for the EVE University Wiki (rate-limited, CC-BY-SA → preserves attribution).
- `chunk.py` — chunking + metadata enrichment (`type`, `category`, `group`, `source`, `url`).
- `embed.py` — embeddings via Ollama (bge-m3).
- `index.py` — creates the collection and upserts the points into Qdrant.
- `run.py` — CLI orchestrator.

The current state is a **skeleton**: each module has the structure and `TODO`s with the logic to be implemented.
