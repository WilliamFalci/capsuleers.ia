#!/usr/bin/env node
// Validates the manifest's HuggingFace URLs by comparing sha256 + size against the
// metadata published by HF (LFS oid), WITHOUT downloading the files. Re-run it every
// time a model is changed: an HF repo might re-quantize a file and change its
// sha256, making the user-side download fail (integrity gate).
//
//   node tools/validate-hf.mjs        (or: npm run validate-hf)
//
// Exits with code 1 if anything does not match (useful in CI).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.join(HERE, "..", "src", "assets-manifest.json");
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf-8"));

// Extracts owner/repo/filename from https://huggingface.co/<owner>/<repo>/resolve/<ref>/<file>
function parse(url) {
  const m = url.match(/huggingface\.co\/([^/]+)\/([^/]+)\/resolve\/[^/]+\/(.+)$/);
  return m ? { owner: m[1], repo: m[2], file: decodeURIComponent(m[3]) } : null;
}

async function hfFileInfo({ owner, repo, file }) {
  const api = `https://huggingface.co/api/models/${owner}/${repo}/tree/main?recursive=1`;
  const res = await fetch(api, { headers: { "User-Agent": "capsuleers-validate-hf" } });
  if (res.status === 404) return { error: "repo non trovato (404)" };
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const entry = (await res.json()).find((e) => e.path === file);
  if (!entry) return { error: "file non presente nel repo" };
  // For LFS files, lfs.oid is the sha256 of the content.
  return { sha: entry.lfs?.oid || null, size: entry.lfs?.size ?? entry.size ?? null };
}

const items = [
  { id: "embedding", url: manifest.embedding.url, sha256: manifest.embedding.sha256, size: manifest.embedding.size },
  ...manifest.models.map((m) => ({ id: m.id, url: m.url, sha256: m.sha256, size: m.size })),
];

let okCount = 0;
const bad = [];
for (const it of items) {
  const p = parse(it.url);
  if (!p) { console.log(`✗ ${it.id}: URL non riconosciuto`); bad.push(it.id); continue; }
  let info;
  try { info = await hfFileInfo(p); } catch (e) { info = { error: e.message }; }
  if (info.error) { console.log(`✗ ${it.id} (${p.owner}/${p.repo}/${p.file}): ${info.error}`); bad.push(it.id); continue; }
  const shaOk = info.sha && info.sha.toLowerCase() === it.sha256.toLowerCase();
  const sizeOk = info.size == null || Number(info.size) === it.size;
  if (shaOk && sizeOk) { console.log(`✓ ${it.id}: combacia (sha256 + size)`); okCount++; }
  else {
    console.log(`✗ ${it.id} (${p.owner}/${p.repo}):`);
    console.log(`    manifest sha256: ${it.sha256}`);
    console.log(`    HF       sha256: ${info.sha || "(assente)"}  ${shaOk ? "OK" : "≠"}`);
    if (!sizeOk) console.log(`    size: manifest ${it.size} vs HF ${info.size}`);
    bad.push(it.id);
  }
}
console.log(`\n${bad.length === 0 ? "TUTTI VALIDI" : "DA CORREGGERE: " + bad.join(", ")} — ${okCount}/${items.length} ok`);
process.exit(bad.length === 0 ? 0 : 1);
