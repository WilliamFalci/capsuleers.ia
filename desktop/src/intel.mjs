// Live intel from eve-kill.com (killboard): characters, corporations, alliances.
// Public API, no auth, CORS. Requires internet (real-time data).
import { priceByTypeId } from "./prices.mjs";

const BASE = "https://api.eve-kill.com";
const UA = "Capsuleers.IA/0.1 (dedodj@gmail.com)";

async function get(pathQ) {
  const r = await fetch(BASE + pathQ, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`eve-kill HTTP ${r.status}`);
  return r.json();
}

function isk(n) {
  n = typeof n === "number" ? n : 0;
  if (n >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return String(Math.round(n));
}

function parseId(hit) {
  const m = String(hit.id || "").match(/^(alliance|corporation|character)_(\d+)$/);
  return m ? { type: m[1], id: Number(m[2]) } : null;
}

// Batch ID→name resolution via ESI (ship type, system, character, corp, alliance).
async function resolveNames(ids) {
  const uniq = [...new Set(ids.filter((x) => x))];
  const out = new Map();
  if (!uniq.length) return out;
  try {
    const r = await fetch("https://esi.evetech.net/latest/universe/names/", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(uniq.slice(0, 1000)),
    });
    if (r.ok) for (const x of await r.json()) out.set(x.id, x.name);
  } catch { /* offline: no names */ }
  return out;
}

