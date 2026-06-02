// Parsing + analysis of EFT fits.
//
// The stat math (DPS/EHP/cap/tank/navigation/targeting/fitting) is delegated to the
// `eve-fit-engine` npm package, which is Pyfa-parity (validated by 631 assertions /
// 23 fixtures) and ships its own version-pinned SDE bundle — so the numbers below are
// AUTHORITATIVE, offline, and need no remote dogma call. This module only:
//   • detects a pasted fit (looksLikeFit),
//   • extracts ship + module NAMES verbatim (parseEft) for the price lookup and the
//     module listing shown to the LLM (the engine's Fit carries only typeIDs),
//   • renders the computed DerivedStats into the Italian context block (describeFit).
import {
  loadBundledDataset, buildAllVSkillProfile, computeFit,
  parseEft as engineParseEft, defaultStateForModule,
} from "eve-fit-engine/node";

const HEADER = /^\[(.+?),\s*(.+?)\]$/;
const ATTR_DRONE_BANDWIDTH = 1271;   // ship: total drone bandwidth (Mbit/s)
const ATTR_DRONE_BW_USED = 1272;     // drone: bandwidth it consumes in space
const MAX_DRONES_IN_SPACE = 5;       // Drones skill at level V (sub-cap controllable count)

const attrVal = (type, id) => type?.attributes?.find((a) => a.id === id)?.v;

// EFT lists the drone BAY; the engine's OFFENSE only counts drones with countActive>0.
// Launch drones greedily in EFT order, capped by ship bandwidth + the All-V 5-drone
// limit, so the headline DPS reflects the drones actually deployable (Pyfa's behaviour).
// Returns the deployed-drone summary (the engine's state-based derived.drones counters
// don't reflect countActive set directly, so we tally it here for display).
function launchDrones(fit, dataset) {
  let bw = attrVal(dataset.getType(fit.shipTypeID), ATTR_DRONE_BANDWIDTH) || 0;
  let slots = MAX_DRONES_IN_SPACE;
  let active = 0, bwUsed = 0;
  for (const d of fit.drones) {
    const used = attrVal(dataset.getType(d.typeID), ATTR_DRONE_BW_USED) || 0;
    let n = 0;
    while (n < d.countTotal && slots > 0 && (used === 0 || bw - used >= -1e-9)) {
      bw -= used; slots -= 1; n += 1; active += 1; bwUsed += used;
    }
    d.countActive = n;
  }
  return { active, bwUsed };
}

let _allVProfile = null;

/** Pre-loads the bundled SDE so the first pasted fit doesn't pay the ~8 MB JSON read.
 *  Called once from engine.init(). Safe to ignore failures (lazy-loaded on demand). */
export async function warmFitEngine() {
  try { await loadBundledDataset(); } catch { /* loaded lazily on first fit */ }
}

export function looksLikeFit(text) {
  return HEADER.test((text.trim().split("\n")[0] || "").trim());
}

// Lightweight name parser: ship + module/charge names verbatim from the EFT text.
// Used for the price lookup (priceByName) and the module listing in the context block.
// The numeric stats come from eve-fit-engine, which re-parses the raw EFT itself.
export function parseEft(text) {
  const lines = text.trim().split("\n");
  const h = (lines[0] || "").trim().match(HEADER);
  if (!h) return null;
  const modules = [];
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    const [namePart, charge] = line.split(",").map((s) => s.trim());
    const qm = namePart.match(/^(.*?)\s+x(\d+)$/);   // "Drone Name xN" (drones/cargo)
    const name = qm ? qm[1] : namePart;
    const qty = qm ? parseInt(qm[2], 10) : 1;
    modules.push({ name, qty, ...(charge ? { charge } : {}) });
  }
  return { ship: h[1].trim(), name: h[2].trim(), modules };
}

// ── Formatting helpers ────────────────────────────────────────────────────────
const r0 = (n) => Math.round(n || 0);
const r1 = (n) => Math.round((n || 0) * 10) / 10;
const pct = (n) => Math.round((n || 0) * 100);   // 0..1 resonance/fraction → percent

/** Fit analysis: module listing (verbatim) + Pyfa-parity stats from eve-fit-engine,
 *  rendered as the Italian context block fed to the LLM.
 *  @param {{ship:string, modules:Array}} fit  parsed by parseEft (names for the listing)
 *  @param {string} eftText  the raw EFT string (the engine re-parses + computes from it) */
