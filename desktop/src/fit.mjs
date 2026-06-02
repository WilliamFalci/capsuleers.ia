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
  moduleAcceptsChargeType, isTurretWeapon, isMissileLauncher,
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

// Renders the offense (DPS + weapon-range) lines for one OffenseReport. `prefix` annotates
// the DPS/range labels (e.g. " (alto danno · Antimatter Charge L)") when contrasting two
// ammo loads. Returns [] when the fit deals no weapon/drone/fighter damage.
function offenseStatLines(o, { prefix = "" } = {}) {
  if (!o || o.totalDps <= 0) return [];
  const out = [];
  const parts = [];
  if (o.weaponDps > 0) parts.push(`armi ${r0(o.weaponDps)}`);
  if (o.droneDps > 0) parts.push(`droni ${r0(o.droneDps)}`);
  if (o.fighterDps > 0) parts.push(`fighter ${r0(o.fighterDps)}`);
  let dps = `- DPS${prefix}: ~${r0(o.totalDps)}${parts.length > 1 ? ` (${parts.join(", ")})` : ""}`;
  if (o.totalSustainedDps > 0 && Math.abs(o.totalSustainedDps - o.totalDps) > 1) dps += `; sostenuto ~${r0(o.totalSustainedDps)}`;
  if (o.alphaStrike > 0) dps += `; alpha ${r0(o.alphaStrike)}`;
  out.push(dps + ".");
  const rng = [];
  if (o.weaponOptimal > 0) rng.push(`ottimale ${r0(o.weaponOptimal)} m`);
  if (o.weaponFalloff > 0) rng.push(`falloff ${r0(o.weaponFalloff)} m`);
  if (o.weaponTracking != null) rng.push(`tracking ${o.weaponTracking.toFixed(4)}`);
  if (o.missileRange > 0) rng.push(`gittata ${r1(o.missileRange / 1000)} km`);
  if (o.explosionVelocity != null) rng.push(`expl.vel ${r0(o.explosionVelocity)} m/s`);
  if (o.explosionRadius != null) rng.push(`expl.radius ${r0(o.explosionRadius)} m`);
  if (rng.length) out.push(`- Portata armi${prefix}: ${rng.join(", ")}.`);
  return out;
}