function shortDate(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}` : "";
}

// Recent kills (or losses) of an entity → structured data for the cards.
async function recentKills(ep, id, kind, limit = 6) {
  const list = await get(`/${ep}/${id}/${kind}?limit=${limit}&before=99999999999`);
  const raw = Array.isArray(list) ? list : (list.killmails || list.data || list.items || []);
  if (!raw.length) return { kills: [], entities: [] };
  const slice = raw.slice(0, limit);
  const ids = [];
  for (const k of slice) {
    const v = k.victim || {};
    ids.push(v.ship_type_id, k.solar_system_id, v.character_id || v.corporation_id);
  }
  const names = await resolveNames(ids);
  const kills = [], entities = [];
  for (const k of slice) {
    const v = k.victim || {};
    const whoId = v.character_id || v.corporation_id;
    const who = names.get(whoId) || "?";
    const price = await priceByTypeId(v.ship_type_id);
    kills.push({
      kind,
      killmailId: k.killmail_id,
      shipId: v.ship_type_id,
      shipName: names.get(v.ship_type_id) || `nave ${v.ship_type_id}`,
      victimId: whoId || null,
      victimName: who,
      isCharacter: !!v.character_id,
      systemId: k.solar_system_id,
      system: names.get(k.solar_system_id) || "?",
      value: price?.adjusted ?? null,
      time: k.killmail_time,        // UTC = EVE Time
    });
    if (whoId && who !== "?") entities.push({ name: who, type: v.character_id ? "character" : "corporation", id: whoId });
  }
  return { kills, entities };
}

export async function search(name) {
  const d = await get(`/search?q=${encodeURIComponent(name)}&limit=5`);
  return d.hits || [];
}

function fmtGroup(name, ticker, type, s) {
  const label = type === "alliance" ? "Alleanza" : "Corporazione";
  const lines = [`${name}${ticker ? ` [${ticker}]` : ""} — ${label}`];
  lines.push(`Kill: ${s.kills || 0} · Perdite: ${s.losses || 0} · Efficienza ISK: ${s.isk_efficiency ?? s.efficiency ?? 0}%`);
  lines.push(`ISK distrutti: ${isk(s.isk_destroyed)} · ISK persi: ${isk(s.isk_lost)}`);
  const ships = (s.topShips || []).map((x) => x.ship_name).filter(Boolean).slice(0, 5);
  if (ships.length) lines.push(`Navi più usate: ${ships.join(", ")}`);
  const sys = (s.topSystems || []).map((x) => x.system_name || x.name).filter(Boolean).slice(0, 5);
  if (sys.length) lines.push(`Sistemi più attivi: ${sys.join(", ")}`);
  const mem = (s.topMembers || []).map((x) => x.name).filter(Boolean).slice(0, 3);
  if (mem.length) lines.push(`Top membri: ${mem.join(", ")}`);
  return lines.join("\n");
}

function fmtCharacter(name, stats, intel) {
  const lines = [`${name} — Personaggio`];
  if (stats && (stats.kills != null || stats.losses != null)) {
    lines.push(`Kill: ${stats.kills || 0} · Perdite: ${stats.losses || 0}`
      + (stats.isk_efficiency != null ? ` · Efficienza ISK: ${stats.isk_efficiency}%` : ""));
  }
  if (intel) {
    if (intel.dominant_style) {
      const fc = intel.fc?.likelihood && intel.fc.likelihood !== "None" ? `, probabilità FC: ${intel.fc.likelihood}` : "";
      lines.push(`Stile di gioco: ${intel.dominant_style}${fc}`);
    }
    const flags = [];
    if (intel.capital_pilot) flags.push("capital pilot");
    if (intel.is_logi) flags.push("logi");
    if (intel.bait && intel.bait !== "None") flags.push(`bait: ${intel.bait}`);
    if (flags.length) lines.push(`Note: ${flags.join(", ")}`);
    const ships = (intel.ships_flown || []).map((x) => x.name || x.ship_name).filter(Boolean).slice(0, 5);
    if (ships.length) lines.push(`Navi recenti: ${ships.join(", ")}`);
  }
  return lines.join("\n");
}

// Recent battles (corp/alliance only; the fields already include the names).
async function recentBattles(type, id, limit = 4) {
  if (type === "character") return "";
  const d = await get(`/battles/${type}/${id}?limit=${limit}`);
  const b = Array.isArray(d) ? d : (d.battles || d.data || d.items || []);
  if (!b.length) return "";
  const lines = b.slice(0, limit).map((x) =>
    `  • ${x.system_name} (${x.region_name}) — ${shortDate(x.start_time)}, ${x.duration_minutes}min, ${x.kill_count} kill, ${isk(x.total_isk_destroyed)} ISK`);
  return `Ultime battaglie:\n${lines.join("\n")}`;
}

/**
 * Searches for an entity by name and returns an intel summary (or null).
 * opts: { kills, losses, battles } to include the recent data.
 */
export async function intelFor(name, opts = {}) {
  let hits;
  try { hits = await search(name); } catch { return null; }
  if (!hits.length) return null;
  const hit = hits[0];
  const pid = parseId(hit);
  if (!pid) return null;
  try {
    const parts = [];
    const entities = [{ name: hit.name, type: pid.type, id: pid.id }];
    if (pid.type === "character") {
      const [st, it] = await Promise.allSettled([
        get(`/characters/${pid.id}/stats`),
        get(`/characters/${pid.id}/intel?days=90`),
      ]);
      parts.push(fmtCharacter(hit.name, st.value, it.value));
    } else {
      const sep = pid.type === "alliance" ? "alliances" : "corporations";
      const stats = await get(`/${sep}/${pid.id}/stats/alltime`);
      parts.push(fmtGroup(hit.name, hit.ticker, pid.type, stats));
      for (const tm of (stats.topMembers || []).slice(0, 3)) {
        if (tm.character_id && tm.name) entities.push({ name: tm.name, type: "character", id: tm.character_id });
      }
    }
    const ep = pid.type === "alliance" ? "alliances" : pid.type === "corporation" ? "corporations" : "characters";
    const empty = { kills: [], entities: [] };
    const kills = [];
    if (opts.kills) { const k = await recentKills(ep, pid.id, "kills").catch(() => empty); kills.push(...k.kills); entities.push(...k.entities); }
    if (opts.losses) { const l = await recentKills(ep, pid.id, "losses").catch(() => empty); kills.push(...l.kills); entities.push(...l.entities); }
    if (opts.battles) { const b = await recentBattles(pid.type, pid.id).catch(() => ""); if (b) parts.push(b); }
    if (kills.length) parts.push("(I kill recenti sono elencati come schede dettagliate sotto la risposta.)");
    return {
      text: `INTEL eve-kill.com (dati live):\n${parts.join("\n")}\nFonte: https://eve-kill.com/${pid.type}/${pid.id}`,
      entities,
      kills,
    };
  } catch {
    return null;
  }
}

