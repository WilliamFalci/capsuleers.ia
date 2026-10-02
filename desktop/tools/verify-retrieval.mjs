// Retrieval quality on the golden set (eval/retrieval.jsonl): for every question,
// is a chunk that answers it in the context the model actually sees — the top-K,
// cut to the MAX_CONTEXT_CHARS budget the way engine.mjs fills it? Compares the
// old dense-only ranking with the hybrid one in src/retrieval.mjs, on the real index.
// Generation is not involved: if the answer isn't in the context, no prompt fixes it.
//
//   node tools/verify-retrieval.mjs                 # index + models from the app's data dir
//   IA_DATA=… IA_MODELS=… node tools/verify-retrieval.mjs [--dataset file.jsonl] [--only id,id] [--show]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLlama } from "node-llama-cpp";
import { bonusOf } from "../src/source-tiers.mjs";
import { expandQuery } from "../src/engine.mjs";
import { buildLexicalIndex, denseSearch, retrieve } from "../src/retrieval.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(os.homedir(), ".config", "capsuleers-ia-desktop");
const DATA = process.env.IA_DATA || path.join(APP, "data");
const MODELS = process.env.IA_MODELS || path.join(APP, "models");
const DATASET_DEFAULT = path.join(HERE, "..", "..", "eval", "retrieval.jsonl");
const DIM = 1024, TOP_K = 12, MAX_CONTEXT_CHARS = 6000;

const argv = process.argv.slice(2);
const only = argv.includes("--only") ? new Set(argv[argv.indexOf("--only") + 1].split(",")) : null;
const show = argv.includes("--show");
const DATASET = argv.includes("--dataset") ? path.resolve(argv[argv.indexOf("--dataset") + 1]) : DATASET_DEFAULT;
// Tuning knobs (defaults = the ones the app runs): RETR_OPTS='{"alpha":0.15,"dupSim":0.9}'
const opts = JSON.parse(process.env.RETR_OPTS || "{}");

const cases = fs.readFileSync(DATASET, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .filter((c) => !only || only.has(c.id));

const buf = fs.readFileSync(path.join(DATA, "index.vec"));
const vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const meta = fs.readFileSync(path.join(DATA, "index.meta.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const count = meta.length;
for (let i = 0; i < count; i++) {
  let s = 0; const off = i * DIM;
  for (let j = 0; j < DIM; j++) s += vectors[off + j] ** 2;
  const inv = 1 / (Math.sqrt(s) || 1);
  for (let j = 0; j < DIM; j++) vectors[off + j] *= inv;
}
const index = { vectors, count, meta, bonus: Float32Array.from(meta, bonusOf) };
let t = Date.now();
const lex = buildLexicalIndex(meta);
console.log(`Indice: ${count} chunk · indice lessicale ${Date.now() - t} ms, ${lex.post.size} termini`);

const llama = await getLlama();
const embedModel = await llama.loadModel({ modelPath: path.join(MODELS, "bge-m3-Q8_0.gguf") });
const embedCtx = await embedModel.createEmbeddingContext({ contextSize: 2048 });

const key = (i) => `${meta[i].url || ""} ${meta[i].title}`.toLowerCase();
// A `want` matches as a substring of "<url> <title>"; with a leading "=" it must be the
// whole key (" caracal" = the SDE record, whose url is empty — not the wiki page).
const hit = (i, w) => (w.startsWith("=") ? key(i) === w.slice(1).toLowerCase() : key(i).includes(w.toLowerCase()));
const rankOf = (ids, want) => ids.findIndex((i) => want.some((w) => hit(i, w)));
// What the model actually sees: engine.mjs fills MAX_CONTEXT_CHARS in retrieval order,
// skipping a block that does not fit. ~30 chars of tag per block.
function inBudget(ids) {
  let used = 0; const out = [];
  for (const i of ids) {
    const n = meta[i].title.length + meta[i].text.length + 30;
    if (used + n > MAX_CONTEXT_CHARS) continue;
    used += n; out.push(i);
  }
  return out;
}
let hitOld = 0, hitNew = 0, ms = 0;
for (const c of cases) {
  const q = expandQuery(c.q);
  const { vector } = await embedCtx.getEmbeddingFor(q);
  const full = denseSearch(index, vector, count).map(([, i]) => i);
  const old = rankOf(full, c.want);
  t = Date.now();
  const ids = inBudget(retrieve(index, lex, vector, q, TOP_K, opts));
  ms += Date.now() - t;
  const now = rankOf(ids, c.want);
  const oldCtx = inBudget(full.slice(0, TOP_K));
  const oldIn = rankOf(oldCtx, c.want) >= 0;
  if (oldIn) hitOld++;
  if (now >= 0) hitNew++;
  const fmt = (r, inCtx) => (r < 0 ? "  —" : `${String(r + 1).padStart(3)}${inCtx ? "" : "✗"}`);
  console.log(`${now >= 0 ? "✓" : "✗"} ${c.id.padEnd(18)} denso ${fmt(old, oldIn).padEnd(5)} ibrido ${now >= 0 ? String(now + 1).padStart(3) : "  —"}`);
  if (show) ids.forEach((i, r) => console.log(`      ${String(r + 1).padStart(2)} ${(meta[i].source || meta[i].type || "").padEnd(20)} ${meta[i].title.slice(0, 90)}`));
}
console.log(`\nNel contesto (${MAX_CONTEXT_CHARS} caratteri): denso ${hitOld}/${cases.length} → ibrido ${hitNew}/${cases.length} · ${Math.round(ms / cases.length)} ms/domanda (escluso l'embedding)`);
process.exit(hitNew >= hitOld ? 0 : 1);
