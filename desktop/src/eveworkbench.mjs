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
// Strips leading articles + a trailing need word so "la vagabond pvp" → "vagabond".
function shipName(s) {
  let n = clean(s).replace(/^(?:una?|un['’]?|la|lo|il|le|gli|i|l['’]|the|a|an)\s+/i, "");
  n = n.replace(/\s+(?:pvp|pve|ratting|mining|exploration|esplorazione|wormhole|incursion\w*|abyss\w*|economic\w*|economic|cheap|barato|t1|t2|meta|fit|fitting|loadout)$/i, "").trim();
  return n;
}

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

/**
 * Detects a "fit by need" request and answers it. Returns a live block or EMPTY.
 *  • DRILL-DOWN (gated on a prior search): "specifiche del #2" / "fit del primo" → stats + EFT.
 *  • SEARCH: "voglio/cercami/consigliami un fit[ting] [need] per la <nave>" → fit-list card.
 */
export async function maybeWorkbench(question) {
  const q = question;
  try {
    // DRILL-DOWN first (so it isn't swallowed by the search regex).
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

    // SEARCH: must mention a fit AND target a ship (after per/della/for…, or a request verb).
    if (!/\bfit\w*\b/i.test(q)) return EMPTY;
    const hasVerb = /\b(?:vog[lh]io|cerca\w*|consiglia\w*|trova\w*|dammi|suggerisci\w*|mostra\w*|propon\w*|i\s+want|find|suggest|recommend|gimme|need)\b/i.test(q);
    const conn = q.match(/\b(?:per|della|dello|del|dell['’]|dei|degli|delle|da|for|of)\s+([\w'’\-. ]{2,40})$/i);
    if (!conn && !hasVerb) return EMPTY;
    let ship = shipName(conn ? conn[1] : (q.match(/\bfit\w*\b\s+(?:[a-z]+\s+)?([\w'’\-. ]{2,40})$/i)?.[1] || ""));
    if (!ship || ship.length < 2) return EMPTY;
    const tag = needToTag(q);
    const fits = await searchFits({ query: ship, tags: tag, take: 8 });
    if (!fits.length) return EMPTY;
    resetDoctrineMemory();                 // a fit search becomes the active "specs" context
    lastFitSearch = { ship, tag, fits };
    const label = `fit per ${ship}${tag ? ` (${tag})` : ""} da EVE Workbench`;
    const body = `${fits.length} fit della community trovati, numerati #1–#${fits.length} nella lista sotto. `
      + `Di' all'utente che può chiedere «specifiche del #X» (es. «specifiche del #1») per ottenere il fitting completo in EFT e l'analisi di quel fit (DPS, gittata, tank, velocità).`;
    return {
      text: `INTEL EVE Workbench (dati live) — ${label}:\n${body}\nFonte: https://eveworkbench.com/`,
      entities: [], source: "https://eveworkbench.com/", sourceTitle: "eveworkbench.com · fit community (dati live)",
      cards: { kind: "fitlist", ship, tag, items: fits },
    };
  } catch { /* never break a chat answer over a live-data failure */ }
  return EMPTY;
}
