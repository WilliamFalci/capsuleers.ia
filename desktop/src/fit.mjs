// Parsing, validation and stat estimation of EFT fits (standalone).
// CPU/PG/slot validation (All V) + estimates of DPS, EHP, speed and cap stability,
// plus a check of whether the fit uses the ship's bonuses. Requires data/fit_lookup.json.
// The numbers are All-V ESTIMATES (no overheat, simplified support skills, uniform
// damage profile): close to pyfa, not identical.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOOKUP_PATH = path.resolve(HERE, "..", "data", "fit_lookup.json");
const HEADER = /^\[(.+?),\s*(.+?)\]$/;

// Fitting skill bonuses at level V (community standard).
const ALL_V = { shipCpu: 1.25, shipPg: 1.25, weaponCpu: 0.75, weaponPg: 0.75, shieldPg: 0.75 };
// Stacking-penalty factors for the n-th strongest module of the same kind.
const STACK = [1, 0.8691, 0.5706, 0.2830, 0.1060, 0.0301, 0.0086, 0.0019];
// Approximate All-V support-skill multipliers per weapon family (damage / rate-of-fire).
const SKILL = {
  turret: { dmg: 1.15, rof: 0.80 },   // ~Surgical Strike V, Rapid Firing V
  missile: { dmg: 1.10, rof: 0.90 },  // ~Warhead Upgrades V, Missile Launcher Operation V
  drone: 1.50,                        // ~Drone Interfacing V (+50% drone damage)
};
const DTYPES = ["em", "therm", "kin", "exp"];

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
    const [namePart, charge] = line.split(",").map((s) => s.trim());
    const qm = namePart.match(/^(.*?)\s+x(\d+)$/);   // "Drone Name xN" (drones/cargo)
    const name = qm ? qm[1] : namePart;
    const qty = qm ? parseInt(qm[2], 10) : 1;
    modules.push({ name, qty, ...(charge ? { charge } : {}) });
  }
  return { ship: h[1].trim(), name: h[2].trim(), modules };
}

// ── Stat math ───────────────────────────────────────────────────────────────

const sumDmg = (d) => (d.em || 0) + (d.therm || 0) + (d.kin || 0) + (d.exp || 0);

// Combine resonance multipliers (<1 = resist) with the stacking penalty.
function stackResonance(mults) {
  const fr = mults.map((m) => 1 - m).filter((f) => Math.abs(f) > 1e-9).sort((a, b) => b - a);
  let res = 1;
  fr.forEach((f, i) => { res *= (1 - f * (STACK[i] ?? 0)); });
  return res;
}
// Combine percentage damage-mod bonuses (e.g. 20.5) with the stacking penalty.
function stackBonus(pcts) {
  const s = pcts.filter((p) => p > 0).sort((a, b) => b - a);
  let mult = 1;
  s.forEach((p, i) => { mult *= (1 + p / 100 * (STACK[i] ?? 0)); });
  return mult;
}

// Ship damage multiplier for a weapon family / a specific drone group (per-level → ×5).
function shipDamageMult(ship, { weaponKw, droneGroup } = {}) {
  let mult = 1;
  for (const b of ship.bonuses || []) {
    if (!(b.pct && b.value && /damage/i.test(b.text))) continue;
    const t = b.text.toLowerCase();
    let applies = false;
    if (droneGroup != null) {
      if (!/drone/.test(t)) continue;
      const isSentry = /sentry/.test(droneGroup.toLowerCase());
      const mSentry = /sentry/.test(t), mLMH = /light drone|medium drone|heavy drone/.test(t);
      applies = (!mSentry && !mLMH) || (mSentry && isSentry) || (mLMH && !isSentry);
    } else if (weaponKw) {
      applies = weaponKw.test(t);
    }
    if (applies) mult *= (1 + (b.perLevel ? b.value * 5 : b.value) / 100);
  }
  return mult;
}

function computeEHP(ship, items) {
  if (!ship.hp) return null;
  const hp = { shield: ship.hp.shield || 0, armor: ship.hp.armor || 0, hull: ship.hp.hull || 0 };
  for (const it of items) { const a = it.attrs || {}; hp.shield += a.shieldHpAdd || 0; hp.armor += a.armorHpAdd || 0; }
  const out = { hp }; let total = 0;
  for (const layer of ["shield", "armor", "hull"]) {
    let resSum = 0;  // Σ resonance over the 4 damage types (uniform profile)
    for (const dt of DTYPES) {
      const base = ship.res?.[layer]?.[dt] ?? 1;
      const mults = [];
      for (const it of items) {
        const a = it.attrs || {}, grp = it.group || "";
        if (a[`${layer}Res_${dt}`] != null) mults.push(a[`${layer}Res_${dt}`]);
        if (a[`${layer}ResBonus_${dt}`]) mults.push(1 + a[`${layer}ResBonus_${dt}`] / 100);
        if (a[`resBonus_${dt}`]) {
          const isShield = /shield/i.test(grp), isArmor = /armor|membrane|plate|energized/i.test(grp);
          if ((layer === "shield" && isShield) || (layer === "armor" && isArmor)) mults.push(1 + a[`resBonus_${dt}`] / 100);
        }
      }
      resSum += base * stackResonance(mults);
    }
    const ehp = hp[layer] / (resSum / 4);   // HP / average resonance
    out[layer] = Math.round(ehp); total += ehp;
  }
  out.total = Math.round(total);
  return out;
}

