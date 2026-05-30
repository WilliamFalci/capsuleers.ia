# Third-Party Notices & Attributions

Capsuleers.IA is a fan-made, non-commercial tool. Its **source code** is licensed
under the MIT License (see [`LICENSE`](LICENSE)). This document covers the
third-party material the project relies on, which is governed by **separate
licenses** that you must respect when redistributing builds, the knowledge-base
index, or the models.

---

## 1. EVE Online (Fenris Creations)

> EVE Online and the EVE logo are the registered trademarks of Fenris Creations. All rights
> are reserved worldwide. All other trademarks are the property of their respective
> owners. EVE Online, the EVE logo, EVE and all associated logos and designs are
> the intellectual property of Fenris Creations. All artwork, screenshots, characters,
> vehicles, storylines, world facts or other recognizable features of the
> intellectual property relating to these trademarks are likewise the intellectual
> property of Fenris Creations.
>
> Fenris Creations has granted permission to Capsuleers.IA to use EVE Online and all
> associated logos and designs for promotional and information purposes on its
> website but does not endorse, and is not in any way affiliated with,
> Capsuleers.IA. Fenris Creations is in no way responsible for the content on or functioning of
> this software, nor can it be liable for any damage arising from the use of this
> software.

This project uses the following official Fenris Creations data and services:

- **EVE Static Data Export (SDE)** — game static data (skills, ships, modules,
  dogma, universe, industry, blueprints). Used to build the knowledge-base index.
- **ESI** (`esi.evetech.net`) — official EVE Swagger Interface, queried live at
  runtime for character/corp/alliance and system data. No authentication required
  for the public endpoints used.
- **Image Server** (`images.evetech.net`) — official portrait/logo images,
  referenced at runtime.

Use is governed by the [Fenris Creations Developer License Agreement](https://developers.eveonline.com/license-agreement)
and Fenris Creations' third-party application policy.

---

## 2. Knowledge-base index (release artifact)

The prebuilt index (`index.vec` + `index.meta.jsonl`), distributed separately as a
release download (not bundled in the source repository), contains text derived from
the sources below. **The index as a whole inherits the most restrictive of these
licenses — CC BY-NC-SA 4.0 — and is therefore distributed for non-commercial use,
with attribution, under share-alike terms.**

| Source | Content | License |
|---|---|---|
| EVE University Wiki (`wiki.eveuniversity.org`) | Mechanics, terminology, mining, exploration | **CC BY-NC-SA 4.0** |
| EVE SDE (Fenris Creations) | Game static data | Fenris Creations Developer License |
| eve-survival.org | PVE mission guides | Terms not explicit — used as fan reference; see ingestion note |
| Anoikis (`anoikis.info`) | Wormhole effects / statics | Fan community data |
| EVE Ref (`everef.net`) | Item reference / live prices | Open data |

If you intend to use the index commercially, you must regenerate it **excluding**
the CC BY-NC-SA sources (EVE University Wiki).

---

## 3. Language models (downloaded on demand)

The application downloads GGUF models at runtime; they are **not** redistributed by
this repository. Each is governed by its own license:

| Model | Role | License |
|---|---|---|
| BAAI bge-m3 | Embeddings | MIT |
| Qwen2.5 / Qwen3 Instruct (Alibaba) | Chat | Apache-2.0 (Qwen license) |
| Mistral-Nemo-Instruct-2407 | Chat (optional) | Apache-2.0 |

Models are fetched from their official Hugging Face repositories. Review each
model's license before redistributing any build that bundles it.

---

## 4. Runtime libraries

- **Electron** — MIT
- **node-llama-cpp** — MIT (wraps `llama.cpp`, MIT)

---

## 5. Live third-party APIs (queried at runtime)

These services are called for live data and are not redistributed; respect their
respective terms of service and rate limits:

- `eve-kill.com` / `api.eve-kill.com` — killboard
- `eve-scout.com` / `api.eve-scout.com` — Thera/Turnur wormhole connections
- `everef.net` / `data.everef.net` — prices / reference

---

*If you are a rights holder and believe attribution here is incomplete or
incorrect, please open an issue.*
