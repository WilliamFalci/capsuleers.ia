// Live features built on the EVE-KILL MCP server (see mcp.mjs). Each helper returns
// { text, entities, source, sourceTitle } — the same shape intel.mjs/esi.mjs use — so
// the engine drops the block straight into the RAG context and the local model narrates
// it in the user's language. Headers are in Italian (like the other live modules); the
// LANG_DIRECTIVE in engine.mjs re-languages the final answer to IT or EN as needed.
//
// What is NOT here on purpose:
//  • me_* tools — they target "your" character; the app has no login/pilot context.
//  • item_info/ship_info/system_info — ships/items/systems are answered offline from the
//    RAG index + local SDE; routing them online would break the offline-first stance.
//  • Fit math stays fully local + offline (fit.mjs → eve-fit-engine, pyfa parity);
//    no dogma_eval / fit_compare / ship_compare (server-side fit/ship evaluation) is wired.
//  • kills_with — redundant with flies_with (same "who appears on X's killmails" signal).
//  • compare — head-to-head A-vs-B is already served (more richly) by war_report.
// Everything else the server exposes that is read-only analytics IS wired below: the
// pulse tools (global/system), the entity_* family (kills/overview/timeline/top) and
// ships_used, on top of the original killmail/route/war/doctrine/intel-graph set.
import { callTool } from "./mcp.mjs";
import { doctrineFitStatsData } from "./fit.mjs";
import { resetFitMemory } from "./eveworkbench.mjs";

// ── Formatting helpers ───────────────────────────────────────────────────────

// Readable, indented serialization of an arbitrary JSON result (MCP tool shapes vary;
// this stays tolerant). The model rewrites it anyway, so we just need it labeled and present.
function pretty(v, ind = "") {
  if (v == null || v === "") return "";
  if (typeof v !== "object") return `${ind}${v}`;
  if (Array.isArray(v)) {
    return v.map((x) => (x != null && typeof x === "object")
      ? `${ind}-\n${pretty(x, ind + "  ")}`
      : `${ind}- ${x}`).join("\n");
  }
  return Object.entries(v)
    // Drop noise the local model would choke on: opaque hashes and bare urls.
    .filter(([k, val]) => val != null && val !== "" && !(Array.isArray(val) && !val.length) && !/hash/i.test(k) && k !== "url")
    .map(([k, val]) => (typeof val === "object")
      ? `${ind}${k}:\n${pretty(val, ind + "  ")}`
      : `${ind}${k}: ${val}`)
    .join("\n");
}
function render(data, cap = 2400) {
  const s = pretty(data);
  return s.length > cap ? s.slice(0, cap) + "\n…(troncato)" : s;
}

function iskShort(n) {
  n = Number(n) || 0;
  if (n >= 1e12) return (n / 1e12).toFixed(1) + "T";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(0) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return String(Math.round(n));
}

// doctrine_detect / meta_pulse return `clusters` of fit families (ship + signature +
// losses + ISK). The generic dump buries the useful "signature" under family_hash and
// module lists, so we render a clean numbered list instead. `withFit` appends the top
// cluster's example modules (the concrete fit). Returns null if there are no clusters.
function fmtClusters(d, { withFit = false } = {}) {
  const cl = d?.clusters || [];
  if (!cl.length) return null;
  const lines = cl.slice(0, 12).map((c, i) => {
    const ship = c.ship?.name || `nave ${c.ship?.type_id ?? "?"}`;
    const label = c.signature || `${ship}${c.ship?.group ? ` [${c.ship.group}]` : ""}`;
    const meta = [
      c.losses != null && `${c.losses} perdite`,
      c.avg_isk_per_loss && `~${iskShort(c.avg_isk_per_loss)} ISK ciascuna`,
    ].filter(Boolean).join(", ");
    return `${i + 1}. ${label}${meta ? ` (${meta})` : ""}`;
  });
  if (withFit) {
    const mods = cl[0]?.example_killmail?.modules;
    if (Array.isArray(mods) && mods.length) lines.push(`Fit d'esempio (${cl[0].ship?.name || "top"}): ${mods.join("; ")}`);
  }
  return lines.join("\n");
}

