// Reusable RAG engine for the desktop app: embedded in-RAM index + GPU.
// init() loads models and index once; ask() answers in streaming.
import { getLlama, LlamaChatSession, readGgufFileInfo, GgufInsights } from "node-llama-cpp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { looksLikeFit, parseEft, describeFit, warmFitEngine } from "./fit.mjs";
import { priceByName, isKnownType, configureDataDir as pricesDataDir } from "./prices.mjs";
import { intelFor, intelForCandidate } from "./intel.mjs";
import { corpSummary, characterAffiliation, systemActivity } from "./esi.mjs";
import { scoutConnections } from "./eve-scout.mjs";
import { maybeMcp, resetDoctrineMemory } from "./mcp-intel.mjs";
import { maybeWorkbench, resetFitMemory } from "./eveworkbench.mjs";
import { linkify, detectLang, configureDataDir as linksDataDir } from "./links.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DEFAULT_MODEL = "Qwen3-4B-Instruct-2507-Q4_K_M.gguf";  // starting chat model

// Models and data directories. In development (electron . / node rag.mjs) they live inside
// the project (desktop/models, desktop/data). In the packaged app the app dir is
// read-only and gets overwritten on every update, so the assets (downloaded on-demand)
// live in app.getPath("userData"): main.mjs calls configurePaths() before init().
let MODELS_DIR = path.join(ROOT, "models");
let DATA = path.join(ROOT, "data");
let EMBED_MODEL = path.join(MODELS_DIR, "bge-m3-Q8_0.gguf");
// File where we remember the last model the user picked (in models/, next to the
// .gguf files, so it stays alongside the assets and outside the app package).
let MODEL_CHOICE_FILE = path.join(MODELS_DIR, ".selected-model");

/** Redirects models and index to external directories (e.g. userData) when the app is
 *  packaged. Must be called BEFORE init(). With no arguments it changes nothing. */
export function configurePaths({ modelsDir, dataDir } = {}) {
  if (modelsDir) MODELS_DIR = modelsDir;
  if (dataDir) DATA = dataDir;
  EMBED_MODEL = path.join(MODELS_DIR, "bge-m3-Q8_0.gguf");
  MODEL_CHOICE_FILE = path.join(MODELS_DIR, ".selected-model");
  // Sibling modules read their own lookup files (names_index, links) from the SAME
  // data dir — point them there too, or the packaged app looks inside app.asar.
  // (fit.mjs no longer needs this: its SDE is bundled in eve-fit-engine/node.)
  if (dataDir) { pricesDataDir(dataDir); linksDataDir(dataDir); }
}

const DIM = 1024, TOP_K = 12, MAX_CONTEXT_CHARS = 6000;
// Min cosine similarity (new question vs the previous one) to consider the prior
// turn relevant and include it as context. Too much history confuses the model, so
// we keep at most ONE turn, and only when it's actually on-topic.
const HIST_SIM = 0.5;

// Cosine similarity between two embedding vectors.
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
const EXPECTED_EMBED = "bge-m3";  // the index MUST have been built with this embedder

/**
 * Checks that the on-disk index is compatible with this version of the app, so that
 * a corrupted/differently-sized index fails IMMEDIATELY with a clear message
 * instead of producing garbage answers. Pure function (testable without models).
 * @param {{vecBytes:number, metaCount:number, sidecar?:{dim?:number,embedModel?:string,version?:string}}} o
 * @returns {number} the number of vectors (count)
 */
export function checkIndexCompat({ vecBytes, metaCount, sidecar } = {}) {
  if (!vecBytes || vecBytes % (DIM * 4) !== 0)
    throw new Error(`Indice corrotto o incompatibile: index.vec (${vecBytes} byte) non è un multiplo di ${DIM} float (embedder atteso: ${EXPECTED_EMBED}). Riscarica l'indice.`);
  const count = vecBytes / 4 / DIM;
  if (metaCount !== count)
    throw new Error(`Indice incoerente: ${count} vettori ma ${metaCount} righe di metadati. Riscarica l'indice.`);
  if (sidecar) {
    if (sidecar.dim && sidecar.dim !== DIM)
      throw new Error(`Indice incompatibile: dimensione ${sidecar.dim} ≠ ${DIM} attesa. Riscarica l'indice.`);
    if (sidecar.embedModel && sidecar.embedModel !== EXPECTED_EMBED)
      throw new Error(`Indice incompatibile: costruito con ${sidecar.embedModel}, ma serve ${EXPECTED_EMBED}. Riscarica l'indice.`);
  }
  return count;
}
// Reduced chat context: less KV cache → ~2-4GB models fit (almost) entirely in GPU
// even with other apps using VRAM. createChatContext() shrinks further if needed.
const CHAT_CTX = 4096;

const SYSTEM = `Sei un assistente esperto di EVE Online. Rispondi usando SOLO il CONTESTO fornito.
- LINGUA: rispondi SEMPRE nella stessa lingua della DOMANDA. Se la domanda è in italiano, l'INTERA risposta è in italiano, anche se le fonti sono in inglese. Non cambiare lingua a metà.
- TERMINOLOGIA (tassativo): NON tradurre MAI i nomi di navi, oggetti, moduli, skill, luoghi e i termini di gioco di EVE: vanno lasciati ESATTAMENTE in inglese, come nel gioco e nel contesto. Esempi corretti: "Sovereignty Hub" (NON "Hub di Sovranità"), "Entosis Link", "relic site" e "data site" (NON "siti di reliquie/dati"), "Damage Control II", "high slot", "Sovereignty". Traduci solo il testo discorsivo attorno a questi nomi.
- Scrivi in italiano CORRETTO e grammaticale: niente errori di ortografia né parole inventate (es. "alleanza" non "alianza", "schierare/deployare" non "deplofare"). Se non sei certo di una parola italiana, usane una più semplice e corretta.
- QUANTITÀ E NUMERI (tassativo): quando il contesto riporta quantità, prezzi, tempi, percentuali o livelli (es. "3× Capital Capacitor Battery", "200× Life Support Backup Unit", "skill ... 3", ISK, ore), riportali SEMPRE ed ESATTAMENTE come nel contesto, senza ometterli né arrotondarli. In una lista di materiali/requisiti METTI la quantità davanti a OGNI voce (es. "3× Capital Capacitor Battery", non "Capital Capacitor Battery"). Non aggiungere descrizioni inventate non presenti nel contesto.
- Usa SOLO le informazioni nel contesto. Se non bastano, dillo ("Non ho questa informazione nelle fonti"); non inventare. Sii conciso e preciso.`;

