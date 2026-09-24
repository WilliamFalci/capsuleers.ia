// Source hierarchy — the ONE place that says how much each source is trusted.
//
//   L1  primary: CCP itself (SDE, ESI, documentation, Support, patch notes,
//       developer posts)
//   L2  official data re-processed by a tool that declares CCP/SDE/ESI
//       provenance (EVE Ref, eve-fit-engine)
//   L3  structured community sources (EVE University, EVE-Scout, Dotlan,
//       Anoikis, Ellatha, Fuzzwork, eve-kill, zKillboard, …)
//   L4  generic community prose (Fandom wikis, eve-survival, Riley,
//       EVE Workbench fits) — outside the three declared levels, kept as the
//       last resort instead of silently ranking alongside L3
//
// The tier is derived HERE, at query time, from `source` when the index carries
// it and otherwise from the URL host. Index releases published before `source`
// was exported only carry the URL — and every SDE chunk is the only one with
// url=null (verified on index-2026.09.23: 59 859 null, all SDE) — so the
// hierarchy works on the index users already have, without a re-download.
//
// Caveat on L1-by-null-URL: SDE `system` documents of J-space are enriched with
// Anoikis statics/effects (ingestion/sde/wormholes.py). Those lines are L3 data
// inside an L1 document; the tier is per document, not per line.

export const TIERS = {
  1: { it: "Fonte primaria CCP", en: "Primary CCP source" },
  2: { it: "Dati ufficiali elaborati", en: "Processed official data" },
  3: { it: "Community strutturata", en: "Structured community" },
  4: { it: "Community generica", en: "General community" },
};

// Ingestion `source` keys (Document.source) → [tier, short label]. Only keys the
// ingestion actually emits; a new source adds its row here.
const BY_SOURCE = {
  ccp_sde: [1, "CCP SDE"],
  ccp_patch_notes: [1, "CCP patch notes"],
  ccp_dev_blog: [1, "CCP dev blog"],
  ccp_support: [1, "CCP Support"],
  ccp_academy: [1, "EVE Academy"],
  ccp_devdocs: [1, "CCP developer docs"],
  eve_university_wiki: [3, "EVE University"],
  eve_fandom_wiki: [4, "EVE Wiki (Fandom)"],
  sisters_probe_wiki: [4, "Sisters Probe Wiki (Fandom)"],
  eve_survival: [4, "eve-survival.org"],
  riley_entertainment: [4, "Riley Entertainment"],
};

// URL host (suffix match) → [tier, short label]. First match wins, so the more
// specific hosts come first.
const BY_HOST = [
  ["developers.eveonline.com", 1, "CCP developers"],
  ["support.eveonline.com", 1, "CCP Support"],
  ["esi.evetech.net", 1, "ESI"],
  ["eveonline.com", 1, "CCP eveonline.com"],
  ["everef.net", 2, "EVE Ref"],
  ["wiki.eveuniversity.org", 3, "EVE University"],
  ["eve-scout.com", 3, "EVE-Scout"],
  ["dotlan.net", 3, "Dotlan"],
  ["anoik.is", 3, "Anoik.is"],
  ["anoikis.info", 3, "Anoikis"],
  ["ellatha.com", 3, "Ellatha"],
  ["fuzzwork.co.uk", 3, "Fuzzwork"],
  ["eve-kill.com", 3, "eve-kill"],
  ["zkillboard.com", 3, "zKillboard"],
  ["sistersprobe.fandom.com", 4, "Sisters Probe Wiki (Fandom)"],
  ["fandom.com", 4, "EVE Wiki (Fandom)"],
  ["eve-survival.org", 4, "eve-survival.org"],
  ["eveworkbench.com", 4, "EVE Workbench"],
  ["riley-entertainment.com", 4, "Riley Entertainment"],
];

function host(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

/** { tier, label, unknown? } for a retrieved chunk / cited source ({source?, url?}). */
export function tierOf({ source, url } = {}) {
  const s = source && BY_SOURCE[source];
  if (s) return { tier: s[0], label: s[1] };
  if (!url) return { tier: 1, label: "CCP SDE" };   // only SDE chunks lack a URL
  const h = host(url);
  // Older index releases carry no `source`: a news article is recognised by path.
  if ((h === "eveonline.com" || h.endsWith(".eveonline.com")) && /\/news\/view\//.test(url)) {
    return { tier: 1, label: "CCP news", dated: true };
  }
  if ((h === "eveonline.com" || h.endsWith(".eveonline.com")) && /\/eve-academy(\/|$)/.test(url)) {
    return { tier: 1, label: "EVE Academy" };
  }
  for (const [suffix, tier, label] of BY_HOST) {
    if (h === suffix || h.endsWith("." + suffix)) return { tier, label };
  }
  return { tier: 4, label: h || "?", unknown: true }; // unknown = lowest trust
}

// Retrieval nudge added to the cosine score. Deliberately small: it reorders
// near-ties (the same fact phrased by the SDE and by a Fandom page) without
// letting the 60k SDE records drown the guides on a mechanics question, where
// the wiki is simply the better match. Measured on 20 real questions against
// index-2026.09.23 (tools/verify-source-tiers.mjs): the score gap between the 1st
// and 12th hit has median 0.087, so the 0.03 L1-L4 span reorders the tail of
// top-12 (0.9 chunks replaced per question on average) and never the head.
export const TIER_BONUS = { 1: 0.015, 2: 0.008, 3: 0, 4: -0.015 };

// DATED sources — CCP patch notes and dev blogs — stay L1 in the tag and in the
// conflict rule, but get NO retrieval nudge. The nudge exists to favour what
// describes the game as it is NOW; a patch note describes a change as of its date
// and may have been superseded, and a dev blog can be a narrative (a battle
// report, a security-policy post). Measured on the index + 4 991 CCP chunks: with
// the L1 nudge, "How do I make ISK as a new player?" pulled 5 of 12 context blocks
// from one security-policy dev blog.
const DATED = new Set(["ccp_patch_notes", "ccp_dev_blog"]);

/** Retrieval nudge for a chunk ({source?, url?}). */
export function bonusOf(hit) {
  const t = tierOf(hit);
  if (DATED.has(hit?.source) || t.dated) return 0;
  return TIER_BONUS[t.tier] ?? 0;
}

/** Short context tag, e.g. "L1 · CCP SDE". */
export function tierTag(hit) {
  const { tier, label } = tierOf(hit);
  return `L${tier} · ${label}`;
}
