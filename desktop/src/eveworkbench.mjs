// EVE Workbench community-fit search (https://eveworkbench.com). Lets the user ask for a
// fitting by need — "voglio un fit PvP per la Vagabond" — and get a list of community fits,
// then drill into one for authoritative Pyfa-parity stats + a copy-able EFT.
//
// Two public endpoints (headless: no auth/cookies, just the app User-Agent + origin/referer):
//   POST /Fit/PostSearchFits  → { totalResultCount, results[], success } — list (cards).
//   GET  /Fit/GetById?id=<id> → { success, result } — full slots + droneBay + charges → EFT.
//
// Same { text, entities, source, sourceTitle, cards?, theory?, eft? } block shape the engine
// already drops into the RAG context, so the local model narrates a one-line intro and the
// card/EFT render client-side. Never throws (degrades to no live block).
import { USER_AGENT as UA } from "./user-agent.mjs";
import { doctrineFitStatsData } from "./fit.mjs";
import { resetDoctrineMemory } from "./mcp-intel.mjs";

const API = "https://webapi.eveworkbench.com";
const HEADERS = { accept: "application/json", "content-type": "application/json",
  origin: "https://eveworkbench.com", referer: "https://eveworkbench.com/", "User-Agent": UA };
const TIMEOUT = 12000;
const EMPTY = { text: "", entities: [], source: null, sourceTitle: null };

// Remembered search so a follow-up ("specifiche del #2") can compute one fit's stats.
let lastFitSearch = null;   // { ship, tag, fits: [{ id, name, shipName, shipClass, ... }] }
export function resetFitMemory() { lastFitSearch = null; }

// Maps a stated need to an EVE Workbench tag (its `tags` filter is a single slug).
const TAG_MAP = [
  [/\b(pvp|small\s*gang|solo|roam|gank)\w*/i, "pvp"],
  [/\b(pve|ratt\w*|missio\w*|anomal\w*|farm\w*|isk)\w*/i, "pve"],
  [/\b(mining|minerar\w*|estrazion\w*|miner\w*)/i, "mining"],
  [/\b(explorat\w*|esplorazion\w*|scann\w*|relic|data)\w*/i, "exploration"],
  [/\b(wormhole|anoikis|\bwh\b)/i, "wormhole"],
  [/\b(incursion\w*)/i, "incursion"],
  [/\b(abyss\w*|abissal\w*)/i, "abyssal"],
];
function needToTag(q) { for (const [re, t] of TAG_MAP) if (re.test(q)) return t; return null; }

