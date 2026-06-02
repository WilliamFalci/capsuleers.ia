// Official ESI APIs (Fenris Creations) — esi.evetech.net. Official live data, complementary to
// eve-kill: corporation/alliance records (CEO, members, alliance, founding date)
// and system activity (jumps / ship kills / npc kills / pod kills) per
// geographic area. Public endpoints, no auth, datasource=tranquility. Requires internet.
import { search } from "./intel.mjs";
import { USER_AGENT as UA } from "./user-agent.mjs";

const ESI = "https://esi.evetech.net/latest";

async function get(p) {
  const r = await fetch(`${ESI}${p}${p.includes("?") ? "&" : "?"}datasource=tranquility`, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`ESI HTTP ${r.status} ${p}`);
  return r.json();
}
async function post(p, body) {
  const r = await fetch(`${ESI}${p}?datasource=tranquility`, {
    method: "POST", headers: { "content-type": "application/json", "User-Agent": UA }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`ESI HTTP ${r.status} ${p}`);
  return r.json();
}

// Batch ID→{id,name,category} resolution via ESI.
async function namesOf(ids) {
  const uniq = [...new Set(ids.filter((x) => x != null))];
  const map = new Map();
  if (!uniq.length) return map;
  try { for (const x of await post("/universe/names/", uniq.slice(0, 1000))) map.set(x.id, x); } catch { /* offline */ }
  return map;
}

// Resolves a geographic name (region/constellation/system) → {category,id,name}.
// NB: /universe/ids is case-insensitive but wants the (almost) exact name.
async function resolveArea(name) {
  let d;
  try { d = await post("/universe/ids/", [name]); } catch { return null; }
  for (const [cat, key] of [["regions", "region"], ["constellations", "constellation"], ["systems", "system"]]) {
    if (d[cat]?.length) return { category: key, id: d[cat][0].id, name: d[cat][0].name };
  }
  return null;
}

function parseEntity(hit) {
  const m = String(hit.id || "").match(/^(alliance|corporation|character)_(\d+)$/);
  return m ? { type: m[1], id: Number(m[2]), name: hit.name } : null;
}

const dateOnly = (iso) => String(iso || "").slice(0, 10);

// === Corporation / Alliance: CEO, members, alliance, founding date (ESI records) ===
// Name resolution uses eve-kill's fuzzy search (ranked by relevance:
// avoids hitting inactive same-named shells), then ESI gives the official data via ID.
export async function corpSummary(rawName) {
  let ent = null;
  try {
    const hits = await search(rawName);
    ent = hits.map(parseEntity).find((e) => e && (e.type === "corporation" || e.type === "alliance")) || null;
  } catch { /* no eve-kill network */ }
  if (!ent) return null;

  try {
    if (ent.type === "alliance") {
      const a = await get(`/alliances/${ent.id}/`);
      const nm = await namesOf([a.executor_corporation_id, a.creator_corporation_id]);
      const exec = nm.get(a.executor_corporation_id);
      const lines = [`${a.name} [${a.ticker}] — Alleanza`];
      if (exec) lines.push(`Corporazione esecutrice (leadership): ${exec.name}`);
      lines.push(`Fondata: ${dateOnly(a.date_founded)}`);
      const entities = [{ name: a.name, type: "alliance", id: ent.id }];
      if (exec) entities.push({ name: exec.name, type: "corporation", id: a.executor_corporation_id });
      return { text: `INTEL ESI (Fenris Creations, dati ufficiali live):\n${lines.join("\n")}\nFonte: https://esi.evetech.net/`, entities };
    }
    const c = await get(`/corporations/${ent.id}/`);
    const nm = await namesOf([c.ceo_id, c.alliance_id]);
    const ceo = nm.get(c.ceo_id), ally = nm.get(c.alliance_id);
    const lines = [`${c.name} [${c.ticker}] — Corporazione`];
    if (ceo) lines.push(`CEO: ${ceo.name}`);
    lines.push(`Membri: ${c.member_count}`);
    if (ally) lines.push(`Alleanza: ${ally.name}`);
    lines.push(`Fondata: ${dateOnly(c.date_founded)} · Tax rate: ${Math.round((c.tax_rate ?? 0) * 100)}%`);
    const entities = [{ name: c.name, type: "corporation", id: ent.id }];
    if (ceo) entities.push({ name: ceo.name, type: "character", id: c.ceo_id });
    if (ally) entities.push({ name: ally.name, type: "alliance", id: c.alliance_id });
    return { text: `INTEL ESI (Fenris Creations, dati ufficiali live):\n${lines.join("\n")}\nFonte: https://esi.evetech.net/`, entities };
  } catch { return null; }
}

// === Character affiliation: which corporation/alliance they belong to ===
export async function characterAffiliation(rawName) {
  let ent = null;
  try {
    const hits = await search(rawName);
    ent = hits.map(parseEntity).find((e) => e && e.type === "character") || null;
  } catch { /* no eve-kill network */ }
  if (!ent) return null;
  try {
    const c = await get(`/characters/${ent.id}/`);  // name, corporation_id, alliance_id
    const corp = c.corporation_id ? await get(`/corporations/${c.corporation_id}/`).catch(() => null) : null;
    const nm = await namesOf([c.alliance_id].filter(Boolean));
    const ally = c.alliance_id ? nm.get(c.alliance_id) : null;
    const lines = [`${c.name} — Personaggio`];
    if (corp) lines.push(`Corporazione: ${corp.name} [${corp.ticker}]${corp.member_count != null ? ` (${corp.member_count} membri)` : ""}`);
    if (ally) lines.push(`Alleanza: ${ally.name}`);
    if (typeof c.security_status === "number") lines.push(`Security status: ${c.security_status.toFixed(1)}`);
    const entities = [{ name: c.name, type: "character", id: ent.id }];
    if (corp) entities.push({ name: corp.name, type: "corporation", id: c.corporation_id });
    if (ally) entities.push({ name: ally.name, type: "alliance", id: c.alliance_id });
    return { text: `INTEL ESI (Fenris Creations, dati ufficiali live):\n${lines.join("\n")}\nFonte: https://esi.evetech.net/`, entities };
  } catch { return null; }
}

// === System activity per area (last hour, ESI universe/system_* feed) ===
const regionCache = new Map();  // regionId → Set(systemId)
async function regionSystemIds(regionId) {
  if (regionCache.has(regionId)) return regionCache.get(regionId);
  const region = await get(`/universe/regions/${regionId}/`);
  const set = new Set();
  await Promise.all((region.constellations || []).map(async (cid) => {
    try { const c = await get(`/universe/constellations/${cid}/`); (c.systems || []).forEach((s) => set.add(s)); } catch { /* skip */ }
  }));
  regionCache.set(regionId, set);
  return set;
}

const TOP_N = 10;

// System→region resolution (with persistent cache: only the ~20 systems shown).
const sysToRegionId = new Map();    // systemId → regionId
const constToRegionId = new Map();  // constellationId → regionId
async function regionsOfSystems(ids) {
  const miss = [...new Set(ids)].filter((id) => !sysToRegionId.has(id));
  await Promise.all(miss.map(async (id) => {
    try {
      const sys = await get(`/universe/systems/${id}/`);
      let rid = constToRegionId.get(sys.constellation_id);
      if (rid == null) {
        const con = await get(`/universe/constellations/${sys.constellation_id}/`);
        rid = con.region_id; constToRegionId.set(sys.constellation_id, rid);
      }
      sysToRegionId.set(id, rid);
    } catch { sysToRegionId.set(id, null); }
  }));
  const rnames = await namesOf([...new Set(ids.map((id) => sysToRegionId.get(id)).filter((x) => x != null))]);
  const out = new Map();
  for (const id of ids) { const rid = sysToRegionId.get(id); out.set(id, rid != null ? (rnames.get(rid)?.name || null) : null); }
  return out;
}

// Formats one or more rankings (label → rows {id,v}) resolving the names once.
// withRegions=true → puts the region next to each system (global list).
async function fmtRankings(scope, sections, withRegions = false) {
  const ids = sections.flatMap(([, rows]) => rows.map((r) => r.id));
  if (!ids.length) {
    return { text: `INTEL ESI (Fenris Creations, dati ufficiali live): nessuna attività rilevante in ${scope} nell'ultima ora.`, entities: [] };
  }
  const nm = await namesOf(ids);
  const regionMap = withRegions ? await regionsOfSystems(ids) : null;
  const blocks = sections.map(([label, rows]) => {
    if (!rows.length) return `Top ${label}: nessuna attività nell'ultima ora.`;
    const lines = rows.map((x, i) => {
      const region = regionMap?.get(x.id);
      return `${i + 1}. ${nm.get(x.id)?.name || x.id}${region ? ` (${region})` : ""}: ${x.v.toLocaleString("it-IT")}`;
    });
    return `Top ${rows.length} per ${label} (ultima ora):\n${lines.join("\n")}`;
  });
  return {
    text: `INTEL ESI (Fenris Creations, dati ufficiali live) — sistemi più attivi in ${scope}:\n${blocks.join("\n\n")}\nFonte: https://esi.evetech.net/`,
    entities: [],
  };
}

/**
 * Most active systems. areaName=null → the WHOLE universe (New Eden); otherwise
 * filters by region/constellation/system. By default returns TWO rankings:
 * PVP (ship kills) and PVE (npc kills), top 10 each. opts.metric="jumps" →
 * a single traffic ranking. Returns null only if a given area is unresolvable.
 */
export async function systemActivity(areaName, opts = {}) {
  let systemSet = null, scope = "tutto l'universo (New Eden)";
  if (areaName) {
    const area = await resolveArea(areaName);
    if (!area) return null;
    scope = area.name;
    if (area.category === "region") systemSet = await regionSystemIds(area.id);
    else if (area.category === "constellation") { const c = await get(`/universe/constellations/${area.id}/`); systemSet = new Set(c.systems || []); }
    else systemSet = new Set([area.id]);
  }
  const inScope = (id) => systemSet === null || systemSet.has(id);
  const rank = (rows, field) => rows.map((x) => ({ id: x.system_id, v: x[field] }))
    .filter((x) => inScope(x.id) && x.v > 0).sort((a, b) => b.v - a.v).slice(0, TOP_N);

  const global = systemSet === null;  // global list → show the region of each system

  // Explicit traffic → single jumps ranking.
  if (opts.metric === "jumps") {
    let jumps;
    try { jumps = await get("/universe/system_jumps/"); } catch { return null; }
    return fmtRankings(scope, [["jumps (traffico)", rank(jumps, "ship_jumps")]], global);
  }

  // Default: PVP (ship kills) + PVE (npc kills).
  let kills;
  try { kills = await get("/universe/system_kills/"); } catch { return null; }
  return fmtRankings(scope, [
    ["ship kills (PVP)", rank(kills, "ship_kills")],
    ["NPC kills (PVE)", rank(kills, "npc_kills")],
  ], global);
}
