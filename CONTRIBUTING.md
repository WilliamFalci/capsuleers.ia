# Contributing to Capsuleers.IA

Thanks for wanting to help! This is the **step-by-step guide for contributors**: how the
project is laid out, how to set up a dev environment, what every internal command does, and
the conventions to follow. Read it once end-to-end before your first PR.

> Companion docs: [`README.md`](README.md) (product overview), [`CLAUDE.md`](CLAUDE.md)
> (architecture for AI/automation), [`RUNNING.md`](RUNNING.md) (run from scratch),
> [`RELEASING.md`](RELEASING.md) (cut a release), and the per-area READMEs in
> [`desktop/`](desktop/README.md), [`ingestion/`](ingestion/README.md), [`ops/`](ops/README.md),
> [`eval/`](eval/README.md). This file is the **map**; those are the detail.

---

## 1. What you'll be working on

Capsuleers.IA is a **standalone, 100% local, GPU-accelerated desktop AI** for EVE Online. It
answers questions with cited sources using **RAG** (retrieval over a prebuilt knowledge index +
a local LLM). The repo has **two independent parts** — pick the one your change touches:

| Part | Path | Stack | When you touch it |
|---|---|---|---|
| **App** (the product) | [`desktop/`](desktop/) | Electron + Node + `node-llama-cpp` | UI, RAG engine, fit analysis, live-data features (intel, prices, scout, MCP), packaging |
| **Data factory** (build-time) | [`ingestion/`](ingestion/) | Python | The knowledge index: SDE/wiki/mission parsing, chunking, embedding, Qdrant indexing |
| **Ops** | [`ops/`](ops/) | Bash + systemd | Local infra (Qdrant/Ollama) + the scheduled SDE auto-update |
| **Eval** | [`eval/`](eval/) | Python | Golden-question accuracy harness |

The **end-user app never runs Python, Qdrant or Ollama** — those are only used to *build* the
index, which is then shipped as a release artifact. So a desktop-only contributor needs none of
the Python/Docker stack.

---

## 2. Prerequisites

- **Node.js 22** (matches CI) + npm — for everything under `desktop/`.
- **A GPU is recommended** for the app: Vulkan (AMD/Intel), Metal (Apple), or CUDA (NVIDIA).
  CPU fallback works but is slow. Validated on RX 6700 XT (Vulkan): ~1.5 s/response.
- **Python 3.11+** — only if you touch `ingestion/` or `eval/`.
- **podman or docker** — only if you need to run the indexing infra locally (Qdrant + Ollama).
  [`ops/start.sh`](ops/start.sh) auto-detects podman first, then docker, and auto-configures the
  GPU (NVIDIA/AMD/CPU).
- **git** + a GitHub account.

### What is NOT in the repo (gitignored — see [`.gitignore`](.gitignore))

`models/` (GGUF weights), `data/` (the index + dumps + caches), `*.gguf`, `*.jsonl`, `*.sqlite`,
`.env`, `node_modules/`, `desktop/dist/`. You download or generate these locally; never commit them.

---

## 3. Clone & first build (desktop app)

This is the most common contribution path.

```bash
git clone git@github.com:WilliamFalci/capsuleers.ia.git
cd capsuleers.ia/desktop
npm install            # node-llama-cpp's postinstall pulls the GPU native binaries
```

You need two things present locally before `npm start`: the **GGUF models** and the **index**.

```bash
# 1) GGUF models → ./desktop/models/
npx node-llama-cpp pull --dir ./models "https://huggingface.co/bartowski/Mistral-Nemo-Instruct-2407-GGUF/resolve/main/Mistral-Nemo-Instruct-2407-Q4_K_M.gguf"
npx node-llama-cpp pull --dir ./models "https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q8_0.gguf"

# 2) Index → ./desktop/data/  (two options)
python3 export_index.py     # fast — export vectors from an already-populated Qdrant
# or
node build-index.mjs        # standalone — re-embed the JSONL dumps with the bge-m3 GGUF (slow, one-time)

# 3) Launch
npm start
```

> If you only have a release available, you can also grab the published `index.vec` /
> `index.meta.jsonl` / `names_index.json` from a GitHub `index-*` release into `desktop/data/`.

