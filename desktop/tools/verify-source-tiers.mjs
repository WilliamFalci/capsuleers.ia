// Verifies the source hierarchy (src/source-tiers.mjs) against the REAL index:
//   1. the rule on known hosts/sources (pure);
//   2. every chunk of the index resolves to a tier, and none falls to the
//      "unknown host" fallback — a new source added to ingestion without a row
//      in source-tiers.mjs would land there silently, at the lowest trust;
//   3. the retrieval nudge: on real questions, how much it reorders top-K and
//      how it compares to the score spread it is meant to break ties within.
//
//   node tools/verify-source-tiers.mjs            # index + models from the app's data dir
//   IA_DATA=… IA_MODELS=… node tools/verify-source-tiers.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tierOf, TIER_BONUS } from "../src/source-tiers.mjs";

const APP = path.join(os.homedir(), ".config", "capsuleers-ia-desktop");
const DATA = process.env.IA_DATA || path.join(APP, "data");
const MODELS = process.env.IA_MODELS || path.join(APP, "models");
const DIM = 1024, TOP_K = 12;

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) fail++; };

// ── 1. The rule ────────────────────────────────────────────────────────────
const cases = [
  [{ url: null }, 1], [{ source: "ccp_sde", url: null }, 1],
  [{ url: "https://esi.evetech.net/" }, 1],
  [{ url: "https://developers.eveonline.com/docs/guides/skinr/" }, 1],
  [{ url: "https://www.eveonline.com/news/view/patch-notes" }, 1],
  [{ url: "https://everef.net/" }, 2],
  [{ url: "https://wiki.eveuniversity.org/Warp_Scrambler" }, 3],
  [{ url: "https://www.eve-scout.com/" }, 3], [{ url: "https://eve-kill.com/character/1" }, 3],
  [{ url: "https://evemaps.dotlan.net/map/Delve" }, 3], [{ url: "https://zkillboard.com/" }, 3],
  [{ url: "https://eve.fandom.com/wiki/Rifter" }, 4], [{ url: "https://sistersprobe.fandom.com/wiki/X" }, 4],
  [{ url: "https://eve-survival.org/?wakka=X" }, 4], [{ url: "https://eveworkbench.com/" }, 4],
  [{ url: "https://www.riley-entertainment.com/gaming/eve-online/" }, 4],
  // source wins over URL; an unknown host is lowest trust, never trusted by default.
  [{ source: "eve_university_wiki", url: "https://example.org/" }, 3],
  [{ url: "https://example.org/" }, 4],
  // suffix match must be on a label boundary: "noteveonline.com" is not CCP.
  [{ url: "https://noteveonline.com/" }, 4],
];
for (const [hit, want] of cases) {
  const got = tierOf(hit).tier;
  ok(got === want, `tierOf(${hit.source ?? ""}${hit.url ?? "url=null"}) = L${got} (atteso L${want})`);
}
ok(TIER_BONUS[1] > TIER_BONUS[2] && TIER_BONUS[2] > TIER_BONUS[3] && TIER_BONUS[3] > TIER_BONUS[4],
  "il bonus decresce strettamente con il livello");

