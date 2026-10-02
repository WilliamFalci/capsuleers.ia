// Hybrid retrieval over the in-RAM index: dense (bge-m3 cosine + the source-tier
// nudge) plus a share of lexical BM25, then de-duplicated so one family of near-identical
// records cannot fill the whole context. Pure functions over { vectors, meta, bonus },
// no models: tools/probe-retrieval.mjs and tools/verify-retrieval.mjs drive the same
// code the app runs.
//
// Why, measured on index-2026.10.02 with "dove si droppano gli impianti
// High-grade Amulet?": dense-only top-12 was 12 SDE records of the Amulet set
// (Low/Mid/High × Alpha…Omega, cosine 0.56-0.59, all saying the same thing and none
// saying where the implants come from), while the Feb 2020 patch note that answers it
// ("Amulet Implants moved to Blood Raider Loyalty Store and loot tables") sat at rank
// 339. A rare proper noun ("Amulet") barely moves a 1024-dim embedding of a whole
// question; it is exactly what a keyword index is good at. And no fusion helps while
// 18 near-copies outrank everything: hence the near-duplicate cap.

const DIM = 1024;

// Candidate pools handed to the fusion. Dense is the primary signal; the lexical
// pool only has to be deep enough to reach a chunk that mentions a rare name once.
const DENSE_POOL = 200;
const LEXICAL_POOL = 100;
// Fusion: dense score + LEX_ALPHA × BM25 normalised to the best lexical hit, over the
// union of both pools. Tuned with tools/verify-retrieval.mjs on eval/retrieval.jsonl
// (30 questions IT/EN) and checked on the held-out eval/retrieval-holdout.jsonl (22),
// counting what fits the 6000-char context: dense-only 26/30 and 19/22 → 30/30 and
// 22/22 (with the caps below). 0.05 lost the
// Italian Amulet question, 0.15 changed nothing. Reciprocal Rank Fusion was tried
// first and lost the English one: the patch note sat 5th in the lexical list only,
// and RRF ranked above it every page that merely said "implants" in BOTH lists — rank
// fusion throws away that "Amulet" is a 22-chunk word and "implants" an 821-chunk one.
const LEX_ALPHA = 0.1;
// Near-duplicate cap: a candidate whose cosine with an already-selected chunk OF THE
// SAME SOURCE is ≥ DUP_SIM waits behind every non-duplicate. Measured on
// index-2026.10.02: records of one SDE family (the 18 Amulet implants, the SKINs of a
// hull) score 0.77-0.98 with each other, a patch-note section vs the items it talks
// about ~0.65; two chunks of the SAME wiki/Support/patch-note page reach 0.85 only
// 2-9% of the time (median 0.70-0.79), so the cap thins families without splitting
// pages. Across sources a high cosine is not redundancy: the SDE record of the
// Caracal and EVE Uni's Caracal page are ≥ 0.85 apart yet complementary (the official
// skill tree vs how to fly it) — compared across sources, the cap dropped the SDE
// record and the model invented the skill list.
const DUP_SIM = 0.85;
const MAX_DUP = 1;
// One chunk per page before every other candidate (more only if there aren't k
// others): the 6000-char context holds ~4-6 blocks. With two, "quanti slot ha la
// Vexor?" filled the budget with two EVE Uni chunks + the Fandom page and the 2 000-char
// SDE record with the actual slot layout no longer fit — the model answered "3 mid,
// 4 low" (it is 4 and 5). Same on the Caracal skill tree, with four chunks of one page.
const MAX_PER_PAGE = 1;

// BM25 parameters (the textbook values) and the document-frequency ceiling above
// which a query term is ignored: the lexical side is there for RARE names (Amulet:
// 22 chunks), not for "asteroid" (1 451) or "state" (1 927 — Italian "sono state"
// pulled every "State Managed Asteroid Belt" record and pushed the 19.11 patch note
// out of the context). 1% of the index = ~850 chunks.
const BM25_K1 = 1.2, BM25_B = 0.75;
const MAX_DF_RATIO = 0.01;

// Function words of the two supported languages, plus the question words that
// carry no lexical content. "ore" is here on purpose: in Italian it means "hours",
// and as the English mining word it matches thousands of SDE ore records, so the df
// ceiling would drop it anyway — the dense side still understands it.
const STOP = new Set(`
a ad al alla alle allo ai agli anche c che chi ci come con cosa cos da dal dalla dalle dai degli dei del della delle dello di do dove dovrei e ed è gli ha hai ho i il in io la le lo ma mi ne nel nella nelle nei negli non o per perché perche più piu può puo qual quale quali qualcuno quando quanto quanti quante quanta questo questa questi queste quello quella quelli quelle se si sia sono su sul sulla sulle sui ti tra fra tu un una uno vorrei voglio dammi dimmi parlami spiegami posso puoi devo serve servono ore
an and are as at be by can could do does did for from has have how i if in is it its me my of on or should tell the their there these they this those to was were what when where which who why will with would you your about please give show get
eve online
`.split(/\s+/).filter(Boolean));