// System prompt for FIT analysis: unlike the strict factual one, theorycrafting
// needs the model's general EVE knowledge. The computed stats stay authoritative.
const SYSTEM_FIT = `Sei un esperto di fitting di EVE Online e stai analizzando un fit incollato dall'utente.
- LINGUA: rispondi SEMPRE nella lingua indicata dalla direttiva finale. Non cambiare lingua a metà.
- TERMINOLOGIA (tassativo): NON tradurre MAI i nomi di navi, moduli, skill e termini di gioco di EVE: restano ESATTAMENTE in inglese (es. "Damage Control II", "high slot", "Microwarpdrive").
- I NUMERI dell'ANALISI DEL FIT (DPS, EHP, velocità, cap stability) sono AUTOREVOLI: riportali ESATTAMENTE come forniti, non inventarne altri né ricalcolarli.
- Puoi usare la tua conoscenza generale di EVE per spiegare il RUOLO della nave e fare theorycrafting (a cosa serve il fit, PvP/PvE, punti di forza e debolezze, come si vola), ma sii accurato: se non sei certo, dillo.
- Scrivi in modo CORRETTO, conciso e ben strutturato (usa i punti elenco richiesti dalla direttiva).`;

// Explicit language directive, in the target language, to place AT THE END of the prompt
// (maximum salience): it overrides the dominant language of the context (intel/ESI in IT).
const LANG_DIRECTIVE = {
  it: "Rispondi in ITALIANO, indipendentemente dalla lingua del contesto qui sopra.",
  en: "Reply in ENGLISH only, regardless of the language of the context above.",
};

// EVE slang expansion to improve retrieval (the short/abbreviated query embeds
// poorly: e.g. "sov" was matching "SSO"). For search only, not for the prompt.
const EVE_SLANG = {
  sov: "sovereignty", wh: "wormhole", ewar: "electronic warfare",
  dps: "damage per second", rr: "remote repair", lp: "loyalty points",
  pi: "planetary interaction", fw: "factional warfare", ng: "null-sec",
  cyno: "cynosural field", jf: "jump freighter", hs: "high-sec", ls: "low-sec",
};
function expandQuery(q) {
  return q.replace(/\b([a-z]{2,4})\b/gi, (m) => EVE_SLANG[m.toLowerCase()] ? `${m} ${EVE_SLANG[m.toLowerCase()]}` : m);
}

let llama, embedCtx, chatModel, index;
let currentModelFile = null;  // file name (.gguf) of the chat model currently loaded
let history = [];  // conversation: [{ q, a }] for follow-ups
let convLang = null;  // language of the current conversation (so follow-ups don't flip)
// Disambiguation: when "chi è X" matches >1 entity exactly across types, we ask which
// one and stash the candidates here; the next turn's reply resolves against them.
let pendingDisambiguation = null;  // { name, candidates, opts, question }
let forcedIntel = null;            // intel pre-resolved from a disambiguation choice (consumed by maybeIntel)

// In-flight generation: AbortController + active context. Needed to cancel
// cleanly when the app closes while the model is still answering
// (otherwise llama's native AsyncWorker blows up in Napi::Error → terminate).
let activeAbort = null;
let activeCtx = null;

export function resetConversation() { history = []; convLang = null; pendingDisambiguation = null; forcedIntel = null; resetDoctrineMemory(); resetFitMemory(); }

/** File (.gguf) of the chat model currently loaded (null if none). */
export function currentModel() { return currentModelFile; }

/** Delete a downloaded chat model from the models dir to free disk space. Refuses
 *  the model in use and the embedding model. Works in dev and packaged (MODELS_DIR). */
export async function deleteModelFile(file) {
  if (!/^[^/\\]+\.gguf$/i.test(file || "") || /bge|embed/i.test(file)) return { error: "Modello non valido." };
  if (file === currentModelFile) return { error: "Modello in uso: passa a un altro prima di eliminarlo." };
  try {
    await fs.promises.unlink(path.join(MODELS_DIR, file));
    await fs.promises.unlink(path.join(MODELS_DIR, file + ".part")).catch(() => {});
    return { ok: true };
  } catch (e) { return { error: e.message }; }
}

// Cancels the generation currently in progress (if any). Returns a promise
// that resolves once the generation has truly finished tearing down.
export async function cancel() {
  if (activeAbort) activeAbort.abort();
  // Waits for ask() to exit the finally (context disposal) before returning.
  for (let i = 0; i < 50 && activeCtx; i++) await new Promise((r) => setTimeout(r, 20));
}

// Orderly shutdown: cancel the generation and wait. To be called before
// closing the app, so no native work is in flight when the JS environment dies.
export async function shutdown() {
  try { await cancel(); } catch { /* best-effort */ }
}

// Creates a chat context that tolerates scarce VRAM: if the requested size
// doesn't fit (InsufficientMemoryError, typical when other apps occupy the GPU),
// it retries with progressively smaller contexts instead of failing outright.
async function createChatContext(size = CHAT_CTX) {
  const ladder = [...new Set([size, 3072, 2560, 2048, 1536, 1024])]
    .filter((s) => s <= size).sort((a, b) => b - a);
  let lastErr;
  for (const contextSize of ladder) {
    try { return await chatModel.createContext({ contextSize }); }
    catch (e) {
      lastErr = e;
      // Only memory errors are recoverable by stepping down in size.
      if (!/insufficient|memory|vram/i.test(String(e?.message || e))) throw e;
    }
  }
  throw lastErr;
}

// Rewrites a follow-up into a standalone question using the history (for retrieval).
async function condense(question) {
  if (history.length === 0) return question;
  const h = history.slice(-1).map((t) => `Utente: ${t.q}\nAssistente: ${t.a}`).join("\n");
  const ctx = await createChatContext(1536);
  activeCtx = ctx;
  activeAbort = new AbortController();
  const session = new LlamaChatSession({
    contextSequence: ctx.getSequence(),
    systemPrompt: "Riscrivi l'ultima domanda dell'utente come domanda autonoma e completa, risolvendo i riferimenti alla conversazione precedente. Mantieni la lingua originale. Rispondi SOLO con la domanda riscritta, niente altro.",
  });
  let out = "";
  try {
    out = await session.prompt(`Conversazione:\n${h}\n\nUltima domanda: ${question}`, { maxTokens: 80, temperature: 0.1, signal: activeAbort.signal });
  } catch (e) {
    if (!activeAbort.signal.aborted) throw e;  // expected cancellation → fall back to the original question
  } finally {
    try { await ctx.dispose(); } catch { /* already tearing down */ }
    activeCtx = null;
    activeAbort = null;
  }
  return out.trim() || question;
}

// Estimated cost of a fit (sum of average prices of ship + modules). Requires internet.
async function fitCost(fit) {
  let total = 0, any = false;
  for (const name of [fit.ship, ...fit.modules.map((m) => m.name)]) {
    const p = await priceByName(name);
    if (p.found && p.average) { total += p.average; any = true; }
  }
  return any ? `Costo stimato (prezzi medi globali, escluse cariche): ~${Math.round(total).toLocaleString("it-IT")} ISK.` : "";
}

