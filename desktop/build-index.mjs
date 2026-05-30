// Builds the embedded index for the standalone app: re-embeds the corpus (the
// ingestion JSONL dump) with bge-m3 ON GPU and saves vectors + metadata to file.
// No Qdrant/Ollama: everything is local.
//
//   node build-index.mjs
//
// Output in ./data/: index.vec (raw Float32) + index.meta.jsonl (id/title/type/url/text)
import { getLlama } from "node-llama-cpp";
import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";

const EMBED_MODEL = "./models/bge-m3-Q8_0.gguf";
const SOURCES = [
  "../ingestion/data/docs_sde.jsonl",
  "../ingestion/data/docs_wiki.jsonl",
];
const OUT_DIR = "./data";
const DIM = 1024;

fs.mkdirSync(OUT_DIR, { recursive: true });

const BATCH = 48;  // concurrent embeddings to make use of the GPU

const llama = await getLlama();
console.log("GPU backend:", llama.gpu);
const model = await llama.loadModel({ modelPath: EMBED_MODEL });
const ctx = await model.createEmbeddingContext({ contextSize: 8192, batchSize: 8192 });
console.log("Embedding model caricato (dim attesa", DIM + ").");

const vecOut = fs.createWriteStream(path.join(OUT_DIR, "index.vec"));
const metaOut = fs.createWriteStream(path.join(OUT_DIR, "index.meta.jsonl"));

let n = 0;
const t0 = Date.now();

async function flush(batch) {
  // Concurrent embeddings, results in order.
  const vecs = await Promise.all(batch.map((o) => ctx.getEmbeddingFor(o.text)));
  for (let i = 0; i < batch.length; i++) {
    const f32 = Float32Array.from(vecs[i].vector);
    if (f32.length !== DIM) throw new Error(`dim ${f32.length} != ${DIM}`);
    vecOut.write(Buffer.from(f32.buffer));
    const o = batch[i], m = o.metadata ?? {};
    metaOut.write(JSON.stringify({ id: o.id, text: o.text, title: m.title, type: m.type, url: m.url ?? null }) + "\n");
  }
  n += batch.length;
  const rate = n / ((Date.now() - t0) / 1000);
  console.log(`${n} embeddati (${rate.toFixed(0)}/s)`);
}

let batch = [];
for (const src of SOURCES) {
  if (!fs.existsSync(src)) { console.warn("salto (assente):", src); continue; }
  const rl = readline.createInterface({ input: fs.createReadStream(src), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    batch.push(JSON.parse(line));
    if (batch.length >= BATCH) { await flush(batch); batch = []; }
  }
}
if (batch.length) await flush(batch);
vecOut.end(); metaOut.end();
console.log(`Fatto: ${n} chunk in ${((Date.now() - t0) / 1000).toFixed(0)}s → ${OUT_DIR}/index.vec + index.meta.jsonl`);