// ── Group intel for a Local (list of names from the clipboard) ──────────────

// Affiliation (corp/alliance + ticker) via official ESI. In a fleet many
// pilots share the same corp/alliance: the cache avoids repeated requests.
const ESI = "https://esi.evetech.net/latest";
async function esiGet(p) {
  const r = await fetch(`${ESI}${p}${p.includes("?") ? "&" : "?"}datasource=tranquility`, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`ESI ${r.status}`);
  return r.json();
}
const groupCache = new Map();   // "corporations:ID" / "alliances:ID" → {id,ticker,name}
async function groupInfo(kind, id) {
  if (id == null) return null;
  const key = `${kind}:${id}`;
  if (groupCache.has(key)) return groupCache.get(key);
  let info = null;
  try { const d = await esiGet(`/${kind}/${id}/`); info = { id, ticker: d.ticker || "", name: d.name || "" }; } catch { /* offline */ }
  groupCache.set(key, info);
  return info;
}
// Corp + alliance of a character (with ticker and id for the logos).
async function affiliation(charId) {
  let aff;
  try { aff = await esiGet(`/characters/${charId}/`); } catch { return {}; }
  const [corp, alliance] = await Promise.all([
    groupInfo("corporations", aff.corporation_id),
    aff.alliance_id ? groupInfo("alliances", aff.alliance_id) : null,
  ]);
  return { corp, alliance };
}

// Estimates the danger level (0=unknown · 1=low · 2=medium · 3=high) of a
// character from eve-kill data, to highlight dangerous pilots.
function dangerScore(stats, intel) {
  if (!stats && !intel) return 0;                 // no data → unknown
  let s = 1;                                       // has data → at least low
  const kills = stats?.kills || 0;
  const eff = stats?.isk_efficiency;
  if (kills >= 100 || (eff != null && eff >= 70) || intel?.is_logi) s = 2;   // medium
  const fc = intel?.fc?.likelihood;
  const fcHot = fc && fc !== "None" && fc !== "Low";
  if (intel?.capital_pilot || fcHot || kills >= 500 || (intel?.bait && intel.bait !== "None")) s = 3; // high
  return s;
}

// Resolves a single character by exact name → ID via eve-kill search.
async function charIdByName(name) {
  let hits;
  try { hits = await search(name); } catch { return null; }
  if (!hits?.length) return null;
  const hit = hits.find((h) => /^character_/.test(String(h.id))) || null;
  if (!hit) return null;
  const pid = parseId(hit);
  return pid ? { id: pid.id, name: hit.name } : null;
}

// Concise summary card of a character for the Local table.
// Returns { name, id, danger, kills, losses, eff, flags[], found }.
async function characterRow(name) {
  const idn = await charIdByName(name);
  if (!idn) return { name, id: null, danger: 0, kills: null, losses: null, eff: null, flags: [], found: false };
  const [st, it, aff] = await Promise.allSettled([
    get(`/characters/${idn.id}/stats`),
    get(`/characters/${idn.id}/intel?days=90`),
    affiliation(idn.id),
  ]);
  const stats = st.status === "fulfilled" ? st.value : null;
  const intel = it.status === "fulfilled" ? it.value : null;
  const { corp = null, alliance = null } = aff.status === "fulfilled" ? aff.value : {};
  const flags = [];
  if (intel?.capital_pilot) flags.push("capital");
  if (intel?.is_logi) flags.push("logi");
  if (intel?.fc?.likelihood && intel.fc.likelihood !== "None") flags.push("FC:" + intel.fc.likelihood);
  if (intel?.bait && intel.bait !== "None") flags.push("bait");
  if (intel?.dominant_style) flags.push(intel.dominant_style);
  return {
    name: idn.name, id: idn.id,
    danger: dangerScore(stats, intel),
    kills: stats?.kills ?? null,
    losses: stats?.losses ?? null,
    eff: stats?.isk_efficiency ?? null,
    flags,
    corpId: corp?.id ?? null, corpTicker: corp?.ticker || "", corpName: corp?.name || "",
    allianceId: alliance?.id ?? null, allianceTicker: alliance?.ticker || "", allianceName: alliance?.name || "",
    found: true,
  };
}