// Live intel (eve-kill): detect the intent and the name of the entity to look up.
function _cleanName(s) {
  return s.replace(/[?.!,;]+$/g, "")
    .replace(/\b(in eve(\s+online)?|la corp(orazione)?|l['’]alleanza|il (personaggio|pilota|player)|the (character|pilot|player|corp(oration)?|alliance))\b/gi, "")
    .trim();
}
function intelQuery(q) {
  // "Tell me about an entity" intents: chi è/sono X · X chi è · che (mi) sai dire · dimmi · parlami · info su…
  let m = q.match(/\bchi\s+(?:è|e|sono)\s+(.+)/i)            // IT "chi è X"
    || q.match(/^\s*(.+?)\s+chi\s+(?:è|e|sono)(?=\s|[?!.]|$)/i)  // IT "X chi è"
    || q.match(/\bwho\s+(?:is|are|the\s+\w+\s+is)\s+(.+)/i)   // EN "who is X"
    || q.match(/\b(?:che\s+(?:mi\s+)?sai\s+dire|cosa\s+(?:mi\s+)?sai|dimmi|parlami|raccontami|info(?:rmazioni)?|dammi info)\s+(?:su|di|della|dello|del|dei|sull[ao']?|dell[ao']?)\s+(.+)/i)  // IT "parlami di X"
    || q.match(/\b(?:tell\s+me\s+about|what\s+(?:do|can)\s+you\s+(?:know|tell\s+me)\s+about|what'?s\s+the\s+(?:deal|story)\s+(?:with|on)|info(?:rmation)?\s+(?:on|about)|look\s+up|search\s+for|find\s+(?:out\s+about)?)\s+(.+)/i);  // EN "tell me about X"
  if (m) return _cleanName(m[1]);
  if (!/\b(killboard|killmail|intel|kills?|losses|perdite|stat(?:s|istiche)?|battagli|pvp|efficien)/i.test(q)) return "";
  m = q.match(/["']([^"']{2,48})["']/);
  if (m) return _cleanName(m[1]);
  // everything after the trigger, then iteratively strips leading preps/articles/entity-types
  let s = q.replace(/^[\s\S]*?\b(?:killboard|killmail|intel|kills?|losses|perdite|stat\w*|battagli\w*|pvp|efficien\w*)\b/i, "");
  let prev;
  do {
    prev = s;
    s = s.replace(/^[\s,:.'’]+/, "")
      .replace(/^(?:su|sulla|sullo|sull|della|dello|dell|del|dei|degli|delle|di|d|about|on|for|the|la|il|lo|le|gli|l|un|una)\b['’]?\s*/i, "")
      .replace(/^(?:alleanza|alliance|corp(?:orazione)?|corporation|personaggio|pilota|player|character|giocatore)\b\s*/i, "");
  } while (s !== prev);
  return _cleanName(s);
}
async function maybeIntel(question) {
  const empty = { text: "", entities: [], kills: [] };
  // A disambiguation choice was just resolved: serve that intel directly (don't re-search,
  // which would re-trigger the same ambiguity for the same name).
  if (forcedIntel) { const r = forcedIntel; forcedIntel = null; return r; }
  const name = intelQuery(question);
  if (!name || name.length < 2) return empty;
  // If the name is a known EVE type (e.g. "Caracal"), it's a game question → leave it to RAG.
  try { if (await isKnownType(name)) return empty; } catch { /* ignore */ }
  const opts = {
    kills: /\bkill/i.test(question),
    losses: /\b(perdit|loss)/i.test(question),
    battles: /\b(battagli|battle)/i.test(question),
  };
  try {
    const r = await intelFor(name, opts);
    // Ambiguous across entity types → surface it so ask() can ask the user which one.
    if (r && r.ambiguous) return { ...empty, ambiguous: { ...r, opts } };
    return r || empty;
  } catch { return empty; }
}

// ── Disambiguation helpers ───────────────────────────────────────────────────
const _ENT_LABEL = {
  it: { character: "personaggio", corporation: "corporazione", alliance: "alleanza" },
  en: { character: "character", corporation: "corporation", alliance: "alliance" },
};
// "Which one did you mean?" question listing the exact-match candidates.
function buildDisambiguationQuestion(amb, lang) {
  const L = _ENT_LABEL[lang === "it" ? "it" : "en"];
  const lines = amb.candidates.map((c, i) => {
    const tick = c.ticker ? ` [${c.ticker}]` : "";
    return `${i + 1}. ${c.name}${tick} — ${L[c.type] || c.type}`;
  });
  return lang === "it"
    ? `Esistono più entità con il nome «${amb.name}». Quale intendi?\n${lines.join("\n")}\n\nRispondi col numero o col tipo (es. "${L.character}", "${L.corporation}").`
    : `There are multiple entities named “${amb.name}”. Which one do you mean?\n${lines.join("\n")}\n\nReply with the number or the type (e.g. "${L.character}", "${L.corporation}").`;
}
// Interprets a reply to a disambiguation question → the chosen candidate, or null if
// the reply doesn't clearly pick one (the user moved on to a different question).
function matchDisambiguationChoice(reply, candidates) {
  const r = ` ${reply.trim().toLowerCase()} `;
  const numM = r.match(/\b(?:opzione|option|n\.?|numero|number)?\s*([1-9])\b/);
  let idx = numM ? Number(numM[1]) : null;
  if (!idx) {
    const ord = { primo: 1, prima: 1, secondo: 2, seconda: 2, terzo: 3, terza: 3, first: 1, second: 2, third: 3 };
    for (const [w, n] of Object.entries(ord)) if (new RegExp(`\\b${w}\\b`).test(r)) { idx = n; break; }
  }
  if (idx && candidates[idx - 1]) return candidates[idx - 1];
  const typeOf = /\b(personagg|pilota|character|char|player|capsuleer)\w*/i.test(r) ? "character"
    : /\b(corp|corporazion|corporation)\w*/i.test(r) ? "corporation"
    : /\b(allean|alliance)\w*/i.test(r) ? "alliance" : null;
  if (typeOf) { const c = candidates.find((x) => x.type === typeOf); if (c) return c; }
  const byName = candidates.find((x) => r.includes(` ${x.name.toLowerCase()} `) || (x.ticker && r.trim() === x.ticker.toLowerCase()));
  return byName || null;
}

// Iteratively strips leading prepositions/articles/entity-types from a string.
function _stripLead(s) {
  let prev;
  do {
    prev = s;
    s = s.replace(/^[\s,:.'’"]+/, "")
      .replace(/^(?:dell[ao']?|degli|delle|dei|della|dello|del|di|d|of|the|gli|le|la|il|lo|i|l['’]|su|sulla?|sullo|sull|in|nella?|nello|nel|for|per)\b['’]?\s*/i, "")
      .replace(/^(?:corp(?:orazione|oration)?|alleanza|alliance|gruppo|group)\b\s*/i, "");
  } while (s !== prev);
  return s;
}
// Removes trailing temporal adverbs ("adesso", "right now"…) from an area name.
function _trimArea(s) {
  return s.replace(/\b(right\s+now|at\s+the\s+moment|currently|now|today|in\s+questo\s+momento|adesso|attualmente|al\s+momento|ora|oggi)\b/gi, "")
    .replace(/\s{2,}/g, " ").trim().replace(/[?.!,]+$/, "");
}

// Official ESI data (Fenris Creations): corp/alliance profile (CEO…) and system activity
// by area. Bilingual intent detection (IT/EN), object name auto-extracted.
async function maybeEsi(question) {
  const empty = { text: "", entities: [] };
  const q = question;

  // 1) System activity by area (region/constellation/system).
  if (/\b(sistemi?\s+(?:pi[ùu]\s+)?attiv\w*|attivit[àa]\s+(?:dei\s+|nei\s+)?sistem\w*|dove\s+si\s+combatte|sistemi?\s+cald\w*|(?:most\s+)?active\s+systems?|system\s+activity|hotspots?|busiest\s+systems?|where(?:'?s|\s+is)\s+the\s+(?:action|fight|fighting)|most\s+(?:jumps|kills))\b/i.test(q)) {
    const opts = {};
    if (/\b(jump|salti|traffic\w*|traffico)\b/i.test(q)) opts.metric = "jumps";
    // Optional area: if not specified (or not resolvable) → the whole universe.
    const m = q.match(/\b(?:in|nel|nella|nello|della?|del|of|within)\s+([A-Za-z][\w'’\- ]+?)\s*(?:[?.!,]|$)/);
    const area = m ? _cleanName(_trimArea(m[1])) : null;
    try {
      let r = area ? await systemActivity(area, opts) : null;
      if (!r) r = await systemActivity(null, opts);  // no region → universe
      return r || empty;
    } catch { return empty; }
  }

  // 2) Character affiliation: which corp/alliance does X belong to?
  {
    let m = q.match(/\bin\s+(?:che|quale)\s+(?:corp\w*|alleanz\w*|allianc\w*)\s+(?:sta|è|e|milit\w*|gioc\w*|vol\w*|si\s+trova|si\s+trovano)?\s*(.+)/i)  // "in che corp sta X"
      || q.match(/\b(?:corp\w*|alleanz\w*|allianc\w*)\s+(?:di|of)\s+(.+)/i)                                  // "corp di X"
      || q.match(/\bwh(?:ich|at)\s+(?:corp\w*|allianc\w*)\s+(?:is|does)\s+(.+?)\s+(?:in|belong|fly|member)/i)  // "which corp is X in"
      || q.match(/\b(.+?)['’]s\s+(?:corp\w*|allianc\w*)\b/i)                                                 // "X's corp"
      || q.match(/\bdove\s+(?:sta|milit\w*|gioc\w*|vol\w*)\s+(.+)/i);                                        // "dove milita X"
    if (m) {
      const name = _cleanName(m[1]);
      if (name && name.length >= 2) {
        try { const r = await characterAffiliation(name); if (r) return r; } catch { /* fall-through */ }
      }
    }
  }

  // 3) CEO / leadership of a corporation or alliance.
  if (/\b(ceo|amministratore\s+delegato|direttore|chi\s+(?:comanda|guida|è\s+a\s+capo|dirige)|executor|who\s+(?:is\s+(?:the\s+ceo|in\s+charge)|leads|runs|heads)|leader\s+of)\b/i.test(q)) {
    const s = q.replace(/^[\s\S]*?\b(?:ceo|executor|direttore|amministratore(?:\s+delegato)?|leader|capo|comanda|guida|dirige|charge|leads|runs|heads)\b/i, "");
    const name = _cleanName(_stripLead(s));
    if (name && name.length >= 2) { try { return (await corpSummary(name)) || empty; } catch { return empty; } }
  }

  return empty;
}

// EVE-Scout: live wormhole connections from Thera/Turnur. Triggers when the question
// names Thera or Turnur together with a "connection/exit/wormhole" intent.
async function maybeScout(question) {
  const empty = { text: "", entities: [] };
  const q = question;
  if (!/\b(thera|turnur)\b/i.test(q)) return empty;

  // "più vicino a X" / "closest to X" / "nearest X" / "from X" → proximity reference.
  const opts = {};
  const nm = q.match(/\b(?:vicin\w*\s+(?:a|ad|all[ao'’]?)|closest\s+to|nearest(?:\s+to)?|near(?:\s+to)?|from)\s+([A-Za-z][\w'’\- ]+?)(?=[?.!,]|$)/i);
  const ref = nm ? _cleanName(nm[1]) : null;
  // Proximity reference (a k-space system, not Thera/Turnur itself) → sort connections
  // by distance from it. (fmtSig always shows both signatures, so no direction flag.)
  if (ref && !/^(thera|turnur)$/i.test(ref)) opts.near = ref;

  // Intent: a "connection" word OR a proximity request (in EVE
  // "the Thera closest to X" means the Thera connection closest to X).
  // NB: no trailing \b → allows inflected forms (collegament-i, uscit-e). "wh" standalone.
  const hasIntent = opts.near
    || /(?:\bwh\b)|\b(?:collegament|connession|connection|usc|esco|esci|exit|leave|ingress|entrat|entrance|buch|worm\s?hole|hole|signatur|firm|route|rotta|vicin\w*|closest|nearest|come\s+arriv|come\s+(?:ci\s+)?si\s+arriv|how\s+to\s+(?:get|reach))/i.test(q);
  if (!hasIntent) return empty;

  const systems = [];
  if (/\bthera\b/i.test(q)) systems.push("Thera");
  if (/\bturnur\b/i.test(q)) systems.push("Turnur");
  if (!systems.length) systems.push("Thera", "Turnur");
  try { return (await scoutConnections(systems, opts)) || empty; } catch { return empty; }
}

// Total cost of an "N× Item" list (e.g. blueprint materials) taken from the
// previous answer: sums the EVE Ref average prices.
async function maybeTotalCost(question) {
  if (!/\b(quanto\s+cost|cost[oa]\s+totale|prezzo\s+totale|acquist|comprar|in\s+totale|tutto\s+quanto|costerebb|spes|how\s+much|total\s+(?:cost|price)|buy\s+(?:it\s+|them\s+)?all|altogether|in\s+total|what\s+would\s+it\s+cost)/i.test(question)) return "";
  const last = [...history].reverse().find((t) => /\d+\s*[×x]\s*[A-Za-z]/.test(t.a));
  if (!last) return "";
  const items = [];
  for (const line of last.a.split("\n")) {
    const m = line.match(/(\d+)\s*[×x]\s*(.+)/);
    if (m) { const qty = parseInt(m[1], 10); const name = m[2].trim().replace(/[.;,]+$/, ""); if (qty && name) items.push({ qty, name }); }
  }
  if (!items.length) return "";
  let total = 0; const missing = [];
  for (const it of items) {
    const p = await priceByName(it.name);
    const unit = p.found ? (p.average || p.adjusted) : null;
    if (unit) total += unit * it.qty; else missing.push(it.name);
  }
  if (total <= 0) return "";
  let s = `COSTO TOTALE (prezzi medi globali EVE Ref): ~${Math.round(total).toLocaleString("it-IT")} ISK per l'intera lista.`;
  if (missing.length) s += ` Non valutati (prezzo non disponibile): ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? "…" : ""}.`;
  return s;
}

// If the question is about prices, adds the price of the most relevant item.
async function maybePrice(question, hits) {
  if (!/\b(prezzo|prezzi|costa|costo|isk|valore|price|cost|value|worth)\b/i.test(question)) return "";
  const top = hits.find((h) => ["item", "ship", "module", "blueprint"].includes(h.type));
  if (!top) return "";
  const p = await priceByName(top.title);
  if (!p.found || !(p.average || p.adjusted)) return "";
  return `Prezzo di riferimento di ${top.title}: ~${Math.round(p.average || p.adjusted).toLocaleString("it-IT")} ISK (media globale, non per-hub).`;
}

// Reads the index metadata sidecar if present (written at download time): version,
// embedder, dimension. Absent in development → no embedder/dim check.
function readIndexSidecar() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, "index-meta.json"), "utf-8")); }
  catch { return null; }
}

function loadIndex() {
  const buf = fs.readFileSync(path.join(DATA, "index.vec"));
  const metaText = fs.readFileSync(path.join(DATA, "index.meta.jsonl"), "utf-8");
  const meta = metaText.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  // Compatibility validation BEFORE interpreting the bytes as vectors.
  const count = checkIndexCompat({ vecBytes: buf.byteLength, metaCount: meta.length, sidecar: readIndexSidecar() });
  const vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  for (let i = 0; i < count; i++) {
    let s = 0; const off = i * DIM;
    for (let j = 0; j < DIM; j++) s += vectors[off + j] ** 2;
    const inv = 1 / (Math.sqrt(s) || 1);
    for (let j = 0; j < DIM; j++) vectors[off + j] *= inv;
  }
  return { vectors, count, meta };
}

function topK(query) {
  const q = Float32Array.from(query);
  let s = 0; for (let j = 0; j < DIM; j++) s += q[j] ** 2;
  const inv = 1 / (Math.sqrt(s) || 1); for (let j = 0; j < DIM; j++) q[j] *= inv;
  const scores = [];
  for (let i = 0; i < index.count; i++) {
    let dot = 0; const off = i * DIM;
    for (let j = 0; j < DIM; j++) dot += index.vectors[off + j] * q[j];
    scores.push([dot, i]);
  }
  scores.sort((a, b) => b[0] - a[0]);
  return scores.slice(0, TOP_K).map(([, i]) => index.meta[i]);
}

// ── Chat model management (user choice + performance estimate) ────────────

// Human-readable label from the file name: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf" → "Qwen3 4B Instruct 2507".
function modelLabel(file) {
  return file.replace(/\.gguf$/i, "")
    .replace(/[-_](Q\d[\w]*|IQ\d[\w]*|f16|bf16|fp16)$/i, "")  // drop the quantization suffix
    .replace(/[-_]+/g, " ").trim();
}
// Quantization, shown separately: "...-Q4_K_M.gguf" → "Q4_K_M".
function modelQuant(file) {
  const m = file.match(/(IQ\d[\w]*|Q\d[\w]*|f16|bf16|fp16)\.gguf$/i);
  return m ? m[1].toUpperCase() : "";
}
// All .gguf files in models/, excluding the embedding model (bge-m3).
function modelFiles() {
  try {
    return fs.readdirSync(MODELS_DIR).filter((f) => /\.gguf$/i.test(f) && !/bge|embed/i.test(f)).sort();
  } catch { return []; }
}
// Parameters (in billions) estimated from the on-disk size (Q4_K_M ≈ 0.58 GB/B).
function paramsBFromSize(bytes) { return Math.max(0.3, (bytes / 1e9) / 0.58); }

// Estimated generation speed (tokens/s), calibrated on real measurements from this
// machine (RX 6700 XT, Vulkan, Q4): fully in GPU ≈ 120/paramsB tok/s; with partial
// offload the CPU part dominates (≈2.5 tok/s "equivalent", almost independent of
// size because it's bound by CPU↔GPU transfers) → weighted harmonic mean.
function estimateTokPerSec(paramsB, fraction) {
  const sFull = 120 / paramsB;
  if (fraction >= 0.97) return sFull;
  const tPerTok = fraction / sFull + (1 - fraction) / 2.5;
  return 1 / tPerTok;
}
// Estimated time for a typical answer: prefill of the RAG context (~1800 tokens, ~6×
// the generation speed) + ~180 generated tokens.
function estimateEtaSeconds(tokPerSec) {
  return Math.round(1800 / (tokPerSec * 6) + 180 / tokPerSec);
}
function ratingFor(fraction) {
  return fraction >= 0.97 ? "veloce" : fraction >= 0.6 ? "accettabile" : "lento";
}

const insightsCache = new Map();  // file → { insights, totalLayers, sizeBytes, paramsB }
async function modelInsights(file) {
  if (insightsCache.has(file)) return insightsCache.get(file);
  const p = path.join(MODELS_DIR, file);
  const sizeBytes = fs.statSync(p).size;
  const insights = await GgufInsights.from(await readGgufFileInfo(p), llama);
  const entry = { insights, totalLayers: insights.totalLayers, sizeBytes, paramsB: paramsBFromSize(sizeBytes) };
  insightsCache.set(file, entry);
  return entry;
}

/** Current VRAM state (MB). */
export async function vramState() {
  if (!llama) return null;
  const v = await llama.getVramState();
  return { freeMB: Math.round(v.free / 1048576), totalMB: Math.round(v.total / 1048576), usedMB: Math.round((v.total - v.free) / 1048576) };
}

// VRAM (bytes) currently occupied by the chat model: it would be freed by switching
// models, so it must be added back to "free" to estimate the alternatives fairly.
async function reclaimableVram() {
  if (!chatModel || !currentModelFile) return 0;
  try {
    const { insights } = await modelInsights(currentModelFile);
    return insights.estimateModelResourceRequirements({ gpuLayers: chatModel.gpuLayers }).gpuVram;
  } catch { return 0; }
}

/** List of models with estimates, based on the VRAM that would be free AFTER unloading
 *  the current model (which is what happens when switching models). Sorted by speed. */
export async function listModels() {
  const reclaim = await reclaimableVram();
  // "Corrected" getVramState: adds to free the VRAM the current model would release.
  const vramForEstimate = async () => {
    const v = await llama.getVramState();
    const free = Math.min(v.total, v.free + reclaim);
    return { ...v, free, used: v.total - free };
  };
  const out = [];
  for (const file of modelFiles()) {
    const base = { file, label: modelLabel(file), quant: modelQuant(file), current: file === currentModelFile };
    try {
      const { insights, totalLayers, sizeBytes, paramsB } = await modelInsights(file);
      // CURRENT model: report the layers ACTUALLY loaded (consistent with the status
      // bar). Other models: estimate how many would fit by unloading the current one.
      const gpuLayers = (base.current && chatModel)
        ? chatModel.gpuLayers
        : await insights.configurationResolver.resolveModelGpuLayers(
            { fitContext: { contextSize: CHAT_CTX } },
            { getVramState: vramForEstimate },
          );
      const fraction = totalLayers ? gpuLayers / totalLayers : 0;
      const tokPerSec = estimateTokPerSec(paramsB, fraction);
      out.push({
        ...base, sizeGB: +(sizeBytes / 1e9).toFixed(1), paramsB: Math.round(paramsB),
        totalLayers, gpuLayers, fraction: +fraction.toFixed(2),
        tokPerSec: Math.round(tokPerSec), etaSeconds: estimateEtaSeconds(tokPerSec), rating: ratingFor(fraction),
      });
    } catch (e) { out.push({ ...base, error: String(e?.message || e).slice(0, 80) }); }
  }
  out.sort((a, b) => (b.current - a.current) || ((a.etaSeconds ?? 1e9) - (b.etaSeconds ?? 1e9)));
  return out;
}

// "Ready" status as a structured object: the renderer localizes it (so all the
// GUI strings live in a single dictionary, on the renderer side).
function buildStatus() {
  const loaded = chatModel.gpuLayers;
  const total = chatModel.fileInsights?.totalLayers ?? loaded;
  const onGpu = loaded >= total;
  const statusObj = { k: "ready", model: modelLabel(currentModelFile), gpu: llama.gpu, loaded, total, onGpu };
  return { statusObj, loaded, total, onGpu };
}

// Loads a chat model (fitContext: max layers in GPU while reserving room for the context)
// and frees the previous one. Updates currentModelFile.
async function loadChatModel(file) {
  const modelPath = path.join(MODELS_DIR, file);
  if (!fs.existsSync(modelPath)) throw new Error(`Modello non trovato: ${file}`);
  // Free the current model FIRST: if it stayed loaded, the two would compete for
  // VRAM during the overlap and the new one would get few/zero layers in GPU.
  if (chatModel) { const prev = chatModel; chatModel = null; try { await prev.dispose(); } catch { /* tearing down */ } }
  chatModel = await llama.loadModel({ modelPath, gpuLayers: { fitContext: { contextSize: CHAT_CTX } } });
  currentModelFile = file;
}

/** Hot-swaps the chat model. Cancels the in-flight generation, reloads,
 *  remembers the choice. Returns the status (GPU layers, etc.). */
export async function setModel(file, onStatus = () => {}) {
  await cancel();  // no generation in flight while swapping the model
  onStatus({ k: "loadingModel", model: modelLabel(file) });
  await loadChatModel(file);
  try { fs.writeFileSync(MODEL_CHOICE_FILE, file, "utf-8"); } catch { /* best-effort */ }
  const s = buildStatus();
  onStatus(s.statusObj);
  return { ok: true, file, loaded: s.loaded, total: s.total, onGpu: s.onGpu };
}

function pickInitialModel() {
  let chosen;
  try { const f = fs.readFileSync(MODEL_CHOICE_FILE, "utf-8").trim(); if (f) chosen = f; } catch { /* no saved choice */ }
  const available = modelFiles();
  if (chosen && available.includes(chosen)) return chosen;
  if (available.includes(DEFAULT_MODEL)) return DEFAULT_MODEL;
  return available[0];  // whatever is there (or undefined → explicit error below)
}

export async function init(onStatus = () => {}) {
  onStatus({ k: "index" });
  index = loadIndex();
  onStatus({ k: "models", count: index.count });
  llama = await getLlama();
  // Embeddings on CPU (gpuLayers: 0): bge-m3 runs once per question on a short
  // sentence → on CPU it costs ~100-300ms (imperceptible) but frees ~0.6-1GB of VRAM,
  // all available to the chat model so it can stay entirely in GPU.
  const embedModel = await llama.loadModel({ modelPath: EMBED_MODEL, gpuLayers: 0 });
  embedCtx = await embedModel.createEmbeddingContext({ contextSize: 2048 });

  // Pre-load the fitting engine's SDE bundle (~8 MB JSON) so the first pasted fit
  // doesn't stall. Fire-and-forget: it loads lazily on first use if this hasn't run.
  warmFitEngine();

  const initial = pickInitialModel();
  if (!initial) throw new Error("Nessun modello .gguf trovato in models/.");
  await loadChatModel(initial);

  const s = buildStatus();
  onStatus(s.statusObj);
  return { gpu: llama.gpu, count: index.count, model: currentModelFile, gpuLayers: s.loaded, totalLayers: s.total, onGpu: s.onGpu };
}

/** Answers the question; onToken(text) for streaming. Returns {answer, sources}. */
export async function ask(question, onToken = () => {}, uiLang = null) {
  // 0. Disambiguation follow-up: if last turn we asked which entity the user meant,
  //    try to read this turn as the choice. A matched choice pre-resolves the intel
  //    (forcedIntel) and rewrites the query to the canonical "chi è <name>" so the rest
  //    of the pipeline narrates it normally; an unmatched reply just clears the pending
  //    state and is handled as a fresh question.
  if (pendingDisambiguation && !looksLikeFit(question)) {
    // If the reply is itself a fresh "chi è Y / parlami di Y" about a DIFFERENT name,
    // it's a new question — don't misread a stray "corp"/number in it as the choice.
    const freshName = intelQuery(question);
    const cands = pendingDisambiguation.candidates;
    const isNewIntel = freshName && !cands.some((c) => freshName.toLowerCase().includes(c.name.toLowerCase()));
    const choice = isNewIntel ? null : matchDisambiguationChoice(question, cands);
    if (choice) {
      forcedIntel = await intelForCandidate(choice, pendingDisambiguation.opts || {}).catch(() => null);
      pendingDisambiguation = null;
      if (forcedIntel) question = `chi è ${choice.name}`;
      else {
        const lang = convLang || detectLang(question, (uiLang === "it" || uiLang === "en") ? uiLang : "en");
        const msg = lang === "it"
          ? `Non sono riuscito a recuperare i dati di ${choice.name}. Riprova tra poco.`
          : `I couldn't fetch data for ${choice.name}. Please try again shortly.`;
        onToken(msg); history.push({ q: question, a: msg }); if (history.length > 6) history.shift();
        return { answer: msg, sources: [] };
      }
    } else {
      pendingDisambiguation = null;   // reply didn't pick one → treat as a new question
    }
  }

  // 1. Pasted EFT fit → analysis (validation + DPS/EHP/tank/cap/navigation/targeting).
  //    Fully offline + authoritative: the stats come from the Pyfa-parity eve-fit-engine
  //    package (bundled SDE), so nothing is sent to any server.
  const eftText = question;
  const isFit = looksLikeFit(eftText);
  let fitInfo = "", fitShip = null;
  if (isFit) {
    const fit = parseEft(eftText);
    if (fit) {
      fitShip = fit.ship;
      fitInfo = await describeFit(fit, eftText);
      const cost = await fitCost(fit);
      if (cost) fitInfo += "\n" + cost;
    }
  }

  // 2. Retrieval query. For a fit, retrieve the SHIP doc (role/theorycrafting
  //    context), NOT the EFT module list. Otherwise: condense the follow-up.
  const standalone = (isFit && fitShip) ? `${fitShip} nave ruolo bonus` : await condense(question);
  const { vector } = await embedCtx.getEmbeddingFor(expandQuery(standalone));
  const hits = topK(vector);

  // 3. Live price / intel, if the question calls for it (uses the original question
  //    to preserve entity proper names).
  const priceInfo = await maybePrice(standalone, hits);
  const totalCost = await maybeTotalCost(question);
  // eve-kill MCP analytics (dossier archetypes, route danger, war report, wingmates,
  // battles, meta, killmail story/forensics…). { text, entities, source, sourceTitle }.
  let mcp = await maybeMcp(question, standalone);
  // EVE Workbench community-fit search ("voglio un fit PvP per la Vagabond"). Runs only when no
  // MCP intent fired; folds into `mcp` so the card/EFT/theory plumbing below is shared.
  if (!mcp.text) { const wb = await maybeWorkbench(question); if (wb.text) mcp = wb; }
  // A matched MCP relational/analytic intent (e.g. "chi uccide X", "X vs Y") takes
  // precedence over the generic killboard intel for the same name → don't run both.
  const intel = mcp.text ? { text: "", entities: [], kills: [] } : await maybeIntel(question);  // { text, entities, kills }
  const esi = await maybeEsi(question);      // { text, entities } — official Fenris Creations data
  // Use the CONDENSED question for EVE-Scout so a follow-up ("and the closest to
  // Fountain?") keeps the Thera/Turnur context resolved by condense().
  const scout = await maybeScout(standalone);  // { text, entities } — EVE-Scout connections
  // Answer/link language. A pasted fit is all-English game terms (→ follow the
  // system language). A follow-up keeps the conversation's language (so a short
  // "elencale" after an Italian turn doesn't flip to English). First turn: detect,
  // with the system language as the tie-breaker instead of always English.
  const sysFb = (uiLang === "it" || uiLang === "en") ? uiLang : "en";
  const qLang = isFit ? sysFb
    : convLang ? convLang          // a follow-up keeps the conversation's language
    : detectLang(question, sysFb);
  convLang = qLang;

  // 3b. Ambiguous entity ("chi è X" matched >1 entity exactly across types): ask the
  //     user which one and stash the candidates. No generation this turn — the next
  //     reply resolves against pendingDisambiguation (Phase 0 above).
  if (intel.ambiguous) {
    const msg = buildDisambiguationQuestion(intel.ambiguous, qLang);
    pendingDisambiguation = { name: intel.ambiguous.name, candidates: intel.ambiguous.candidates, opts: intel.ambiguous.opts, question };
    onToken(msg);
    history.push({ q: question, a: msg, vec: vector });
    if (history.length > 6) history.shift();
    const linked = await linkify(msg, { lang: qLang, entities: intel.ambiguous.candidates });
    return { answer: linked, sources: [{ title: "eve-kill.com · disambiguazione", type: "api", url: "https://eve-kill.com/" }] };
  }

  // 4. Context from the retrieved documents.
  let context = "", used = 0;
  for (const h of hits) {
    const block = `[${h.type}] ${h.title}\n${h.text}`;
    if (used + block.length > MAX_CONTEXT_CHARS) break;
    context += block + "\n\n---\n\n"; used += block.length;
  }

  // At most the LAST turn, and only if it's actually relevant to the new question
  // (embedding similarity). Irrelevant history makes the model misread the prompt.
  let histText = "";
  if (history.length) {
    const prev = history[history.length - 1];
    // Reuse the previous turn's cached query embedding — no extra embed call.
    const related = prev.vec ? cosine(vector, prev.vec) >= HIST_SIM : false;
    // Truncate the previous answer: it's just context, and a full long answer
    // would bloat the prompt and eat into the generation budget.
    if (related) histText = `Conversazione precedente (contesto pertinente):\nD: ${prev.q}\nR: ${prev.a.slice(0, 600)}\n\n`;
  }
  // Live data (EVE-Scout/ESI/killboard/prices) goes INSIDE the CONTEXT, marked as
  // authoritative: the SYSTEM prompt says to answer using only the CONTEXT, so if
  // these blocks sit outside it the model ignores them and says "no info" even when
  // the data is right there. A final directive (highest salience) reinforces it.
  const liveIntel = [mcp.text, intel.text, esi.text, scout.text, totalCost, priceInfo].filter(Boolean).join("\n\n");
  // End-of-prompt directives (highest salience), one per active source. Gating +
  // IT/EN text live together, so adding a source is one row here.
  const directives = [
    { on: !!liveIntel,
      it: "\nIMPORTANTE: il CONTESTO include DATI LIVE autorevoli (EVE-Scout/ESI/killboard/prezzi): rispondi usandoli, NON dire che l'informazione manca.",
      en: "\nIMPORTANT: the CONTEXT includes authoritative LIVE DATA (EVE-Scout/ESI/killboard/prices): answer using it, do NOT say the information is missing." },
    { on: !!(mcp.cards || mcp.kills || intel.card),
      it: "\nI risultati dettagliati sono mostrati come SCHEDA/LISTA sotto la tua risposta: scrivi SOLO una breve frase introduttiva (1 riga), NON elencare i singoli risultati e NON ripetere i numeri.",
      en: "\nThe detailed results are shown as a CARD/LIST below your answer: write ONLY a short one-line intro, do NOT enumerate the individual results and do NOT repeat the numbers." },
    { on: !!scout.text,
      it: "\nPer un collegamento Thera/Turnur indica SEMPRE entrambe le signature: quella di ENTRATA (da scansionare nel sistema k-space) e quella di USCITA (da scansionare in Thera/Turnur). Se i dati EVE-Scout contengono un AVVISO (⚠, es. il riferimento è una regione/costellazione e non un sistema), riportalo chiaramente all'utente.",
      en: "\nFor a Thera/Turnur connection ALWAYS give both wormhole signatures: the ENTRY one (to scan in the k-space system) and the EXIT one (to scan in Thera/Turnur). If the EVE-Scout data contains a WARNING (⚠, e.g. the reference is a region/constellation, not a system), relay it clearly to the user." },
    { on: !!fitInfo,
      it: `\nQuesto è un FIT. Struttura la risposta così, basandoti sull'ANALISI DEL FIT qui sopra (dati autorevoli, NON reinventarli). La CLASSE della nave è indicata nell'analisi: usala ESATTAMENTE, non dedurre né inventare la classe/ruolo dello scafo.\n1) **DPS**, **Tank (EHP)**, **Velocità**, **Cap stability** (riporta i numeri).\n2) **Bonus nave**: se il fit sfrutta o no i bonus della nave, e perché.\n3) **Theorycrafting**: a cosa serve questa nave con questo fit (ruolo, PvP/PvE, punti di forza e debolezze, come si usa). Usa la tua conoscenza della nave, coerente con la CLASSE indicata.`,
      en: `\nThis is a FIT. Structure the answer like this, based on the FIT ANALYSIS above (authoritative data, do NOT make it up). The ship's CLASS is given in the analysis: use it EXACTLY, do NOT infer or invent the hull's class/role.\n1) **DPS**, **Tank (EHP)**, **Speed**, **Cap stability** (report the numbers).\n2) **Ship bonuses**: whether the fit uses the ship's bonuses, and why.\n3) **Theorycrafting**: what this ship is for with this fit (role, PvP/PvE, strengths and weaknesses, how to fly it). Use your knowledge of the ship, consistent with the CLASS given.` },
    { on: !!mcp.theory,
      it: `\nIl CONTESTO contiene le STATISTICHE di un fit di dottrina (eve-fit-engine, parità pyfa). Basati SOLO su quei numeri (NON reinventarli). Struttura la risposta così:\n1) **Danno**: riporta DPS e gittata sia con la carica ad alto danno sia con quella a lunga gittata (il «massimo e minimo»).\n2) **Tank (EHP)**, **Velocità**, **Cap** (riporta i numeri).\n3) **Theorycrafting**: ruolo tattico nella dottrina, range/velocità d'ingaggio ideale, punti di forza e debolezze, come si combatte. Ricorda che la rilevazione si basa sulle PERDITE degli ultimi 30 giorni.\nNON elencare i moduli e NON produrre alcun blocco di codice: il fit completo viene mostrato automaticamente sotto la tua risposta. Fermati dopo il punto 3.`,
      en: `\nThe CONTEXT contains the STATS of a doctrine fit (eve-fit-engine, pyfa parity). Rely ONLY on those numbers (do NOT invent them). Structure the answer like this:\n1) **Damage**: report DPS and range for both the high-damage and the long-range ammo (the "max and min").\n2) **Tank (EHP)**, **Speed**, **Cap** (report the numbers).\n3) **Theorycrafting**: tactical role in the doctrine, ideal engagement range/speed, strengths and weaknesses, how to fight it. Note the detection is based on the last 30 days of LOSSES.\nDo NOT list the modules and do NOT output any code block: the full fit is shown automatically below your answer. Stop after point 3.` },
  ];
  const directiveText = directives.filter((d) => d.on).map((d) => (qLang === "it" ? d.it : d.en)).join("");
  const userMsg = `${histText}CONTESTO:\n`
    + (liveIntel ? `[DATI LIVE]\n${liveIntel}\n\n` : "")
    + (fitInfo ? `[ANALISI DEL FIT — dati autorevoli]\n${fitInfo}\n\n` : "")
    + `${context}\n`
    + `DOMANDA: ${question}\n\n${(LANG_DIRECTIVE[qLang] || LANG_DIRECTIVE.en)}${directiveText}`;

  // 5. Generation (GPU, streaming). Cancelable via AbortSignal: if the app closes
  //    while the model is answering, cancel() interrupts the prompt and here we dispose
  //    the context in an orderly way — no native work in flight once teardown is done.
  const ctx = await createChatContext(CHAT_CTX);
  activeCtx = ctx;
  activeAbort = new AbortController();
  const session = new LlamaChatSession({ contextSequence: ctx.getSequence(), systemPrompt: isFit ? SYSTEM_FIT : SYSTEM });
  let answer = "";
  let aborted = false;
  try {
    // High cap so answers finish at EOS instead of being cut mid-sentence; the
    // 4096 context leaves room for prompt + a long answer. (No real Q&A answer
    // reaches this, so it effectively means "generate until complete".)
    await session.prompt(userMsg, {
      maxTokens: 1600, temperature: 0.2,
      signal: activeAbort.signal,
      onTextChunk: (t) => { answer += t; onToken(t); },
    });
  } catch (e) {
    // Cancellation is expected (close/new question): we keep the partial answer.
    if (activeAbort.signal.aborted) aborted = true; else throw e;
  } finally {
    try { await ctx.dispose(); } catch { /* already tearing down */ }
    activeCtx = null;
    activeAbort = null;
  }

  // 5b. Doctrine-fit specs carry the verbatim example EFT (straight from the killmail).
  //     We attach it ourselves as a copy/paste-able code block AFTER generation:
  //     deterministic (not the small model, which corrupts module names + links) and kept
  //     OUT of linkify so the fence stays pristine. The small model often ALSO emits its own
  //     EFT/module code block despite the directive — strip any model-produced fence (and an
  //     immediately-preceding "…EFT/fit…" heading) so only our single authoritative block
  //     remains. Streamed live, stored in history, appended to the linked answer below.
  let eftBlock = "";
  if (mcp.eft && !aborted) {
    answer = answer
      .replace(/(?:^|\n)[ \t]*[*_#> ]*[^\n]*\b(?:EFT|fit(?:ting)?)\b[^\n]*\n+\s*```[\s\S]*?```/gi, "")
      .replace(/```[\s\S]*?```/g, "")        // any remaining model-emitted fence
      .replace(/\n{3,}/g, "\n\n").trimEnd();
    const label = qLang === "it" ? "Fit EFT (dal killmail d'esempio)" : "EFT fit (from the example killmail)";
    eftBlock = `\n\n**${label}:**\n\`\`\`\n${String(mcp.eft).trim()}\n\`\`\`\n`;
    onToken(eftBlock);
  }

  // 6. History (plain text for follow-ups) + linkification for the UI. The EFT block is
  //    stored in history and appended to the linked answer verbatim (never linkified).
  history.push({ q: question, a: answer + eftBlock, vec: vector });  // vec → next turn's relevance check
  if (history.length > 6) history.shift();
  const linked = await linkify(answer, { lang: qLang, entities: [...mcp.entities, ...intel.entities, ...esi.entities] }) + eftBlock;

  // 7. SOURCES: if the answer comes from a live API, report the actual API (not the
  //    RAG vector neighbors, which would be noise here). Otherwise the RAG documents
  //    (possibly enriched with the prices source if it was used).
  const apiSources = [];
  if (mcp.text) apiSources.push({ title: mcp.sourceTitle || "eve-kill · MCP (dati live)", type: "api", url: mcp.source || "https://eve-kill.com/" });
  if (intel.text) {
    const e = intel.entities[0];
    apiSources.push({ title: "eve-kill.com · killboard live", type: "api", url: e ? `https://eve-kill.com/${e.type}/${e.id}` : "https://eve-kill.com/" });
  }
  if (esi.text) apiSources.push({ title: "ESI · API ufficiale di EVE Online", type: "api", url: "https://esi.evetech.net/" });
  if (scout.text) apiSources.push({ title: "EVE-Scout · collegamenti Thera/Turnur", type: "api", url: "https://www.eve-scout.com/" });
  if (priceInfo || totalCost) apiSources.push({ title: "EVE Ref · prezzi di mercato", type: "api", url: "https://everef.net/" });

  let sources;
  if (mcp.text || intel.text || esi.text || scout.text) {
    sources = apiSources;  // answer driven by live entity/system data: no RAG
  } else {
    const seen = new Set();
    const rag = hits.filter((h) => { const k = h.url || h.title; if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 5).map((h) => ({ title: h.title, type: h.type, url: h.url }));
    sources = [...apiSources, ...rag];
  }
  return { answer: linked, sources, kills: (mcp.kills?.length ? mcp.kills : intel.kills), cards: mcp.cards || intel.card || null };
}