**Quick CLI smoke test (no GUI):**

```bash
node rag.mjs "Quali skill servono per un Caracal?"
node test-gpu.mjs            # confirm GPU offload is working
```

---

## 4. Desktop internal commands

Run from `desktop/` (`npm run <script>`):

| Command | What it does |
|---|---|
| `npm start` | Launch the Electron app in dev (`electron .`). Expects `models/` + `data/`. |
| `node rag.mjs "<question>"` | Headless RAG query — fastest way to test engine changes. |
| `node test-gpu.mjs` | Verify `node-llama-cpp` GPU offload. |
| `npm run build-index` | `node build-index.mjs` — rebuild the in-RAM vector index from JSONL dumps + the bge-m3 GGUF. |
| `npm run export-index` | `python3 export_index.py` — export vectors from a populated Qdrant (fast path). |
| `npm run validate-hf` | Check the embedding model + every catalog model still resolve on HuggingFace (`repo`/`file` exist, checksum). Run after editing [`models-catalog.json`](desktop/src/models-catalog.json). |
| `npm run pack` | `electron-builder --dir` — unpacked build (no installer) for fast local packaging checks. |
| `npm run dist:linux:cuda` / `npm run dist:linux:vulkan` | Build the NVIDIA/CUDA or AMD/Vulkan Linux AppImage (`--publish never`). `npm run dist:linux` builds the base/Vulkan-lite variant. |
| `npm run dist:win:cuda` / `npm run dist:win:vulkan` | Build the NVIDIA/CUDA or AMD/Vulkan Windows NSIS installer (`--publish never`). Run **on Windows** — the `win-x64-*` native binaries don't install on Linux. `npm run dist:win` builds the base/Vulkan-lite variant. |
| `npm run dist` | Build for the current platform. |

### Where the runtime logic lives ([`desktop/src/`](desktop/src/))

- [`main.mjs`](desktop/src/main.mjs) — Electron main process: window, tray/mini, IPC, auto-update
  (electron-updater), `refreshDataFiles()` (re-fetches index/data files whose size drifts from the
  manifest).
- [`preload.cjs`](desktop/src/preload.cjs) — the secure renderer↔main bridge.
- [`renderer/index.html`](desktop/src/renderer/index.html) — the chat UI (streaming + sources +
  the bilingual help text).
- [`engine.mjs`](desktop/src/engine.mjs) — **the orchestrator**: `init()` (loads models + index +
  warms the fit engine) and `ask(question, onToken, uiLang)` (fit detection → RAG retrieve → prompt
  → stream).
- [`fit.mjs`](desktop/src/fit.mjs) — EFT parsing + fit analysis (delegates the math to
  `eve-fit-engine`, see §7).
- Live-data: [`prices.mjs`](desktop/src/prices.mjs) (EVE Ref), [`intel.mjs`](desktop/src/intel.mjs)
  (eve-kill killboard), [`esi.mjs`](desktop/src/esi.mjs) (ESI), [`eve-scout.mjs`](desktop/src/eve-scout.mjs)
  (Thera/Turnur), [`mcp.mjs`](desktop/src/mcp.mjs) + [`mcp-intel.mjs`](desktop/src/mcp-intel.mjs)
  (eve-kill MCP), [`clipboard-watch.mjs`](desktop/src/clipboard-watch.mjs) (clipboard scan
  detection: Local roster **or** D-Scan), [`intel-history.mjs`](desktop/src/intel-history.mjs)
  (persisted share-link history), [`links.mjs`](desktop/src/links.mjs) (linkify + language detection).
  Both clipboard scans (Local intel + offline D-Scan composition) can be shared to
  capsuleers.app for a 24h link (`sharePilotIntel`/`shareDScan` in `intel.mjs`).
- [`assets-manifest.json`](desktop/src/assets-manifest.json) — the index/data files the app downloads
  on first run (size + sha256).
- [`models-catalog.json`](desktop/src/models-catalog.json) — the user-selectable chat-model catalog.

---

## 5. The data factory ([`ingestion/`](ingestion/))

