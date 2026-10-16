# capsuleers.ia

Assistente IA desktop per EVE Online, 100% locale con GPU: LLM via `node-llama-cpp` su indice RAG in RAM,
risposte con fonti citate in IT/EN, più intel Local/D-Scan e dati live da API pubbliche.
Due parti: `desktop/` (Electron, il prodotto; nessun server/Python a runtime) e `ingestion/` (Python,
offline, genera l'indice). Percorsi relativi a questa cartella; orchestrazione in `../CLAUDE.md`.

## Comandi
```bash
cd desktop && npm install
npm start                                  # dev — richiede models/ + data/ locali
npm run pack                               # cartella non pacchettizzata
npm run dist:linux[:cuda|:vulkan]          # AppImage (base / NVIDIA / AMD)
npm run dist:win[:cuda|:vulkan]            # NSIS (build su Windows)
npm run validate-hf                        # modelli embedding + catalogo esistono su HuggingFace
npm run build-index | rag | export-index   # indice vettoriale da dump / CLI RAG / export
node desktop/tools/verify-{retrieval,source-tiers,query-rules,intel-backend}.mjs   # verifiche (dalla root)
node desktop/tools/eval-answers.mjs <model.gguf>   # eval risposte (GPU libera)

cd ingestion && python3 -m venv .venv && . .venv/bin/activate && pip install -e .
python -m capsuleers_ingestion.run --sde --dump data/docs_sde.jsonl    # anche --wiki, --names-index, --from-dump, --ccp
python -m capsuleers_ingestion.update                                  # check SDE + re-index zero-downtime
pytest ingestion/tests                                                 # test offline
```
Flusso completo: `RUNNING.md`; rilascio app/indice: `RELEASING.md`.

## Vincoli
- User-Agent solo dalle costanti `desktop/src/user-agent.mjs` e `ingestion/capsuleers_ingestion/config.py`.
- Nuova fonte → riga in `desktop/src/source-tiers.mjs` (altrimenti finisce L4); `verify-source-tiers` fallisce.
- `eve-fit-engine/data/**` in `asarUnpack`; non reintrodurre estimatore All-V, `fitlookup.py` o keyword `dogma`.
- `desktop/src/capsuleers-api.mjs` identico a quello di intel: modificali insieme.
- Sicurezza da non regredire: renderer sandbox, `esc()` quote-safe, CSP, fuses, conferma main-side su
  `data:wipe-all`, basename `*.gguf` nei handler dei modelli, nessuna telemetria (dettaglio security.md).
- Riley solo opt-in (`--riley`), mai in `--all`; indice non commerciale (EVE Uni CC BY-NC-SA).
- Dopo un bump SDE verifica che sia uscita la release `index-<date>`: `rag-check` verde vuol dire solo "rilevato".
- Icone: non modificarle né generarle qui (vedi brand.md).

## Aree (leggi solo se il task le tocca)
| area | file | leggi se |
|---|---|---|
| runtime desktop | docs/claude/desktop-runtime.md | tocchi engine, retrieval, tier fonti, prezzi, prompt, modelli, eval |
| live-data | docs/claude/live-data.md | tocchi moduli che chiamano servizi esterni, clipboard, main.mjs, auto-update |
| fit | docs/claude/fit.md | tocchi `fit.mjs` o doctrine specs |
| ingestion | docs/claude/ingestion.md | tocchi `ingestion/`, `ops/`, manifest asset, fonti e licenze |
| sicurezza | docs/claude/security.md | tocchi renderer, preload, CSP, fuses, IPC, rete |
| storico | docs/architecture.md | solo per la storia: design precedente, NON il runtime attuale |
| rapporti tra repo | ../docs/claude/cross-repo.md | tocchi API v1, `/api/articles`, eve-fit-engine |
| marchio | ../docs/claude/brand.md | tocchi icone o `docs/brand/` |