function pushEnt(out, seen, name, type, id) {
  if (!name || id == null) return;
  const key = `${type}:${id}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ name: String(name), type, id: Number(id) });
}
// Walks the result for {name, *_id} pairs so linkify() can link character/corp/alliance
// names to capsuleers.app. Best-effort: missing ids just mean no link.
function collectEntities(node, out = [], seen = new Set(), depth = 0) {
  if (!node || typeof node !== "object" || depth > 5 || out.length >= 20) return out;
  if (Array.isArray(node)) { for (const x of node) collectEntities(x, out, seen, depth + 1); return out; }
  const nm = node.name || node.character_name || node.corporation_name || node.alliance_name;
  if (node.character_id != null) pushEnt(out, seen, node.character_name || nm, "character", node.character_id);
  if (node.corporation_id != null) pushEnt(out, seen, node.corporation_name || (node.character_id == null ? nm : null), "corporation", node.corporation_id);
  if (node.alliance_id != null) pushEnt(out, seen, node.alliance_name || (node.character_id == null && node.corporation_id == null ? nm : null), "alliance", node.alliance_id);
  for (const v of Object.values(node)) if (v && typeof v === "object") collectEntities(v, out, seen, depth + 1);
  return out;
}

function block(header, data, { source = "https://eve-kill.com/", sourceTitle = "eve-kill · analisi MCP (dati live)" } = {}) {
  return blockBody(header, render(data), data, { source, sourceTitle });
}
// Same as block() but with a pre-rendered body (for tools that need a dedicated, cleaner
// formatter than the generic dump). Entities are still collected from the raw data.
function blockBody(header, body, data, { source = "https://eve-kill.com/", sourceTitle = "eve-kill · analisi MCP (dati live)" } = {}) {
  return {
    text: `INTEL eve-kill (MCP, dati live) — ${header}:\n${body}\nFonte: ${source}`,
    entities: collectEntities(data),
    source, sourceTitle,
  };
}

// ── Text extraction helpers ──────────────────────────────────────────────────

const clean = (s) => (s || "")
  .replace(/["'?.!,;:]+$/g, "").replace(/^["'\s]+/, "").trim()
  .replace(/\s+(?:adesso|ora|attualmente|al\s+momento|right\s+now|now|currently|please|per\s+favore)$/i, "").trim();

function stripLead(s) {
  let p;
  do {
    p = s;
    s = s.replace(/^[\s,:.'’"]+/, "")
      // A framing role word, optionally preceded by ANY article ("the pilot", "il personaggio",
      // "l'alleanza"): stripping "the"/"a" here is safe because a role word follows it.
      .replace(/^(?:(?:il|lo|la|i|gli|le|l['’]|the|un|una|uno|a|an)\s+)?(?:pilota|personaggio|player|character|corp(?:orazione|oration)?|alleanza|alliance|giocatore|capsuleer)\s+/i, "")
      // A BARE leading article. Italian only — NOT English "the"/"a"/"an", which are frequently
      // the first word of an EVE alliance name ("The Initiative.", "The Bastion", "A Band Apart.").
      // Stripping them dropped "The Initiative." onto an unrelated corp named "Initiative" (0 clusters).
      .replace(/^(?:il|lo|la|i|gli|le|l['’]|un|una|uno)\s+/i, "");
  } while (s !== p);
  return s;
}
// Cleans an entity name captured from a two-side ("X vs Y") match: drops the leading
// question framing ("chi vince…", "war report…") before the actual name.
function cleanEntity(s) {
  return stripLead(clean(s)
    .replace(/^.*?\b(?:chi\s+vince|chi\s+è\s+più\s+forte|who\s+wins|war\s*report|report|confronto|guerra|war|battaglia|battle)\b\s*/i, "")
    .replace(/^\s*(?:tra|fra|between|contro)\s+/i, ""));   // drop a leftover connector ("guerra TRA X…")
}
const ok = (s) => s && s.length >= 2 && s.length <= 60;

// ── Doctrine memory (for "specs of #2 / the Muninn" follow-ups) ───────────────
// Normalised clusters from the last successful doctrine_detect. Lets the next turn resolve
// a doctrine by ordinal or ship name and compute its fit stats, without re-querying the MCP.
let lastDoctrine = null;   // { entity, clusters:[{ name, signature, killmail_id, losses }] }
export function resetDoctrineMemory() { lastDoctrine = null; }

// killmail_fitting (format:"eft") returns { ..., eft }. Pull a valid EFT block out of it.
function extractEft(d) {
  const s = typeof d === "string" ? d : (d?.eft || d?.text || d?.fitting);
  return typeof s === "string" && /^\s*\[.+,/.test(s) ? s : null;
}

const ORD_WORDS = { prim: 1, second: 2, terz: 3, quart: 4, quint: 5, sest: 6, settim: 7,
  first: 1, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7 };
// Resolves a doctrine reference — "#2", "la seconda", or a ship name/signature — against the
// remembered clusters. Returns the matched cluster or null.
function resolveCluster(needle, clusters) {
  if (!clusters?.length) return null;
  const n = (needle || "").toLowerCase().trim().replace(/^(?:la|lo|il|the|dottrina|doctrine|nave|fit)\s+/i, "");
  if (!n) return null;
  const numM = n.match(/^[#n]?[°.]?\s*(\d{1,2})$/);            // "#2", "2", "n.2"
  if (numM) return clusters[Number(numM[1]) - 1] || null;
  for (const [stem, idx] of Object.entries(ORD_WORDS)) if (n.startsWith(stem)) return clusters[idx - 1] || null;
  let best = null;                                             // ship-name / signature substring
  for (const c of clusters) {
    const name = (c.name || "").toLowerCase();
    if (name && (n.includes(name) || name.includes(n))) return c;
    if (!best && n.length >= 3 && (c.signature || "").toLowerCase().includes(n)) best = c;
  }
  return best;
}

// Pulls the cluster's example killmail fit and computes its Pyfa-parity stats (with max/min
// damage spread). Returns { body, eft } — the Italian stats block + the raw EFT block so the
// caller can surface the verbatim fit — or null if it can't be fetched/computed.
async function doctrineFitStats(cluster) {
  if (!cluster?.killmail_id) return null;
  const ft = await callTool("killmail_fitting", { killmail_id: cluster.killmail_id, format: "eft" });
  const eft = extractEft(ft);
  if (!eft) return null;
  const stats = await doctrineFitStatsData(eft);   // { card, summary }
  return stats ? { ...stats, eft } : null;
}

// Normalises a doctrine_detect result into the slim cluster shape we cache in lastDoctrine.
function clustersFromDetect(d) {
  return (d?.clusters || []).map((c) => ({
    name: c.ship?.name || `nave ${c.ship?.type_id ?? "?"}`,
    signature: c.signature || "",
    killmail_id: c.example_killmail?.killmail_id,
    losses: c.losses,
  })).filter((c) => c.killmail_id);
}

// find_battles → structured cards (drawn client-side, not narrated as a wall of text).
function battleCards(d) {
  const arr = Array.isArray(d) ? d : (d?.battles || d?.results || d?.data || d?.items || []);
  return arr.slice(0, 12).map((b) => ({
    id: b.battle_id,
    href: b.url || (b.battle_id ? `https://eve-kill.com/battle/${b.battle_id}` : null),
    system: b.system?.name || null,
    region: b.system?.region_name || null,
    multiParty: !!b.is_multi_party,
    killCount: b.kill_count ?? null,
    durationMin: b.duration_minutes ?? null,
    iskDestroyed: b.total_isk_destroyed ?? null,
    iskPerMin: b.intensity_isk_per_minute ?? null,
    alliances: b.alliances_involved ?? null,
    corporations: b.corporations_involved ?? null,
    topAlliance: b.top_alliance_by_isk?.alliance_id ? {
      id: b.top_alliance_by_isk.alliance_id,
      name: b.top_alliance_by_isk.name,
      ticker: b.top_alliance_by_isk.ticker,
    } : null,
    start: b.start_time || null,
    end: b.end_time || null,
  }));
}

// flies_with / preys_on / hunted_by → a character portrait list (rendered client-side).
// Each row carries portrait id + name + corp/alliance sub + a metric (shared/total kills).
function entityListItems(rows) {
  return (rows || []).slice(0, 15).map((r) => {
    const id = r.character_id ?? r.id;
    const name = r.character_name || r.name;
    if (!id || !name) return null;
    return {
      id, type: "character", name,
      sub: [r.corporation_name, r.alliance_name].filter(Boolean).join(" · "),
      metric: r.shared_kills ?? r.kills ?? r.count ?? null,
    };
  }).filter(Boolean);
}

// war_report → a head-to-head "versus" recap card (two sides with logos + scoreboard + ISK share).
function versusCard(d) {
  const t = d?.totals;
  if (!d?.a?.id || !d?.b?.id || !t) return null;
  const sys = (d.top_contested_systems || []).slice(0, 6)
    .map((s) => ({ name: s.system_name || s.name, region: s.region_name || null, kills: s.kills ?? s.count ?? null }))
    .filter((s) => s.name);
  return {
    kind: "versus",
    a: { id: d.a.id, type: d.a.type, name: d.a.name, kills: t.a_kills_b, isk: t.a_isk_destroyed },
    b: { id: d.b.id, type: d.b.type, name: d.b.name, kills: t.b_kills_a, isk: t.b_isk_destroyed },
    totalKills: t.total_kills, totalIsk: t.total_isk, leader: t.leader, iskShareA: t.a_isk_share,
    systems: sys,
  };
}

// battle_report → a team recap card (per-team scoreboard + member alliance/corp logos + winner).
function battleReportCard(d) {
  const teams = d?.teams || [];
  if (!d?.battle_id || teams.length < 2) return null;
  const maxIsk = Math.max(...teams.map((t) => Number(t.total_isk_destroyed) || 0));
  const mapTeams = teams.map((t) => ({
    won: (Number(t.total_isk_destroyed) || 0) === maxIsk && maxIsk > 0,
    kills: t.total_kills, losses: t.total_losses, isk: t.total_isk_destroyed,
    members: (t.members || []).slice(0, 8).map((m) => {
      const allianceId = m.alliance_id, corpId = m.corporation_id;
      return {
        type: allianceId ? "alliance" : "corporation",
        id: allianceId || corpId,
        name: m.alliance_name || m.corporation_name || "?",
        ticker: m.alliance_ticker || m.corporation_ticker || null,
        corps: m.corporation_count ?? null,
        kills: m.kills, isk: m.isk_destroyed,
      };
    }).filter((m) => m.id),
  }));
  return {
    kind: "battlecard",
    id: d.battle_id, href: d.url || `https://eve-kill.com/battle/${d.battle_id}`,
    system: d.system?.name || null, region: d.system?.region_name || null, security: d.system?.security ?? null,
    durationMin: d.duration_minutes ?? null, totalKills: d.kill_count ?? null, totalIsk: d.total_isk_destroyed ?? null,
    teams: mapTeams,
  };
}

