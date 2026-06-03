// Disk-persisted history of pilot-intel share links generated from a Local.
// Stored as JSON in the Electron userData dir (next to clipboard-consent.json),
// so it survives app restarts. Entries are pruned on read once past their 24h
// expiry — that matches the site's TTL (the link 410s after that), so a dead
// row in the list would just be noise. The renderer renders a live countdown
// to expiry from each entry's `expiresAt`.
import { app } from "electron";
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const FILE = () => path.join(app.getPath("userData"), "intel-share-history.json");
const MAX_ENTRIES = 100;   // cap the file; newest kept

async function readAll() {
  try {
    const raw = JSON.parse(await readFile(FILE(), "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

async function writeAll(list) {
  try {
    await mkdir(path.dirname(FILE()), { recursive: true });
    await writeFile(FILE(), JSON.stringify(list), "utf-8");
  } catch { /* best-effort: history is non-critical */ }
}

function prune(list) {
  const now = Date.now();
  return list.filter((e) => e && Number.isFinite(e.expiresAt) && e.expiresAt > now);
}

// Live (non-expired) entries, newest first. Rewrites the file if anything was
// pruned, so expired links drop out of the list automatically on next read.
export async function listEntries() {
  const all = await readAll();
  const live = prune(all);
  if (live.length !== all.length) await writeAll(live);
  return live.slice().sort((a, b) => b.createdAt - a.createdAt);
}

export async function addEntry({ id, url, expiresAt, kind, count }) {
  const expMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number(expiresAt);
  const entry = {
    id,
    url,
    kind: kind || "intel",   // 'intel' (pilot-intel) | 'dscan'
    createdAt: Date.now(),
    expiresAt: Number.isFinite(expMs) ? expMs : Date.now() + 24 * 60 * 60 * 1000,
    count: count ?? null,    // pilots (intel) or objects (dscan)
  };
  const all = prune(await readAll());
  all.push(entry);
  all.sort((a, b) => b.createdAt - a.createdAt);
  await writeAll(all.slice(0, MAX_ENTRIES));
  return entry;
}

export async function clearEntries() {
  await writeAll([]);
}