Only needed if your change affects the knowledge base. Full from-scratch walkthrough is in
[`RUNNING.md`](RUNNING.md); the short version:

```bash
cd ingestion
python3 -m venv .venv && . .venv/bin/activate
pip install -e .
cp ../.env.example ../.env       # then edit if your Qdrant/Ollama aren't on the defaults
```

The pipeline is **two phases**: *(1)* fetch/parse/chunk (Python only, no infra) → optionally dump to
JSONL; *(2)* embed + index into Qdrant (needs Ollama + Qdrant running — use [`ops/start.sh`](ops/start.sh)).

### `python -m capsuleers_ingestion.run` flags ([`run.py`](ingestion/capsuleers_ingestion/run.py))

| Flag | Effect |
|---|---|
| `--all` | SDE + Wiki + missions. |
| `--sde` | Parse the official SDE only (downloads it if `--sde-dir` not given; also pulls Anoikis wormhole data best-effort). |
| `--wiki` / `--wiki-source KEY` / `--wiki-limit N` | Scrape every registered MediaWiki (EVE University + EVE Sister Core Scanner Probe Fandom wiki — see [`wiki/sources.py`](ingestion/capsuleers_ingestion/wiki/sources.py)), rate-limited. `--wiki-source eveuni\|sistersprobe` restricts to one; `--wiki-limit` caps pages **per source** for a quick test. |
| `--missions` / `--missions-limit N` | Scrape eve-survival mission guides. |
| `--riley` / `--riley-limit N` | Scrape Riley Entertainment's static EVE guides ([`web/riley.py`](ingestion/capsuleers_ingestion/web/riley.py)). **Opt-in** — no explicit licence, so it is **never** part of `--all`. |
| `--sde-dir DIR` | Use an already-extracted SDE JSONL dir (skip the download). |
| `--dump FILE` | Write chunks to JSONL instead of indexing — **no infra needed**. |
| `--from-dump FILE` | Index chunks from a JSONL dump (**needs Qdrant + Ollama**); also populates the embed cache. |
| `--names-index FILE` | Export the `{name → typeID}` map of published types (used by the app for price lookups) and exit. |

Example (recommended for iterating without infra):

```bash
python -m capsuleers_ingestion.run --sde   --dump data/docs_sde.jsonl
python -m capsuleers_ingestion.run --wiki  --dump data/docs_wiki.jsonl    # ~40 min
python -m capsuleers_ingestion.run --names-index data/names_index.json
# later, with Qdrant+Ollama up:
python -m capsuleers_ingestion.run --from-dump data/docs_sde.jsonl
```

### `python -m capsuleers_ingestion.update` ([`update.py`](ingestion/capsuleers_ingestion/update.py))

Daily-style refresh: checks the upstream SDE **build number** vs `data/sde_version.json`, and on a
change rebuilds → indexes into a new versioned Qdrant collection → **atomic alias swap** (zero
downtime), reusing unchanged embeddings from `embed_cache.sqlite`.

```bash
python -m capsuleers_ingestion.update --check    # exit 1 if an update is available, else 0
python -m capsuleers_ingestion.update            # update if changed
python -m capsuleers_ingestion.update --force    # rebuild regardless
```

### Source parsers

[`sde/`](ingestion/capsuleers_ingestion/sde/) (`parse`, `dogma`, `universe`, `industry`, `social`,
`facilities`, `sites`, `wormholes`, `source`, `download`), [`wiki/`](ingestion/capsuleers_ingestion/wiki/)
(multi-source MediaWiki crawler — see [`wiki/sources.py`](ingestion/capsuleers_ingestion/wiki/sources.py)),
[`missions/eve_survival.py`](ingestion/capsuleers_ingestion/missions/),
[`web/riley.py`](ingestion/capsuleers_ingestion/web/riley.py) (static-site crawler). Adding a domain =
add a parser that yields `Document`s and wire it into `parse_all` / `sources()`; adding a MediaWiki =
append a `WikiSource` to `wiki/sources.py` (picked up by both the full crawl and the incremental timer).

---

## 6. Local infra & scheduled updates ([`ops/`](ops/))

