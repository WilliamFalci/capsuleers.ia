// Live prices (EVE Ref) ported into the standalone. Requires data/names_index.json
// to resolve name→typeID. NB: requires an internet connection (dynamic prices).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { USER_AGENT } from "./user-agent.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Data dir: defaults next to the module (dev); the packaged app points us to userData.
let DATA_DIR = path.resolve(HERE, "..", "data");
export function configureDataDir(dir) { if (dir) { DATA_DIR = dir; namesIndex = null; } }
const PRICES_URL = "https://data.everef.net/markets-prices/markets-prices-latest.json";
const TTL = 3600 * 1000;

let namesIndex = null, pricesCache = null;

async function loadNames() {
  if (!namesIndex) namesIndex = JSON.parse(await readFile(path.join(DATA_DIR, "names_index.json"), "utf-8"));
  return namesIndex;
}

async function getPrices() {
  const now = Date.now();
  if (pricesCache && now - pricesCache.at < TTL) return pricesCache.data;
  const res = await fetch(PRICES_URL, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`prezzi HTTP ${res.status}`);
  const rows = await res.json();
  const data = new Map();
  for (const r of rows) data.set(r.type_id, { adjusted: r.adjusted_price ?? null, average: r.average_price ?? null });
  pricesCache = { at: now, data };
  return data;
}

/** Price (adjusted/average) by typeID. Null if unavailable/offline. */
export async function priceByTypeId(typeId) {
  if (typeId == null) return null;
  try { return (await getPrices()).get(typeId) ?? null; } catch { return null; }
}

/** True if the name is a known EVE type (ship/item/skill…) → game question, not an entity. */
export async function isKnownType(name) {
  const idx = await loadNames();
  return Object.prototype.hasOwnProperty.call(idx, name.trim().toLowerCase());
}

/** Price (global reference) of an item by name. {found, average, adjusted}. */
export async function priceByName(name) {
  const idx = await loadNames();
  const tid = idx[name.trim().toLowerCase()] ?? null;
  if (tid == null) return { name, typeID: null, found: false };
  let prices;
  try { prices = await getPrices(); } catch { return { name, typeID: tid, found: false, offline: true }; }
  const p = prices.get(tid);
  return { name, typeID: tid, adjusted: p?.adjusted ?? null, average: p?.average ?? null, found: !!p };
}
