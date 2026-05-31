// Makes items/ships and entities (character/corp/alliance) clickable in the answers,
// with links to capsuleers.app in the right language.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Data dir: defaults next to the module (dev); the packaged app points us to userData.
let DATA_DIR = path.resolve(HERE, "..", "data");
export function configureDataDir(dir) { if (dir) { DATA_DIR = dir; names = null; } }

// Path per language: localized Italian, otherwise English.
const PATHS = {
  it: { item: "it/items", character: "it/character", corporation: "it/corporazione", alliance: "it/alleanza" },
  en: { item: "items", character: "character", corporation: "corporation", alliance: "alliance" },
};
function url(lang, kind, id) {
  const p = (PATHS[lang] || PATHS.en)[kind];
  return `https://capsuleers.app/${p}/${id}`;
}

let names = null;  // { name_lowercase: typeID }
async function loadNames() {
  if (!names) { try { names = JSON.parse(await readFile(path.join(DATA_DIR, "names_index.json"), "utf-8")); } catch { names = {}; } }
  return names;
}

/** Simple language detection (it vs en) from the text. On a tie/undetermined
 *  result it returns `fallback` (e.g. the system language) instead of always English. */
export function detectLang(text, fallback = "en") {
  const t = text.toLowerCase();
  // STRONG markers of Italian: accented vowels (almost never in English) and
  // apostrophe elisions (l'/d'/un'/cos'/dell'…). They weigh more than function words.
  const accents = (t.match(/[àèéìòù]/g) || []).length;
  const elisions = (t.match(/\b(?:l|d|un|dell|all|nell|sull|quest|cos|c|po|gl|sant|grand|bell|mezz)['’]/g) || []).length;
  // Unambiguous function words (excluding those ambiguous between the two languages: in, a, i, on).
  const it = accents * 3 + elisions * 2 + (t.match(/\b(di|che|chi|per|una|un|uno|sono|sei|hai|ho|della|dello|del|dei|degli|delle|il|la|le|gli|lo|con|non|come|cosa|cos|dove|quando|quali|qual|quale|quanto|nel|nella|piu|puo|mi|ci|ti|si|sai|dimmi|perche|sulla|sullo|questo|questa|quello|quella|anche|essere|fare|sta|milita|gioca|parlami|dammi|vorrei|tra|fra|ed)\b/g) || []).length;
  const en = (t.match(/\b(the|of|to|and|is|are|was|were|you|who|what|where|when|which|how|why|with|for|this|that|these|those|at|your|can|could|has|have|had|do|does|did|about|tell|please|give|show|it|its|they|their|there|my|an|will|would|should)\b/g) || []).length;
  if (it > en) return "it";
  if (en > it) return "en";
  return fallback;  // tie/undetermined → caller's fallback (system/conversation language)
}

// Applies a transformation only OUTSIDE the already-present markdown links.
function outsideLinks(text, fn) {
  return text.split(/(\[[^\]]+\]\([^)]+\))/g)
    .map((seg) => (/^\[[^\]]+\]\([^)]+\)$/.test(seg) ? seg : fn(seg)))
    .join("");
}

const _esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Linkifies the text: entities (exact name) + items/ships (known Capitalized phrases). */
export async function linkify(text, { lang = "it", entities = [] } = {}) {
  const idx = await loadNames();

  // 1. Entities (character/corp/alliance) with known id: first occurrence of the exact name.
  const seen = new Set();
  for (const e of entities) {
    if (!e?.name || e.id == null || seen.has(e.name.toLowerCase())) continue;
    seen.add(e.name.toLowerCase());
    const re = new RegExp(`(?<!\\]\\()\\b${_esc(e.name)}\\b`);
    text = outsideLinks(text, (seg) => seg.replace(re, (m) => `[${m}](${url(lang, e.type, e.id)})`));
  }

  // 2. Items/ships: phrases of Capitalized words that match a known type.
  const CAP = /([A-Z][\p{L}\p{N}'’]*(?:[ -][A-Z0-9][\p{L}\p{N}'’]*)*)/gu;
  text = outsideLinks(text, (seg) => seg.replace(CAP, (m) => {
    const words = m.split(/([ -])/);  // keeps the separators
    // longest match from the left
    let acc = "";
    for (let i = 0; i < words.length; i += 2) {
      acc += (i ? words[i - 1] : "") + words[i];
      const id = idx[acc.trim().toLowerCase()];
      if (id != null && i + 1 >= words.length) return `[${m}](${url(lang, "item", id)})`;
    }
    // try prefixes (e.g. "Capital Capacitor Battery" inside a longer phrase)
    for (let len = words.length - 1; len >= 1; len -= 2) {
      const sub = words.slice(0, len).join("");
      const id = idx[sub.trim().toLowerCase()];
      if (id != null) return `[${sub}](${url(lang, "item", id)})` + words.slice(len).join("");
    }
    return m;
  }));

  return text;
}