// hunts_in → a solar-system list (security badge + system + region + kills), rendered client-side.
function huntSystems(d) {
  const arr = Array.isArray(d) ? d : (d?.systems || d?.results || d?.rows || d?.items || []);
  return arr.slice(0, 12).map((s) => ({
    id: s.system_id ?? s.id,
    name: s.system_name || s.name,
    region: s.region_name || null,
    security: s.security ?? null,
    kills: s.kills ?? s.count ?? null,
    href: s.url || (s.system_id ? `https://eve-kill.com/system/${s.system_id}` : null),
  })).filter((s) => s.name);
}

// expensive_losses / entity_kills → the kill-card shape renderKills() expects (ship render +
// victim portrait/corp logo + system + value + time + eve-kill link). Tolerates both shapes:
// expensive_losses carries victim_ship; entity_kills nests ship under victim.ship_*. Accepts
// either the raw {kills|killmails|results} container or the array itself (shape can vary).
function killCardItems(input) {
  const arr = Array.isArray(input) ? input : (input?.kills || input?.killmails || input?.results || input?.data || []);
  return arr.slice(0, 20).map((k) => {
    const v = k.victim || {};
    const ship = k.victim_ship || { type_id: v.ship_type_id, name: v.ship_name };
    const isChar = v.character_id != null;
    return {
      killmailId: k.killmail_id,
      isCharacter: isChar,
      victimId: isChar ? v.character_id : v.corporation_id,
      shipId: ship.type_id,
      shipName: ship.name || `type ${ship.type_id ?? "?"}`,
      victimName: v.character_name || v.corporation_name || "?",
      system: k.system?.name || "",
      value: k.total_value ?? 0,
      time: k.time,
    };
  }).filter((k) => k.killmailId && k.shipId);
}

// pilot_efficiency → character stat panel (portrait + K:D / ISK ratio / solo rate / peak hour).
function efficiencyCard(d) {
  const c = d?.character, t = d?.totals;
  if (!c?.id || !t) return null;
  return {
    kind: "stats",
    entity: { id: c.id, type: "character", name: c.name, href: c.url },
    totals: {
      kills: t.kills, losses: t.losses, kd: t.kill_loss_ratio, iskRatio: t.isk_ratio,
      iskEff: t.isk_efficiency_pct, soloRate: t.solo_rate_pct, finalBlows: t.final_blows, avgGang: t.avg_gang_on_kills,
    },
    peakHourUtc: d?.activity?.peak_hour_event_count ? d.activity.peak_hour_utc : null,
  };
}

// entity_overview → profile card (logo/portrait + lifetime stats + top ships flown/lost icons).
function overviewCard(d) {
  const e = d?.entity, lf = d?.lifetime;
  if (!e?.id || !lf) return null;
  const ships = (arr) => (arr || []).slice(0, 5).map((s) => ({ id: s.id, name: s.name, n: s.kills ?? s.losses ?? 0 }));
  return {
    kind: "profile",
    entity: { id: e.id, type: e.type, name: e.name, ticker: e.ticker, href: e.url },
    lifetime: {
      kills: lf.kills, losses: lf.losses, iskEff: lf.isk_efficiency, iskDestroyed: lf.isk_destroyed,
      iskLost: lf.isk_lost, soloKills: lf.solo_kills, finalBlows: lf.final_blows,
    },
    shipsFlown: ships(d.top_ships_flown),
    shipsLost: ships(d.top_ships_lost),
  };
}

// entity_top → ranking list (rank + per-dimension icon + name + kills/losses + ISK).
function rankCard(d) {
  const rows = (d?.rows || []).slice(0, 12).map((r, i) => ({
    rank: i + 1, id: r.id, name: r.name, kills: r.kills, losses: r.losses, isk: r.isk_destroyed,
  }));
  if (!rows.length) return null;
  const e = d?.entity;
  return { kind: "rank", entity: e ? { id: e.id, type: e.type, name: e.name } : null, dimension: d.dimension, rows };
}

// coalition_graph → a node-link graph card (alliance logos as nodes, edges coloured by
// relation: allied / enemy / mixed, thickness ∝ battles). Every node + edge endpoint
// already carries alliance_id, so the renderer builds evetech logo URLs with no lookup.
function coalitionGraphCard(d) {
  const nodes = (d?.nodes || [])
    .filter((n) => n && n.alliance_id)
    .map((n) => ({ id: n.alliance_id, name: n.name, ticker: n.ticker }));
  if (nodes.length < 2) return null;
  const mk = (e, type) => ({
    a: e?.a?.alliance_id, b: e?.b?.alliance_id,
    w: e?.total_battles ?? ((e?.allied_battles || 0) + (e?.enemy_battles || 0)), type,
  });
  const links = [
    ...(d.allied_edges || []).map((e) => mk(e, "ally")),
    ...(d.enemy_edges || []).map((e) => mk(e, "enemy")),
    ...(d.mixed_edges || []).map((e) => mk(e, "mixed")),
  ].filter((l) => l.a && l.b && l.a !== l.b);
  if (!links.length) return null;
  return {
    kind: "coalitiongraph",
    focus: d.focus?.alliance_id || null, focusName: d.focus?.name || null,
    nodeCount: d.node_count ?? nodes.length, edgeCount: d.edge_count ?? links.length,
    nodes, links,
  };
}

// entity_timeline → a per-period activity list (one row per month/day/year bucket).
// Rendered as a kill-list-style card. Tolerates the reduced `vs` shape (?? null).
function timelineCard(d) {
  const rows = (d?.buckets || []).map((b) => ({
    period: b.period_start,
    kills: b.kills ?? 0, losses: b.losses ?? 0,
    soloKills: b.solo_kills ?? null, finalBlows: b.final_blows ?? null,
    iskDestroyed: b.isk_destroyed ?? 0, iskLost: b.isk_lost ?? 0,
  })).filter((r) => r.period);
  if (!rows.length) return null;
  const e = d?.entity;
  return { kind: "timeline", entity: e ? { id: e.id, type: e.type, name: e.name } : null, bucket: d?.bucket || "month", rows };
}

// ships_used → most-flown hulls list (ship render + name + count). Defensive parse: the
// tool shape can vary, so we probe several array/field names and fall back to the dump.
function shipsCard(d, entityName) {
  // ships_used puts the rows under `breakdown`; usage = kills + losses (no `count` field).
  const arr = Array.isArray(d) ? d : (d?.breakdown || d?.ships || d?.top_ships || d?.results || d?.data || d?.items || []);
  const items = arr.map((s) => {
    const k = s.kills ?? 0, l = s.losses ?? 0;
    return {
      id: s.type_id ?? s.ship_type_id ?? s.id,
      name: s.name ?? s.ship_name ?? `type ${s.type_id ?? s.ship_type_id ?? "?"}`,
      count: s.count ?? s.used ?? s.flown ?? s.times ?? (k + l || null),
      kills: k, losses: l,
    };
  }).filter((s) => s.id);
  items.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  if (!items.length) return null;
  return { kind: "shiplist", entityName: entityName || null, items: items.slice(0, 30) };
}

// "How does pilot X fit ship Y" → the pilot's most recent LOSS of that hull, EFT extracted.
// entity_kills has no ship filter (client-side filter on victim.ship_type_id), with
// expensive_losses as a server-side hull fallback; killmail_fitting yields the EFT. Skips
// killmails whose fit isn't extracted yet (unprocessed / no fitted modules).
async function pilotShipFit(pilot, shipText) {
  const sr = await callTool("search", { query: shipText, type: "ship" });
  const hit = (sr?.hits || [])[0];
  if (!hit?.id) return { noShip: true };                       // not a ship → let other intents try
  const shipId = hit.id, shipName = hit.name || shipText;
  const ek = await callTool("entity_kills", { entity: pilot, type: "character", role: "losses", limit: 50 });
  const pilotId = ek?.entity?.id, pilotName = ek?.entity?.name || pilot;
  let matches = (ek?.kills || []).filter((k) => k?.victim?.ship_type_id === shipId);
  if (!matches.length && pilotId) {
    const el = await callTool("expensive_losses", { victim_character_id: pilotId, ship_type_id: shipId, days: 365, limit: 20 });
    matches = (el?.kills || []).filter((k) => (k?.victim_ship?.type_id ?? k?.victim?.ship_type_id) === shipId);
  }
  if (!matches.length) return { found: false, shipName, pilotName };
  for (const k of matches.slice(0, 6)) {
    const eft = extractEft(await callTool("killmail_fitting", { killmail_id: k.killmail_id, format: "eft" }));
    if (eft) return { found: true, shipName, pilotName, eft, used: k, count: matches.length };
  }
  return { found: true, shipName, pilotName, eft: null, used: matches[0], count: matches.length };
}

