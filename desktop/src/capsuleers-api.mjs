// capsuleers.app as the killboard/intel backend — the ONE place that knows its routes.
//
// The site serves pilot intel, killmail search and entity panels from its OWN
// killmail archive (Postgres, 90-day retention), and proxies eve-kill's lifetime
// totals behind a shared cache and a 429 brake. Calling it instead of eve-kill
// directly means: one request for a whole Local instead of three per pilot, and no
// traffic from thousands of desktops against a budget eve-kill grants PER IP.
//
// Called from the main process: no Origin header, which is what the site's API
// origin guard lets through (server-to-server). CAPSULEERS_SITE overrides the host.
//
// Paths: several still live under the legacy /api/eve-kill/ prefix on the site
// even though they read the site's own archive. They are all here so a rename is
// one edit. Every function returns null on ANY failure — callers fall back to
// eve-kill, so a site outage degrades to the old behaviour instead of no intel.
import { USER_AGENT as UA } from "./user-agent.mjs";

export const SITE_BASE = process.env.CAPSULEERS_SITE || "https://capsuleers.app";
const TIMEOUT_MS = 12_000;

async function call(path, body) {
  try {
    const r = await fetch(SITE_BASE + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "User-Agent": UA, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

const PLURAL = { character: "characters", corporation: "corporations", alliance: "alliances" };

/** Pilot intel, 90 days, own archive: { stats, intel } (eve-kill /intel shape), or null. */
export async function pilotIntel(id) {
  const d = await call(`/api/eve-kill/characters/${Number(id)}/intel`);
  return d && typeof d === "object" ? d : null;
}

/** Lifetime profile (eve-kill totals via the site's cache): { stats:{kills,losses,isk_efficiency,…}, … }. */
export async function entityProfile(type, id) {
  return call(`/api/eve-kill/${PLURAL[type]}/${Number(id)}/profile`);
}

/** Lifetime stats of a corporation/alliance (topShips, topSystems, topMembers…). */
export async function groupAlltime(type, id) {
  return call(`/api/eve-kill/${PLURAL[type]}/${Number(id)}/stats/alltime`);
}

/** Batch pilot scan (≤250 ids): Map<character_id, row>. A pilot with no data in the
 *  window is ABSENT from the map — "no data", never "zero kills". Null on failure. */
export async function scanPilots(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 250) {
    const d = await call("/api/eve-kill/characters/scan", { character_ids: ids.slice(i, i + 250) });
    if (!d || !Array.isArray(d.data)) return null;
    for (const r of d.data) out.set(Number(r.character_id), r);
  }
  return out;
}

/** Killmail search on the archive (see the site's shared/killboard.ts KillboardFilter). */
export async function killboardSearch(filter) {
  const d = await call("/api/killboard/search", filter);
  return d && Array.isArray(d.rows) ? d.rows : null;
}

/** Entity panels (matchups, hulls, most_valuable, activity, battles). */
export async function entityPanels(type, id, panels, days = 90) {
  return call(`/api/entity/${type}/${Number(id)}/panels?days=${days}&panels=${panels.join(",")}`);
}

/** Public page of an entity on the site (English route). */
export function siteEntityUrl(type, id) {
  return `${SITE_BASE}/${type}/${id}`;
}
