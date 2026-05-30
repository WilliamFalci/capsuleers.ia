// State and provisioning of the on-demand assets (.gguf models + RAG index).
// Reads the catalog from assets-manifest.json, reports what's missing for first
// run, and downloads the requested set with aggregated progress. Relies on downloader.mjs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadFile } from "./downloader.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Load the asset catalog (bundled next to this module). */
export function loadManifest() {
  return JSON.parse(fs.readFileSync(path.join(HERE, "assets-manifest.json"), "utf-8"));
}

/** Write the index's compatibility sidecar (version, embedder, dim) next to the
 *  downloaded files: the engine reads it at init() to reject incompatible indexes. */
export function writeIndexMeta(dataDir, manifest = loadManifest()) {
  const { version, embedModel, dim } = manifest.index;
  fs.writeFileSync(path.join(dataDir, "index-meta.json"), JSON.stringify({ version, embedModel, dim }, null, 2));
}

const indexUrl = (m, f) => `${m.index.baseUrl.replace(/\/$/, "")}/${f.name}`;
const sizeMatches = (p, size) => { try { return fs.statSync(p).size === size; } catch { return false; } };

/** A download "task": label, source, destination, size, and checksum. */
function task(label, url, dest, size, sha256) { return { label, url, dest, size, sha256 }; }

/** All tasks for the INDEX (vector file + metadata + lookup). */
export function indexTasks(manifest, dataDir) {
  return manifest.index.files.map((f) =>
    task(`Indice · ${f.name}`, indexUrl(manifest, f), path.join(dataDir, f.name), f.size, f.sha256));
}

/** Task for the EMBEDDING model (bge-m3), always required. */
export function embeddingTask(manifest, modelsDir) {
  const e = manifest.embedding;
  return task(`Embedding · ${e.filename}`, e.url, path.join(modelsDir, e.filename), e.size, e.sha256);
}

/** Task for a chat model given its id (default: the one with "default": true). */
export function chatModelTask(manifest, modelsDir, modelId) {
  const m = manifest.models.find((x) => x.id === modelId) || manifest.models.find((x) => x.default) || manifest.models[0];
  if (!m) return null;
  return { ...task(`Modello · ${m.label}`, m.url, path.join(modelsDir, m.filename), m.size, m.sha256), modelId: m.id };
}

/**
 * State of the assets on disk. A "light" presence check (existence + size);
 * the full SHA256 is verified only at download time.
 */
export function assetStatus({ modelsDir, dataDir, manifest = loadManifest() }) {
  const embeddingReady = sizeMatches(path.join(modelsDir, manifest.embedding.filename), manifest.embedding.size);
  const indexReady = manifest.index.files.every((f) => sizeMatches(path.join(dataDir, f.name), f.size));
  const installedModels = manifest.models.filter((m) => sizeMatches(path.join(modelsDir, m.filename), m.size)).map((m) => m.id);
  const firstRunReady = embeddingReady && indexReady && installedModels.length > 0;
  return { embeddingReady, indexReady, installedModels, firstRunReady };
}

/**
 * Builds the MISSING tasks to bring the app to first run: embedding + index +
 * the chosen chat model. Skips whatever is already present (correct size).
 */
export function firstRunTasks({ modelsDir, dataDir, modelId, manifest = loadManifest() }) {
  const st = assetStatus({ modelsDir, dataDir, manifest });
  const tasks = [];
  if (!st.embeddingReady) tasks.push(embeddingTask(manifest, modelsDir));
  if (!st.indexReady) {
    for (const t of indexTasks(manifest, dataDir)) if (!sizeMatches(t.dest, t.size)) tasks.push(t);
  }
  // If there's no chat model yet, download the chosen one (or the default).
  if (st.installedModels.length === 0 || modelId) {
    const ct = chatModelTask(manifest, modelsDir, modelId);
    if (ct && !sizeMatches(ct.dest, ct.size)) tasks.push(ct);
  }
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