```bash
./ops/start.sh        # start Qdrant (:6333) + Ollama (:11434), auto-detect GPU, pull bge-m3 + qwen2.5:7b-instruct
./ops/update.sh       # wrapper around capsuleers_ingestion.update (used by the systemd timer)
```

`start.sh` handles podman/docker, NVIDIA CUDA / AMD ROCm (with `HSA_OVERRIDE_GFX_VERSION` for consumer
cards) / CPU automatically. The [`capsuleers-sde-update.service`](ops/capsuleers-sde-update.service) +
[`.timer`](ops/capsuleers-sde-update.timer) run `update.sh` on a schedule in production.

---

## 7. Working with the fitting engine (`eve-fit-engine`)

Fit stats are **not** hand-rolled here — [`fit.mjs`](desktop/src/fit.mjs) delegates all math to the
[`eve-fit-engine`](https://www.npmjs.com/package/eve-fit-engine) npm package (Pyfa-parity, 631
assertions / 23 fixtures, with its own version-pinned SDE bundle). The numbers are authoritative and
fully offline. `fit.mjs` only parses module **names** (for prices + the LLM listing) and renders the
engine's `DerivedStats` into the Italian context block.

The bundled SDE is also reused **outside fitting**: [`intel.mjs`](desktop/src/intel.mjs)
`analyzeDScan()` calls `loadBundledDataset()` and walks `getType(typeID)`→`groups`→`categories`
to classify a D-Scan offline (ship class + category). Caveat — the engine bundles only
**fittable** types, so celestials/most deployables don't resolve (they bucket as "Others");
ship classes resolve perfectly. The capsuleers.app D-Scan share recomputes the full split
(celestials included) server-side via ESI.

`fit.mjs` also exports `describeDoctrineFit(eft)` for the **doctrine specs** flow (a doctrine fit pulled
from a corp/alliance killmail via the eve-kill MCP — see CLAUDE.md). It reuses the same engine math but
contrasts the offense at the highest-damage vs longest-range ammo (`pickAmmoExtremes()`), surfacing the
missile flight range from `offense.missileRange` (requires **eve-fit-engine ≥ 0.1.4**).

**Three traps to respect (regressions are easy here):**

1. **`eve-fit-engine/data/**` must stay `asarUnpack`'d** in [`electron-builder.yml`](desktop/electron-builder.yml).
   The package's `/node` loader reads its bundled SDE from disk via `fs`, which fails inside `app.asar`.
2. **Promote modules to their default state on import** with `defaultStateForModule(type, dataset.effects)`,
   or weapons sit `ONLINE` and report **0 DPS**.
3. **Launch drones explicitly** (`launchDrones()`): EFT lists the drone *bay*, but the engine's OFFENSE
   only counts drones with `countActive > 0`. Deploy greedily within ship bandwidth + the All-V 5-drone
   cap so headline DPS matches Pyfa.

**Upgrading the fit data / SDE** = bump `eve-fit-engine` in [`desktop/package.json`](desktop/package.json)
and rebuild. There is no `fit_lookup.json` to regenerate anymore (removed), and no remote `dogma_eval`
opt-in (stats are always offline + authoritative).

---

## 8. Evaluation ([`eval/`](eval/))

Before/after a change that could affect answer quality, run the golden-question set:

```bash
python eval/validate_dataset.py     # offline: are the expected facts present in the corpus? (coverage)
python eval/run_eval.py             # end-to-end: API answers (substring match) — needs the API + index up
python eval/run_eval.py --judge     # semantic grading via LLM
```

`validate_dataset` measures whether the **data exists** to answer; `run_eval` measures whether the
system **retrieves + answers** correctly. A gap between them points to retrieval/prompt issues, not
data gaps. **Add a row to [`dataset.jsonl`](eval/dataset.jsonl)** for every real user question you fix.

---

## 9. Releasing

App and index are released **separately** (see [`RELEASING.md`](RELEASING.md) for the full checklist):