// Runs `tasks` (functions → Promise) with at most `limit` in parallel,
// invoking onEach(result, completed) as they finish.
async function pool(tasks, limit, onEach) {
  let i = 0, done = 0;
  const results = new Array(tasks.length);
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      try { results[idx] = await tasks[idx](); } catch { results[idx] = null; }
      done++;
      try { onEach?.(results[idx], done); } catch { /* */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/**
 * Resolves the concise intel for a list of names (Local).
 * - cap: maximum number of pilots to resolve (the rest stay stubs)
 * - onProgress(done, total): progress callback
 * Returns { rows, total, resolved, capped } with rows sorted alphabetically.
 */
export async function localIntel(names, { cap = 100, concurrency = 4, onProgress } = {}) {
  const uniq = [...new Set((names || []).map((n) => n.trim()).filter(Boolean))];
  const total = uniq.length;
  const target = uniq.slice(0, cap);
  const capped = total > cap;

  const tasks = target.map((n) => () => characterRow(n));
  const resolved = await pool(tasks, concurrency, (_r, done) => onProgress?.(done, target.length));

  const rows = resolved.filter(Boolean);
  for (const n of uniq.slice(cap)) rows.push({ name: n, id: null, danger: 0, kills: null, losses: null, eff: null, flags: [], found: false });

  rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { rows, total, resolved: target.length, capped };
}

/**
 * Full intel detail of a character (for the popup on row click).
 * Accepts the already-known ID (preferred) or the name. Returns an object ready
 * for rendering, or null.
 */
export async function characterDetail({ id, name } = {}) {
  if (id == null && name) { const idn = await charIdByName(name); if (idn) { id = idn.id; name = idn.name; } }
  if (id == null) return null;
  const [st, it, aff] = await Promise.allSettled([
    get(`/characters/${id}/stats`),
    get(`/characters/${id}/intel?days=90`),
    affiliation(id),
  ]);
  const stats = st.status === "fulfilled" ? st.value : null;
  const intel = it.status === "fulfilled" ? it.value : null;
  const { corp = null, alliance = null } = aff.status === "fulfilled" ? aff.value : {};
  const ps = intel?.playstyle || {};
  return {
    id,
    name: name || `#${id}`,
    corpName: corp?.name || "", corpId: corp?.id ?? null, corpTicker: corp?.ticker || "",
    allianceName: alliance?.name || "", allianceId: alliance?.id ?? null, allianceTicker: alliance?.ticker || "",
    kills: stats?.kills ?? null,
    losses: stats?.losses ?? null,
    eff: stats?.isk_efficiency ?? null,
    danger: dangerScore(stats, intel),
    dominant: intel?.dominant_style || "",
    // Percentages for the solo / small+mid / fleet+blob bar.
    play: {
      solo: ps.solo ?? 0,
      small: (ps.small_gang ?? 0) + (ps.mid_gang ?? 0),
      fleet: (ps.fleet ?? 0) + (ps.blob ?? 0),
      avgFleet: ps.avg_fleet_size ?? null,
    },
    capital_pilot: !!intel?.capital_pilot,
    is_logi: !!intel?.is_logi,
    fc: intel?.fc?.likelihood && intel.fc.likelihood !== "None" ? intel.fc.likelihood : "",
    bait: intel?.bait && intel.bait !== "None" ? intel.bait : "",
    partners: (intel?.fleet_partners || []).slice(0, 10).map((p) => ({ id: p.id, name: p.name, count: p.count })),
    ships: (intel?.ships_flown || []).slice(0, 6).map((s) => ({ id: s.id, name: s.name, count: s.count })),
  };
}
