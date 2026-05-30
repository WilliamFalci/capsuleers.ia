# Releasing

The app is **lite**: the installer contains only the code. Models (.gguf) and the RAG index
are downloaded on first launch (see [`desktop/src/assets-manifest.json`](desktop/src/assets-manifest.json)).
Three independent lifecycles: **app** (auto-update), **index** (GitHub Releases),
**models** (HuggingFace).

## One-time, when the repo goes on GitHub

Replace `CHANGE_ME` with the repo owner in:
- [`desktop/electron-builder.yml`](desktop/electron-builder.yml) → `publish.owner` (CI
  overrides it anyway, but keep it aligned for local builds)
- [`desktop/src/assets-manifest.json`](desktop/src/assets-manifest.json) → `index.baseUrl`

Validate the models' HuggingFace URLs (without downloading them): `cd desktop && npm run validate-hf`.
It compares the manifest's sha256 + size against the metadata published by HuggingFace and exits
with an error if anything doesn't match. If it fails, fix `url` or `sha256` in the manifest
— the runtime download would fail safely anyway. Rerun it every time you
change a model (an HF repo might re-quantize a file and change its fingerprint).

## Releasing the index (when the knowledge base changes)

1. Regenerate the index (`desktop/ build-index.mjs` / `export_index.py`).
2. Update `index.version` and the `sha256`/`size` values in `assets-manifest.json` (you can
   recompute them with `sha256sum data/index.* data/*_index.json data/fit_lookup.json`).
3. Create a GitHub release with tag `index-<version>` (e.g. `index-2026.05.30`) and upload
   `index.vec`, `index.meta.jsonl`, `fit_lookup.json`, `names_index.json` as assets.

> The index also derives from the EVE University Wiki (CC BY-NC-SA 4.0) → **non-commercial**
> distribution (see [`THIRD_PARTY.md`](THIRD_PARTY.md)).

## Releasing the app

1. Update `version` in [`desktop/package.json`](desktop/package.json).
2. Create and push a `vX.Y.Z` tag:
   ```bash
   git tag v0.1.0 && git push origin v0.1.0
   ```
3. CI ([`.github/workflows/release.yml`](.github/workflows/release.yml)) builds on
   **ubuntu** (AppImage) and **windows** (NSIS) and publishes the artifacts + the `latest*.yml`
   files to the tag's release. `electron-updater` will use those files for updates.

Local build (without publishing): `cd desktop && npm run dist:linux` (or `dist:win`).

## Notes

- **Code signing**: not configured. Windows will show the SmartScreen warning until
  you add an Authenticode certificate; AppImage requires no signing.
- **CUDA**: excluded from the lite build (Vulkan/Metal cover NVIDIA too). For a CUDA
  variant, remove the `*cuda*` line from `electron-builder.yml` and build on that platform.
- **macOS**: not included in the first release (requires Apple notarization).