const TOKEN = /[\p{L}\p{N}]+/gu;

/** Lower-cased word tokens (letters/digits, any script), length ≥ 2. */
export function tokenize(text) {
  const out = [];
  for (const t of (text || "").toLowerCase().match(TOKEN) || []) if (t.length >= 2) out.push(t);
  return out;
}

/**
 * Inverted index over title + text of every chunk. ~2 s and ~25 MB of postings for
 * 85k chunks (measured), so it is built once, after the vectors, not per query.
 * @param {{title?:string,text?:string}[]} meta
 */
export function buildLexicalIndex(meta) {
  const raw = new Map();   // token → [doc, tf, doc, tf, …] while building
  const docLen = new Uint32Array(meta.length);
  let total = 0;
  for (let i = 0; i < meta.length; i++) {
    const toks = tokenize(`${meta[i].title || ""} ${meta[i].text || ""}`);
    docLen[i] = toks.length; total += toks.length;
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, c] of tf) {
      let a = raw.get(t);
      if (!a) { a = []; raw.set(t, a); }
      a.push(i, c);
    }
  }
  const post = new Map();
  for (const [t, a] of raw) {
    const ids = new Uint32Array(a.length / 2), tf = new Uint16Array(a.length / 2);
    for (let j = 0; j < a.length; j += 2) { ids[j / 2] = a[j]; tf[j / 2] = Math.min(a[j + 1], 65535); }
    post.set(t, { ids, tf });
  }
  return { post, docLen, avgLen: total / (meta.length || 1), n: meta.length };
}

/** The query terms the lexical index scores: deduped, no stopwords, no ubiquitous terms. */
export function lexicalTerms(lex, query, maxDfRatio = MAX_DF_RATIO) {
  const maxDf = Math.max(1, Math.floor(lex.n * maxDfRatio));
  return [...new Set(tokenize(query))].filter((t) => !STOP.has(t) && lex.post.get(t)?.ids.length <= maxDf);
}

/** BM25 top-`n` as [score, docIndex], best first. */
export function lexicalSearch(lex, query, n = LEXICAL_POOL, maxDfRatio = MAX_DF_RATIO) {
  const terms = lexicalTerms(lex, query, maxDfRatio);
  if (!terms.length) return [];
  const acc = new Map();
  for (const t of terms) {
    const { ids, tf } = lex.post.get(t);
    const idf = Math.log(1 + (lex.n - ids.length + 0.5) / (ids.length + 0.5));
    for (let j = 0; j < ids.length; j++) {
      const d = ids[j], f = tf[j];
      const s = idf * (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * lex.docLen[d] / lex.avgLen));
      acc.set(d, (acc.get(d) || 0) + s);
    }
  }
  return [...acc].map(([d, s]) => [s, d]).sort((a, b) => b[0] - a[0]).slice(0, n);
}

/**
 * Docs whose WHOLE title is named in the query ("Vexor", "Damage Control II", "Jita"):
 * every title token appears among the query tokens, and at least one of them is a
 * lexical term (rare enough to pass lexicalTerms). That is the entity the question is
 * about. Measured on "quanti high slot … ha la Vexor?": BM25 favours short records, so
 * the 30+ "Vexor … SKIN" records outscored the ship's own SDE record, and the first
 * SKIN kept made the near-duplicate cap drop the ship — the model then guessed the
 * slot layout. "Vexor IGC SKIN" is not a title match: "IGC SKIN" is not in the query.
 * Candidates come from the postings of the lexical terms, so the check is cheap.
 */
export function titleMatches(lex, meta, query, maxDfRatio = MAX_DF_RATIO) {
  const q = new Set(tokenize(query));
  const out = new Set();
  for (const t of lexicalTerms(lex, query, maxDfRatio)) {
    for (const d of lex.post.get(t).ids) {
      if (out.has(d)) continue;
      const tt = tokenize(meta[d].title);
      if (tt.length && tt.every((x) => q.has(x))) out.add(d);
    }
  }
  return out;
}

