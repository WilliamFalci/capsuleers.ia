// capsuleers.app as the killboard/intel backend — the ONE place that knows its routes.
//
// The site serves pilot intel, killmail search and entity panels from its OWN
// killmail archive (Postgres, 90-day retention), and proxies eve-kill's lifetime
// totals behind a shared cache and a 429 brake. Calling it instead of eve-kill
// directly means: one request for a whole Local instead of three per pilot, and no
// traffic from thousands of desktops against a budget eve-kill grants PER IP.
//
// The contract is the site's PUBLIC API v1 (/api/v1/…, shared/api-v1.ts in the
// capsuleers.website repo): stable paths and shapes, rate-limited per IP, 404 = "no
// such entity" and 503 = "upstream unwell" kept apart. Called from the main process:
// no Origin header, which the site's origin guard lets through. CAPSULEERS_SITE
// overrides the host.
//
// DEPLOY ORDER DOES NOT MATTER. Every /api/v1 response carries `X-Capsuleers-Api`
// (set by the site's middleware before routing, so even a 404 has it). A response
// WITHOUT it means the site running in production predates v1: the call is retried
// once on the legacy route that serves the same data, and the verdict is remembered.
// An app released before the site still works; one released after never sees it.
//
// Every function returns null on ANY failure (network, 429, 5xx, "no such entity")
// and the caller falls back to eve-kill direct, so a site outage degrades to the old
// behaviour instead of no intel.
import { USER_AGENT as UA } from "./user-agent.mjs";

export const SITE_BASE = process.env.CAPSULEERS_SITE || "https://capsuleers.app";
const TIMEOUT_MS = 12_000;
const PLURAL = { character: "characters", corporation: "corporations", alliance: "alliances" };

let v1Live = null;   // null = not yet known · true = v1 answered · false = site predates v1

async function request(path, body) {
  const r = await fetch(SITE_BASE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "User-Agent": UA, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return r;
}

async function call(v1Path, legacyPath, body) {
  try {
    if (v1Live !== false) {
      const r = await request(v1Path, body);
      if (r.headers.get("x-capsuleers-api")) {
        v1Live = true;
        return r.ok ? await r.json() : null;
      }
      v1Live = false;   // no header: the deployed site has no /api/v1 yet
    }
    if (!legacyPath) return null;
    const r = await request(legacyPath, body);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Pilot intel, 90 days, own archive: { stats, intel } — both null = no data in the window. Null on failure. */
export async function pilotIntel(id) {
  const n = Number(id);
  const d = await call(`/api/v1/pilots/${n}/intel`, `/api/eve-kill/characters/${n}/intel`);
  return d && typeof d === "object" ? d : null;
}

/** Lifetime profile (eve-kill totals via the site's cache): { stats:{kills,losses,isk_efficiency,…}, … }. */
export async function entityProfile(type, id) {
  const n = Number(id);
  return call(`/api/v1/entities/${type}/${n}/profile`, `/api/eve-kill/${PLURAL[type]}/${n}/profile`);
}

/** Lifetime stats of an entity (topShips, topSystems, topMembers…). */
export async function groupAlltime(type, id) {
  const n = Number(id);
  return call(`/api/v1/entities/${type}/${n}/stats`, `/api/eve-kill/${PLURAL[type]}/${n}/stats/alltime`);
}

/** Batch pilot scan: Map<character_id, row>. A pilot with no data in the window is
 *  ABSENT from the map — "no data", never "zero kills". Null on failure. */
export async function scanPilots(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 250) {
    const body = { character_ids: ids.slice(i, i + 250) };
    const d = await call("/api/v1/pilots/scan", "/api/eve-kill/characters/scan", body);
    if (!d || !Array.isArray(d.data)) return null;
    for (const r of d.data) out.set(Number(r.character_id), r);
  }
  return out;
}

/** Killmail search on the archive (KillboardFilter, shared/killboard.ts on the site). */
export async function killboardSearch(filter) {
  const d = await call("/api/v1/killmails/search", "/api/killboard/search", filter);
  return d && Array.isArray(d.rows) ? d.rows : null;
}

/** Entity panels (matchups, hulls, most_valuable, activity, battles). */
export async function entityPanels(type, id, panels, days = 90) {
  const q = `${type}/${Number(id)}/panels?days=${days}&panels=${panels.join(",")}`;
  return call(`/api/v1/entities/${q}`, `/api/entity/${q}`);
}

/** Public page of an entity on the site (English route). */
export function siteEntityUrl(type, id) {
  return `${SITE_BASE}/${type}/${id}`;
}

/** Which API family answered (for diagnostics and the verification script). */
export function apiFamily() { return v1Live === null ? "unknown" : v1Live ? "v1" : "legacy"; }
