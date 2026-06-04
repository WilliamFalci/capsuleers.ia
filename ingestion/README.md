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
python -m capsuleers_ingestion.run --wiki         # all registered MediaWiki sources
python -m capsuleers_ingestion.run --wiki --wiki-source sistersprobe   # one wiki only
python -m capsuleers_ingestion.run --riley        # Riley Entertainment guides (opt-in; not in --all)
python -m capsuleers_ingestion.run --reindex      # re-embed + re-index without re-downloading
python -m capsuleers_ingestion.wiki_update        # incremental wiki update (recentchanges → re-index changed pages, all wikis)
python -m capsuleers_ingestion.missions_update    # incremental missions update (content-hash → re-index changed)
python -m capsuleers_ingestion.wormhole_update    # incremental wormhole update (file hash → re-index J-space systems)
```

## Modules

- `config.py` — configuration from `.env`.
- `sde/source.py` — loader for the official Fenris Creations SDE JSONL files (`_key`, localized fields).
- `sde/download.py` — finds the current build (latest.jsonl) and downloads/extracts the official JSONL zip.
- `sde/parse.py` + `universe/industry/dogma/social/facilities.py` — build the Documents
  for each domain (skills, ships, modules, attributes/dogma, requirements, bonuses, universe, etc.).
- `update.py` — daily SDE check (build number) and zero-downtime re-index (see `ops/`).
- `wiki_update.py` — daily **incremental** wiki update over **every** registered wiki:
  detects changed pages via the MediaWiki `recentchanges` API (per-source watermark —
  `wiki_state.json` for EVE Uni, `wiki_state_<key>.json` for the others) and re-indexes only those.
- `wiki/sources.py` — registry of crawled MediaWiki installs (`WIKI_SOURCES`): EVE University
  Wiki + EVE Sister Core Scanner Probe Wiki (Fandom, DE) + EVE Wiki (Fandom, EN). Each `WikiSource`
  carries its api.php, page-URL prefix, doc-id namespace, licence and `fetch_mode` (`extracts` vs
  `parse_html`).
- `wiki/api.py` — shared MediaWiki API client (`api_get`, `page_url`, `doc_id`), source-parameterised.
- `wiki/scrape.py` — MediaWiki crawler (full crawl + per-title `scrape_titles`; rate-limited,
  preserves attribution). Two extraction paths: TextExtracts (EVE Uni) and `action=parse` HTML→text
  (Fandom, which has no TextExtracts).
- `wiki/recentchanges.py` — `changed_titles_since(source, …)` (the structured `Special:RecentChanges`).
- `htmltext.py` — shared, stdlib-only HTML→plain-text extractor (`html_to_text`); used by the Fandom
  `action=parse` path and the static-site scrapers in `web/`.
- `web/riley.py` — bounded BFS crawler for Riley Entertainment's static EVE guides
  (`riley-entertainment.com/gaming/eve-online`). Opt-in (`--riley`): no explicit licence, so it is
  never part of `--all`.
- `missions_update.py` — daily/weekly **incremental** missions update: content-hash diff
  (`missions_state.json`), re-indexes only changed pages, drops removed ones.
- `wormhole_update.py` — **incremental** Anoikis update: `wormhole.json` file-hash →
  re-index only the affected J-space system Documents in place (`wormhole_state.json`).
- `missions/eve_survival.py` — Wikka-wiki scraper (full crawl + per-name `scrape_named`).
- `chunk.py` — chunking + metadata enrichment (`type`, `category`, `group`, `source`, `url`).
- `embed.py` — embeddings via Ollama (bge-m3).
- `index.py` — creates the collection and upserts the points into Qdrant.
- `run.py` — CLI orchestrator.

The current state is a **skeleton**: each module has the structure and `TODO`s with the logic to be implemented.