// Renders defense/tank/cap/navigation/targeting/drones — everything EXCEPT offense (which
// varies per ammo load). Shared by describeFit (single load) and describeDoctrineFit (max/min).
function coreStatLines(d, droneInfo, isStructure) {
  const out = [];
  const df = d.defense;
  const ehpTotal = r0(df.shield.ehpUniform + df.armor.ehpUniform + df.hull.ehpUniform);
  out.push(`- Tank (EHP, profilo uniforme): ~${ehpTotal} (scudo ${r0(df.shield.ehpUniform)}, armatura ${r0(df.armor.ehpUniform)}, scafo ${r0(df.hull.ehpUniform)}).`);
  const resLine = (layer, label) => {
    const r = layer.resistances;
    return `  Resistenze ${label}: EM ${pct(r.em)}%, Th ${pct(r.thermal)}%, Kin ${pct(r.kinetic)}%, Exp ${pct(r.explosive)}%.`;
  };
  out.push(resLine(df.shield, "scudo"), resLine(df.armor, "armatura"), resLine(df.hull, "scafo"));

  const t = d.tank;
  const rep = [];
  if (t.shieldRepairPerSecond > 0) rep.push(`scudo ${r0(t.shieldRepairPerSecond)}/s (sost. ${r0(t.shieldRepairPerSecondSustained)}/s)`);
  if (t.armorRepairPerSecond > 0) rep.push(`armatura ${r0(t.armorRepairPerSecond)}/s (sost. ${r0(t.armorRepairPerSecondSustained)}/s)`);
  if (t.hullRepairPerSecond > 0) rep.push(`scafo ${r0(t.hullRepairPerSecond)}/s`);
  if (rep.length) out.push(`- Riparazione attiva: ${rep.join(", ")}.`);
  if (t.passiveShieldRegenPeak > 0) out.push(`- Rigen passivo scudo (picco): ~${r0(t.passiveShieldRegenPeak)}/s.`);

  const c = d.capacitor;
  if (c.capacity > 0) {
    out.push(c.stable
      ? `- Cap: STABILE (~${pct(c.stablePercent)}%).`
      : `- Cap: NON stabile (dura ~${r0(c.secondsToEmpty)} s; uso ${r1(c.usagePerSecond)} GJ/s > picco ricarica ${r1(c.peakRechargeRate)} GJ/s).`);
  }

  if (!isStructure) {
    const n = d.navigation;
    out.push(`- Velocità: ${r0(n.maxVelocity)} m/s; massa ${r0(n.mass)} kg; agilità ${r1(n.agility)}; align ~${r1(n.alignTimeSeconds)} s; warp ${r1(n.warpSpeed)} AU/s.`);
    const tg = d.targeting;
    out.push(`- Targeting: portata ${r1(tg.maxTargetingRange / 1000)} km, ${tg.maxLockedTargets} bersagli, signature ${r0(tg.signatureRadius)} m, scan res ${r0(tg.scanResolution)} mm, sensori ${tg.sensorType} ${r0(tg.sensorStrength)}.`);
    if (droneInfo.active > 0) out.push(`- Droni in volo: ${droneInfo.active}, control range ${r1(d.drones.controlRange / 1000)} km.`);
  }
  return out;
}

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
  const statLines = [...offenseStatLines(d.offense), ...coreStatLines(d, droneInfo, isStructure)];

  lines.push("STATISTICHE (motore eve-fit-engine, All V, parità pyfa):");
  lines.push(...statLines);

  const unk = warnings.map((w) => w.text).filter(Boolean);
  if (unk.length) lines.push(`Righe non riconosciute (escluse dal calcolo): ${unk.join(", ")}.`);
  return lines.join("\n");
}

// ── Doctrine fit analysis (killmail EFT → max/min damage spread) ────────────────
// Damage-component dogma attributes, summed to rank a charge by raw damage.
const DMG_ATTRS = [114, 118, 117, 116];   // EM, thermal, kinetic, explosive
const chargeDamageSum = (charge) => DMG_ATTRS.reduce((s, id) => s + (attrVal(charge, id) || 0), 0);

// Identifies the fit's damage weapons and, from every SDE charge that loads them, picks the
// highest-damage load (short range) and the lowest-damage non-zero load (long range), so
// describeDoctrineFit can show the DPS/range spread. Killmail fits routinely lose their ammo
// (charges aren't on the victim's loss), so this also restores a sane DPS where the raw fit
// computes 0. Returns { weaponMods, max:{id,name,dmg}, min:{id,name,dmg}, charges } or null
// (drone boats / EWAR / weapons with no swappable damage ammo → caller falls back).
async function pickAmmoExtremes(fit, dataset) {
  const weaponMods = [];
  for (const m of fit.modules) {
    const t = dataset.getType(m.typeID);
    if (t && (isTurretWeapon(t) || isMissileLauncher(t))) weaponMods.push({ m, t });
  }
  if (!weaponMods.length) return null;

  let charges;
  try { charges = await dataset.loadBucket("charges"); } catch { return null; }

  // Doctrine fits are weapon-homogeneous; the dominant weapon defines the ammo family.
  const primary = weaponMods[0].t;
  const isMissile = isMissileLauncher(primary);
  const primarySize = attrVal(primary, 128);   // ATTR.CHARGE_SIZE
  const compatible = [];
  for (const c of charges.values()) {
    if (!moduleAcceptsChargeType(primary, c)) continue;
    // The engine's size rule is permissive (size ≤). Turret/launcher ammo must match the
    // weapon size EXACTLY — otherwise we'd pick e.g. Small ammo for a Medium gun.
    const cSize = attrVal(c, 128);
    if (primarySize != null && cSize != null && Math.round(cSize) !== Math.round(primarySize)) continue;
    // Skip FOF / Auto-Targeting / Defender missiles — niche utility loads, not a range trade.
    if (/auto-targeting|\bdefender\b/i.test(c.name || "")) continue;
    const dmg = chargeDamageSum(c);
    if (dmg <= 0) continue;
    // For missiles, max flight range = base velocity × base flight time (the relative order
    // is preserved under the ship/skill/rig multipliers, so base attrs rank range correctly).
    const range = isMissile ? (attrVal(c, 37) || 0) * (attrVal(c, 281) || 0) : 0;
    compatible.push({ id: c.id, name: c.name || `carica ${c.id}`, dmg, range });
  }
  if (!compatible.length) return null;

  compatible.sort((a, b) => a.dmg - b.dmg);
  const max = compatible[compatible.length - 1];           // alto danno
  // Long-range load: missiles → genuinely longest flight range; turrets → lowest-damage ammo,
  // which for the T1/faction lineup is the long-range one (validated: Carbonized Lead vs EMP).
  let min;
  if (isMissile) {
    const byRange = [...compatible].sort((a, b) => b.range - a.range);
    min = byRange.find((c) => c.id !== max.id) || byRange[0];
  } else {
    min = compatible[0];
  }
  return { weaponMods, charges, min, max };
}