export async function describeFit(fit, eftText) {
  const lines = [`Nave: ${fit.ship}`];

  // Load the bundled SDE + parse the EFT once: reused for the authoritative hull-CLASS
  // line below AND the stat computation further down.
  let dataset, parsed;
  try {
    dataset = await loadBundledDataset();
    parsed = engineParseEft(eftText, dataset);
  } catch { /* dataset/parse unavailable → degrade gracefully below */ }

  // Authoritative hull class straight from the bundled SDE (groupID→group name,
  // categoryID→category name). Without it the LLM has only the ship NAME in its
  // context, and a small local model can hallucinate the role (e.g. report a Marauder
  // as a "Command Destroyer"). groups/categories are Maps — use .get(), not [].
  if (dataset && parsed) {
    const shipType = dataset.getType(parsed.fit.shipTypeID);
    const grp = shipType && dataset.groups.get(shipType.groupID);
    const cat = grp && dataset.categories.get(grp.categoryID);
    if (grp) lines.push(`Classe: ${grp.name}${cat ? ` (${cat.name})` : ""}.`);
  }

  lines.push("Moduli:");
  for (const m of fit.modules) {
    const qty = m.qty > 1 ? ` ×${m.qty}` : "";
    const charge = m.charge ? ` (carica: ${m.charge})` : "";
    lines.push(`  - ${m.name}${qty}${charge}`);
  }

  let computed, warnings = [], droneInfo = { active: 0, bwUsed: 0 };
  if (!dataset || !parsed) {
    lines.push("(Statistiche del fit non calcolabili.)");
    return lines.join("\n");
  }
  try {
    warnings = parsed.warnings || [];
    const efit = parsed.fit;
    // Promote modules to their natural state (weapons/props → ACTIVE), as the editor
    // does on EFT import — otherwise weapons sit ONLINE and contribute 0 DPS.
    for (const m of efit.modules) {
      const ty = dataset.getType(m.typeID);
      if (ty) m.state = defaultStateForModule(ty, dataset.effects);
    }
    droneInfo = launchDrones(efit, dataset);
    _allVProfile ??= buildAllVSkillProfile(dataset);
    computed = computeFit(efit, dataset, { skillProfile: _allVProfile });
  } catch {
    lines.push("(Statistiche del fit non calcolabili.)");
    return lines.join("\n");
  }
  const d = computed.derived;
  const isStructure = !!d.structure;
  if (isStructure) lines.push("(Fit di struttura Upwell: navigazione/align non applicabili.)");

  // Fitting resources.
  const f = d.fitting;
  lines.push(`Fitting (skill a livello V): CPU ${r1(f.cpuUsed)}/${r0(f.cpuMax)} tf, PG ${r1(f.powerUsed)}/${r0(f.powerMax)} MW${f.calibrationMax ? `, calibrazione ${r0(f.calibrationUsed)}/${r0(f.calibrationMax)}` : ""}.`);
  const s = f.slots || {};
  const slot = (k) => `${s[k]?.used ?? 0}/${s[k]?.max ?? 0}`;
  lines.push(`Slot usati: high ${slot("HI")}, mid ${slot("MED")}, low ${slot("LO")}, rig ${slot("RIG")}${s.SUBSYSTEM?.max ? `, subsystem ${slot("SUBSYSTEM")}` : ""}.`);
  const hpt = f.hardpoints;
  if (hpt.turret.max || hpt.launcher.max) {
    lines.push(`Hardpoint: turret ${hpt.turret.used}/${hpt.turret.max}, launcher ${hpt.launcher.used}/${hpt.launcher.max}.`);
  }
  if (f.droneBandwidthMax || f.droneBayMax) {
    lines.push(`Capacità droni: banda ${r0(droneInfo.bwUsed)}/${r0(f.droneBandwidthMax)} Mbit/s (in volo), stiva ${r0(f.droneBayUsed)}/${r0(f.droneBayMax)} m³.`);
  }

  // Resource overflow check.
  const issues = [];
  if (f.cpuUsed > f.cpuMax + 1e-6) issues.push("CPU insufficiente");
  if (f.powerUsed > f.powerMax + 1e-6) issues.push("PG insufficiente");
  if (f.calibrationUsed > f.calibrationMax + 1e-6) issues.push("calibrazione insufficiente");
  for (const [k, label] of [["HI", "high"], ["MED", "mid"], ["LO", "low"], ["RIG", "rig"], ["SUBSYSTEM", "subsystem"]]) {
    if (s[k] && s[k].used > s[k].max) issues.push(`troppi moduli ${label}`);
  }
  if (hpt.turret.used > hpt.turret.max) issues.push("hardpoint turret insufficienti");
  if (hpt.launcher.used > hpt.launcher.max) issues.push("hardpoint launcher insufficienti");
  lines.push(issues.length ? `Possibili problemi: ${issues.join(", ")}.` : "Il fit sta in piedi (CPU/PG/slot OK).");

  // Computed stats (only emit a line when its source value is present / non-zero).
  const statLines = [];
  const o = d.offense;
  if (o.totalDps > 0) {
    const parts = [];
    if (o.weaponDps > 0) parts.push(`armi ${r0(o.weaponDps)}`);
    if (o.droneDps > 0) parts.push(`droni ${r0(o.droneDps)}`);
    if (o.fighterDps > 0) parts.push(`fighter ${r0(o.fighterDps)}`);
    let dps = `- DPS: ~${r0(o.totalDps)}${parts.length > 1 ? ` (${parts.join(", ")})` : ""}`;
    if (o.totalSustainedDps > 0 && Math.abs(o.totalSustainedDps - o.totalDps) > 1) dps += `; sostenuto ~${r0(o.totalSustainedDps)}`;
    if (o.alphaStrike > 0) dps += `; alpha ${r0(o.alphaStrike)}`;
    statLines.push(dps + ".");
    const rng = [];
    if (o.weaponOptimal > 0) rng.push(`ottimale ${r0(o.weaponOptimal)} m`);
    if (o.weaponFalloff > 0) rng.push(`falloff ${r0(o.weaponFalloff)} m`);
    if (o.weaponTracking != null) rng.push(`tracking ${o.weaponTracking.toFixed(4)}`);
    if (o.explosionVelocity != null) rng.push(`expl.vel ${r0(o.explosionVelocity)} m/s`);
    if (o.explosionRadius != null) rng.push(`expl.radius ${r0(o.explosionRadius)} m`);
    if (rng.length) statLines.push(`- Portata armi: ${rng.join(", ")}.`);
  }

  const df = d.defense;
  const ehpTotal = r0(df.shield.ehpUniform + df.armor.ehpUniform + df.hull.ehpUniform);
  statLines.push(`- Tank (EHP, profilo uniforme): ~${ehpTotal} (scudo ${r0(df.shield.ehpUniform)}, armatura ${r0(df.armor.ehpUniform)}, scafo ${r0(df.hull.ehpUniform)}).`);
  const resLine = (layer, label) => {
    const r = layer.resistances;
    return `  Resistenze ${label}: EM ${pct(r.em)}%, Th ${pct(r.thermal)}%, Kin ${pct(r.kinetic)}%, Exp ${pct(r.explosive)}%.`;
  };
  statLines.push(resLine(df.shield, "scudo"), resLine(df.armor, "armatura"), resLine(df.hull, "scafo"));

  const t = d.tank;
  const rep = [];
  if (t.shieldRepairPerSecond > 0) rep.push(`scudo ${r0(t.shieldRepairPerSecond)}/s (sost. ${r0(t.shieldRepairPerSecondSustained)}/s)`);
  if (t.armorRepairPerSecond > 0) rep.push(`armatura ${r0(t.armorRepairPerSecond)}/s (sost. ${r0(t.armorRepairPerSecondSustained)}/s)`);
  if (t.hullRepairPerSecond > 0) rep.push(`scafo ${r0(t.hullRepairPerSecond)}/s`);
  if (rep.length) statLines.push(`- Riparazione attiva: ${rep.join(", ")}.`);
  if (t.passiveShieldRegenPeak > 0) statLines.push(`- Rigen passivo scudo (picco): ~${r0(t.passiveShieldRegenPeak)}/s.`);

  const c = d.capacitor;
  if (c.capacity > 0) {
    statLines.push(c.stable
      ? `- Cap: STABILE (~${pct(c.stablePercent)}%).`
      : `- Cap: NON stabile (dura ~${r0(c.secondsToEmpty)} s; uso ${r1(c.usagePerSecond)} GJ/s > picco ricarica ${r1(c.peakRechargeRate)} GJ/s).`);
  }

  if (!isStructure) {
    const n = d.navigation;
    statLines.push(`- Velocità: ${r0(n.maxVelocity)} m/s; massa ${r0(n.mass)} kg; agilità ${r1(n.agility)}; align ~${r1(n.alignTimeSeconds)} s; warp ${r1(n.warpSpeed)} AU/s.`);
    const tg = d.targeting;
    statLines.push(`- Targeting: portata ${r1(tg.maxTargetingRange / 1000)} km, ${tg.maxLockedTargets} bersagli, signature ${r0(tg.signatureRadius)} m, scan res ${r0(tg.scanResolution)} mm, sensori ${tg.sensorType} ${r0(tg.sensorStrength)}.`);
    if (droneInfo.active > 0) statLines.push(`- Droni in volo: ${droneInfo.active}, control range ${r1(d.drones.controlRange / 1000)} km.`);
  }

  lines.push("STATISTICHE (motore eve-fit-engine, All V, parità pyfa):");
  lines.push(...statLines);

  const unk = warnings.map((w) => w.text).filter(Boolean);
  if (unk.length) lines.push(`Righe non riconosciute (escluse dal calcolo): ${unk.join(", ")}.`);
  return lines.join("\n");
}
