# Capsuleers.IA

An expert AI assistant for **EVE Online** — a **standalone desktop app**, cross-platform,
**100% local** and **GPU-accelerated**. Ask about skills, fitting, terminology, PVE
missions, wormholes, sovereignty, exploration, industry and more, and get answers
**with cited sources**, in Italian or English (auto-detected).

It runs entirely on your machine: a local LLM (via `node-llama-cpp`) answers using a
**RAG** (Retrieval-Augmented Generation) index of EVE knowledge. No data leaves the
computer, except optional lookups to public EVE APIs for the live-data features.

## Download

Grab the installer for your OS from the [**Releases**](../../releases/latest):

- **Windows** — `Capsuleers.IA-Setup-<version>.exe` (NSIS installer)
- **Linux** — `Capsuleers.IA-<version>.AppImage`

The installer is **lite** (code only). On first launch the app downloads, once, the
embedding model + the EVE knowledge index and a chat model of your choice (you can
change/add/remove models later). Updates are delivered automatically (electron-updater).

> No macOS build yet (it needs Apple notarization). Building from source works on macOS.

## What it does

- **Q&A on EVE** — skills, fitting, ships/modules, missions, wormholes, sovereignty,
  anomalies, exploration, incursions, planetary interaction, factional warfare… with
  the sources it used.
- **Fit analysis** — paste an EFT fit and get All-V validation (CPU/PG/slots) plus
  estimated **DPS, EHP, speed, cap stability**, whether the fit **uses the ship's
  bonuses**, and short **theorycrafting** on the role (PvP/PvE, strengths/weaknesses).
  Add `precise` on its own line for exact server-computed stats (eve-kill dogma engine).
- **Live prices** (EVE Ref) — "how much is a Caracal?", total cost of a material list.
- **Pilot intel** (eve-kill killboard) — "who is `<pilot/corp/alliance>`?" → kills,
  losses, PvP stats; **leadership** and **system activity** via official ESI.
- **PvP analytics** (eve-kill MCP) — relationships and fights from the killboard:
  "who flies with `<pilot>`", "who hunts `<pilot>`", "`<X>` vs `<Y>`", **safe routes**
  ("safe route from Jita to Amarr"), **recent battles**, the **current meta/doctrines**,
  most expensive kills, and **killmail** story/forensics from a zKillboard link.
- **Local intel from the clipboard** — copy the Local in EVE (Ctrl+A, Ctrl+C) and the
  app shows who's around it, flagging the dangerous ones.
- **Thera/Turnur wormhole connections** (EVE-Scout) — "the Thera connection closest to
  Jita", with the **entry and exit signatures** and jump distance.
- **Model management** — pick/download/delete chat models from an **updatable catalog**,
  filtered to a sensible VRAM range, with a response-time estimate for your GPU.

## Stack

| Component | Technology |
|---|---|
| App / UI | Electron + HTML/JS |
| Inference (LLM + embeddings) | `node-llama-cpp` — GPU **Vulkan/Metal/CUDA**, CPU fallback |
| Chat models | Updatable catalog (Qwen3-4B, Qwen2.5-3B/7B, Mistral-Nemo 12B…), Q4 GGUF |
| Embeddings | bge-m3 (Q8) |
| Index | in-RAM vectors (cosine), no DB |
| Data factory | Python (SDE parsing, wiki/mission scraping) |

## Two parts

```
  DATA FACTORY (build-time, Python)               APP (runtime, Electron + Node)
  ┌────────────────────────────────┐             ┌──────────────────────────────┐
  │ Official SDE (JSONL)            │             │  Chat UI (sci-fi, tray, mini) │
  │ EVE University Wiki (CC-BY-NC-SA)│   produces  │       engine.mjs              │
  │ eve-survival (missions)         │  ────────►  │  node-llama-cpp (GPU Vulkan/  │
  │  → parse/scrape → chunk → embed │  index +    │   Metal/CUDA) + in-RAM index  │
  │  → index.vec + meta + lookup    │  lookups    │  + live EVE APIs (intel/scout)│
  └────────────────────────────────┘             └──────────────────────────────┘
```

- **App** ([`desktop/`](desktop/)): Electron + `node-llama-cpp`. No server, no
  Qdrant/Ollama, no Python at runtime.
- **Data factory** ([`ingestion/`](ingestion/)): a Python pipeline run **offline** (by
  whoever builds the app) to generate the knowledge base and keep it up to date (SDE).

## Data sources

- **Official SDE** (JSON Lines) — skills, ships, modules, dogma, universe, industry,
  blueprints, sites/anomalies, lore. Authoritative source.
- **EVE University Wiki** (**CC BY-NC-SA 4.0**, non-commercial) — mechanics, terminology, mining, exploration.
- **eve-survival.org** — PVE mission guides *(license not explicitly stated: see the note in
  [`ingestion`](ingestion/capsuleers_ingestion/missions/eve_survival.py))*.
- **Anoikis** (wormhole effects/statics) · **EVE Ref** (live prices) · **ESI** (official
  live data) · **eve-kill.com** (killboard + [MCP](https://mcp.eve-kill.com/mcp) analytics) ·
  **EVE-Scout** (Thera/Turnur connections).

## Build from source

```bash
cd desktop
npm install
npm start            # dev (expects models/ and data/ present locally)
npm run dist:linux   # or dist:win — build an installer
```

Developer guides: [`desktop/README.md`](desktop/README.md), release process in
[`RELEASING.md`](RELEASING.md), knowledge base in [`ingestion/README.md`](ingestion/README.md).

## Structure

- [`desktop/`](desktop/) — the standalone app (Electron + GPU RAG engine + live-data features).
- [`ingestion/`](ingestion/) — Python data factory (SDE, wiki, missions, lookup, auto-update).
- [`docs/`](docs/) — architecture notes and data sources.

## License

- **Source code**: [MIT](LICENSE).
- **Knowledge base index** (release artifact, not in the repo): effectively
  **non-commercial** because it also derives from **CC BY-NC-SA 4.0** content (EVE
  University Wiki). See [`THIRD_PARTY.md`](THIRD_PARTY.md).
- **GGUF models**: downloaded at runtime, each under its own license (Apache-2.0 / MIT).
  They are not redistributed by this repo.

Full attributions and third-party notices: [`THIRD_PARTY.md`](THIRD_PARTY.md).

Created by [TremalJack](https://capsuleers.app/character/789877270) with the support of the EVE Online community.

## Disclaimer

> EVE Online and the EVE logo are the registered trademarks of Fenris Creations. All rights
> reserved worldwide. All other trademarks are the property of their respective
> owners. All EVE Online related materials are the intellectual property of Fenris Creations.
> Fenris Creations does not endorse, and is in no way affiliated with, Capsuleers.IA, and is
> not responsible for the content or functioning of this software.

Capsuleers.IA is an **unofficial, non-commercial fan-made project**.