// Loads `chargeId` into every weapon module that accepts it (mutates fit in place before a
// recompute). Skips weapons of a different family (mixed-weapon fits keep their own load).
function setWeaponCharge(weaponMods, chargeId, charges) {
  const charge = charges.get(chargeId);
  for (const { m, t } of weaponMods) {
    if (charge && moduleAcceptsChargeType(t, charge)) m.chargeTypeID = chargeId;
  }
}

/** Doctrine-fit analysis from a killmail EFT block (from eve-kill MCP `killmail_fitting`).
 *  Same authoritative tank/cap/navigation/targeting numbers as describeFit, but contrasts
 *  the offense at the highest-damage ammo vs the longest-range ammo (the "max/min" spread).
 *  Returns the Italian context block, or null if the EFT can't be parsed/computed. */
export async function describeDoctrineFit(eft) {
  let dataset, parsed;
  try {
    dataset = await loadBundledDataset();
    parsed = engineParseEft(eft, dataset);
  } catch { return null; }
  if (!parsed?.fit) return null;

  const fit = parsed.fit;
  for (const m of fit.modules) {
    const ty = dataset.getType(m.typeID);
    if (ty) m.state = defaultStateForModule(ty, dataset.effects);
  }
  const droneInfo = launchDrones(fit, dataset);
  _allVProfile ??= buildAllVSkillProfile(dataset);

  // Header: ship + authoritative hull class + verbatim module listing.
  const named = parseEft(eft) || { ship: dataset.getType(fit.shipTypeID)?.name || "Nave", modules: [] };
  const lines = [`Nave: ${named.ship}`];
  const shipType = dataset.getType(fit.shipTypeID);
  const grp = shipType && dataset.groups.get(shipType.groupID);
  const cat = grp && dataset.categories.get(grp.categoryID);
  if (grp) lines.push(`Classe: ${grp.name}${cat ? ` (${cat.name})` : ""}.`);
  lines.push("Moduli:");
  for (const m of named.modules) {
    const qty = m.qty > 1 ? ` ×${m.qty}` : "";
    const charge = m.charge ? ` (carica: ${m.charge})` : "";
    lines.push(`  - ${m.name}${qty}${charge}`);
  }

  // Base compute first (with the killmail's own ammo, if any) → clean defensive/nav stats.
  let base;
  try { base = computeFit(fit, dataset, { skillProfile: _allVProfile }); }
  catch { return null; }
  const isStructure = !!base.derived.structure;

  // Offense: option-1 max/min via two ammo loads. Recomputes are pure (the fit is mutated
  // then re-evaluated), and base ran first, so the defensive numbers below stay clean.
  let offenseLines;
  const ext = await pickAmmoExtremes(fit, dataset);
  if (ext && ext.max.id !== ext.min.id) {
    setWeaponCharge(ext.weaponMods, ext.max.id, ext.charges);
    const maxC = computeFit(fit, dataset, { skillProfile: _allVProfile });
    setWeaponCharge(ext.weaponMods, ext.min.id, ext.charges);
    const minC = computeFit(fit, dataset, { skillProfile: _allVProfile });
    offenseLines = [
      ...offenseStatLines(maxC.derived.offense, { prefix: ` (alto danno · ${ext.max.name})` }),
      ...offenseStatLines(minC.derived.offense, { prefix: ` (lunga gittata · ${ext.min.name})` }),
    ];
  } else if (ext) {
    setWeaponCharge(ext.weaponMods, ext.max.id, ext.charges);
    const onlyC = computeFit(fit, dataset, { skillProfile: _allVProfile });
    offenseLines = offenseStatLines(onlyC.derived.offense, { prefix: ` (${ext.max.name})` });
  } else {
    offenseLines = offenseStatLines(base.derived.offense);
  }

  lines.push("STATISTICHE (motore eve-fit-engine, All V, parità pyfa; danno min/max per munizione):");
  lines.push(...offenseLines, ...coreStatLines(base.derived, droneInfo, isStructure));
  return lines.join("\n");
}

