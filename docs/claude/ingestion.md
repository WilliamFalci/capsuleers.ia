# Ingestion (data factory Python), distribuzione dell'indice, fonti e licenze

Leggi se tocchi `ingestion/`, `ops/`, il manifest degli asset o le fonti del RAG. Flussi completi: `RUNNING.md`, `RELEASING.md`, `ingestion/README.md`, `ops/README.md`; fonti: `docs/data-sources.md`, `THIRD_PARTY.md`.

## Comandi (dettaglio)

```bash
# Data factory (ingestion/) — offline, needs Qdrant + Ollama only for the index step
cd ingestion
python3 -m venv .venv && . .venv/bin/activate && pip install -e .
python -m capsuleers_ingestion.run --sde   --dump data/docs_sde.jsonl   # SDE → chunks
python -m capsuleers_ingestion.run --wiki  --dump data/docs_wiki.jsonl  # all MediaWiki sources (~40 min)
python -m capsuleers_ingestion.run --names-index data/names_index.json  # name→typeID (price lookups)
python -m capsuleers_ingestion.run --from-dump data/docs_sde.jsonl      # index into Qdrant
python -m capsuleers_ingestion.update                                   # daily SDE build check + zero-downtime re-index
```

## Data / asset model
- [`desktop/src/assets-manifest.json`](../../desktop/src/assets-manifest.json) declares the release-artifact
  files (`index.vec`, `index.meta.jsonl`, `names_index.json`) with size + sha256. On first launch the
  app downloads them (plus the embedding model + a chat model) into userData. `refreshDataFiles()`
  re-downloads any file whose size drifts from the manifest, so installs pick up new data without a
  reinstall — the big vector index is untouched when unchanged.
- The index is released separately on GitHub Releases (tag `index-<version>`); the installer is "lite"
  (code only). See [`RELEASING.md`](../../RELEASING.md).

## Ingestion (Python data factory)

[`ingestion/capsuleers_ingestion/`](../../ingestion/capsuleers_ingestion/): `run.py` (CLI), `update.py`
(daily SDE build-number check + zero-downtime Qdrant alias swap), plus four **incremental**
auto-updaters that re-index changed docs **in place** on the live collection (NOT via update.py's
SDE-only swap, which would drop wiki/missions):
- `wiki_update.py` — `recentchanges` API watermark (per-source: `wiki_state.json` for EVE Uni, `wiki_state_<key>.json` for the others) → re-index changed pages across every wiki in [`wiki/sources.py`](../../ingestion/capsuleers_ingestion/wiki/sources.py) (EVE University + EVE Sister Core Scanner Probe Fandom wiki).
- `missions_update.py` — content-hash diff (`missions_state.json`) for eve-survival (Wikka wiki,
  no API) → re-index changed / drop removed.
- `wormhole_update.py` — `wormhole.json` file-hash (`wormhole_state.json`) → re-index only the
  affected J-space system Documents (new ∪ previous key-set, so removed effects get cleared).
