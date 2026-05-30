# Architecture — Capsuleers.IA

## Goal
An AI that answers questions about EVE Online (skills, fitting, terminology, mechanics),
with **multilingual** responses, a **local** model, exposed via an **API** for a website.

## Approach: RAG (not fine-tuning)
EVE knowledge is indexed in a vector DB; for every question the relevant pieces are
retrieved and passed to the model, which answers while citing its sources. Advantages:
updatable (just re-ingest), accurate, traceable, and well suited to a local 7B
model that on its own "knows" little about EVE.

## Components
| Component | Role | Technology |
|---|---|---|
| Ingestion | EVE sources → vectors | Python |
| Vector DB | Semantic search + filters | Qdrant |
| Model serving | LLM + embeddings | Ollama |
| API | Conversational endpoint for the site | Node + Fastify (TS) |

Models: **Qwen2.5-7B-Instruct** (multilingual, runs on CPU/Apple Silicon),
**bge-m3** for embeddings (the same model used in both ingestion and query).

## Data flow (ingestion)
```
SDE (Fuzzwork SQLite / Fenris Creations JSONL) ─┐
EVE University Wiki (MediaWiki API)─┴─► Unified Documents ─► chunk+metadata ─► embed ─► Qdrant
```
Each `Document` has a `type` (skill/ship/module/term/guide), `source`, `url` (for
citation) and metadata for filtering. The wiki is CC-BY-SA → attribution is preserved.

## Request flow (`POST /ask`)
1. **Condense** — the follow-up is rewritten into a standalone question using the history.
2. **Fit detection** — if the message is an EFT fit, it is parsed and its modules
   enriched with SDE data, then injected as extra context.
3. **Retrieve** — embed the question → search on Qdrant (with optional filters).
4. **Prompt** — system prompt (EVE expert, answers only from the context, in the user's
   language, cites sources) + context + history.
5. **Generate** — streaming from Ollama → SSE to the client (tokens, then sources, then done).

## Conversation
Thread state can be handled in two ways: the client sends `history`, or the server
keeps the history per `sessionId` (in-memory store with TTL; Redis in production).

## Deployment
Everything is containerized (`docker-compose`): portable to any host (local now,
cloud/VPS later). The API can run in a container or as a separate Node process.

## Known limitations and next steps
- Local 7B model: limited complex reasoning about fits → an optional cloud fallback
  for hard questions could be added.
- Quality = retrieval quality: take care with chunking, metadata, and filters.
- Implement the logic in the `TODO`s: full SDE parsing (dogma/attributes),
  wiki scraping, name→typeID lookup for fits, payload index on Qdrant.
- Add an evaluation set (known questions → expected answers) to measure accuracy.
