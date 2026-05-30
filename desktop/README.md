# Capsuleers.IA — Standalone desktop app

A **cross-platform standalone version**: download it, launch it, and you have an interface
to ask questions about EVE Online. Everything is **local and on GPU** (Vulkan/Metal/CUDA,
CPU fallback), with no external servers (no Qdrant/Ollama).

## Architecture

```
Electron (window + chat UI)
   └─ main process ─ engine.mjs ─┬─ node-llama-cpp (GPU)  → embeddings (bge-m3) + generation (Mistral-Nemo 12B)
                                 └─ embedded in-RAM index (data/index.vec + index.meta.jsonl) → cosine top-k
```

- **node-llama-cpp**: GPU inference via Vulkan/Metal/CUDA (prebuilt binaries, Node-API → works under Electron too). Validated on the RX 6700 XT (Vulkan): ~1.5s/response.
- **Embedded index**: ~68k documents (SDE + wiki + wormholes), cosine search in memory. No DB.

## Setup (development)

```bash
cd desktop
npm install

# GGUF models (into ./models/)
npx node-llama-cpp pull --dir ./models "https://huggingface.co/bartowski/Mistral-Nemo-Instruct-2407-GGUF/resolve/main/Mistral-Nemo-Instruct-2407-Q4_K_M.gguf"
npx node-llama-cpp pull --dir ./models "https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q8_0.gguf"

# Index (./data/): two ways
python3 export_index.py      # fast: exports the vectors from an already-populated Qdrant
# or
node build-index.mjs         # standalone: re-embeds the JSONL dumps with bge-m3 GGUF (slow, one-time)

# Launch the app
npm start
```

Test CLI (no GUI): `node rag.mjs "Quali skill servono per un Caracal?"`

## Files
- `src/main.mjs` — Electron main: window + IPC + engine init.
- `src/preload.cjs` — secure renderer↔main bridge.
- `src/renderer/index.html` — chat interface (streaming + sources).
- `src/engine.mjs` — reusable RAG engine (init + ask).
- `export_index.py` / `build-index.mjs` — index construction.
- `rag.mjs` / `test-gpu.mjs` — CLI tests.

## To do (packaging — final phase)
- **electron-builder** to generate the installers: Windows (`.exe`/nsis), macOS (`.dmg`),
  Linux (`.AppImage`). Bundle `models/` + `data/` (or download them on first launch to
  reduce the installer size).
- Verify GPU usage under Electron on all three OSes; code signing (macOS
  notarization, Windows signing) for warning-free downloads.
- A "download the 7B model" option for users with a powerful GPU.
