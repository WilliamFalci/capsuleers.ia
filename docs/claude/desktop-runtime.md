# Runtime desktop — engine, retrieval, fonti

Leggi se tocchi `desktop/src/engine.mjs`, `retrieval.mjs`, `source-tiers.mjs`, `prices.mjs`, prompt, modelli o eval delle risposte. `docs/architecture.md` descrive un design precedente (API Fastify + Ollama + Qdrant a runtime): storico, non vale per il runtime attuale.

## Panoramica
**Capsuleers.IA** — a **standalone, cross-platform, 100% local, GPU-accelerated** desktop
AI assistant for **EVE Online**. It answers questions (skills, fitting, terminology, PVE,
wormholes, sovereignty, exploration, industry…) **with cited sources**, in Italian or
English (auto-detected). A local LLM (via `node-llama-cpp`) answers over a **RAG** index of
EVE knowledge. Nothing leaves the machine except optional lookups to public EVE APIs for the
live-data features.

The companion website / web platform lives in a separate repo (**capsuleers.website**, capsuleers.app); this
repo is the desktop app + the offline data factory that feeds it.

## Two parts

| Part | Path | Runtime | Role |
|---|---|---|---|
| **App** | [`desktop/`](../../desktop/) | Electron + Node | The shipped product. No server, no Qdrant/Ollama, no Python at runtime. |
| **Data factory** | [`ingestion/`](../../ingestion/) | Python (build-time, offline) | Generates the knowledge-base index from EVE sources; run by whoever builds a release. |

The app is self-contained: at runtime it only needs the GGUF models + the prebuilt index
(downloaded once on first launch). The Python pipeline never runs on an end user's machine.

## Desktop runtime architecture

Orchestrator is [`desktop/src/engine.mjs`](../../desktop/src/engine.mjs):

- **Models** — `node-llama-cpp` (GPU **Vulkan/Metal/CUDA**, CPU fallback). Embeddings via
  **bge-m3 (Q8)**; chat model from an updatable catalog ([`models-catalog.json`](../../desktop/src/models-catalog.json)),
  Q4 GGUF. `DIM = 1024`, `TOP_K = 12`, `MAX_CONTEXT_CHARS = 6000`.
