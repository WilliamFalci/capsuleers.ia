# Releasing

The app is **lite**: the installer contains only the code. Models (.gguf) and the RAG index
are downloaded on first launch. The RAG index + embedding are fixed assets
([`desktop/src/assets-manifest.json`](desktop/src/assets-manifest.json)); the selectable
chat models live in an **updatable catalog** ([`desktop/src/models-catalog.json`](desktop/src/models-catalog.json))
fetched from the repo at runtime, so new models appear **without an app update**.
Three independent lifecycles: **app** (auto-update), **index** (GitHub Releases),
**models** (HuggingFace, via the catalog).

## Adding or updating a chat model (no app release needed)

Edit [`desktop/src/models-catalog.json`](desktop/src/models-catalog.json) on `main` and push:
the app fetches it at every launch, so users see the change immediately. Each entry is just
a HuggingFace `repo` + `file` (plus `label`, approximate `sizeGB`/`paramsB` for display and
the VRAM range filter). **No checksum to maintain** — the app resolves the exact size and
SHA256 live from HuggingFace (LFS oid) at download time. Keep entries within the `range`
(too-large models won't run on typical hardware; too-small ones hurt answer quality).
Run `cd desktop && npm run validate-hf` to confirm every `repo`/`file` exists on HuggingFace.

## One-time, when the repo goes on GitHub

Point the owner/repo at your fork in:
- [`desktop/electron-builder.yml`](desktop/electron-builder.yml) → `publish.owner` (CI
  overrides it anyway, but keep it aligned for local builds)
- [`desktop/src/assets-manifest.json`](desktop/src/assets-manifest.json) → `index.baseUrl`
- [`desktop/src/assets.mjs`](desktop/src/assets.mjs) → `CATALOG_URL` (the raw URL of
  `models-catalog.json` on your repo's default branch)

Then `cd desktop && npm run validate-hf` to confirm the embedding (checksum match) and every
catalog model (`repo`/`file` exist on HuggingFace).

## Releasing the index (when the knowledge base changes)

1. Regenerate the index (`desktop/ build-index.mjs` / `export_index.py`).
2. Update `index.version` and the `sha256`/`size` values in `assets-manifest.json` (you can
   recompute them with `sha256sum data/index.* data/*_index.json`).
3. Create a GitHub release with tag `index-<version>` (e.g. `index-2026.05.30`) and upload
   `index.vec`, `index.meta.jsonl`, `names_index.json` as assets.
   (Fit stats no longer ship a `fit_lookup.json` — the desktop app's fitting math is the
   version-pinned SDE bundled inside the `eve-fit-engine` npm package.)

> The index also derives from the EVE University Wiki (CC BY-NC-SA 4.0) → **non-commercial**
> distribution (see [`THIRD_PARTY.md`](THIRD_PARTY.md)).

### Automated index publishing + auto-update (no app release)

Steps 2–3 are scripted by [`ops/publish-index.sh`](ops/publish-index.sh): it exports the
flat index from the current Qdrant collection, recomputes sizes/SHA256, bumps
[`assets-manifest.json`](desktop/src/assets-manifest.json) (`index.version`/`baseUrl`/`files`),
cuts the `index-<date>` release, and pushes the manifest.

**The app fetches that manifest at launch** (`assets.mjs` `INDEX_MANIFEST_URL`, same pattern
as `models-catalog.json`) and, if a newer **compatible** index version is published (same
`embedModel`/`dim`), downloads it in the background and offers a restart — so the knowledge
base auto-updates on existing installs **without an app release**. The bundled manifest is the
offline floor; the accepted manifest is persisted in `dataDir/index-manifest.json`.

This pairs with the daily server jobs that keep Qdrant fresh — SDE ([`ops/update.sh`](ops/update.sh))
and EVE University wiki incremental ([`ops/wiki-update.sh`](ops/wiki-update.sh), via the
`recentchanges` API). Run `publish-index.sh` on a slow cadence (weekly, or when those jobs
reported changes): the ~290 MB vector file isn't worth republishing per wiki edit.

## Releasing the app

1. Update `version` in [`desktop/package.json`](desktop/package.json).
2. Create and push a `vX.Y.Z` tag:
   ```bash
   git tag v0.1.0 && git push origin v0.1.0
   ```
3. CI ([`.github/workflows/release.yml`](.github/workflows/release.yml)) builds **two GPU
   variants per desktop OS** (ubuntu → AppImage, windows → NSIS) and publishes the artifacts
   + the `latest*.yml` files to the tag's release. `electron-updater` uses those files for
   updates.

   | Artifact | GPU | Backend pref. | Update file |
   |---|---|---|---|
   | `Capsuleers.IA-Setup-NVIDIA_Cuda-<ver>.exe` | NVIDIA (Win) | CUDA → Vulkan → CPU | `latest-cuda.yml` |
   | `Capsuleers.IA-Setup-AMD_Vulkan-<ver>.exe` | AMD/other (Win) | Vulkan → CPU | `latest.yml` (default) |
   | `Capsuleers.IA-NVIDIA_Cuda-<ver>.AppImage` | NVIDIA (Linux) | CUDA → Vulkan → CPU | `latest-cuda-linux.yml` |
   | `Capsuleers.IA-AMD_Vulkan-<ver>.AppImage` | AMD/other (Linux) | Vulkan → CPU | `latest-linux.yml` (default) |

   Each variant ships different `@node-llama-cpp` binaries via its own config
   (`desktop/electron-builder.{win,linux}-{cuda,vulkan}.yml`). The channels are distinct, so a
   CUDA install never auto-updates with the Vulkan artifact (or vice versa); the `-linux`
   suffix electron-builder adds for the AppImage target keeps the Linux CUDA file
   (`latest-cuda-linux.yml`) distinct from the Windows one (`latest-cuda.yml`). The Vulkan
   variants stay on the **default channel** on purpose: today's shipped "lite" installs are
   already Vulkan, so they keep auto-updating with no transition release needed.

Local build (without publishing): each GPU variant must be built **on its own OS** (the
`win-x64-*` / `linux-x64-*` native binaries only install on that platform):
- Linux: `cd desktop && npm run dist:linux:cuda` or `npm run dist:linux:vulkan`
- Windows: `npm run dist:win:cuda` or `npm run dist:win:vulkan`

(`dist:linux` / `dist:win` build the base/Vulkan-lite variant against the parent config.)

## Notes

- **Code signing**: not configured. Windows will show the SmartScreen warning until
  you add an Authenticode certificate; AppImage requires no signing.
- **CUDA**: shipped as a dedicated `NVIDIA_Cuda` variant **on both Windows and Linux**
  (~600 MB heavier) that bundles `*-cuda` + `*-cuda-ext` (the latter carries the CUDA runtime,
  so the user needs no CUDA Toolkit — only the NVIDIA driver). The base/`AMD_Vulkan` builds
  exclude `*cuda*` and stay lite. Both keep Vulkan as fallback. See the variants table above.
- **macOS**: not included in the first release (requires Apple notarization).
