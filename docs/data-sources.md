# Authoritative data sources for EVE Online

Architectural principle: **static data** (knowledge that rarely changes) →
indexed in the RAG; **live data** (prices, orders, killmails, activity) → fetched
**on-demand** by API tools (they don't go into the index because they change constantly).

## Source hierarchy

When two sources disagree, the lower level wins. Implemented in
[`desktop/src/source-tiers.mjs`](../desktop/src/source-tiers.mjs) (retrieval nudge, context tags,
prompt rule, cited-source chips).

| Level | Meaning | In use |
|---|---|---|
| **L1** — primary | CCP itself: documentation, Support, SDE, ESI, patch notes, developer posts | SDE, patch notes + dev blogs since 2019 (dated), CCP Support, EVE Academy, the guides of CCP's developer docs (all indexed); ESI (live) |
| **L2** — processed official data | tools that declare CCP/SDE/ESI provenance | EVE Ref (global reference prices), eve-fit-engine (fit analysis computed from the SDE, Pyfa parity) |
| **L3** — structured community | EVE University, EVE Scout, Dotlan, Anoik.is, Ellatha, Fuzzwork, EVE-Kill, zKillboard, other specialised databases/tools | EVE University, Anoikis, EVE-Scout, eve-kill, Fuzzwork (live Jita 4-4 order book) |
| **L4** — general community | prose wikis and guides without a structured data model | EVE Wiki + Sisters Probe Wiki (Fandom), eve-survival, Riley (opt-in), EVE Workbench fits |

Anoikis statics/effects are merged into the SDE `system` documents of J-space, so they ride at L1
there: the tier is per document, not per line.

**L3 sources recognised but deliberately NOT integrated** (their hosts are in the tier table, so a
link to them is labelled correctly if one ever appears):

- **zKillboard** — the same killmails eve-kill already serves, with richer analytics on eve-kill's
  side; a second killboard would be two numbers for the same fact. The Capsuleers site made the
  same choice.
- **Dotlan** — no public API; its jumps/kills/NPC counts are ESI's own, which `esi.mjs` already
  reads at L1. Scraping it would mean fetching L1 data second-hand at L3.
- **Ellatha** — its core (LP store offers) is on ESI at L1 (`/loyalty/stores/{corp}/offers`); if LP
  questions become a need, that is the route, not the mirror.
- **Anoik.is** — the J-space data we index comes from Anoikis (`anoikis.info`, same community dataset);
  both are L3.

## In use

| Source | What it provides | Type | Status |
|---|---|---|---|
| **CCP patch notes + dev blogs** (eveonline.com via Contentful CDA) | balance changes, features, fixes, design rationale — each dated | static, dated (© CCP) | ✅ indexed (since 2019, incremental daily) |
| **CCP Support** (support.eveonline.com, Zendesk API) | official rules: Crimewatch, asset safety, downtime, structures, sov, EULA/ToS, client | static (© CCP) | ✅ indexed (incremental daily) |
| **EVE Academy** (eveonline.com/eve-academy, Contentful) | CCP's player guides: combat mechanics, careers, ship primers, industry | static (© CCP) | ✅ indexed (incremental daily) |
| **CCP developer docs — guides** (github.com/esi/esi-docs `docs/guides`) | formulae (warp-in points), security rounding/classes, route calculation, fitting formats, PI, SKINR | static (© CCP) | ✅ indexed (incremental daily) |
| **Official Fenris Creations SDE** (JSONL) | skills, items, ships, modules, dogma, universe, blueprints, lore, sites/anomalies | static | ✅ indexed |
| **EVE University Wiki** | guides, terminology, mechanics, missions, wormholes, exploration | static (CC BY-NC-SA 4.0) | ✅ indexed |
| **EVE Sister Core Scanner Probe Wiki** (Fandom, DE) | exploration sites: anomalies, signatures, relic & data sites | static (CC-BY-SA) | ✅ indexed |
| **EVE Wiki** (eve.fandom.com, EN) | general EVE encyclopedia | static (CC-BY-SA) | ✅ indexed |
| **Riley Entertainment** (static guides) | combat-site ship fits, COSMOS guides, hacking/relic/data loot stats | static (no explicit licence) | ⚠️ opt-in (`--riley`, never in `--all`) |
| **eve-survival.org** | PVE mission guides (Wikka wiki) | static (licence not stated) | ✅ indexed |
| **Anoikis** (anoikis.info) | system effects and wormhole statics (J-space) | semi-static | ✅ indexed |
| **EVE Ref** (data.everef.net) | global reference prices (adjusted/average) | live | ✅ on-demand lookup (`/price`) |
| **Fuzzwork** (market.fuzzwork.co.uk) | live Jita 4-4 order book: best sell / best buy + volume (aggregated from ESI) | live | ✅ on-demand, next to EVE Ref on price questions (5-min cache, the server's own expiry) |
| **eve-kill** (eve-kill.com/api) | killboard: character/corp/alliance stats, recent kills/losses, battles, intel | live | ✅ on-demand (`intel.mjs`/`esi.mjs`) |
| **eve-kill analitiche** (eve-kill.com/api/mcp/tools) | pre-computed analytics: capsuleer dossier (archetypes/wingmates/playstyle), route danger, war report, flies-with/hunts-in/hunted-by/preys-on, find battles, meta/doctrine pulse, expensive losses, killmail story/forensics, entity overview/timeline/kills, ships-used, entity-top rankings (ship/system/region/kill-death dims), global/system pulse | live | ✅ on-demand (`mcp.mjs` + `mcp-intel.mjs`); no auth, 600 req/15m per IP condivise con il REST (RateLimit-* su ogni risposta). Excludes `me_*`, offline-answered `item/ship/system_info`, fitting tools |
| **EVE-Scout** (api.eve-scout.com) | Thera/Turnur wormhole connections (signatures, ship size, lifetime) | live | ✅ on-demand (`eve-scout.mjs`) |
| **ESI** (esi.evetech.net) | official: corp/alliance records (CEO, members, founding), per-area system activity (jumps/ship/NPC kills) | live | ✅ on-demand (`esi.mjs`) |

## Other recommended authoritative sources (to integrate if needed)

| Source | What it provides | When to integrate it | Type |
|---|---|---|---|
| **ESI** (esi.evetech.net) — official Fenris Creations API | **live regional market orders** and historical data, universe, sovereignty; with OAuth: character skills/assets/wallet | for real per-hub prices (Jita) and account-linked features (e.g. "which skills am I missing for X") | live |
| **zKillboard** (zkillboard.com) | killmails: ships lost, **fits actually used**, PvP statistics | for advice on "meta" fits and what people fly | live |
| **Adam4EVE** (adam4eve.eu) | market, industry, mineral indices, economy, PCU | economic/industrial analysis | live |
| **Dotlan EVEMaps** (evemaps.dotlan.net) | maps, jumps/kills/NPCs per system, sovereignty | route and per-system activity data | mixed |
| **Fenris Creations Image Server** (images.evetech.net) | item/ship icons and renders | to enrich the site UI | static |
| **EVE Workbench / EVE Marketer** | community fits, market prices | alternative fits and price comparison | mixed |

## Recommendations by domain

- **Precise per-hub prices (Jita/Amarr)** → add **ESI** market or **Fuzzwork** (the current EVE Ref prices are global reference values, great as an estimate but not the actual selling price at Jita).
- **Recommended / meta fits** → **zKillboard** (fits actually used) as an on-demand tool.
- **Wormhole effect magnitudes per class (C1–C6)** → the wiki contains them; for exact structured data you could extract from the SDE dogma or from Anoikis if exposed.
- **Account-linked features** (player skills/assets) → require **ESI with OAuth** and therefore a login on the site.

## Note
All live sources should be used as **tools** invoked at question time
(with a short TTL cache), never indexed: this guarantees always-fresh data and a
stable RAG index.