// Builds the computed-specs block (+ EFT) for a resolved cluster. Returns the MCP block or null.
async function specsBlock(target, entityLabel) {
  const res = await doctrineFitStats(target);
  if (!res?.card) return null;
  const header = `specifiche dottrina ${target.name} di ${entityLabel}`;
  // cards → visual fit-stats panel; theory → theorycrafting-only directive; eft → engine
  // appends the verbatim fit block. summary is the model's context (not shown verbatim).
  return { ...blockBody(header, res.summary, target), cards: { ...res.card, context: `dottrina · ${entityLabel}` }, theory: true, eft: res.eft };
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

const EMPTY = { text: "", entities: [], source: null, sourceTitle: null };

/**
 * Detects an MCP-backed intent from the question (IT/EN triggers) and, if one matches,
 * calls the relevant tool and returns a formatted live block. Returns EMPTY when nothing
 * matches (cheap: just regex tests, no network). Never throws.
 */
export async function maybeMcp(question, standalone = question) {
  // Strip trailing punctuation (?, !, …) so $-anchored captures aren't broken — e.g.
  // "qual è il fitting del muninn?" must still resolve the doctrine follow-up (#5-bis).
  const q = (question || "").replace(/[\s?!.…]+$/u, "") || question;
  try {
    // 1) KILLMAIL by id / zKillboard|eve-kill URL → detail · story · forensics · fitting.
    {
      const url = q.match(/(?:zkillboard\.com\/kill|eve-?kill\.com\/kill)\/(\d{4,})/i);
      const idm = url || q.match(/\bkill\s?mail\s+#?(\d{4,})/i) || q.match(/\bkm\s+#?(\d{4,})/i)
        || (/\bkill\s?mail\b/i.test(q) ? q.match(/\b(\d{6,})\b/) : null);
      if (idm) {
        const killmail_id = Number(idm[1]);
        if (/\b(racconta|storia|story|narr\w*)\b/i.test(q)) {
          const d = await callTool("killmail_story", { killmail_id });
          return d ? block(`racconto del killmail ${killmail_id}`, d) : EMPTY;
        }
        if (/\b(forensi\w*|autops\w*|post[\s-]?mortem|analizz\w*|com['’e]?\s*è\s+mort\w*|why\s+did\b|how\s+did\b.*die)\b/i.test(q)) {
          const d = await callTool("killmail_forensics", { killmail_id });
          return d ? block(`analisi forense del killmail ${killmail_id} (cap stability, outnumbering, resist deboli, doctrine match)`, d) : EMPTY;
        }
        if (/\b(fit|loadout|equipaggiament\w*|moduli)\b/i.test(q)) {
          const d = await callTool("killmail_fitting", { killmail_id, format: "eft" });
          return d ? block(`fit del killmail ${killmail_id}`, d) : EMPTY;
        }
        const d = await callTool("killmail", { killmail_id });
        return d ? block(`dettaglio killmail ${killmail_id}`, d) : EMPTY;
      }
    }

    // 2) ROUTE DANGER — stargate route with per-hop danger. Needs a route intent + from/to.
    if (/\b(rotta|percors\w*|route|come\s+(?:ci\s+)?(?:arriv\w*|vad\w*|si\s+arriv\w*)|how\s+(?:do\s+i\s+|to\s+)?get|quanti\s+salti|jumps?\s+from|how\s+many\s+jumps)\b/i.test(q)) {
      const m = q.match(/\b(?:da|from)\s+(.+?)\s+(?:a(?:d|l|llo|lla)?|to|verso|fino\s+a)\s+(.+)/i);
      if (m) {
        const from = clean(m[1]), to = stripLead(clean(m[2]));
        if (ok(from) && ok(to)) {
          const prefer = /\b(sicur\w*|safe\w*)\b/i.test(q) ? "safest" : /\blowsec/i.test(q) ? "lowsec_ok" : "shortest";
          const d = await callTool("route_danger", { from, to, prefer, round_trip: /\b(andata\s+e\s+ritorno|round[\s-]?trip|ritorno)\b/i.test(q) });
          return d ? block(`rotta ${from} → ${to} (${prefer}) con pericolosità per salto`, d, { source: "https://eve-kill.com/" }) : EMPTY;
        }
      }
    }

    // 3) WAR / HEAD-TO-HEAD — "X vs Y", "guerra tra X e Y", "confronta X e Y".
    {
      // Explicit war framing ("guerra/war … tra/fra/between … e/and/vs") must be tried
      // BEFORE the generic "X vs Y": otherwise "guerra tra The Initiative. vs Fraternity"
      // is caught by the vs-matcher with side A = "guerra tra The Initiative." — the "tra"
      // survives cleanEntity, side A is unresolvable, and the command silently no-ops.
      const m = q.match(/\b(?:guerra|war)\b.*?\b(?:tra|fra|between|of)\s+(.+?)\s+(?:e|ed|and|vs\.?|versus|contro)\s+(.+)/i)
        || q.match(/(.+?)\s+(?:vs\.?|versus|contro)\s+(.+)/i)
        || q.match(/\b(?:tra|fra|between)\s+(.+?)\s+(?:e|ed|and)\s+(.+)/i)
        || q.match(/\b(?:confronta|compara|compare)\s+(.+?)\s+(?:e|ed|con|and|with|to)\s+(.+)/i);
      if (m) {
        const a = cleanEntity(m[1]), b = cleanEntity(m[2]);
        if (ok(a) && ok(b)) {
          const d = await callTool("war_report", { a, b });
          if (!d) return EMPTY;
          const card = versusCard(d);
          // Rich textual recap (full-data narration) AND the visual card — not just a
          // pointer to the card, so the battle / ISK / contested-systems story is written out.
          const body = block(`scontro testa a testa ${a} vs ${b} (kill per direzione, timeline ISK, sistemi contesi, battaglie)`, d);
          return card ? { ...body, cards: card } : body;
        }
      }
    }

    // 4) COALITION GRAPH — alliance allied/enemy edges from battles.
    if (/\b(coalizion\w*|blocch\w*\s+di\s+potere|coalition\w*|power\s+bloc\w*)\b/i.test(q)
      || /\bchi\s+è\s+alleat\w+\s+(?:con|di)\b/i.test(q) || /\bwho\s+is\s+allied\s+(?:with|to)\b/i.test(q)) {
      const fm = q.match(/\b(?:con|di|with|to)\s+(.+)$/i);
      const focus = fm ? stripLead(clean(fm[1])) : null;
      const d = await callTool("coalition_graph", focus && ok(focus) ? { focus_alliance: focus } : {});
      if (!d) return EMPTY;
      const header = focus ? `grafo coalizioni attorno a ${focus}` : "grafo coalizioni (alleati/nemici dalle battaglie)";
      const card = coalitionGraphCard(d);
      const body = block(header, d);   // full-data narration AND the graph card, not just a pointer
      return card ? { ...body, cards: card } : body;
    }

    // 4-bis) PILOT SHIP FIT — "come fitta <pilota> la <nave>" / "how does <pilot> fit <ship>"
    //   → the pilot's most recent loss of that hull, with the EFT pulled from the killmail.
    //   Placed before the doctrine/fit intents; the ship name is validated via `search`, so a
    //   mis-split (or a non-ship word) returns noShip and falls through to the other intents.
    {
      const m = q.match(/\bcome\s+(?:fitt\w+|mont\w+|equipaggi\w+|arm\w+)\s+(.+?)\s+(?:il|lo|la|l['’]|i|gli|le)\s+(.+)/i)
        || q.match(/\bhow\s+does\s+(.+?)\s+(?:fit|fly|run)\s+(?:the\s+|a\s+|an\s+)?(.+)/i)
        || q.match(/\bfit\s+di\s+(.+?)\s+(?:per|sulla?|sul)\s+(?:il|lo|la|l['’])?\s*(.+)/i);
      if (m) {
        const pilot = stripLead(clean(m[1])), shipText = stripLead(clean(m[2]));
        if (ok(pilot) && ok(shipText)) {
          const r = await pilotShipFit(pilot, shipText);
          if (r && !r.noShip) {
            const header = `fit di ${r.pilotName || pilot} per ${r.shipName} (da loss recenti)`;
            if (!r.found) return blockBody(header, `Nessuna perdita recente di ${r.shipName} trovata per ${r.pilotName || pilot} (cercato tra le ultime 50 perdite e nell'ultimo anno).`, { pilota: r.pilotName, nave: r.shipName });
            const summary = {
              pilota: r.pilotName, nave: r.shipName, perdita_del: r.used?.time,
              valore_isk: r.used?.total_value, sistema: r.used?.system?.name,
              killmail: r.used?.killmail_id ? `https://eve-kill.com/kill/${r.used.killmail_id}` : null,
              perdite_della_nave_trovate: r.count,
            };
            if (!r.eft) return blockBody(header, render(summary) + "\nNota: il killmail non ha ancora un fit estratto (non ancora processato o vittima senza moduli equipaggiati).", summary);
            // Compute the fit stats panel (eve-fit-engine) from the EFT, like doctrine specs.
            let stats = null; try { stats = await doctrineFitStatsData(r.eft); } catch { /* compute failed → still show the EFT */ }
            const baseR = blockBody(header, render(summary), summary);
            return stats?.card
              ? { ...baseR, cards: { ...stats.card, context: `loss · ${r.pilotName || pilot}` }, eft: r.eft }
              : { ...baseR, eft: r.eft };
          }
        }
      }
    }

    // 5-bis) DOCTRINE SPECS — computed stats (DPS max/min, tank, velocità) + EFT of ONE
    //   doctrine fit. Two ways in (must precede #5 so it isn't swallowed as a re-list):
    //   (a) ONE-SHOT: "fitting della <nave> di <entità>" → fetch THAT entity's doctrines,
    //       resolve the ship — works even with no/other cached list (the cross-entity case).
    //   (b) FOLLOW-UP: after a doctrine list, "fitting della <nave>" / "specifiche #2".
    //   Triggers: specifiche/specs/dettagli/scheda, fit/fitting/loadout/equipaggiamento,
    //   "a quanto spara/quanto tank/dps/danno", "dimmi/mostra … fit".
    {
      const SPEC_TRIG = "specifiche|statistiche|specs?|stats?|dettagli|caratteristiche|scheda|fit|fitting|loadout|equipaggiament\\w*";
      // (a) "<trigger> [di dottrina] <nave> di/dei/del <entità>" — ship + explicit entity.
      const mOne = q.match(new RegExp(
        `\\b(?:${SPEC_TRIG})\\b(?:\\s+(?:di|della?|del)\\s+dottrin\\w*)?\\s+(?:della?|dei|degli|delle|del|di)?\\s*` +
        `([\\w'’\\- ]+?)\\s+(?:di|del|della|dei|degli|delle|of)\\s+([\\w'’.\\- ]{2,40})\\s*$`, "i"));
      if (mOne) {
        const ship = stripLead(clean(mOne[1]));
        const entity = stripLead(clean(mOne[2]));
        if (ok(ship) && ok(entity)) {
          // Reuse the cached list if it's the same entity, else fetch this entity's doctrines.
          let clusters = null, label = null;
          const want = entity.toLowerCase().replace(/\.$/, "");
          if (lastDoctrine?.clusters?.length && lastDoctrine.entity.toLowerCase().includes(want)) {
            clusters = lastDoctrine.clusters; label = lastDoctrine.entity;
          } else {
            const cl = clustersFromDetect(await callTool("doctrine_detect", { entity }));
            if (cl.length) { clusters = cl; label = entity; lastDoctrine = { entity, clusters: cl }; resetFitMemory(); }
          }
          if (clusters) {
            const target = resolveCluster(ship, clusters);
            if (target) { const b = await specsBlock(target, label); if (b) return b; }
          }
        }
      }
      // (b) follow-up against the remembered list (ordinal or ship name, no entity in the query).
      if (lastDoctrine?.clusters?.length) {
        const m = q.match(new RegExp(`\\b(?:${SPEC_TRIG})\\b[\\s\\S]*?([\\w'’\\- ]{1,40})$`, "i"))
          || q.match(/\b(?:a\s+quanto\s+spara|quanto\s+(?:tank\w*|dps|danno|fa)|che\s+(?:tank|dps|danno|stat\w*))\b[\s\S]*?([\w'’\- ]{1,40})$/i)
          || q.match(/\b(?:dimmi|dammi|mostra(?:mi)?|fammi\s+vedere|show|tell\s+me)\b[\s\S]*\b(?:fit|dottrina|nave)\b[\s\S]*?([\w'’\- ]{1,40})$/i);
        if (m) {
          const target = resolveCluster(stripLead(clean(m[1])), lastDoctrine.clusters);
          if (target) { const b = await specsBlock(target, lastDoctrine.entity); if (b) return b; }
        }
      }
    }

    // 5) DOCTRINE DETECT — dominant fit doctrines of an entity.
    {
      const m = q.match(/\bdottrin\w*\s+(?:di|del|della|dei|usate?\s+d[ai])\s+(.+)/i)
        || q.match(/\bdoctrines?\s+(?:of|used\s+by)\s+(.+)/i)
        || q.match(/\bche\s+dottrin\w*\s+(?:usa|vola|porta|schiera|monta)\w*\s+(.+)/i)
        || q.match(/\bche\s+fit\s+(?:usa|vola|porta)\s+(.+)/i)
        || q.match(/\bfit\s+(?:usati?|preferiti?|tipici?)\s+(?:da|di|of)\s+(.+)/i)
        || q.match(/\bwhat\s+(?:fits?|doctrines?)\s+does\s+(.+?)\s+(?:use|fly)/i);
      if (m) {
        const entity = stripLead(clean(m[1]));
        if (ok(entity)) {
          const d = await callTool("doctrine_detect", { entity });
          if (!d) return EMPTY;
          // Remember the clusters so the next turn can compute a specific fit's stats.
          const clusters = clustersFromDetect(d);
          lastDoctrine = clusters.length ? { entity, clusters } : null;
          if (lastDoctrine) resetFitMemory();
          const body = fmtClusters(d, { withFit: true });
          const header = `dottrine/fit dominanti di ${entity} (ultimi 30 giorni)`;
          const hint = lastDoctrine ? "\n(Per le statistiche di un fit chiedi: «specifiche della <nave>», «fitting della <nave>» oppure «specifiche #2».)" : "";
          return body ? blockBody(header, body + hint, d) : block(`${header} (nessuna dottrina ricorrente rilevata)`, d);
        }
      }
    }

    // 6) META PULSE — global doctrine/meta scan.
    if (/\bmeta\b/i.test(q) && /(attual\w*|del\s+momento|in\s+gioco|adesso|ora|gener\w*|popolar\w*|current|popular|now|right\s+now|c['’]è|going\s+on)/i.test(q)
      || /\b(dottrine|fit)\s+(pi[ùu]\s+)?(usat\w*|popolar\w*|comuni)\b/i.test(q) || /\bwhat['’]?s\s+the\s+meta\b/i.test(q)) {
      const d = await callTool("meta_pulse", {});
      if (!d) return EMPTY;
      const body = fmtClusters(d);
      const header = "meta del momento — fit/dottrine più diffusi (ultimi 7 giorni, per perdite)";
      return body ? blockBody(header, body, d) : block(header, d);
    }

    // 7) BATTLES — battle_report by id, otherwise recent battles.
    {
      const bid = q.match(/\b(?:battle\s*report|report\s+battagli\w*|battagli\w*|battle)\b[^.\d]*?#?(\d{3,})/i);
      if (bid && /\b(report|battle|battagli)/i.test(q)) {
        const d = await callTool("battle_report", { battle_id: Number(bid[1]) });
        if (d) {
          const card = battleReportCard(d);
          // Full-data descriptive recap (from the real battle data, no invention) AND the card.
          const body = block(`battle report #${bid[1]}`, d);
          return card ? { ...body, cards: card } : body;
        }
      }
      if (/\b(ultime?\s+battagli\w*|battagli\w*\s+(?:recenti|più\s+grandi|grosse)|recent\s+battles?|biggest\s+battles?|latest\s+battles?|grandi\s+battagli\w*)\b/i.test(q)) {
        const recent = /\b(recenti|recent|latest|ultime)\b/i.test(q);
        const d = await callTool("find_battles", { sort: recent ? "recent" : "isk" });
        if (!d) return EMPTY;
        const items = battleCards(d);
        if (!items.length) return block("battaglie recenti", d);
        const header = `battaglie ${recent ? "recenti" : "più grandi (per ISK distrutti)"}`;
        return { ...blockBody(header, `${items.length} battaglie — vedi le schede sotto.`, d), cards: { kind: "battles", items } };
      }
    }

    // 8) EXPENSIVE LOSSES — most valuable killmails → kill cards (ship + victim + link).
    if (/\b(kill\w*\s+(pi[ùu]\s+)?costos\w*|perdit\w*\s+(pi[ùu]\s+)?costos\w*|navi\s+(pi[ùu]\s+)?costos\w*\s+pers\w*|most\s+expensive\s+(kills?|losses?|ships?)|biggest\s+(kills?|losses?)|priciest)\b/i.test(q)) {
      const d = await callTool("expensive_losses", {});
      if (!d) return EMPTY;
      const kills = killCardItems(d);
      if (!kills.length) return block("kill più costosi (ultimi 30 giorni)", d);
      return { ...blockBody("kill più costosi (ultimi 30 giorni)", `I ${kills.length} kill più costosi — vedi la lista sotto.`, d), kills };
    }


    // 10) PREYS_ON — who X kills most ("le prede di X", "who does X kill/prey on").
    {
      const m = q.match(/\b(?:prede|vittime(?:\s+preferite)?)\s+(?:di|del|della)\s+(.+)/i)
        || q.match(/\bwho\s+does\s+(.+?)\s+(?:prey|kill|hunt)\b/i)
        || q.match(/\b(.+?)['’]s\s+(?:prey|favou?rite\s+(?:victims?|targets?))\b/i);
      if (m) {
        const entity = stripLead(clean(m[1]));
        if (ok(entity)) {
          const d = await callTool("preys_on", { entity });
          if (!d) return EMPTY;
          const items = entityListItems(d.characters || d.preys || d.results);
          if (!items.length) return block(`prede preferite di ${entity} (chi uccide più spesso, 90gg)`, d);
          return { ...blockBody(`prede preferite di ${entity}`, `Prede preferite di ${entity} — vedi la lista sotto.`, d), cards: { kind: "entitylist", variant: "prey", entityName: entity, items } };
        }
      }
    }

    // 11) HUNTS_IN — preferred hunting systems ("dove caccia X", "where does X hunt").
    {
      const m = q.match(/\bdove\s+(?:caccia|uccide|killa|opera)\s+(.+)/i)
        || q.match(/\b(?:sistemi?|zone?)\s+di\s+caccia\s+(?:di|del|della)\s+(.+)/i)
        || q.match(/\bwhere\s+does\s+(.+?)\s+(?:hunt|kill|operate)\b/i)
        || q.match(/\b(.+?)['’]s\s+hunting\s+(?:grounds?|systems?)\b/i);
      if (m) {
        const entity = stripLead(clean(m[1]));
        if (ok(entity)) {
          const d = await callTool("hunts_in", { entity });
          if (!d) return EMPTY;
          const items = huntSystems(d);
          if (!items.length) return block(`sistemi di caccia preferiti di ${entity}`, d);
          return { ...blockBody(`sistemi di caccia preferiti di ${entity}`, `Sistemi di caccia di ${entity} — vedi la lista sotto.`, d), cards: { kind: "syslist", entityName: entity, items } };
        }
      }
    }

    // 12) HUNTED_BY — who kills X most ("chi uccide X", "who hunts X").
    {
      const m = q.match(/\bchi\s+(?:uccide|killa|caccia|ammazza|fa\s+fuori)\s+(.+)/i)
        || q.match(/\bda\s+chi\s+(?:viene\s+ucciso|è\s+ucciso|è\s+cacciato)\s+(.+)/i)
        || q.match(/\b(?:nemici|cacciatori)\s+(?:di|del|della)\s+(.+)/i)
        || q.match(/\bwho\s+(?:hunts|kills|killed)\s+(.+)/i)
        || q.match(/\b(.+?)['’]s\s+(?:hunters?|nemes[ie]s|killers?)\b/i);
      if (m) {
        const entity = stripLead(clean(m[1]));
        if (ok(entity)) {
          const d = await callTool("hunted_by", { entity });
          if (!d) return EMPTY;
          const items = entityListItems(d.characters || d.hunters || d.results);
          if (!items.length) return block(`chi uccide più spesso ${entity} (90gg)`, d);
          return { ...blockBody(`chi uccide più spesso ${entity}`, `Chi uccide più spesso ${entity} — vedi la lista sotto.`, d), cards: { kind: "entitylist", variant: "hunters", entityName: entity, items } };
        }
      }
    }

    // 13) FLIES_WITH — frequent wingmates ("con chi vola X", "wingmates of X").
    {
      const m = q.match(/\bcon\s+chi\s+vola\s+(.+)/i)
        || q.match(/\bchi\s+vola\s+(?:con|insieme\s+a)\s+(.+)/i)
        || q.match(/\b(?:wingmate[s]?|compagni(?:\s+di\s+volo)?|gregari)\s+(?:di|of)\s+(.+)/i)
        || q.match(/\bwho\s+(?:does\s+(.+?)\s+fl(?:y|ies)\s+with|flies\s+with\s+(.+))/i)
        || q.match(/\b(.+?)['’]s\s+wingmates?\b/i);
      if (m) {
        const entity = stripLead(clean(m[1] || m[2]));
        if (ok(entity)) {
          const d = await callTool("flies_with", { entity });
          if (!d) return EMPTY;
          const items = entityListItems(d.partners || d.results || d.characters);
          if (!items.length) return block(`compagni di volo abituali di ${entity} (ultimi 90gg)`, d);
          return { ...blockBody(`compagni di volo abituali di ${entity}`, `Compagni di volo di ${entity} — vedi la lista sotto.`, d), cards: { kind: "entitylist", variant: "wingmates", entityName: entity, items } };
        }
      }
    }

    // 14) PILOT EFFICIENCY — K:D, ISK ratio, solo rate, activity heatmaps.
    {
      const m = q.match(/\befficien\w*\s+(?:di|del|della)\s+(.+)/i)
        || q.match(/\b(?:k\/?d|kd|rapporto\s+kill[\s/]+mort\w*)\s+(?:di|del|of)\s+(.+)/i)
        || q.match(/\bquanto\s+(?:è\s+)?(?:brav\w*|forte)\s+(.+)/i)
        || q.match(/\b(?:efficiency|k[:/]?d(?:\s+ratio)?|kill[\s/]+death\s+ratio|performance)\s+(?:of|for)\s+(.+)/i)
        || q.match(/\bhow\s+good\s+is\s+(.+)/i);
      if (m) {
        const entity = stripLead(clean(m[1]));
        if (ok(entity)) {
          const d = await callTool("pilot_efficiency", { entity });
          if (!d) return EMPTY;
          const card = efficiencyCard(d);
          if (!card) return block(`efficienza di ${entity} (K:D, ISK ratio, solo rate, fasce orarie)`, d);
          return { ...blockBody(`efficienza di ${entity}`, `Efficienza di ${entity} — vedi la scheda sotto.`, d), cards: card };
        }
      }
    }

    // 15) ENTITY OVERVIEW — killboard summary of a character/corp/alliance.
    {
      const m = q.match(/\b(?:panoramica|overview|riepilog\w*|scheda)\s+(?:killboard\s+)?(?:di|del|della|dell['’]|of)\s+(.+)/i)
        || q.match(/\bkillboard\s+(?:di|of)\s+(.+)/i)
        || q.match(/\b(.+?)['’]s\s+(?:killboard\s+)?overview\b/i);
      if (m) {
        const entity = stripLead(clean(m[1]));
        if (ok(entity)) {
          const d = await callTool("entity_overview", { entity });
          if (!d) return EMPTY;
          const card = overviewCard(d);
          if (!card) return block(`panoramica killboard di ${entity} (kill/perdite, ISK, efficienza, top navi/sistemi)`, d);
          return { ...blockBody(`panoramica killboard di ${entity}`, `Panoramica di ${entity} — vedi la scheda sotto.`, d), cards: card };
        }
      }
    }

    // 16) ENTITY TIMELINE — activity over time (kills/losses), not membership history.
    {
      const m = q.match(/\b(?:timeline|cronologia|andamento)(?:\s+(?:di\s+|dell['’])?attivit\S*)?\s+(?:di|del|della|dell['’]|of|for)\s+(.+)/i)
        || q.match(/\battivit\S*\s+nel\s+tempo\s+(?:di|del|della|of|for)\s+(.+)/i)
        || q.match(/\b(?:activity\s+)?timeline\s+(?:of|for)\s+(.+)/i)
        || q.match(/\b(.+?)['’]s\s+(?:activity\s+)?timeline\b/i);
      if (m) {
        const entity = stripLead(clean(m[1]));
        if (ok(entity)) {
          const d = await callTool("entity_timeline", { entity });
          if (!d) return EMPTY;
          const header = `timeline di attività di ${entity} (kill/perdite nel tempo)`;
          const card = timelineCard(d);
          if (!card) return block(header, d);
          return { ...blockBody(header, `Timeline di ${entity} — vedi la lista sotto.`, d), cards: card };
        }
      }
    }

    // 17) ENTITY KILLS — recent killmails of an entity ("ultimi kill di X").
    {
      const m = q.match(/\b(?:ultim\w*|recent\w*)\s+kill\w*\s+(?:di|del|della|dell['’]|of|by)\s+(.+)/i)
        || q.match(/\bkill\w*\s+recent\w*\s+(?:di|del|della|of|by)\s+(.+)/i)
        || q.match(/\brecent\s+kills?\s+(?:of|by)\s+(.+)/i)
        || q.match(/\b(?:cosa|chi)\s+ha\s+(?:killat\w*|ucciso)\s+(.+?)\s+(?:di\s+recente|ultimamente|recentemente)/i);
      if (m) {
        const entity = stripLead(clean(m[1]));
        if (ok(entity)) {
          const d = await callTool("entity_kills", { entity });
          if (!d) return EMPTY;
          const kills = killCardItems(d);
          if (!kills.length) return block(`ultimi kill di ${entity}`, d);
          return { ...blockBody(`ultimi kill di ${entity}`, `Ultimi ${kills.length} kill di ${entity} — vedi la lista sotto.`, d), kills };
        }
      }
    }

    // 18) SHIPS USED — hulls an entity flies most (complements doctrine_detect, which is fits).
    {
      const m = q.match(/\b(?:che|quali)\s+navi\s+(?:usa|vola|porta|piloti?a|preferisce)\s+(.+)/i)
        || q.match(/\bnavi\s+(?:usate|volate|preferite|tipiche)\s+(?:da|di)\s+(.+)/i)
        || q.match(/\b(?:what|which)\s+ships?\s+does\s+(.+?)\s+(?:use|fly|pilot)/i)
        || q.match(/\bships?\s+(?:used|flown)\s+(?:by|of)\s+(.+)/i);
      if (m) {
        const entity = stripLead(clean(m[1]));
        if (ok(entity)) {
          const d = await callTool("ships_used", { entity });
          if (!d) return EMPTY;
          const header = `navi più usate da ${entity} (ultimi 90gg)`;
          const card = shipsCard(d, entity);
          if (!card) return block(header, d);
          return { ...blockBody(header, `Navi più usate da ${entity} — vedi la lista sotto.`, d), cards: card };
        }
      }
    }

    // 19) ENTITY TOP — ranking by a dimension. Works for characters AND alliances/corps
    //     (unlike the char-only intel-graph tools). The dimension is inferred from the
    //     question's keyword; bail (fall through) if no dimension is recognised.
    {
      const DIM_LABEL = {
        ship_flown: "navi più volate", ship_lost: "navi più perse",
        system: "sistemi più attivi", constellation: "costellazioni più attive",
        region: "regioni più attive", killed_alliance: "alleanze più uccise",
        dies_to_alliance: "alleanze che lo uccidono di più",
        killed_corporation: "corp più uccise", dies_to_corporation: "corp che lo uccidono di più",
      };
      let dimension = null;
      if (/\bnavi\b[^.]*\b(?:pers\w*|perdut\w*)|\bship\w*\s+lost|\blost\s+ship/i.test(q)) dimension = "ship_lost";
      else if (/\bnavi\b|\bship\w*\s+(?:flown|used)|\bhull/i.test(q)) dimension = "ship_flown";
      else if (/\bcostellazion\w*|constellation/i.test(q)) dimension = "constellation";
      else if (/\bregion\w*/i.test(q)) dimension = "region";
      else if (/\bsistem\w*|\bsystem/i.test(q)) dimension = "system";
      else if (/(?:uccid\w*|kill\w*)[^.]*\balleanz|killed?\s+allianc/i.test(q)) dimension = "killed_alliance";
      else if (/(?:muore|ucciso|dies?)[^.]*\balleanz|dies?\s+to\s+allianc/i.test(q)) dimension = "dies_to_alliance";
      const m = dimension && (
        q.match(/\b(?:top|classific\w*|migliori|preferit\w*|pi[ùu]\s+\w+)\b[^.]*?\b(?:di|del|della|dell['’]|dei|degli|delle|da|of|for|by)\s+(.+)/i)
        || q.match(/\b(?:top|favou?rite|most)\b[^.]*?\b(?:of|for|by)\s+(.+)/i)
      );
      if (m) {
        const entity = stripLead(clean(m[1]));
        if (ok(entity)) {
          const d = await callTool("entity_top", { entity, dimension });
          if (!d) return EMPTY;
          const card = rankCard(d);
          if (!card) return block(`classifica ${DIM_LABEL[dimension]} di ${entity}`, d);
          return { ...blockBody(`classifica ${DIM_LABEL[dimension]} di ${entity}`, `Classifica ${DIM_LABEL[dimension]} di ${entity} — vedi la scheda sotto.`, d), cards: card };
        }
      }
    }

    // 20) SYSTEM PULSE — recent activity / danger of a single solar system.
    {
      const m = q.match(/\b(?:quanto\s+è\s+|com['’]?è\s+|quant['’]?è\s+)?(?:pericolos\w*|attiv\w*|movimentat\w*|cald\w*|tranquill\w*|sicur\w*)\s+(?:il\s+sistema\s+)?([A-Za-z0-9][\w\- ]{1,30})/i)
        || q.match(/\b(?:attivit\S*|situazione|polso)\s+(?:in|nel\s+sistema|di|del\s+sistema)\s+([A-Za-z0-9][\w\- ]{1,30})/i)
        || q.match(/\bhow\s+(?:dangerous|active|hot|busy|quiet)\s+is\s+([A-Za-z0-9][\w\- ]{1,30})/i)
        || q.match(/\b(?:activity|what['’]?s\s+(?:happening|going\s+on))\s+(?:in|at)\s+([A-Za-z0-9][\w\- ]{1,30})/i)
        || q.match(/\bsystem\s+pulse\s+([A-Za-z0-9][\w\- ]{1,30})/i);
      if (m) {
        const system = stripLead(clean(m[1]));
        if (ok(system)) {
          const d = await callTool("system_pulse", { system });
          return d ? block(`polso del sistema ${system} (kill recenti, pericolosità, attività)`, d) : EMPTY;
        }
      }
    }

    // 21) GLOBAL PULSE — cluster-wide activity snapshot (no entity).
    if (/\b(?:cosa|che\s+cosa|che)\s+(?:succede|sta\s+succedendo|c['’]è)\b[^.]*\b(?:in\s+game|in\s+eve|nel\s+cluster|nello\s+spazio|adesso|ora|ovunque)\b/i.test(q)
      || /\bpolso\s+(?:globale|del\s+cluster|di\s+eve|di\s+new\s+eden)\b/i.test(q)
      || /\battivit\S*\s+(?:globale|del\s+cluster|generale)\b/i.test(q)
      || /\b(?:global\s+pulse|global\s+activity|what['’]?s\s+(?:happening|going\s+on)\s+(?:in\s+eve|globally|right\s+now|across\s+(?:new\s+eden|the\s+cluster)))\b/i.test(q)) {
      const d = await callTool("global_pulse", {});
      return d ? block("polso globale di New Eden (attività/kill recenti nel cluster)", d) : EMPTY;
    }
  } catch { /* never break a chat answer over a live-data failure */ }
  return EMPTY;
}

// ── Used by intel.mjs (character intel enrichment) ───────────────────────────

/**
 * Concise extra intel for a CHARACTER from capsuleer_dossier: archetype tags
 * (FC/CAPITAL/SUPER/BLOPS/LOGI/CYNO/GANKER/NEWBIE), playstyle and top wingmates —
 * data the plain killboard stats don't surface. Returns an Italian text block, or "".
 * Tolerant to the exact JSON shape; never throws.
 */
export async function dossierExtra(entity, type = "character") {
  try {
    const d = await callTool("capsuleer_dossier", { entity, type, format: "json" });
    if (!d || typeof d !== "object") return "";
    const tags = d.archetype_tags || d.archetypes || d.tags || d.archetype || null;
    const wing = d.top_wingmates || d.wingmates || d.flies_with || d.fleet_partners || null;
    const style = d.playstyle_90d || d.playstyle || d.dominant_style || d.play_style || null;
    const lines = [];
    if (tags) {
      const list = Array.isArray(tags) ? tags : Object.keys(tags);
      if (list.length) lines.push(`Archetipi (eve-kill): ${list.slice(0, 8).join(", ")}.`);
    }
    if (style) {
      const solo = style.solo_pct ?? style.solo;
      const s = typeof style === "string" ? style
        : [style.dominant && `stile dominante: ${style.dominant}`,
           solo != null && `solo ${solo}%`,
           style.avg_fleet_size && `flotta media ${style.avg_fleet_size}`].filter(Boolean).join(", ");
      if (s) lines.push(`Playstyle: ${s}.`);
    }
    if (Array.isArray(wing) && wing.length) {
      const names = wing.map((w) => w.name || w.character_name || w.character?.name).filter(Boolean).slice(0, 5);
      if (names.length) lines.push(`Vola spesso con: ${names.join(", ")}.`);
    }
    return lines.length ? `Dossier eve-kill (MCP):\n${lines.join("\n")}` : "";
  } catch { return ""; }
}

/**
 * Structured CHARACTER profile card from capsuleer_dossier (portrait + lifetime stats +
 * playstyle bars + recent-ship icons + wingmate chips), optionally enriched with FC
 * likelihood / archetype flags from the killboard /intel endpoint. Returns
 * { card, summary } for intel.mjs to render + give the model a one-line context, or null.
 */
export async function characterCard(id, name, extra = {}) {
  let d;
  try { d = await callTool("capsuleer_dossier", { entity: String(id), type: "character", format: "json" }); }
  catch { return null; }
  if (!d || typeof d !== "object") return null;
  const lf = d.lifetime || {};
  const ps = d.playstyle_90d || d.playstyle || {};
  const st = extra.stats || {};
  const ships = (d.top_ships || []).slice(0, 6)
    .map((s) => ({ id: s.type_id ?? s.id, name: s.name, n: s.kills ?? s.count ?? 0 })).filter((s) => s.id);
  const wingmates = (d.top_wingmates || []).slice(0, 6)
    .map((w) => ({ id: w.character_id ?? w.character?.id, name: w.name || w.character_name, shared: w.shared_kills ?? w.count ?? null }))
    .filter((w) => w.id && w.name);
  const tags = Array.isArray(d.archetype_tags) ? d.archetype_tags : (Array.isArray(d.tags) ? d.tags : []);
  const kills = lf.kills ?? st.kills ?? null;
  const losses = lf.losses ?? st.losses ?? null;
  const iskEff = lf.isk_efficiency ?? lf.efficiency ?? st.isk_efficiency ?? null;
  const card = {
    kind: "pilot",
    entity: { id: Number(id), type: "character", name: name || d.entity?.name || "?", href: d.entity?.url || `https://eve-kill.com/character/${id}` },
    stats: { kills, losses, iskEff },
    playstyle: ps.dominant ? {
      dominant: ps.dominant,
      bars: [["solo", ps.solo_pct], ["small", ps.small_gang_pct], ["mid", ps.mid_gang_pct], ["fleet", ps.fleet_pct], ["blob", ps.blob_pct]]
        .map(([k, v]) => [k, Number(v) || 0]),
      avgFleet: ps.avg_fleet_size ?? null,
    } : null,
    tags, fc: extra.fc || null, flags: extra.flags || [], ships, wingmates,
  };
  const summary = `${card.entity.name}: ${kills ?? "?"} kill / ${losses ?? "?"} perdite`
    + (iskEff != null ? `, ISK eff ${iskEff}%` : "")
    + (ps.dominant ? `, stile ${ps.dominant}` : "")
    + (wingmates.length ? `, vola con ${wingmates.slice(0, 3).map((w) => w.name).join(", ")}` : "") + ".";
  return { card, summary };
}
