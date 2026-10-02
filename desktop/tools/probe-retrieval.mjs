// Shows what the RAG retrieval actually hands the model for a question: the top-K
// chunks (score, tier, source, title) exactly as engine.mjs ranks them, plus — with
// --want — the rank of the chunk(s) that SHOULD answer it. The question to ask
// before touching the prompt: "was the answer in the context at all?"
//
//   node tools/probe-retrieval.mjs "dove si droppano gli High-grade Amulet?"
//   node tools/probe-retrieval.mjs --want "february-2020-release" "dove si droppano…"
//   IA_DATA=/path/to/index IA_MODELS=./models node tools/probe-retrieval.mjs --k 30 "…"
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getLlama } from "node-llama-cpp";
import { bonusOf, tierOf } from "../src/source-tiers.mjs";
import { expandQuery } from "../src/engine.mjs";

const APP = path.join(os.homedir(), ".config", "capsuleers-ia-desktop");
const DATA = process.env.IA_DATA || path.join(APP, "data");
const MODELS = process.env.IA_MODELS || path.join(APP, "models");
const DIM = 1024;

const args = process.argv.slice(2);
let k = 12; const wants = []; const questions = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--k") k = Number(args[++i]);
  else if (args[i] === "--want") wants.push(args[++i].toLowerCase());
  else questions.push(args[i]);
}
if (!questions.length) { console.error("uso: probe-retrieval.mjs [--k N] [--want <url|titolo>] \"domanda\" …"); process.exit(2); }

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
const bonus = Float32Array.from(meta, bonusOf);

const llama = await getLlama();
const embedModel = await llama.loadModel({ modelPath: path.join(MODELS, "bge-m3-Q8_0.gguf") });
const embedCtx = await embedModel.createEmbeddingContext({ contextSize: 2048 });

for (const q of questions) {
  const { vector } = await embedCtx.getEmbeddingFor(expandQuery(q));
  const v = Float32Array.from(vector);
  let s = 0; for (let j = 0; j < DIM; j++) s += v[j] ** 2;
  const inv = 1 / (Math.sqrt(s) || 1); for (let j = 0; j < DIM; j++) v[j] *= inv;
  const scores = new Array(count);
  for (let i = 0; i < count; i++) {
    let dot = 0; const off = i * DIM;
    for (let j = 0; j < DIM; j++) dot += vectors[off + j] * v[j];
    scores[i] = [dot + bonus[i], i];
  }
  scores.sort((a, b) => b[0] - a[0]);
  console.log(`\n=== ${q}`);
  scores.slice(0, k).forEach(([sc, i], r) => {
    const m = meta[i];
    console.log(`${String(r + 1).padStart(3)}  ${sc.toFixed(3)}  L${tierOf(m).tier}  ${(m.source || m.type || "").padEnd(20)} ${m.title}`);
  });
  for (const w of wants) {
    const r = scores.findIndex(([, i]) => `${meta[i].url || ""} ${meta[i].title}`.toLowerCase().includes(w));
    console.log(`  → «${w}»: ${r < 0 ? "assente dall'indice" : `rank ${r + 1}${r < k ? "" : " (FUORI dal contesto)"}`}`);
  }
}