// ── Structured stats (for the VISUAL fit-stats card) ─────────────────────────
const pctR = (r) => ({ em: pct(r.em), th: pct(r.thermal), kin: pct(r.kinetic), exp: pct(r.explosive) });
function tankData(t) {
  if (!t) return null;
  const o = {};
  if (t.shieldRepairPerSecond > 0) o.shield = r0(t.shieldRepairPerSecond);
  if (t.armorRepairPerSecond > 0) o.armor = r0(t.armorRepairPerSecond);
  if (t.hullRepairPerSecond > 0) o.hull = r0(t.hullRepairPerSecond);
  return Object.keys(o).length ? o : null;
}
function offenseData(o, label, ammo) {
  if (!o || o.totalDps <= 0) return null;
  const km = (m) => m > 0 ? +(m / 1000).toFixed(1) : null;
  return {
    label, ammo,
    dps: r0(o.totalDps),
    sustained: (o.totalSustainedDps > 0 && Math.abs(o.totalSustainedDps - o.totalDps) > 1) ? r0(o.totalSustainedDps) : null,
    alpha: o.alphaStrike > 0 ? r0(o.alphaStrike) : null,
    weaponDps: o.weaponDps > 0 ? r0(o.weaponDps) : null,
    droneDps: o.droneDps > 0 ? r0(o.droneDps) : null,
    optimalKm: km(o.weaponOptimal), falloffKm: km(o.weaponFalloff),
    tracking: o.weaponTracking != null ? +o.weaponTracking.toFixed(4) : null,
    rangeKm: km(o.missileRange),
    explVel: o.explosionVelocity != null ? r0(o.explosionVelocity) : null,
    explRadius: o.explosionRadius != null ? r0(o.explosionRadius) : null,
  };
}

/** Same compute as describeDoctrineFit, but returns STRUCTURED stats for a visual card
 *  plus a one-line summary (for the model's theorycrafting context). Returns { card, summary }
 *  or null. The card.kind is 'fitstats'. */
