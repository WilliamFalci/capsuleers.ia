// Standalone RAG engine: embedded index (in-RAM) + generation on GPU.
// No external services. Usage: node rag.mjs "your question"
import { getLlama, LlamaChatSession } from "node-llama-cpp";
import fs from "node:fs";
import readline from "node:readline";

const CHAT_MODEL = "./models/Mistral-Nemo-Instruct-2407-Q4_K_M.gguf";
const EMBED_MODEL = "./models/bge-m3-Q8_0.gguf";
const DIM = 1024;
const TOP_K = 8;
const MAX_CONTEXT_CHARS = 6000;

const SYSTEM = `Sei un assistente esperto di EVE Online. Rispondi usando SOLO il CONTESTO fornito.
- LINGUA: rispondi SEMPRE nella stessa lingua della DOMANDA. Se la domanda è in italiano, l'INTERA risposta è in italiano, anche se le fonti sono in inglese. Non cambiare lingua a metà.
- TERMINOLOGIA (tassativo): NON tradurre MAI i nomi di navi, oggetti, moduli, skill, luoghi e i termini di gioco di EVE: vanno lasciati ESATTAMENTE in inglese, come nel gioco e nel contesto. Esempi corretti: "Sovereignty Hub" (NON "Hub di Sovranità"), "Entosis Link", "relic site" e "data site" (NON "siti di reliquie/dati"), "Damage Control II", "high slot", "Sovereignty". Traduci solo il testo discorsivo attorno a questi nomi.
- Scrivi in italiano CORRETTO e grammaticale: niente errori di ortografia né parole inventate (es. "alleanza" non "alianza", "schierare/deployare" non "deplofare"). Se non sei certo di una parola italiana, usane una più semplice e corretta.
- Usa SOLO le informazioni nel contesto. Se non bastano, dillo ("Non ho questa informazione nelle fonti"); non inventare. Sii conciso e preciso.`;

// --- Load the embedded index into memory ---
function loadIndex() {
  const buf = fs.readFileSync("./data/index.vec");
  const vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const count = vectors.length / DIM;
  // normalize each vector (so cosine = dot product)
  for (let i = 0; i < count; i++) {
    let s = 0; const off = i * DIM;
    for (let j = 0; j < DIM; j++) s += vectors[off + j] ** 2;
    const inv = 1 / (Math.sqrt(s) || 1);
    for (let j = 0; j < DIM; j++) vectors[off + j] *= inv;
  }
  const meta = fs.readFileSync("./data/index.meta.jsonl", "utf-8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { vectors, count, meta };
}

function topK(index, query) {
  const q = Float32Array.from(query);
  let s = 0; for (let j = 0; j < DIM; j++) s += q[j] ** 2;
  const inv = 1 / (Math.sqrt(s) || 1); for (let j = 0; j < DIM; j++) q[j] *= inv;
  const scores = new Array(index.count);
  for (let i = 0; i < index.count; i++) {
    let dot = 0; const off = i * DIM;
    for (let j = 0; j < DIM; j++) dot += index.vectors[off + j] * q[j];
    scores[i] = [dot, i];
  }
  scores.sort((a, b) => b[0] - a[0]);
  return scores.slice(0, TOP_K).map(([score, i]) => ({ score, ...index.meta[i] }));
}

// --- Main ---
const question = process.argv.slice(2).join(" ") || "Quali skill servono per un Caracal?";
console.error("Carico indice…");
const index = loadIndex();
console.error(`Indice: ${index.count} chunk.`);

const llama = await getLlama();
console.error("GPU:", llama.gpu);
const embedModel = await llama.loadModel({ modelPath: EMBED_MODEL });
const embedCtx = await embedModel.createEmbeddingContext({ contextSize: 2048 });
const chatModel = await llama.loadModel({ modelPath: CHAT_MODEL });

const { vector } = await embedCtx.getEmbeddingFor(question);
const hits = topK(index, vector);

let context = "", used = 0;
for (const h of hits) {
  const block = `[${h.type}] ${h.title}\n${h.text}`;
  if (used + block.length > MAX_CONTEXT_CHARS) break;
  context += block + "\n\n---\n\n"; used += block.length;
}

const chatCtx = await chatModel.createContext({ contextSize: 4096 });
const session = new LlamaChatSession({ contextSequence: chatCtx.getSequence(), systemPrompt: SYSTEM });

const t0 = Date.now();
process.stdout.write("\n=== RISPOSTA ===\n");
await session.prompt(`CONTESTO:\n${context}\nDOMANDA: ${question}`, {
  maxTokens: 400,
  onTextChunk: (t) => process.stdout.write(t),
});
console.log(`\n\n=== FONTI ===`);
for (const h of hits.slice(0, 5)) console.log(` - [${h.type}] ${h.title}${h.url ? " — " + h.url : ""}`);
console.log(`\n(tempo: ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