function computeCap(ship, items) {
  const cap = ship.cap?.capacity, rr = ship.cap?.rechargeRate;
  if (!cap || !rr) return null;
  const peak = 2.5 * cap / (rr / 1000);   // peak recharge (GJ/s), at ~25% cap
  let usage = 0;
  for (const it of items) { const a = it.attrs || {}; if (a.capNeed && a.duration) usage += a.capNeed / (a.duration / 1000); }
  const u = usage / peak;
  if (u >= 1) return { stable: false, usage: +usage.toFixed(1), peak: +peak.toFixed(1) };
  const s = (1 + Math.sqrt(1 - u)) / 2;    // stable cap fraction (higher root)
  return { stable: true, pct: Math.round(s * s * 100), usage: +usage.toFixed(1), peak: +peak.toFixed(1) };
}

function computeSpeed(ship, items) {
  const base = ship.mob?.maxVelocity, mass = ship.mob?.mass || 0;
  if (!base) return null;
  let bonus = 0;
  for (const it of items) {
    const a = it.attrs || {};
    if (a.speedFactor && a.speedBoostFactor && mass) {
      const m = mass + (/microwarp/i.test(it.group || "") ? (a.massAddition || 0) : 0);
      bonus = Math.max(bonus, (a.speedFactor / 100) * a.speedBoostFactor / m);
    }
  }
  return { base: Math.round(base), max: Math.round(base * (1 + bonus)) };
}

function computeDPS(ship, items, lk) {
  const charges = lk.charges || {}, dronesDb = lk.drones || {};  // tolerate an older lookup
  let turret = 0, missile = 0, drone = 0;
  for (const it of items) {
    if (it.kind !== "module") continue;
    const a = it.attrs || {};
    if (!a.rof || !it.charge) continue;
    const ch = charges[it.charge]; if (!ch) continue;
    const dmg = sumDmg(ch.dmg), n = it.qty || 1;
    if (a.dmgMult) {  // turret: charge damage × turret multiplier
      const sm = shipDamageMult(ship, { weaponKw: /turret|hybrid|projectile|laser|beam|pulse|blaster|railgun|artillery|autocannon/ });
      turret += dmg * a.dmgMult / (a.rof / 1000) * SKILL.turret.dmg / SKILL.turret.rof * sm * n;
    } else {          // launcher: missile damage
      const sm = shipDamageMult(ship, { weaponKw: /missile|rocket|torpedo/ });
      missile += dmg / (a.rof / 1000) * SKILL.missile.dmg / SKILL.missile.rof * sm * n;
    }
  }
  // Drones in space, limited by drone bandwidth; damage amplifiers stack-penalized.
  const ddaMult = stackBonus(items.filter((i) => i.kind === "module").map((i) => i.attrs?.droneDmgBonus).filter(Boolean));
  let bw = ship.droneBandwidth || 0;
  for (const d of items.filter((i) => i.kind === "drone")) {
    const info = dronesDb[d.name]; if (!info || !info.rof) continue;
    for (let k = 0; k < (d.qty || 1) && bw - (info.bwUsed || 0) >= -1e-9; k++) {
      bw -= info.bwUsed || 0;
      const sm = shipDamageMult(ship, { droneGroup: info.group || "" });
      drone += sumDmg(info.dmg) * (info.dmgMult || 1) / (info.rof / 1000) * SKILL.drone * ddaMult * sm;
    }
  }
  const total = turret + missile + drone;
  return total > 0 ? { total: Math.round(total), turret: Math.round(turret), missile: Math.round(missile), drone: Math.round(drone) } : null;
}