- **App** — push a `vX.Y.Z` tag. The [`release.yml`](.github/workflows/release.yml) workflow builds
  natively per-OS in **two GPU variants each** (ubuntu → AppImage, windows → NSIS): `NVIDIA_Cuda`
  on the `latest-cuda` channel and `AMD_Vulkan` on the default channel, then publishes to the
  GitHub Release. `node-llama-cpp` has per-platform/per-backend binaries, hence the native matrix;
  the four variant configs (`desktop/electron-builder.{win,linux}-{cuda,vulkan}.yml`) differ only
  in which binaries they bundle, the artifact name, and the update channel.
- **Index** — when the knowledge base changes: regenerate, update `index.version` + the `sha256`/`size`
  in [`assets-manifest.json`](desktop/src/assets-manifest.json), and upload `index.vec` /
  `index.meta.jsonl` / `names_index.json` to an `index-<version>` release.

Only maintainers cut releases; contributors don't need to.

---

## 10. Best practices & conventions

**Code style**
- Match the surrounding file: comment density, naming, idioms. Code comments in this repo are often in
  Italian (especially user-facing strings); keep that where it already is.
- Keep modules single-purpose. The live-data features are deliberately one file each — follow that.
- Prefer small, reviewable PRs. One concern per PR.

**Engine / RAG**
- The model answers **only from retrieved context** and **cites sources** — don't add prompt paths that
  let it free-associate. Keep responses in the user's detected language (`detectLang`).
- The index is **in-RAM, no DB** at runtime. Don't reintroduce a runtime dependency on Qdrant/Ollama/Python.

**Secrets & data**
- Never commit `.env`, GGUF models, the index, dumps, caches, or anything under `data/` — they're
  gitignored for a reason (size + licensing). Copy [`.env.example`](.env.example) → `.env` locally.
- The knowledge index derives from CC BY-NC-SA 4.0 wiki content → it's effectively **non-commercial**.
  Respect [`THIRD_PARTY.md`](THIRD_PARTY.md) when adding a data source: record the license + attribution.

**External APIs (live-data features)**
- ESI / eve-kill / EVE-Scout / EVE Ref are public but rate-limited (e.g. eve-kill MCP ~20 req/s/IP).
  Be a good citizen: cache, back off, fail soft (a dead live-data call must not break the answer).
- **Always send the shared `User-Agent`** on every external request — never node's default and never a
  bespoke string. JS: `import { USER_AGENT } from "./user-agent.mjs"` ([`desktop/src/user-agent.mjs`](desktop/src/user-agent.mjs),
  version read from `package.json`). Python: `from ..config import USER_AGENT`
  ([`config.py`](ingestion/capsuleers_ingestion/config.py)). Both render
  `Capsuleers.IA/<version> (+https://capsuleers.app; info@capsuleers.app)` — CCP's recommended
  `App/version (+url; contact)` format. Change the contact/version in those two files only.

**Commits & PRs**
- Conventional-commit style is used here: `feat(fit): …`, `fix(engine): …`, `chore(deps): …`,
  `docs: …`. Write an imperative summary + a body explaining the *why*.
- Run a quick smoke test before pushing: `node rag.mjs "<a question>"` for engine changes, `npm start`
  for UI, the relevant `ingestion`/`eval` command for data changes.

**Fit analysis** — see the three traps in §7. Don't reintroduce the removed All-V estimator,
`fit_lookup.json`, or the `precise`/`dogma` opt-in.

---

## 11. Keeping this document up to date

This file is the contributor source of truth — **update it in the same PR** that changes the thing it
describes. In particular, edit the relevant section whenever you:

- add/rename/remove an **npm script** (§4) or an **ingestion CLI flag** (§5);
- add a **runtime module** or a **data source** (§4/§5/§10);
- change the **release** flow or release artifacts (§9);
- change how **models** / the **index** are obtained (§3);
- bump or change how `eve-fit-engine` is consumed (§7).

Keep [`README.md`](README.md) (product-facing) and [`CLAUDE.md`](CLAUDE.md) (architecture-facing) in
sync too — the three together should never contradict each other.

---

## License

By contributing you agree your code is released under the project's [MIT license](LICENSE). The
knowledge-base artifacts and downloaded models keep their own licenses (see [`THIRD_PARTY.md`](THIRD_PARTY.md)).
Capsuleers.IA is an unofficial, non-commercial fan project, not affiliated with Fenris Creations.
