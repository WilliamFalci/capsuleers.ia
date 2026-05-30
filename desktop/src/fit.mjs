// Parsing and validation of EFT fits (ported from the API into the standalone).
// CPU/PG/slot validation with skills at level V (All V). Requires data/fit_lookup.json.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOOKUP_PATH = path.resolve(HERE, "..", "data", "fit_lookup.json");
const HEADER = /^\[(.+?),\s*(.+?)\]$/;

// Fitting skill bonuses at level V (community standard).
const ALL_V = { shipCpu: 1.25, shipPg: 1.25, weaponCpu: 0.75, weaponPg: 0.75, shieldPg: 0.75 };

let lookupCache = null;
async function loadLookup() {
  if (lookupCache) return lookupCache;
  try { lookupCache = JSON.parse(await readFile(LOOKUP_PATH, "utf-8")); } catch { lookupCache = null; }
  return lookupCache;
}

export function looksLikeFit(text) {
  return HEADER.test((text.trim().split("\n")[0] || "").trim());
}

export function parseEft(text) {
  const lines = text.trim().split("\n");
  const h = (lines[0] || "").trim().match(HEADER);
  if (!h) return null;
  const modules = [];
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    const [name, charge] = line.split(",").map((s) => s.trim());
    modules.push(charge ? { name, charge } : { name });
  }
  return { ship: h[1].trim(), name: h[2].trim(), modules };
}

/** Fit analysis with All V validation. Returns {text, lookup} (lookup for the cost). */
export async function describeFit(fit) {
  const lk = await loadLookup();
  const lines = [`Nave: ${fit.ship}`, "Moduli:"];
  const ship = lk?.ships[fit.ship];
  let cpu = 0, pg = 0;
  const slots = { high: 0, mid: 0, low: 0, rig: 0, subsystem: 0 };
  const unknown = [];
  for (const m of fit.modules) {
    const info = lk?.modules[m.name];
    if (info) {
      const cpuF = info.fitSkill === "weapon" ? ALL_V.weaponCpu : 1;
      const pgF = info.fitSkill === "weapon" ? ALL_V.weaponPg : info.fitSkill === "shield" ? ALL_V.shieldPg : 1;
      cpu += (info.cpu ?? 0) * cpuF;
      pg += (info.pg ?? 0) * pgF;
      slots[info.slot] += 1;
      lines.push(`  - ${m.name} [${info.slot}]${m.charge ? ` (carica: ${m.charge})` : ""}`);
    } else {
      unknown.push(m.name);
      lines.push(`  - ${m.name}${m.charge ? ` (carica: ${m.charge})` : ""}`);
    }
  }
  if (ship) {
    const sCpu = ship.cpuOutput != null ? ship.cpuOutput * ALL_V.shipCpu : null;
    const sPg = ship.pgOutput != null ? ship.pgOutput * ALL_V.shipPg : null;
    lines.push(`Fitting (skill a livello V): CPU ${cpu.toFixed(1)}/${sCpu?.toFixed(0) ?? "?"} tf, PG ${pg.toFixed(1)}/${sPg?.toFixed(0) ?? "?"} MW.`);
    lines.push(`Slot usati: high ${slots.high}/${ship.high}, mid ${slots.mid}/${ship.mid}, low ${slots.low}/${ship.low}, rig ${slots.rig}/${ship.rig}.`);
    const issues = [];
    if (sCpu != null && cpu > sCpu) issues.push("CPU insufficiente");
    if (sPg != null && pg > sPg) issues.push("PG insufficiente");
    for (const k of ["high", "mid", "low", "rig"]) if (slots[k] > ship[k]) issues.push(`troppi moduli ${k}`);
    lines.push(issues.length ? `Possibili problemi: ${issues.join(", ")}.` : "Il fit sta in piedi (CPU/PG/slot OK).");
  } else {
    lines.push("(Nave non riconosciuta nel lookup: analisi limitata.)");
  }
  if (unknown.length) lines.push(`Moduli non riconosciuti: ${unknown.join(", ")}.`);
  return lines.join("\n");
}
