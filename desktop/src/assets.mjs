// State and provisioning of the on-demand assets (.gguf models + RAG index).
// Index + embedding come from the bundled assets-manifest.json (fixed, with
// precomputed SHA256). Chat models come from an UPDATABLE catalog
// (models-catalog.json) fetched from the repo at runtime so new models appear
// without an app update; their exact size + SHA256 are resolved live from
// HuggingFace (LFS oid) at download time. Relies on downloader.mjs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadFile } from "./downloader.mjs";
import { USER_AGENT } from "./user-agent.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Remote model catalog (edit this file on the repo → users see new models on next
// launch, no app update). The bundled copy is the offline fallback.
const CATALOG_URL = "https://raw.githubusercontent.com/WilliamFalci/capsuleers.ia/main/desktop/src/models-catalog.json";

/** Load the index + embedding manifest (bundled next to this module). */
export function loadManifest() {
  return JSON.parse(fs.readFileSync(path.join(HERE, "assets-manifest.json"), "utf-8"));
}

/** Write the index's compatibility sidecar (version, embedder, dim) next to the
 *  downloaded files: the engine reads it at init() to reject incompatible indexes. */
export function writeIndexMeta(dataDir, manifest = loadManifest()) {
  const { version, embedModel, dim } = manifest.index;
  fs.writeFileSync(path.join(dataDir, "index-meta.json"), JSON.stringify({ version, embedModel, dim }, null, 2));
}

// ── Model catalog (remote, updatable, with bundled fallback) ────────────────

function loadCatalogBundled() {
  return JSON.parse(fs.readFileSync(path.join(HERE, "models-catalog.json"), "utf-8"));
}

// Keep only models within the catalog's size range (a standalone shouldn't offer
// models too heavy for typical VRAM, nor so small they hurt answer quality).
function applyRange(catalog) {
  const min = catalog.range?.minGB ?? 0, max = catalog.range?.maxGB ?? Infinity;
  const models = (catalog.models || []).filter((m) => m.sizeGB >= min && m.sizeGB <= max);
  return { ...catalog, models };
}

/** Load the chat-model catalog: try the remote (so it can be updated without an
 *  app release), fall back to the bundled copy. Filtered to the size range. */
export async function loadCatalog({ signal } = {}) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch(CATALOG_URL, { signal: signal || ctl.signal, headers: { "User-Agent": USER_AGENT } });
    clearTimeout(t);
    if (res.ok) {
      const remote = await res.json();
      if (Array.isArray(remote?.models) && remote.models.length) return applyRange(remote);
    }
  } catch { /* offline / unreachable → fallback */ }
  return applyRange(loadCatalogBundled());
}

// Resolve a model's exact download URL, SHA256 and size live from HuggingFace
// (the LFS oid IS the content's sha256). No checksum maintenance in the catalog.
export async function resolveHfAsset(repo, file, signal) {
  const api = `https://huggingface.co/api/models/${repo}/tree/main?recursive=1`;
  const res = await fetch(api, { signal, headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HuggingFace ${res.status} per ${repo}`);
  const entry = (await res.json()).find((e) => e.path === file);
  if (!entry) throw new Error(`File ${file} non trovato in ${repo}`);
  const sha256 = entry.lfs?.oid || null;
  const size = entry.lfs?.size ?? entry.size ?? null;
  if (!sha256 || !size) throw new Error(`Metadati LFS mancanti per ${repo}/${file}`);
  return { url: `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file)}`, sha256, size };
}

const sizeMatches = (p, size) => { try { return fs.statSync(p).size === size; } catch { return false; } };
const existsByName = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
function task(label, url, dest, size, sha256) { return { label, url, dest, size, sha256 }; }

// Any chat .gguf already on disk (excludes the embedding model). Used to decide
// whether first-run setup is still needed — independent of the catalog.
function hasChatModel(modelsDir) {
  try { return fs.readdirSync(modelsDir).some((f) => /\.gguf$/i.test(f) && !/bge|embed/i.test(f)); }
  catch { return false; }
}

/** Catalog model ids already downloaded (matched by file name). */
export function installedCatalogIds(catalog, modelsDir) {
  return catalog.models.filter((m) => existsByName(path.join(modelsDir, m.file))).map((m) => m.id);
}

/** A download task for a catalog model (resolves url/size/sha256 from HuggingFace). */
export async function modelTask(entry, modelsDir, signal) {
  const { url, sha256, size } = await resolveHfAsset(entry.repo, entry.file, signal);
  return { ...task(`Modello · ${entry.label}`, url, path.join(modelsDir, entry.file), size, sha256), modelId: entry.id, filename: entry.file };
}

/** All tasks for the INDEX (vector file + metadata + lookup). */
export function indexTasks(manifest, dataDir) {
  const baseUrl = manifest.index.baseUrl.replace(/\/$/, "");
  return manifest.index.files.map((f) =>
    task(`Indice · ${f.name}`, `${baseUrl}/${f.name}`, path.join(dataDir, f.name), f.size, f.sha256));
}

/** Task for the EMBEDDING model (bge-m3), always required. */
export function embeddingTask(manifest, modelsDir) {
  const e = manifest.embedding;
  return task(`Embedding · ${e.filename}`, e.url, path.join(modelsDir, e.filename), e.size, e.sha256);
}

/**
 * State of the assets on disk. Presence is a light check (existence + size for
 * embedding/index; existence of any chat .gguf for the model). The full SHA256
 * is verified only at download time.
 */
export function assetStatus({ modelsDir, dataDir, manifest = loadManifest() }) {
  const embeddingReady = sizeMatches(path.join(modelsDir, manifest.embedding.filename), manifest.embedding.size);
  const indexReady = manifest.index.files.every((f) => sizeMatches(path.join(dataDir, f.name), f.size));
  const chatModelReady = hasChatModel(modelsDir);
  return { embeddingReady, indexReady, chatModelReady, firstRunReady: embeddingReady && indexReady && chatModelReady };
}

/**
 * Builds the MISSING tasks to bring the app to first run: embedding + index +
 * the chosen chat model (resolved from HuggingFace). Skips what's already present.
 */
export async function firstRunTasks({ modelsDir, dataDir, modelEntry, manifest = loadManifest(), signal }) {
  const tasks = [];
  const emb = embeddingTask(manifest, modelsDir);
  if (!sizeMatches(emb.dest, emb.size)) tasks.push(emb);
  for (const t of indexTasks(manifest, dataDir)) if (!sizeMatches(t.dest, t.size)) tasks.push(t);
  if (modelEntry && !existsByName(path.join(modelsDir, modelEntry.file)))
    tasks.push(await modelTask(modelEntry, modelsDir, signal));
  return tasks;
}

/**
 * Downloads a list of tasks in sequence, reporting AGGREGATED progress
 * (total bytes across all tasks) + the current task. Cancelable via signal.
 */
export async function downloadTasks(tasks, { onProgress = () => {}, signal } = {}) {
  const grandTotal = tasks.reduce((s, t) => s + (t.size || 0), 0);
  let doneBytes = 0;
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    await downloadFile({
      url: t.url, dest: t.dest, sha256: t.sha256, size: t.size, signal,
      onProgress: ({ received, speed }) => onProgress({
        index: i, count: tasks.length, label: t.label,
        received: doneBytes + received, total: grandTotal, speed,
      }),
    });
    doneBytes += t.size || 0;
    onProgress({ index: i, count: tasks.length, label: t.label, received: doneBytes, total: grandTotal, speed: 0 });
  }
  return { ok: true, count: tasks.length };
}
