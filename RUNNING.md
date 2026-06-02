# Running and testing Capsuleers.IA locally

A step-by-step guide to get the entire stack running on your machine and try it out.

## Prerequisites

- **podman** (default on Fedora) or **docker**
- **Node** ≥ 18 and **npm**
- **Python** ≥ 3.11
- ~8 GB free (models) + ~1 GB (data)

> Note: on this machine `docker` is actually **rootless podman**. The scripts
> below use `podman`; with classic docker the commands are identical
> (`docker` in place of `podman`, and for Qdrant you can use `-p 6333:6333` instead
> of `--network host`).

---

## 1. Infrastructure: Qdrant + Ollama

Ready-made script (starts the containers and downloads the models if missing):

```bash
cd Capsuleers.IA
chmod +x ops/start.sh
./ops/start.sh
```

Or manually:

```bash
# Qdrant (vector DB) — host networking to avoid a rootless port-forward bug
podman run -d --name capsuleers-qdrant --network host \
  -v capsuleers_qdrant:/qdrant/storage docker.io/qdrant/qdrant:latest

# Ollama (models)
podman run -d --name capsuleers-ollama -p 11434:11434 \
  -v capsuleers_ollama:/root/.ollama docker.io/ollama/ollama:latest

# Models (~6 GB total, one-time)
podman exec capsuleers-ollama ollama pull bge-m3              # embeddings
podman exec capsuleers-ollama ollama pull qwen2.5:7b-instruct # generation
```

Verify: `curl http://localhost:11434/api/version` and `curl http://localhost:6333/healthz`.

---

## 2. Data: download the SDE and index it

```bash
cd ingestion
python3 -m venv .venv && . .venv/bin/activate
pip install -e .

# (a) Download the official Fenris Creations SDE and generate the chunks (no infra needed)
python -m capsuleers_ingestion.run --sde --dump data/docs_sde.jsonl

# (b) Name→typeID index (used by the app for price lookups; fit stats need no
#     export — the desktop app bundles its own SDE via the eve-fit-engine package)
python -m capsuleers_ingestion.run --names-index data/names_index.json

# (c) EVE University Wiki — ~40 min. IMPORTANT for missions, anomalies,
#     wormholes, exploration, incursions: the discursive explanations of these
#     topics come from here (119+ dedicated pages).
python -m capsuleers_ingestion.run --wiki --dump data/docs_wiki.jsonl

# (d) Index into Qdrant (requires Ollama+Qdrant running). ~30-45 min on CPU.
python -m capsuleers_ingestion.run --from-dump data/docs_sde.jsonl
python -m capsuleers_ingestion.run --from-dump data/docs_wiki.jsonl   # if you did (c)
```

Indexing progress:
```bash
curl -s -X POST http://localhost:6333/collections/eve_knowledge/points/count \
  -H 'content-type: application/json' -d '{"exact":true}'
```

---

## 3. API

```bash
cd ../api
npm install
npm run dev          # http://localhost:3000  (Ctrl-C to stop)
```

---

## 4. Testing

**Health:**
```bash
curl http://localhost:3000/health      # {"ok":true,"qdrant":true}
```

**A single question (response streamed via SSE):**
```bash
curl -N -X POST http://localhost:3000/ask -H 'content-type: application/json' \
  -d '{"message":"Quali bonus ha il Thorax e quali skill servono per pilotarlo?"}'
```

**Fit analysis (paste an EFT fit):**
```bash
curl -N -X POST http://localhost:3000/ask -H 'content-type: application/json' \
  -d '{"message":"[Rifter, PvP]\n200mm AutoCannon II\n200mm AutoCannon II\n200mm AutoCannon II\n\nWarp Scrambler II\nStasis Webifier II\n1MN Afterburner II\n\nDamage Control II\nGyrostabilizer II\nSmall Armor Repairer II\n\nSmall Projectile Collision Accelerator I\nSmall Projectile Collision Accelerator I\n\nDimmi se sta in piedi."}'
```

**Conversation (follow-up):** pass `sessionId` to keep the thread:
```bash
curl -N -X POST http://localhost:3000/ask -H 'content-type: application/json' \
  -d '{"sessionId":"test1","message":"e per la versione Tech II?"}'
```

**In the browser:** open [`examples/test.html`](examples/test.html) (double-click or
`xdg-open examples/test.html`): a mini interface that calls the API and shows
the answer + sources as they stream.

**Evaluation suite** (measures accuracy on the 35 golden questions):
```bash
python eval/run_eval.py            # substring match
python eval/run_eval.py --judge    # semantic grading via LLM
```

---

## 5. SDE update (optional)

```bash
python -m capsuleers_ingestion.update --check   # is there a new Fenris Creations build?
python -m capsuleers_ingestion.update           # update and re-index (zero-downtime)
```
For the automatic daily timer see [`ops/README.md`](ops/README.md).

---

## Stop / cleanup

```bash
podman stop capsuleers-qdrant capsuleers-ollama
podman rm   capsuleers-qdrant capsuleers-ollama       # removes the containers
# the volumes (Qdrant data + models) remain: podman volume rm capsuleers_qdrant capsuleers_ollama
```

## GPU (acceleration)

`ops/start.sh` **automatically detects the GPU** and configures Ollama:
- **NVIDIA** → CUDA image + `--gpus all` (docker) / CDI (podman). Requires the drivers + nvidia-container-toolkit.
- **AMD** → ROCm image + passthrough of `/dev/kfd`,`/dev/dri`. For consumer GPUs
  (e.g. RX 6000/7000) it automatically sets `HSA_OVERRIDE_GFX_VERSION` (overridable
  by exporting the variable before launching the script).
- **No GPU** → CPU.

To change the mode on an already-existing container: `podman rm -f capsuleers-ollama`
and rerun `./ops/start.sh`. Verify with `podman exec capsuleers-ollama ollama ps`
(PROCESSOR column: `GPU` vs `CPU`).

> Note: Ollama accelerates **NVIDIA** and **AMD**. **Intel** GPUs are not supported
> by the standard image (an IPEX-LLM build would be needed) → CPU fallback.

## Notes

- The first generation is slow on CPU: qwen2.5:7b runs at ~7 tokens/s (tens of seconds per
  response). On GPU it drops to a few seconds.
- If `curl` on :6333 returns an empty response with podman, make sure Qdrant was
  started with `--network host` (see above).