// ── 2. The real index ──────────────────────────────────────────────────────
const metaPath = path.join(DATA, "index.meta.jsonl");
if (!fs.existsSync(metaPath)) {
  console.log(`\n(indice assente in ${DATA}: salto i controlli sui dati)`);
  process.exit(fail ? 1 : 0);
}
const meta = fs.readFileSync(metaPath, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const dist = { 1: 0, 2: 0, 3: 0, 4: 0 };
const unknown = new Map();
for (const m of meta) {
  const t = tierOf(m);
  dist[t.tier]++;
  if (t.unknown) unknown.set(t.label, (unknown.get(t.label) || 0) + 1);
}
console.log(`\nindice: ${meta.length} chunk · L1 ${dist[1]} · L2 ${dist[2]} · L3 ${dist[3]} · L4 ${dist[4]}` +
  ` · con campo source: ${meta.filter((m) => m.source).length}`);
ok(unknown.size === 0, `nessun host senza riga in source-tiers.mjs${unknown.size ? ": " + [...unknown].map(([h, n]) => `${h} (${n})`).join(", ") : ""}`);
ok(dist[1] > 0 && dist[3] > 0, "l'indice ha sia fonti L1 sia L3");

// ── 3. The retrieval nudge on real questions ───────────────────────────────
const embedPath = path.join(MODELS, "bge-m3-Q8_0.gguf");
if (!fs.existsSync(embedPath)) {
  console.log(`\n(modello di embedding assente in ${MODELS}: salto la misura del retrieval)`);
  process.exit(fail ? 1 : 0);
}
const { getLlama } = await import("node-llama-cpp");
const llama = await getLlama();
const model = await llama.loadModel({ modelPath: embedPath });
const ectx = await model.createEmbeddingContext();

const buf = fs.readFileSync(path.join(DATA, "index.vec"));
const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const n = Math.min(meta.length, vec.length / DIM);
for (let i = 0; i < n; i++) {
  let s = 0; const o = i * DIM;
  for (let j = 0; j < DIM; j++) s += vec[o + j] ** 2;
  const inv = 1 / (Math.sqrt(s) || 1);
  for (let j = 0; j < DIM; j++) vec[o + j] *= inv;
}
const bonus = Float32Array.from(meta.slice(0, n), (m) => TIER_BONUS[tierOf(m).tier]);

const QUESTIONS = [
  "What does a Warp Scrambler do?", "Come funziona l'entosis link?",
  "What skills do I need to fly a Heron?", "Rifter ship bonuses",
  "How do wormhole statics work?", "What is a C5 wormhole system effect Magnetar?",
  "How does sovereignty work in nullsec?", "Quali sono i requisiti per la Drake?",
  "How to run a relic site?", "What is the Mass Production skill?",
  "How do I make ISK as a new player?", "What are Abyssal deadspace filaments?",
  "Blueprint materials for Tengu", "Cosa fa il modulo Damage Control II?",
  "Where is Jita?", "How does jump fatigue work?",
  "What is a Titan?", "Level 4 mission Buzz Kill tips",
  "How do I scan down a data site?", "What is the capacitor recharge time?",
];
let changed = 0, moved = 0, gaps = [], tierShift = 0;
for (const q of QUESTIONS) {
  const e = Float32Array.from((await ectx.getEmbeddingFor(q)).vector);
  let s = 0; for (let j = 0; j < DIM; j++) s += e[j] ** 2;
  const inv = 1 / Math.sqrt(s); for (let j = 0; j < DIM; j++) e[j] *= inv;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) { let d = 0; const o = i * DIM; for (let j = 0; j < DIM; j++) d += vec[o + j] * e[j]; raw[i] = d; }
  const idx = [...Array(n).keys()];
  const plain = idx.slice().sort((a, b) => raw[b] - raw[a]).slice(0, TOP_K);
  const tiered = idx.slice().sort((a, b) => raw[b] + bonus[b] - raw[a] - bonus[a]).slice(0, TOP_K);
  gaps.push(raw[plain[0]] - raw[plain[TOP_K - 1]]);
  const diff = tiered.filter((i) => !plain.includes(i)).length;
  if (diff) changed++;
  moved += diff;
  const avg = (arr) => arr.reduce((a, i) => a + tierOf(meta[i]).tier, 0) / arr.length;
  tierShift += avg(plain) - avg(tiered);
  console.log(`  ${diff ? "~" : " "} ${q}  — ${diff}/${TOP_K} sostituiti, livello medio ${avg(plain).toFixed(2)} → ${avg(tiered).toFixed(2)}`);
}
gaps.sort((a, b) => a - b);
console.log(`\ndistanza di punteggio fra il 1° e il ${TOP_K}° risultato: mediana ${gaps[gaps.length >> 1].toFixed(3)}, min ${gaps[0].toFixed(3)}, max ${gaps.at(-1).toFixed(3)}`);
console.log(`domande con top-${TOP_K} cambiato: ${changed}/${QUESTIONS.length}, chunk sostituiti in tutto: ${moved}, spostamento medio di livello: ${(tierShift / QUESTIONS.length).toFixed(2)}`);
// The nudge must break ties, not rewrite answers: at most a third of the context
// replaced on average, and its span (L1 − L4) well below the typical top-K spread.
ok(moved / QUESTIONS.length <= TOP_K / 3, `in media al più ${TOP_K / 3} chunk sostituiti per domanda (${(moved / QUESTIONS.length).toFixed(1)})`);
ok(TIER_BONUS[1] - TIER_BONUS[4] < gaps[gaps.length >> 1], "l'escursione del bonus sta sotto la distanza mediana del top-K");
await ectx.dispose(); await model.dispose();
process.exit(fail ? 1 : 0);