export async function doctrineFitStatsData(eft) {
  let dataset, parsed;
  try { dataset = await loadBundledDataset(); parsed = engineParseEft(eft, dataset); } catch { return null; }
  if (!parsed?.fit) return null;
  const fit = parsed.fit;
  for (const m of fit.modules) { const ty = dataset.getType(m.typeID); if (ty) m.state = defaultStateForModule(ty, dataset.effects); }
  const droneInfo = launchDrones(fit, dataset);
  _allVProfile ??= buildAllVSkillProfile(dataset);
  const named = parseEft(eft) || { ship: dataset.getType(fit.shipTypeID)?.name || "Nave" };
  const shipType = dataset.getType(fit.shipTypeID);
  const grp = shipType && dataset.groups.get(shipType.groupID);

  let base;
  try { base = computeFit(fit, dataset, { skillProfile: _allVProfile }); } catch { return null; }
  const isStructure = !!base.derived.structure;

  let damage = [];
  const ext = await pickAmmoExtremes(fit, dataset);
  if (ext && ext.max.id !== ext.min.id) {
    setWeaponCharge(ext.weaponMods, ext.max.id, ext.charges);
    const maxC = computeFit(fit, dataset, { skillProfile: _allVProfile });
    setWeaponCharge(ext.weaponMods, ext.min.id, ext.charges);
    const minC = computeFit(fit, dataset, { skillProfile: _allVProfile });
    damage = [offenseData(maxC.derived.offense, "max", ext.max.name), offenseData(minC.derived.offense, "min", ext.min.name)].filter(Boolean);
  } else if (ext) {
    setWeaponCharge(ext.weaponMods, ext.max.id, ext.charges);
    damage = [offenseData(computeFit(fit, dataset, { skillProfile: _allVProfile }).derived.offense, "only", ext.max.name)].filter(Boolean);
  } else {
    damage = [offenseData(base.derived.offense, "only", null)].filter(Boolean);
  }

  const d = base.derived, df = d.defense;
  const card = {
    kind: "fitstats",
    ship: named.ship, shipClass: grp ? grp.name : null,
    damage,
    ehp: {
      total: r0(df.shield.ehpUniform + df.armor.ehpUniform + df.hull.ehpUniform),
      shield: r0(df.shield.ehpUniform), armor: r0(df.armor.ehpUniform), hull: r0(df.hull.ehpUniform),
      resists: { shield: pctR(df.shield.resistances), armor: pctR(df.armor.resistances), hull: pctR(df.hull.resistances) },
    },
    activeTank: tankData(d.tank),
    passiveShield: d.tank?.passiveShieldRegenPeak > 0 ? r0(d.tank.passiveShieldRegenPeak) : null,
    cap: d.capacitor?.capacity > 0
      ? { stable: !!d.capacitor.stable, pct: pct(d.capacitor.stablePercent), secondsToEmpty: d.capacitor.stable ? null : r0(d.capacitor.secondsToEmpty) }
      : null,
    nav: isStructure ? null : { speed: r0(d.navigation.maxVelocity), align: r1(d.navigation.alignTimeSeconds), warp: r1(d.navigation.warpSpeed), agility: r1(d.navigation.agility) },
    targeting: isStructure ? null : { rangeKm: r1(d.targeting.maxTargetingRange / 1000), locked: d.targeting.maxLockedTargets, sig: r0(d.targeting.signatureRadius), scanRes: r0(d.targeting.scanResolution), sensor: `${d.targeting.sensorType} ${r0(d.targeting.sensorStrength)}` },
    drones: droneInfo.active > 0 ? { active: droneInfo.active, controlRangeKm: r1(d.drones.controlRange / 1000) } : null,
  };

  const dmg = card.damage.map((x) => {
    const lbl = x.label === "max" ? "alto danno" : x.label === "min" ? "lunga gittata" : "";
    const rng = x.rangeKm != null ? `gittata ${x.rangeKm}km` : x.optimalKm != null ? `ottimale ${x.optimalKm}km${x.falloffKm ? `+${x.falloffKm}` : ""}` : "";
    return `${lbl}${x.ammo ? ` (${x.ammo})` : ""} ${x.dps} dps${rng ? `, ${rng}` : ""}`;
  }).join("; ");
  const summary = `${card.ship}${card.shipClass ? ` (${card.shipClass})` : ""}: ${dmg}. EHP ~${card.ehp.total}`
    + `${card.cap ? `, cap ${card.cap.stable ? "stabile" : "instabile"}` : ""}${card.nav ? `, ${card.nav.speed} m/s` : ""}.`;
  return { card, summary };
}
