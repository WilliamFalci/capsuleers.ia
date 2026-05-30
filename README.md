# Capsuleers.IA

An expert AI assistant for **EVE Online** (skills, fitting, terminology, PVE missions,
wormholes, sovereignty, mining…) delivered as a **standalone desktop app**, cross-platform,
**100% local** and **GPU-accelerated**.

**RAG** (Retrieval-Augmented Generation) architecture: EVE knowledge is
indexed and, for every question, the relevant pieces are retrieved and passed to a
local LLM that answers while citing its sources.

## Two parts

```
  DATA FACTORY (build-time, Python)               APP (runtime, Electron + Node)
  ┌────────────────────────────────┐             ┌──────────────────────────────┐
  │ Official Fenris Creations SDE (JSONL)        │             │  Chat UI (sci-fi, tray, mini) │
  │ EVE University Wiki (CC-BY-SA)  │   produces  │            │                  │
  │ eve-survival (missions)         │  ────────►  │       engine.mjs              │
  │  → parse/scrape → chunk → embed │   index +   │  node-llama-cpp (GPU Vulkan/  │
  │  → index.vec + meta + lookup    │   models    │   Metal/CUDA) + in-RAM index  │
  └────────────────────────────────┘             └──────────────────────────────┘
```

- **App** ([`desktop/`](desktop/)): Electron + `node-llama-cpp`. No server, no
  Qdrant/Ollama, no Python at runtime. Includes retrieval, generation, **fit
  analysis (All V)**, **live prices**, and **conversational follow-ups**.
- **Data factory** ([`ingestion/`](ingestion/)): a Python pipeline run **offline**
  (by whoever builds the app) to generate the knowledge base and keep it up to date (SDE).

## Stack

| Component | Technology |
|---|---|
| App / UI | Electron + HTML/JS |
| Inference (LLM + embeddings) | `node-llama-cpp` — GPU **Vulkan/Metal/CUDA**, CPU fallback |
| Model | Mistral-Nemo 12B (Q4) · bge-m3 embeddings (Q8) |
| Index | in-RAM vectors (cosine), no DB |
| Data factory | Python (SDE parsing, wiki/mission scraping) |

## Data sources

- **Official Fenris Creations SDE** (JSON Lines) — skills, ships, modules, dogma, universe, industry,
  blueprints, sites/anomalies, lore. Authoritative source.
- **EVE University Wiki** (**CC BY-NC-SA 4.0**, non-commercial) — mechanics, terminology, mining, exploration.
- **eve-survival.org** — PVE mission guides *(license not explicitly stated: see the note in
  [`ingestion`](ingestion/capsuleers_ingestion/missions/eve_survival.py))*.
- **Anoikis** (wormhole effects/statics) · **EVE Ref** (live prices).

## Quick start (app)

```bash
cd desktop
npm install
# GGUF models + index: see desktop/README.md (npm run export-index / build-index)
npm start
```

Full guide: [`desktop/README.md`](desktop/README.md).
Regenerate/update the knowledge base: [`ingestion/README.md`](ingestion/README.md).

## Structure

- [`desktop/`](desktop/) — the standalone app (Electron + GPU RAG engine).
- [`ingestion/`](ingestion/) — Python data factory (SDE, wiki, missions, lookup, auto-update).
- [`docs/`](docs/) — architecture notes and data sources.

> Note: the old web API (Fastify) has been removed: the project is now **standalone-first**.
> Qdrant/Ollama remain optional only as a build backend (as an alternative to `build-index.mjs`).

## License

- **Source code**: [MIT](LICENSE).
- **Knowledge base index** (release artifact, not included in the repo):
  effectively **non-commercial** because it also derives from **CC BY-NC-SA 4.0**
  content (EVE University Wiki). See [`THIRD_PARTY.md`](THIRD_PARTY.md).
- **GGUF models**: downloaded at runtime, each under its own license
  (Apache-2.0 / MIT). They are not redistributed by this repo.

Full attributions and third-party notices: [`THIRD_PARTY.md`](THIRD_PARTY.md).

## Disclaimer

> EVE Online and the EVE logo are the registered trademarks of Fenris Creations. All rights
> reserved worldwide. All other trademarks are the property of their respective
> owners. All EVE Online related materials are the intellectual property of Fenris Creations.
> Fenris Creations does not endorse, and is in no way affiliated with, Capsuleers.IA, and is
> not responsible for the content or functioning of this software.

Capsuleers.IA is an **unofficial, non-commercial fan-made project**.