/** Unit-normalised copy of an embedding. */
export function normalize(vec) {
  const q = Float32Array.from(vec);
  let s = 0; for (let j = 0; j < q.length; j++) s += q[j] ** 2;
  const inv = 1 / (Math.sqrt(s) || 1);
  for (let j = 0; j < q.length; j++) q[j] *= inv;
  return q;
}

/** Dense top-`n` as [score, docIndex]: cosine (vectors are pre-normalised) + tier nudge. */
export function denseSearch(index, qvec, n = DENSE_POOL) {
  const q = normalize(qvec);
  const scores = new Array(index.count);
  for (let i = 0; i < index.count; i++) {
    let dot = 0; const off = i * DIM;
    for (let j = 0; j < DIM; j++) dot += index.vectors[off + j] * q[j];
    scores[i] = [dot + (index.bonus ? index.bonus[i] : 0), i];
  }
  scores.sort((a, b) => b[0] - a[0]);
  return scores.slice(0, n);
}

/** Score fusion over the union of the pools: dense score (cosine + tier nudge) plus
 *  alpha × (BM25 normalised to the best lexical hit + 1 for a title match)
 *  → docIndex[], best first. */
export function fuseScores(index, qvec, dense, lexical, alpha, titles = new Set()) {
  const q = normalize(qvec);
  const top = lexical[0]?.[0] || 1;
  const lexOf = new Map(lexical.map(([s, d]) => [d, s / top]));
  for (const d of titles) lexOf.set(d, (lexOf.get(d) || 0) + 1);
  const denseOf = new Map(dense.map(([s, d]) => [d, s]));
  const out = [];
  for (const d of new Set([...denseOf.keys(), ...lexOf.keys()])) {
    let ds = denseOf.get(d);
    if (ds === undefined) {
      ds = index.bonus ? index.bonus[d] : 0; const off = d * DIM;
      for (let j = 0; j < DIM; j++) ds += index.vectors[off + j] * q[j];
    }
    out.push([ds + alpha * (lexOf.get(d) || 0), d]);
  }
  return out.sort((a, b) => b[0] - a[0]).map(([, d]) => d);
}

function cos(index, a, b) {
  let dot = 0; const oa = a * DIM, ob = b * DIM;
  for (let j = 0; j < DIM; j++) dot += index.vectors[oa + j] * index.vectors[ob + j];
  return dot;
}

/**
 * Greedy near-duplicate cap over a ranked docIndex[]: keeps the order, but a doc that
 * is a near-copy (cosine ≥ dupSim) of ≥ maxDup already-kept docs of its own source
 * waits behind every
 * non-duplicate. Deferred docs only come back if there aren't k distinct ones.
 */
export function diversify(index, ranked, k, { dupSim = DUP_SIM, maxDup = MAX_DUP, maxPerPage = MAX_PER_PAGE } = {}) {
  const kept = [], deferred = [], perPage = new Map();
  // Older index releases carry no `source`; only SDE chunks have no URL there.
  const src = (d) => index.meta[d].source || (index.meta[d].url ? "web" : "ccp_sde");
  for (const d of ranked) {
    if (kept.length >= k) break;
    const page = index.meta[d].url;   // SDE records (no URL) are one record each
    if (page && (perPage.get(page) || 0) >= maxPerPage) { deferred.push(d); continue; }
    let dups = 0;
    for (const s of kept) if (src(s) === src(d) && cos(index, d, s) >= dupSim && ++dups >= maxDup) break;
    if (dups >= maxDup) { deferred.push(d); continue; }
    kept.push(d);
    if (page) perPage.set(page, (perPage.get(page) || 0) + 1);
  }
  for (const d of deferred) { if (kept.length >= k) break; kept.push(d); }
  return kept;
}

/**
 * The retrieval the app runs: dense + lexical pools + title matches → score fusion →
 * diversity caps → top-k. Without a lexical index it degrades to dense + the cap.
 * @returns {number[]} doc indices into index.meta, best first
 */
export function retrieve(index, lex, qvec, query, k = 12, o = {}) {
  const dense = denseSearch(index, qvec, DENSE_POOL);
  const lexical = lex ? lexicalSearch(lex, query, LEXICAL_POOL, o.maxDfRatio) : [];
  const titles = lex && !o.noTitle ? titleMatches(lex, index.meta, query, o.maxDfRatio) : new Set();
  const ranked = lexical.length || titles.size
    ? fuseScores(index, qvec, dense, lexical, o.alpha ?? LEX_ALPHA, titles)
    : dense.map(([, d]) => d);
  return diversify(index, ranked, k, o);
}
