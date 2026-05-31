#!/usr/bin/env node
// Validates the HuggingFace sources WITHOUT downloading the files:
//  - the embedding (assets-manifest.json): compares its precomputed sha256 + size
//    against the metadata published by HuggingFace (LFS oid);
//  - the chat models (models-catalog.json): confirms each repo/file actually
//    exists on HuggingFace (size/sha256 are resolved live by the app, so there's
//    no checksum to precompute) and that sizeGB is roughly right.
//
//   node tools/validate-hf.mjs        (or: npm run validate-hf)
//
// Exits with code 1 if the embedding mismatches or a catalog model is missing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHfAsset } from "../src/assets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, "assets-manifest.json"), "utf-8"));
const catalog = JSON.parse(fs.readFileSync(path.join(SRC, "models-catalog.json"), "utf-8"));

// Reuse the app's HuggingFace resolver (the load-bearing "lfs.oid = sha256" logic).
async function hfFile(repo, file) {
  try { const { sha256, size } = await resolveHfAsset(repo, file); return { sha: sha256, size }; }
  catch (e) { return { error: e.message }; }
}

function parseHfUrl(url) {
  const m = url.match(/huggingface\.co\/([^/]+)\/([^/]+)\/resolve\/[^/]+\/(.+)$/);
  return m ? { repo: `${m[1]}/${m[2]}`, file: decodeURIComponent(m[3]) } : null;
}

let bad = 0, okc = 0;

// Embedding: precomputed sha256 + size must match.
{
  const e = manifest.embedding, p = parseHfUrl(e.url);
  const info = p ? await hfFile(p.repo, p.file) : { error: "unrecognized url" };
  if (info.error) { console.log(`✗ embedding (${e.filename}): ${info.error}`); bad++; }
  else if (info.sha?.toLowerCase() === e.sha256.toLowerCase() && Number(info.size) === e.size) { console.log(`✓ embedding: matches (sha256 + size)`); okc++; }
  else { console.log(`✗ embedding (${e.filename}): sha256/size mismatch\n    manifest ${e.sha256} / ${e.size}\n    HF       ${info.sha} / ${info.size}`); bad++; }
}

// Catalog models: confirm the repo/file exist; sanity-check sizeGB.
for (const m of catalog.models) {
  const info = await hfFile(m.repo, m.file);
  if (info.error) { console.log(`✗ ${m.id} (${m.repo}/${m.file}): ${info.error}`); bad++; continue; }
  const gb = Number(info.size) / 1e9;
  const off = m.sizeGB ? Math.abs(gb - m.sizeGB) / m.sizeGB : 0;
  const warn = off > 0.15 ? `  ⚠ sizeGB ${m.sizeGB} vs real ${gb.toFixed(1)}` : "";
  console.log(`✓ ${m.id}: exists on HF (${gb.toFixed(1)} GB)${warn}`);
  okc++;
}

console.log(`\n${bad === 0 ? "ALL VALID" : "PROBLEMS: " + bad}  —  ${okc} ok`);
process.exit(bad === 0 ? 0 : 1);