// Does the fit use the ship's combat bonuses? Returns lines [{text, used}].
function bonusUsage(ship, items) {
  const bonuses = (ship.bonuses || []).filter((b) => /damage|rate of fire|hitpoint|resist|repair|booster|tracking|optimal|missile|drone/i.test(b.text));
  if (!bonuses.length) return null;
  const hasDrones = items.some((i) => i.kind === "drone");
  const wg = items.filter((i) => i.kind === "module" && i.attrs?.rof).map((i) => (i.group || "").toLowerCase());
  const usesMissiles = wg.some((g) => /missile|launcher|rocket/.test(g));
  const usesTurrets = wg.some((g) => /turret|laser|hybrid|projectile|cannon|artillery|blaster|railgun|beam|pulse/.test(g));
  const out = [];
  for (const b of bonuses) {
    const t = b.text.toLowerCase();
    let used = null;
    if (/drone/.test(t)) used = hasDrones;
    else if (/missile|rocket|torpedo/.test(t)) used = usesMissiles;
    else if (/turret|hybrid|projectile|laser|beam|pulse|blaster|railgun|artillery|autocannon/.test(t)) used = usesTurrets;
    if (used !== null) out.push({ text: b.text, used });
  }
  return out.length ? out : null;
}

/** Fit analysis: CPU/PG/slot validation (All V) + DPS/EHP/speed/cap estimates +
 *  ship-bonus usage. Returns a text block (used as context for the LLM answer). */
export async function describeFit(fit) {
  const lk = await loadLookup();
  const lines = [`Nave: ${fit.ship}`, "Moduli:"];
  const ship = lk?.ships?.[fit.ship];

  // Classify each parsed entry (module vs drone) and enrich with lookup data.
  const items = [];
  let cpu = 0, pg = 0;
  const slots = { high: 0, mid: 0, low: 0, rig: 0, subsystem: 0 };
  const unknown = [];
  for (const m of fit.modules) {
    const mod = lk?.modules?.[m.name];
    const drn = lk?.drones?.[m.name];
    if (mod) {
      const cpuF = mod.fitSkill === "weapon" ? ALL_V.weaponCpu : 1;
      const pgF = mod.fitSkill === "weapon" ? ALL_V.weaponPg : mod.fitSkill === "shield" ? ALL_V.shieldPg : 1;
      cpu += (mod.cpu ?? 0) * cpuF; pg += (mod.pg ?? 0) * pgF; slots[mod.slot] += 1;
      items.push({ ...m, kind: "module", group: mod.group, slot: mod.slot, attrs: mod.attrs || {} });
      lines.push(`  - ${m.name} [${mod.slot}]${m.charge ? ` (carica: ${m.charge})` : ""}`);
    } else if (drn) {
      items.push({ ...m, kind: "drone", group: drn.group });
      lines.push(`  - ${m.name} ×${m.qty} [drone]`);
    } else {
      unknown.push(m.name);
      lines.push(`  - ${m.name}${m.qty > 1 ? ` ×${m.qty}` : ""}${m.charge ? ` (carica: ${m.charge})` : ""}`);
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

    // Estimated stats (All V). Collected first, printed only if any is available.
    const statLines = [];
    const dps = computeDPS(ship, items, lk);
    if (dps) {
      const parts = [];
      if (dps.turret) parts.push(`turret ${dps.turret}`);
      if (dps.missile) parts.push(`missili ${dps.missile}`);
      if (dps.drone) parts.push(`droni ${dps.drone}`);
      statLines.push(`- DPS: ~${dps.total}${parts.length > 1 ? ` (${parts.join(", ")})` : ""}.`);
    }
    const ehp = computeEHP(ship, items);
    if (ehp) statLines.push(`- Tank (EHP, profilo uniforme): ~${ehp.total} (scudo ${ehp.shield}, armatura ${ehp.armor}, scafo ${ehp.hull}).`);
    const cap = computeCap(ship, items);
    if (cap) statLines.push(cap.stable ? `- Cap: STABILE (~${cap.pct}% di capacitor).` : `- Cap: NON stabile (uso ${cap.usage} GJ/s > picco ricarica ${cap.peak} GJ/s).`);
    const spd = computeSpeed(ship, items);
    if (spd) statLines.push(`- Velocità: base ${spd.base} m/s${spd.max > spd.base ? `, max ~${spd.max} m/s col propulsore` : ""}.`);
    if (statLines.length) { lines.push("STATISTICHE STIMATE (All V, ~pyfa):"); lines.push(...statLines); }

    // Ship-bonus usage.
    const usage = bonusUsage(ship, items);
    if (usage) {
      const unused = usage.filter((u) => !u.used);
      if (unused.length && usage.some((u) => u.used)) {
        lines.push(`- Bonus nave: il fit sfrutta alcuni bonus ma NON: ${unused.map((u) => u.text).join("; ")}.`);
      } else if (unused.length === usage.length) {
        lines.push(`- Bonus nave: il fit sembra NON sfruttare i bonus principali della nave (${unused.map((u) => u.text).join("; ")}).`);
      } else {
        lines.push("- Bonus nave: il fit sfrutta i bonus principali della nave.");
      }
    }
  } else {
    lines.push("(Nave non riconosciuta nel lookup: analisi limitata.)");
  }
  if (unknown.length) lines.push(`Moduli non riconosciuti: ${unknown.join(", ")}.`);
  return lines.join("\n");
}
