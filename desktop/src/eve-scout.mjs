// EVE-Scout (Signal Cartel) — wormhole connections scanned in real time from
// Thera and Turnur. Public API, no auth. Volatile data (holes expire): short cache.
const URL = "https://api.eve-scout.com/v2/public/signatures";
const UA = "Capsuleers.IA/0.1 (dedodj@gmail.com)";
const TTL = 60 * 1000;

// ESI for the jump distance (gates) from a reference system to the k-space
// destination of each connection (e.g. "which Thera is closest to Jita?").
const ESI = "https://esi.evetech.net/latest";
async function esiGet(p) {
  const r = await fetch(`${ESI}${p}${p.includes("?") ? "&" : "?"}datasource=tranquility`, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`ESI ${r.status}`);
  return r.json();
}
// Resolve a reference name to what it actually IS in EVE: a system, region or
// constellation. Jump distance only makes sense from a SYSTEM, so the caller must
// warn when the user gave a region/constellation (e.g. "Fountain") instead.
async function resolveNear(name) {
  try {
    const r = await fetch(`${ESI}/universe/ids/?datasource=tranquility`, {
      method: "POST", headers: { "content-type": "application/json", "User-Agent": UA }, body: JSON.stringify([name]),
    });
    const d = await r.json();
    if (d.systems?.[0]) return { type: "system", id: d.systems[0].id, name: d.systems[0].name };
    if (d.regions?.[0]) return { type: "region", name: d.regions[0].name };
    if (d.constellations?.[0]) return { type: "constellation", name: d.constellations[0].name };
    return null;  // unknown name
  } catch { return null; }
}
const routeCache = new Map();  // "from-to" → number of jumps (or null if unreachable via gate)
async function jumpsBetween(from, to) {
  if (from == null || to == null) return null;
  const key = `${from}-${to}`;
  if (routeCache.has(key)) return routeCache.get(key);
  let j = null;
  try { const r = await esiGet(`/route/${from}/${to}/?flag=shortest`); if (Array.isArray(r)) j = r.length - 1; } catch { j = null; }
  routeCache.set(key, j);
  return j;
}

let cache = null;
async function fetchSignatures() {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const r = await fetch(URL, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`eve-scout HTTP ${r.status}`);
  const json = await r.json();
  const data = Array.isArray(json) ? json : (json.signatures || json.data || []);
  cache = { at: Date.now(), data };
  return data;
}

// Maximum ship size → readable label.
const SHIP = { small: "fino a fregata/destroyer", medium: "fino a incrociatore/BC", large: "fino a battleship", xlarge: "anche capital", capital: "anche capital" };

// Always reports BOTH signatures of the connection:
//  • in_signature  → scan it in the k-space system (dest) to ENTER Thera/Turnur;
//  • out_signature → scan it inside Thera/Turnur to EXIT toward that system.
function fmtSig(s) {
  const dest = s.in_system_name || "?";          // k-space destination (e.g. Sacalan)
  const origin = s.out_system_name || "Thera";   // Thera / Turnur
  const cls = s.in_system_class ? s.in_system_class.toUpperCase() : "";
  const region = s.in_region_name ? `, ${s.in_region_name}` : "";
  const wh = s.wh_type ? ` · WH ${s.wh_type}` : "";
  const size = s.max_ship_size ? ` · ${SHIP[s.max_ship_size] || s.max_ship_size}` : "";
  const life = s.remaining_hours != null ? ` · scade tra ~${s.remaining_hours}h` : "";
  const sigs = [];
  if (s.in_signature) sigs.push(`ENTRATA a ${origin} da ${dest}: scansiona la signature ${s.in_signature} in ${dest}`);
  if (s.out_signature) sigs.push(`USCITA da ${origin} verso ${dest}: scansiona la signature ${s.out_signature} in ${origin}`);
  const sigPart = sigs.length ? ` · ${sigs.join(" · ")}` : "";
  return `${dest}${cls ? ` (${cls}${region})` : region}${wh}${size}${life}${sigPart}`;
}

/**
 * Current connections for the requested systems (e.g. ["Thera"], ["Thera","Turnur"]).
 * Returns { text, entities }. Wormhole signals only; sorted by remaining lifetime.
 * opts.near = system name (e.g. "Jita") → sorts by jumps via gate from that system
 * to the k-space destination of each connection (closest first).
 */
export async function scoutConnections(systems, opts = {}) {
  let sigs;
  try { sigs = await fetchSignatures(); } catch { return null; }
  const wanted = new Set(systems.map((s) => s.toLowerCase()));
  const sel = sigs
    .filter((s) => s.signature_type === "wormhole" && wanted.has((s.out_system_name || "").toLowerCase()))
    .sort((a, b) => (b.remaining_hours ?? 0) - (a.remaining_hours ?? 0));
  if (!sel.length) {
    return { text: `EVE-Scout (dati live): nessun collegamento wormhole segnalato da ${systems.join("/")} al momento.`, entities: [] };
  }

  // Sorting by distance from a reference SYSTEM (e.g. "closest to Jita"). Jump
  // distance only exists between systems, so if the reference is a region or
  // constellation (e.g. "Fountain") we warn instead of computing a bogus distance.
  let nearWarning = "";
  if (opts.near) {
    const ref = await resolveNear(opts.near);
    if (ref && ref.type === "system") {
      const withJumps = await Promise.all(sel.map(async (s) => ({ s, jumps: await jumpsBetween(ref.id, s.in_system_id) })));
      const reachable = withJumps.filter((x) => x.jumps != null).sort((a, b) => a.jumps - b.jumps);
      if (reachable.length) {
        const lines = reachable.map((x, i) => `${i + 1}. ${fmtSig(x.s)} · ${x.jumps} jump da ${ref.name}`);
        return {
          text: `INTEL EVE-Scout (Signal Cartel, dati live) — collegamenti ${systems.join("/")} ordinati per distanza da ${ref.name} (più vicino prima, salti via gate):\n${lines.join("\n")}\nFonte: https://www.eve-scout.com/`,
          entities: [],
        };
      }
    } else if (ref) {  // region / constellation → not a system
      nearWarning = `⚠ ATTENZIONE: "${opts.near}" è ${ref.type === "region" ? "una REGIONE" : "una COSTELLAZIONE"}, NON un sistema. La distanza in salti si calcola solo tra SISTEMI: per il collegamento più vicino indica un SISTEMA specifico (es. un sistema dentro ${ref.name}). Intanto i collegamenti disponibili:\n`;
    } else {           // unknown name
      nearWarning = `⚠ ATTENZIONE: non ho riconosciuto "${opts.near}" come sistema EVE valido. Per la distanza indica un nome di sistema corretto. Intanto i collegamenti disponibili:\n`;
    }
  }

  // Group by origin system (Thera / Turnur).
  const groups = new Map();
  for (const s of sel) {
    const k = s.out_system_name;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const blocks = [...groups.entries()].map(([sys, list]) =>
    `Da ${sys} (${list.length} collegament${list.length === 1 ? "o" : "i"}):\n` +
    list.map((s, i) => `${i + 1}. ${fmtSig(s)}`).join("\n"));
  return {
    text: `${nearWarning}INTEL EVE-Scout (Signal Cartel, dati live) — collegamenti wormhole:\n${blocks.join("\n\n")}\nFonte: https://www.eve-scout.com/`,
    entities: [],
  };
}
