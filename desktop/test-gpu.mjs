// De-risk: load the model on GPU (Vulkan) and measure tokens/sec.
import { getLlama, LlamaChatSession } from "node-llama-cpp";

const modelPath = process.argv[2] ?? "./models/Qwen2.5-3B-Instruct-Q4_K_M.gguf";

const llama = await getLlama();            // auto-selects Vulkan/Metal/CUDA
console.log("GPU backend:", llama.gpu);    // 'vulkan' | 'metal' | 'cuda' | false

const model = await llama.loadModel({ modelPath });  // gpuLayers auto
console.log("GPU layers caricati:", model.gpuLayers, "/", model.fileInsights?.trainContextSize ? "" : "");

const ctx = await model.createContext({ contextSize: 4096 });
const session = new LlamaChatSession({ contextSequence: ctx.getSequence() });

const prompt = "Spiega in 3 frasi cos'è il tanking in EVE Online.";
const t0 = Date.now();
let tokens = 0;
const res = await session.prompt(prompt, {
  maxTokens: 200,
  onTextChunk: () => { tokens++; },
});
const dt = (Date.now() - t0) / 1000;

console.log("\n--- RISPOSTA ---\n" + res);
console.log(`\n--- METRICHE ---`);
console.log(`tempo: ${dt.toFixed(1)}s | chunk: ${tokens} | ~${(tokens / dt).toFixed(1)} chunk/s`);
