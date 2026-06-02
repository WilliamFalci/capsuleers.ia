# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Project Overview

**Capsuleers.IA** — a **standalone, cross-platform, 100% local, GPU-accelerated** desktop
AI assistant for **EVE Online**. It answers questions (skills, fitting, terminology, PVE,
wormholes, sovereignty, exploration, industry…) **with cited sources**, in Italian or
English (auto-detected). A local LLM (via `node-llama-cpp`) answers over a **RAG** index of
EVE knowledge. Nothing leaves the machine except optional lookups to public EVE APIs for the
live-data features.

The companion website / web platform lives in a separate repo (**Capsuleers.Site**); this
repo is the desktop app + the offline data factory that feeds it.

## Two parts

| Part | Path | Runtime | Role |
|---|---|---|---|
| **App** | [`desktop/`](desktop/) | Electron + Node | The shipped product. No server, no Qdrant/Ollama, no Python at runtime. |
| **Data factory** | [`ingestion/`](ingestion/) | Python (build-time, offline) | Generates the knowledge-base index from EVE sources; run by whoever builds a release. |

The app is self-contained: at runtime it only needs the GGUF models + the prebuilt index
(downloaded once on first launch). The Python pipeline never runs on an end user's machine.

## Commands

```bash
# Desktop app (desktop/)
cd desktop
npm install
npm start              # dev — expects models/ + data/ present locally
npm run dist:linux     # build a Linux AppImage installer
npm run dist:win:cuda  # Windows NSIS installer, NVIDIA/CUDA variant (build on Windows)
npm run dist:win:vulkan # Windows NSIS installer, AMD/Vulkan variant (build on Windows)
npm run validate-hf    # verify embedding + catalog models exist on HuggingFace
npm run build-index    # (re)build the vector index from a dump

# Data factory (ingestion/) — offline, needs Qdrant + Ollama only for the index step
cd ingestion
python3 -m venv .venv && . .venv/bin/activate && pip install -e .
python -m capsuleers_ingestion.run --sde   --dump data/docs_sde.jsonl   # SDE → chunks
python -m capsuleers_ingestion.run --wiki  --dump data/docs_wiki.jsonl  # EVE Univ wiki (~40 min)
python -m capsuleers_ingestion.run --names-index data/names_index.json  # name→typeID (price lookups)
python -m capsuleers_ingestion.run --from-dump data/docs_sde.jsonl      # index into Qdrant
python -m capsuleers_ingestion.update                                   # daily SDE build check + zero-downtime re-index
```

See [`RUNNING.md`](RUNNING.md) for the full local-from-scratch flow and [`RELEASING.md`](RELEASING.md)
for cutting an app/index release.

## Desktop runtime architecture

Orchestrator is [`desktop/src/engine.mjs`](desktop/src/engine.mjs):

- **Models** — `node-llama-cpp` (GPU **Vulkan/Metal/CUDA**, CPU fallback). Embeddings via
  **bge-m3 (Q8)**; chat model from an updatable catalog ([`models-catalog.json`](desktop/src/models-catalog.json)),
  Q4 GGUF. `DIM = 1024`, `TOP_K = 12`, `MAX_CONTEXT_CHARS = 6000`.