- `ccp_update.py` — the CCP first-party sources (**L1**), four PROVIDERS in
  [`ccp/`](../../ingestion/capsuleers_ingestion/ccp/): `news` (patch notes + dev blogs since 2019, from
  eveonline.com's Contentful archive via the public CDA token the site ships to every browser),
  `support` (support.eveonline.com, Zendesk Help Center API, ~310 articles, bodies in the listing),
  `academy` (EVE Academy pages, same Contentful space) and `devdocs` (only `docs/guides/**` of
  `esi/esi-docs` — formulae, security rounding, fitting formats, PI, SKINR; not the ESI/SSO docs).
  The same registry also holds `articles` ([`capsuleers_app/articles.py`](../../ingestion/capsuleers_ingestion/capsuleers_app/articles.py)):
  capsuleers.app's community articles from the site's public `/api/articles` (bodies + `updated_at`
  in the listing), EN and IT both indexed with their localised URLs, `source=capsuleers_articles`
  → **L3, dated** (no retrieval nudge) like CCP news. Being in the registry is what makes
  `ccp_update` / `run --ccp` — and so `rag-check`/`rag-publish` — pick it up with no extra wiring;
  the tier comes from `source`, not from the registry.
  Each provider LISTS items with a version stamp and no body (Contentful `sys.publishedAt`, Zendesk
  `updated_at`, git blob sha), so `--check` is a handful of requests and only changed items are
  fetched. `ccp_state.json` keeps the Document ids PER ITEM, because an item becomes many Documents
  and their count changes as it grows (patch notes are edited at every hotfix). After a full rebuild,
  `--seed-from-dump` rebuilds that state from the dump (each Document carries `ccp_provider`,
  `ccp_item`, `ccp_stamp`). Offline tests: `ingestion/tests/test_ccp.py`.
  **Every item is cut at its h2/h3 into ~700-char Documents** (`PIECE` in `ccp/common.py`), title =
  item (+ DATE for news) + section path without repeated segments, no header line. Measured, not tuned
  by eye: a patch-note section is a list of unrelated changes, and on the 19.11 "Ecosystem" section
  the query "when were ore quantities in asteroid belts doubled?" scored cosine 0.38 on a 1 360-char
  block with header, 0.63 on 300 chars. With the index + all 7 480 CCP chunks, 7 of 9 targeted test
  questions put the right CCP chunk in top-12 (the other two at 13 and 16).
  A blockquote heading ("> ## Developer Comment:") is a line, not a section — promoted, it
  replaced the real path on every section after it. **EVE Academy URLs are discovered, not derived**:
  the site answers 200 to any /eve-academy path (a ~37 KB not-found shell), so each page probes a few
  candidates and accepts only a real render; 21 of 76 pages have a URL, the rest (ship primers,
  activity cards) are cited with the Academy home.
All four purge a doc's old chunks via `index.delete_by_doc_ids` before re-insert.
**An SDE bump forces a FULL rebuild (~25 min, wiki + missions re-crawled), and one failed
wiki fetch aborts all of it.** `wiki/api.py::api_get` retries 6× with 1-2-4-8-16 s backoff
(~1.5 min window). It was 3× over ~3 s until 2026-09-23, when a single EVE Uni blip
(`titles=Oracle`) killed the rebuild for SDE 3528119 and the published index stayed on 3503375
while `rag-check` kept reporting the new build as "seen". After an SDE bump, check that an
`index-<date>` release actually shipped — a green `rag-check` only means it was *detected*.
`sde/*` (per-domain parsers: `parse`, `dogma`, `universe`, `industry`, `social`, `facilities`,
`sites`, `wormholes`), `wiki/` (`api` shared client, `scrape` full+per-title crawler,
`recentchanges` detector; rate-limited, CC-BY-SA), `missions/eve_survival.py` (full + per-name
`scrape_named`), `chunk.py`, `embed.py` (Ollama bge-m3), `index.py` (Qdrant). Embedding cache
(`embed_cache.sqlite`) means any update only re-embeds changed documents. Timers + the index
publish step live in [`ops/`](../../ops/) (elenco reale: `ls ops/`; oggi `update.sh`, `wiki-update.sh`, `wormhole-update.sh`, `missions-update.sh`, `publish-index.sh`, `start.sh` + unit systemd).
Le unit `*.service` puntano a `%h/Documenti/WORK/CAPSULEERS/capsuleers.ia/ops/` (percorso corretto il 2026-10-16; prima era il vecchio `Capsuleers.IA`).

## Data sources & licensing
Official SDE (authoritative), capsuleers.app community articles (the project's own site), EVE University Wiki (**CC BY-NC-SA 4.0** → the knowledge index is
effectively **non-commercial**), EVE Sister Core Scanner Probe Fandom wiki (CC BY-SA, German — exploration
sites), EVE Wiki on Fandom (CC BY-SA, EN), Riley Entertainment guides (no explicit licence — opt-in
`--riley`, never in `--all`), eve-survival (missions), Anoikis (wormhole effects/statics), EVE Ref
(prices), ESI, eve-kill (killboard + MCP), EVE-Scout. Source code is MIT; GGUF models keep their own
licenses and are not redistributed. See [`THIRD_PARTY.md`](../../THIRD_PARTY.md). Unofficial, non-commercial
fan project — not affiliated with Fenris Creations.