- **Index** — in-RAM vectors (cosine), no DB. Loaded from `index.vec` + `index.meta.jsonl`.
- **`ask(question, onToken, uiLang)`** pipeline: (1) if the message is a pasted EFT fit
  (`looksLikeFit`) → fit analysis (see below) is injected as context; (2) embed → retrieve
  top-K → build prompt (EVE expert, answers only from context, cites sources, replies in the
  user's language) → stream tokens, then sources.
- **Hybrid retrieval** — [`retrieval.mjs`](../../desktop/src/retrieval.mjs) (pure, no models): dense
  (cosine + tier nudge, pool 200) + **BM25** over title+text (pool 100, built at `init()`, ~2 s /
  ~25 MB) + **title matches** (every title token named in the query: "Vexor", "Damage Control II"),
  fused as `dense + 0.1 × (BM25/best + 1 if title match)`, then two diversity caps: a near-copy
  (cosine ≥ 0.85) of a kept chunk **of the same source** waits behind everything else (SDE families:
  18 Amulet implants, a hull's SKINs), and **one chunk per page** first. Why: on "dove si droppano gli
  High-grade Amulet?" dense-only filled the context with the Amulet records and the Feb 2020 patch
  note that answers it was rank 339; on "quanti slot ha la Vexor?" Vexor SKINs (short → BM25 favourite)
  and EVE Uni chunks pushed the SDE record out of the budget. Cross-source near-copies are NOT capped:
  the SDE Caracal and EVE Uni's Caracal page are ≥ 0.85 apart and complementary. **The context budget
  is the real limit** (6000 chars ≈ 4-6 blocks): engine.mjs picks blocks in RETRIEVAL order, skipping
  one that doesn't fit, and only then sorts the chosen ones by tier — sorting first let low-relevance
  L1 records evict the best L3 hit. Measured with `node desktop/tools/verify-retrieval.mjs` (counts
  what fits the budget): `eval/retrieval.jsonl` dense 26/30 → 30/30, held-out
  `eval/retrieval-holdout.jsonl` 19/22 → 22/22. `tools/probe-retrieval.mjs "<q>"` shows the ranking,
  `IA_DEBUG_PROMPT=1` prints the exact prompt. RRF was tried and lost the English Amulet question
  (rank fusion forgets that "Amulet" is a 22-chunk word and "implants" an 821-chunk one).
- **Answer eval / model choice** — `node desktop/tools/eval-answers.mjs <model.gguf>` runs the real
  `ask()` on `eval/answers.jsonl` (facts the answer must contain, reply language, `refuse` rows for
  unanswerable questions) in a scratch models dir (never touches `.selected-model`). Measure with
  the GPU free: EVE clients running hold ~7.6 GB of VRAM and change both speed and stability.
- **Source hierarchy** — [`source-tiers.mjs`](../../desktop/src/source-tiers.mjs) is the single table
  of how much each source is trusted: **L1** CCP (SDE, ESI, docs, Support, patch notes, dev posts),
  **L2** processed official data (EVE Ref), **L3** structured community (EVE University, EVE-Scout,
  Anoikis, eve-kill, Dotlan, Fuzzwork, zKillboard…), **L4** general community (Fandom wikis,
  eve-survival, Riley, EVE Workbench). It drives three things: a small retrieval nudge
  (`TIER_BONUS`, ±0.015 added to the cosine score, precomputed per chunk at index load); the tag on
  every context block (`[L1 · CCP SDE · item]`, live blocks too) plus a SYSTEM rule "on conflict the
  lower level wins"; and the `tier` on every cited source (sorted primary-first, chip in the UI).
  The tier is derived from `source` when the index carries it, else from the URL host — so it works on
  index releases published before `source` was exported (only SDE chunks have `url: null`).
  **Dated L1 sources (CCP patch notes, dev blogs) get NO retrieval nudge** (`bonusOf`): they stay L1
  for the tag and the conflict rule, but describe a change as of their date and may be superseded —
  and the SYSTEM prompt says SDE/ESI beat them, and among them the newest wins. Support, EVE Academy
  and the dev-docs guides describe the CURRENT game and get the full L1 nudge. The retrieved blocks
  enter the context **sorted by tier** (stable within a tier): a 4B model weighs the head of the
  context most, and the conflict rule is only as good as its attention to the L1 block — on "how does
  sov work" that is what moved the answer from TCU/I-Hub to the Equinox Sovereignty Hub. The prompt
  forbids writing the L-labels in the answer (the model did). **A new
  source needs a row there**, or it silently lands at L4: `node desktop/tools/verify-source-tiers.mjs`
  fails on any host without one, and measures the nudge on real questions (median top-1↔top-12 gap
  0.087; 0.9 chunks of 12 replaced per question — it reorders the tail, never the head).
- **Prices come at two levels and are NOT in conflict**: EVE Ref's global reference average (L2) and
  the live Jita 4-4 order book from Fuzzwork (L3, `jitaPrice` in [`prices.mjs`](../../desktop/src/prices.mjs),
  5-min cache = the server's own expiry). Each is its own tagged block and cited source, and the live
  directive says so explicitly — otherwise "the lower level wins" would make the model prefer the
  global average over the real Jita price. Prices under 100 ISK keep two decimals (Tritanium 3.82 vs
  3.65 was rounded to "4 / 4"). The fit analysis block is tagged **L2 · eve-fit-engine**.
- **Query rules** (`expandQuery`, `intelQuery`, both exported and checked by
  `node desktop/tools/verify-query-rules.mjs`): the killboard-stats trigger needs a word end on
  `stat` — without it "STATus di sicurezza" went to eve-kill as a pilot name and the answer cited the
  killboard; and in an ITALIAN sentence about mining "ore" is REPLACED with "minerale (ore)" (Italian
  "ore" = hours), never after a count ("quante ore", "3 ore"). Measured: appending "(mining ore)"
  pushed the target patch note from rank 5 to 18, substituting brought it to 2.
- **`configurePaths({ modelsDir, dataDir })`** points sibling modules at the userData data dir
  ([`prices.mjs`](../../desktop/src/prices.mjs), [`links.mjs`](../../desktop/src/links.mjs)) — otherwise the
  packaged app looks for lookup files inside `app.asar`. **`fit.mjs` no longer needs this** (its
  SDE is bundled in the `eve-fit-engine` package).