async function postJson(path, body) {
  try {
    const r = await fetch(`${API}${path}`, { method: "POST", headers: HEADERS, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
async function getJson(path) {
  try {
    const r = await fetch(`${API}${path}`, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const clean = (s) => (s || "").replace(/["'?.!,;:]+$/g, "").replace(/^["'\s]+/, "").trim();

/** POST search → normalized fit list. */
export async function searchFits({ query, tags, take = 8 }) {
  const d = await postJson("/Fit/PostSearchFits", {
    skip: 0, take, searchQuery: query || "", characterId: null, minPrice: 0, maxPrice: -1,
    cloneState: "both", period: "every", weather: null, tier: null, shipId: null, shipGroupId: null,
    tags: tags || null, sortField: "favorited", sortOrder: "desc",
    onlyAbyssTracker: null, onlyOwnFits: null, showUnpublishedFits: null, isSearchModeAnd: true,
  });
  return (d?.results || []).map((f) => ({
    id: f.id, name: f.name, shipId: f.shipId, shipName: f.shipName, shipClass: f.shipClass,
    tags: (f.tags || []).map((t) => t.name).filter(Boolean).slice(0, 4),
    author: f.characterName || null, cost: f.totalCost ?? null, alpha: !!f.isAlphaUsable,
  })).filter((f) => f.id && f.shipName);
}

// Build a full EFT from the GetById detail (slots + drones). The engine slots modules by type,
// so rack order isn't critical; charges usually sit in cargo → describeDoctrineFit injects the
// min/max ammo for the damage spread, exactly like a killmail loss fit.
function detailToEft(res) {
  if (typeof res?.eft === "string" && /^\s*\[.+,/.test(res.eft)) return res.eft;
  if (!res?.shipName) return null;
  const names = (arr) => (arr || []).map((m) => m.typeName).filter(Boolean);
  const lines = [`[${res.shipName}, ${res.name || "EVE Workbench"}]`];
  for (const k of ["lowSlot", "mediumSlot", "highSlot", "rigSlot", "subSlot"]) lines.push(...names(res[k]));
  const drones = (res.droneBay || []).map((d) => d.typeName ? `${d.typeName} x${d.amount || 1}` : null).filter(Boolean);
  if (drones.length) { lines.push(""); lines.push(...drones); }
  return lines.length > 1 ? lines.join("\n") : null;
}

/** GET detail → a complete EFT string (or null). */
export async function getFitEft(id) {
  const res = (await getJson(`/Fit/GetById?id=${encodeURIComponent(id)}`))?.result;
  if (!res) return null;
  const eft = detailToEft(res);
  return eft ? { eft, name: res.name, shipName: res.shipName } : null;
}

const ORD = { prim: 1, second: 2, terz: 3, quart: 4, quint: 5, first: 1, third: 3, fourth: 4, fifth: 5 };
// Resolve a fit reference — "#2", "il secondo", a ship name or a fit-name substring.
function resolveFit(needle, fits) {
  const n = clean(needle).toLowerCase().replace(/^(?:il|lo|la|the|fit|fitting|nave)\s+/i, "");
  if (!n) return fits[0] || null;
  const num = n.match(/^[#n]?[°.]?\s*(\d{1,2})$/);
  if (num) return fits[Number(num[1]) - 1] || null;
  for (const [stem, idx] of Object.entries(ORD)) if (n.startsWith(stem)) return fits[idx - 1] || null;
  let best = null;
  for (const f of fits) {
    const hay = `${f.shipName} ${f.name}`.toLowerCase();
    if (hay.includes(n)) { best = f; break; }
  }
  return best || fits[0] || null;
}

// Fit-intent classifier for a question. Returns { mode, tag } or null.
//  • 'primary'       — a direct "give me a fit" request → the fit list IS the answer.
//  • 'supplementary' — fitting asked inside a knowledge question ("what's X's bonus and how
//                      do I fit it") → keep the RAG answer and ATTACH the fit list as a card.
const FIT_WORD = /\bfit\w*\b|\bloadout\b|\bequipaggiament\w*\b|\bcome\s+(?:si\s+)?(?:fitt\w*|mont\w*|equipaggi\w*|arm\w*)\b|\bhow\s+(?:do\s+i|to|should\s+i)\s+(?:fit|equip)\b/i;
const FIT_REQUEST = /\b(?:vog[lh]io|cerca\w*|consiglia\w*|trova\w*|dammi|suggerisci\w*|mostra\w*|propon\w*|i\s+want|find\s+me|recommend|suggest|gimme)\b/i;
export function fitIntent(question) {
  if (!FIT_WORD.test(question)) return null;
  return { mode: FIT_REQUEST.test(question) ? "primary" : "supplementary", tag: needToTag(question) };
}

// Runs the search for an already-resolved ship (the engine takes it from the RAG ship doc, which
// is reliable even when the ship is named mid-sentence). Returns a 'fitlist' card or null, and
// remembers the results so "specifiche del #N" can drill in.
export async function runFitSearch(ship, tag) {
  if (!ship) return null;
  const fits = await searchFits({ query: ship, tags: tag, take: 8 });
  if (!fits.length) return null;
  resetDoctrineMemory();                 // a fit search becomes the active "specs" context
  lastFitSearch = { ship, tag, fits };
  return { kind: "fitlist", ship, tag, items: fits };
}

/** DRILL-DOWN only: "specifiche del #2" / "fit del primo" → computed stats card + EFT. Gated on
 *  a prior fit search (lastFitSearch). The SEARCH itself is driven by the engine (fitIntent +
 *  runFitSearch) because it needs the RAG-resolved ship. Returns a live block or EMPTY. */
export async function maybeWorkbench(question) {
  const q = question;
  try {
    if (lastFitSearch?.fits?.length) {
      const m = q.match(/\b(?:specifiche|statistiche|specs?|stats?|dettagli|caratteristiche|scheda|apri|mostra(?:mi)?|fit|fitting)\b[\s\S]*?([\w'’\-# ]{1,30})$/i);
      if (m && /\b(?:#?\d|prim|second|terz|quart|quint|first|second|third|fourth|fifth|specifich|specs?|stats?|dettagli|scheda|apri|mostra)\b/i.test(q)) {
        const target = resolveFit(m[1], lastFitSearch.fits);
        if (target) {
          const built = await getFitEft(target.id);
          if (built) {
            const stats = await doctrineFitStatsData(built.eft);   // { card, summary }
            if (stats?.card) {
              const url = `https://eveworkbench.com/fit/${target.id}`;
              const header = `fit «${target.name}» (${target.shipName}) — EVE Workbench`;
              return { text: `INTEL EVE Workbench (dati live) — ${header}:\n${stats.summary}\nFonte: ${url}`,
                entities: [], source: url, sourceTitle: "eveworkbench.com · fit (dati live)",
                cards: { ...stats.card, context: `EVE Workbench · «${target.name}»`, href: url }, theory: true, eft: built.eft };
            }
          }
        }
      }
    }
  } catch { /* never break a chat answer over a live-data failure */ }
  return EMPTY;
}
