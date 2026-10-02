// End-to-end answer quality of ONE chat model on eval/answers.jsonl: the real ask()
// pipeline (retrieval + prompt + generation), scored on facts the answer must contain
// (`must`: every group needs one of its alternatives, case-insensitive), on the reply
// language, and — for `refuse` rows — on saying the sources don't have it instead of
// inventing. One process per model: VRAM is released when it exits.
//
//   node tools/eval-answers.mjs Qwen3-4B-Instruct-2507-Q4_K_M.gguf
//   IA_MODELS=/dir/with/ggufs node tools/eval-answers.mjs <file.gguf> [--only id,id] [--show]
//
// The models are linked into a scratch dir, so the app's saved model choice
// (models/.selected-model) is never touched. Ends with one JSON line for comparisons.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configurePaths, init, ask, resetConversation, shutdown } from "../src/engine.mjs";
import { detectLang } from "../src/links.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(os.homedir(), ".config", "capsuleers-ia-desktop");
const DATA = process.env.IA_DATA || path.join(APP, "data");
const MODELS = process.env.IA_MODELS || path.join(APP, "models");
const EMBED = process.env.IA_EMBED || path.join(APP, "models", "bge-m3-Q8_0.gguf");
const DATASET = path.join(HERE, "..", "..", "eval", "answers.jsonl");

const argv = process.argv.slice(2);
const file = argv.find((a) => a.endsWith(".gguf"));
if (!file) { console.error("uso: eval-answers.mjs <modello.gguf> [--only id,id] [--show]"); process.exit(2); }
const only = argv.includes("--only") ? new Set(argv[argv.indexOf("--only") + 1].split(",")) : null;
const show = argv.includes("--show");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "capsuleers-eval-"));
fs.symlinkSync(EMBED, path.join(scratch, "bge-m3-Q8_0.gguf"));
fs.symlinkSync(path.resolve(MODELS, file), path.join(scratch, file));
fs.writeFileSync(path.join(scratch, ".selected-model"), file);
configurePaths({ modelsDir: scratch, dataDir: DATA });

const REFUSAL = /non ho (questa|quest'|queste|l')?\s*informazion|non (è|e') (presente|indicat|specificat|riportat)|non (sono|risulta) disponibil|not (in|available in) the (provided )?(context|sources)|i don'?t have (this|that) information|does not (specify|mention|contain)/i;

const cases = fs.readFileSync(DATASET, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .filter((c) => !only || only.has(c.id));
const t0 = Date.now();
const info = await init(() => {});
console.log(`${file} · GPU ${info.gpu} · layer in GPU ${info.gpuLayers}/${info.totalLayers} · caricato in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

let pass = 0, ms = 0, chars = 0;
for (const c of cases) {
  resetConversation();
  const t = Date.now();
  const { answer } = await ask(c.q, () => {}, c.lang);
  const dt = Date.now() - t; ms += dt; chars += answer.length;
  const text = answer.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");   // linkified names → plain
  const facts = c.refuse ? REFUSAL.test(text)
    : (c.must || []).every((group) => group.some((alt) => text.toLowerCase().includes(alt.toLowerCase())));
  const lang = detectLang(text, c.lang) === c.lang;
  const ok = facts && lang;
  if (ok) pass++;
  console.log(`${ok ? "✓" : "✗"} ${c.id.padEnd(15)} ${(dt / 1000).toFixed(1).padStart(5)} s${facts ? "" : " · fatti mancanti"}${lang ? "" : " · lingua sbagliata"}`);
  if (show || !ok) console.log(`    ${text.replace(/\s+/g, " ").slice(0, 400)}`);
}
console.log(`\n${file}: ${pass}/${cases.length} corrette · ${(ms / cases.length / 1000).toFixed(1)} s/domanda in media`);
console.log(JSON.stringify({ model: file, pass, total: cases.length, avgSec: +(ms / cases.length / 1000).toFixed(2), avgChars: Math.round(chars / cases.length), gpuLayers: `${info.gpuLayers}/${info.totalLayers}` }));
await shutdown();
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(0);