- **Index** — in-RAM vectors (cosine), no DB. Loaded from `index.vec` + `index.meta.jsonl`.
- **`ask(question, onToken, uiLang)`** pipeline: (1) if the message is a pasted EFT fit
  (`looksLikeFit`) → fit analysis (see below) is injected as context; (2) embed → retrieve
  top-K → build prompt (EVE expert, answers only from context, cites sources, replies in the
  user's language) → stream tokens, then sources.
- **`configurePaths({ modelsDir, dataDir })`** points sibling modules at the userData data dir
  ([`prices.mjs`](desktop/src/prices.mjs), [`links.mjs`](desktop/src/links.mjs)) — otherwise the
  packaged app looks for lookup files inside `app.asar`. **`fit.mjs` no longer needs this** (its
  SDE is bundled in the `eve-fit-engine` package).

### Live-data feature modules (`desktop/src/`)

- [`prices.mjs`](desktop/src/prices.mjs) — EVE Ref reference prices (`priceByName`, `isKnownType`).
- [`intel.mjs`](desktop/src/intel.mjs) — eve-kill killboard pilot/corp/alliance intel.
- [`esi.mjs`](desktop/src/esi.mjs) — official ESI (corp summary, character affiliation, system activity).
- [`eve-scout.mjs`](desktop/src/eve-scout.mjs) — Thera/Turnur wormhole connections.
- [`eveworkbench.mjs`](desktop/src/eveworkbench.mjs) — EVE Workbench community-fit **search by need**
  ("voglio un fit PvP per la Vagabond"). `maybeWorkbench()` is a stateful two-step intent (NOT MCP;
  the engine runs it only when no MCP intent fired, folding the result into `mcp`): a SEARCH
  (`POST /Fit/PostSearchFits`) returns a `fitlist` card + remembers the results in module-scope
  `lastFitSearch`; a follow-up ("specifiche del #2") resolves a fit, pulls its full EFT via
  `GET /Fit/GetById` (`detailToEft` rebuilds slots + drones), and computes Pyfa-parity stats with
  `describeDoctrineFit` (`theory:true` + the EFT block). Headless (UA + origin only, no auth). A fit
  search and a doctrine search cross-clear each other (`resetFitMemory`/`resetDoctrineMemory`) so the
  "specs #N" follow-up always targets the most recent context.
- [`mcp.mjs`](desktop/src/mcp.mjs) + [`mcp-intel.mjs`](desktop/src/mcp-intel.mjs) — eve-kill **MCP**
  analytics (dossier, flies-with/hunts/preys/hunted, safe routes, battles, meta/doctrines, killmail
  forensics, entity overview/timeline/kills, ships-used, entity-top rankings, global/system pulse).
  Deliberately NOT wired: `me_*` (no pilot context), `item/ship/system_info` (answered offline),
  fitting (`dogma_eval`/`fit_compare`/`ship_compare`), `kills_with`≈`flies_with`, `compare`≈`war_report`.
  - **Doctrine specs (two-turn flow).** A `doctrine_detect` answer ("which doctrines does corp/alliance
    X use") caches its clusters in module-scope `lastDoctrine` (`{ entity, clusters[] }`). A follow-up
    like *"specifiche della Muninn"* / *"il fitting della Muninn"* / *"specs #2"* / *"a quanto spara la
    Crusader"* resolves the
    cluster (by ordinal or ship name via `resolveCluster`), pulls its example killmail's EFT
    (`killmail_fitting` `format:"eft"`), and computes the fit stats locally via `describeDoctrineFit`
    (max/min damage). The returned block carries `theory:true`, which triggers a theorycrafting
    directive in [`engine.mjs`](desktop/src/engine.mjs). `resetConversation()` clears `lastDoctrine`
    via the exported `resetDoctrineMemory()`. The specs intent (#5-bis) is gated on `lastDoctrine`
    and must precede the doctrine-list intent (#5).
- [`clipboard-watch.mjs`](desktop/src/clipboard-watch.mjs) — Local-chat intel from the clipboard.
- [`links.mjs`](desktop/src/links.mjs) — `linkify` + `detectLang`.

**Outbound User-Agent** — every external request (in both halves) must identify the app via a single
constant. JS: [`desktop/src/user-agent.mjs`](desktop/src/user-agent.mjs) exports `USER_AGENT`
(version read from `package.json` via `createRequire`); Python: `USER_AGENT` in
[`config.py`](ingestion/capsuleers_ingestion/config.py). Both render
`Capsuleers.IA/<version> (+https://capsuleers.app; info@capsuleers.app)` (CCP `App/version (+url; contact)`
format). Don't hardcode a UA string at a call site — import the constant; change contact/version in those
two files only.
- [`main.mjs`](desktop/src/main.mjs) — Electron main process, tray/mini window, electron-updater
  auto-update, `refreshDataFiles()` (re-downloads index/data files whose size no longer matches
  the effective manifest) + `checkIndexUpdateInBackground()` (post-boot: if a newer **compatible**
  RAG index is published, downloads it + offers a restart). `setupInfo()` returns a `dataOnly` flag
  (a catalog chat model is already installed and only the base assets — index/embedding — are
  missing): the renderer's `#setup` overlay then switches to a **data-update** presentation (distinct
  title/intro, no model picker, size shown in MB, "Aggiorna e avvia") instead of the full first-run
  model picker. Same download/cancel/resume machinery for both modes.
- **RAG index auto-update**: [`assets.mjs`](desktop/src/assets.mjs) fetches the index manifest at
  runtime (`INDEX_MANIFEST_URL`, raw `assets-manifest.json` on `main`) like the model catalog. A
  newer `index.version` with matching `embedModel`/`dim` is downloaded + persisted to
  `dataDir/index-manifest.json` (the new baseline; bundled manifest is the offline floor). The
  server side that republishes the index is [`ops/publish-index.sh`](ops/publish-index.sh); the
  daily wiki/SDE jobs keep Qdrant fresh. See [`RELEASING.md`](RELEASING.md).

## Fit analysis (delegated to `eve-fit-engine`)

[`desktop/src/fit.mjs`](desktop/src/fit.mjs) computes fit stats by delegating **all** the math to
the [`eve-fit-engine`](https://www.npmjs.com/package/eve-fit-engine) npm package (the same
Pyfa-parity engine extracted from Capsuleers.Site — 631 assertions / 23 fixtures). The engine
ships its **own version-pinned SDE bundle**, so the numbers are **authoritative, offline and
Pyfa-parity**; nothing is sent to a server.

What `fit.mjs` still owns:
- `looksLikeFit(text)` — detect a pasted EFT block (first line `[Ship, Name]`).
- `parseEft(text)` — extract ship + module/charge **names verbatim** (for the price lookup and the
  module listing shown to the LLM; the engine's `Fit` carries only typeIDs).
- `describeFit(fit, eftText)` — re-parse the raw EFT through the engine and render the computed
  `DerivedStats` into the Italian context block (fitting resources, slots/hardpoints, DPS with
  weapon/drone/fighter split + alpha + sustained, weapon ranges, EHP + per-layer resistances,
  active/passive tank, cap stability, navigation, targeting).
- `describeDoctrineFit(eft)` — doctrine-fit variant used by the **doctrine specs** flow (see the
  MCP section). Same authoritative tank/cap/nav/targeting block, but contrasts the offense at the
  **highest-damage** vs the **longest-range** ammo (the "max/min" damage spread the user asked for).
  Killmail loss fits usually have no ammo, so `pickAmmoExtremes()` injects the two extreme charges:
  exact charge-size match; turret long-range = lowest-damage ammo; **missile long-range = genuinely
  longest flight range** (`maxVelocity × flightTime`, ranked on base attrs since the ship/skill/rig
  multipliers preserve the ordering). Missile flight range is surfaced via the engine's
  `offense.missileRange` (added in eve-fit-engine 0.1.4).
- `warmFitEngine()` — called once from `engine.init()` to preload the ~8 MB bundled SDE so the
  first pasted fit doesn't stall. Fire-and-forget; loads lazily on demand if it didn't run.

Imports from `eve-fit-engine/node`: `loadBundledDataset`, `buildAllVSkillProfile`, `computeFit`,
`parseEft`, `defaultStateForModule`, `moduleAcceptsChargeType`, `isTurretWeapon`, `isMissileLauncher`.

### Fit traps

- **`eve-fit-engine/data/**` MUST be `asarUnpack`'d** ([`desktop/electron-builder.yml`](desktop/electron-builder.yml)) —
  the package's `/node` loader reads its bundled SDE (`manifest.json` + `v<hash>/*.json`) from disk
  via `fs`, which fails inside `app.asar`.
- **Promote modules to their natural state on import** — `defaultStateForModule(type, dataset.effects)`,
  exactly as the editor does on EFT import. Otherwise weapons/props sit `ONLINE` and contribute 0 DPS.
- **Drones must be launched explicitly** — EFT lists the drone *bay*; the engine's OFFENSE only counts
  drones with `countActive > 0`. `launchDrones()` deploys greedily in EFT order, capped by ship drone
  bandwidth + the All-V 5-drone limit, and sets `countActive` so headline DPS matches Pyfa.
- **Removed in the eve-fit-engine migration** (don't reintroduce): the old custom All-V estimator,
  the Python `sde/fitlookup.py` → `fit_lookup.json` artifact, and the opt-in `precise`/`preciso`/`dogma`
  keyword that ran a remote eve-kill `dogma_eval`. Stats are now always authoritative + offline.
  `dogmaEval()` still exists in [`mcp-intel.mjs`](desktop/src/mcp-intel.mjs) but is no longer wired into
  `ask()`.

## Data / asset model

- [`desktop/src/assets-manifest.json`](desktop/src/assets-manifest.json) declares the release-artifact
  files (`index.vec`, `index.meta.jsonl`, `names_index.json`) with size + sha256. On first launch the
  app downloads them (plus the embedding model + a chat model) into userData. `refreshDataFiles()`
  re-downloads any file whose size drifts from the manifest, so installs pick up new data without a
  reinstall — the big vector index is untouched when unchanged.
- The index is released separately on GitHub Releases (tag `index-<version>`); the installer is "lite"
  (code only). See [`RELEASING.md`](RELEASING.md).

## Ingestion (Python data factory)

[`ingestion/capsuleers_ingestion/`](ingestion/capsuleers_ingestion/): `run.py` (CLI), `update.py`
(daily SDE build-number check + zero-downtime Qdrant alias swap), plus three **incremental**
auto-updaters that re-index changed docs **in place** on the live collection (NOT via update.py's
SDE-only swap, which would drop wiki/missions):
- `wiki_update.py` — `recentchanges` API watermark (`wiki_state.json`) → re-index changed pages.
- `missions_update.py` — content-hash diff (`missions_state.json`) for eve-survival (Wikka wiki,
  no API) → re-index changed / drop removed.
- `wormhole_update.py` — `wormhole.json` file-hash (`wormhole_state.json`) → re-index only the
  affected J-space system Documents (new ∪ previous key-set, so removed effects get cleared).
All three purge a doc's old chunks via `index.delete_by_doc_ids` before re-insert.
`sde/*` (per-domain parsers: `parse`, `dogma`, `universe`, `industry`, `social`, `facilities`,
`sites`, `wormholes`), `wiki/` (`api` shared client, `scrape` full+per-title crawler,
`recentchanges` detector; rate-limited, CC-BY-SA), `missions/eve_survival.py` (full + per-name
`scrape_named`), `chunk.py`, `embed.py` (Ollama bge-m3), `index.py` (Qdrant). Embedding cache
(`embed_cache.sqlite`) means any update only re-embeds changed documents. Timers + the index
publish step live in [`ops/`](ops/) (`update.sh`, `wiki-update.sh`, `missions-update.sh`,
`wormhole-update.sh`, `publish-index.sh`).

## Data sources & licensing

Official SDE (authoritative), EVE University Wiki (**CC BY-NC-SA 4.0** → the knowledge index is
effectively **non-commercial**), eve-survival (missions), Anoikis (wormhole effects/statics), EVE Ref
(prices), ESI, eve-kill (killboard + MCP), EVE-Scout. Source code is MIT; GGUF models keep their own
licenses and are not redistributed. See [`THIRD_PARTY.md`](THIRD_PARTY.md). Unofficial, non-commercial
fan project — not affiliated with Fenris Creations.

## Notes

- [`docs/architecture.md`](docs/architecture.md) describes an **earlier** design (Fastify API +
  Ollama serving + Qdrant at query-time). The shipped product is now a self-contained Electron app with
  `node-llama-cpp` + an in-RAM index and no runtime server — treat the runtime sections of that doc as
  historical; this file + [`README.md`](README.md) are the current source of truth.
