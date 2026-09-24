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
| **L1** — primary | CCP itself: documentation, Support, SDE, ESI, patch notes, developer posts | SDE (indexed), patch notes + dev blogs since 2019 (indexed, dated), ESI (live). *Not yet ingested: documentation, Support.* |
| **L2** — processed official data | tools that declare CCP/SDE/ESI provenance | EVE Ref (prices) |
| **L3** — structured community | EVE University, EVE Scout, Dotlan, Anoik.is, Ellatha, Fuzzwork, EVE-Kill, zKillboard, other specialised databases/tools | EVE University, Anoikis, EVE-Scout, eve-kill |
| **L4** — general community | prose wikis and guides without a structured data model | EVE Wiki + Sisters Probe Wiki (Fandom), eve-survival, Riley (opt-in), EVE Workbench fits |

Anoikis statics/effects are merged into the SDE `system` documents of J-space, so they ride at L1
there: the tier is per document, not per line.

## In use

| Source | What it provides | Type | Status |
|---|---|---|---|
| **CCP patch notes + dev blogs** (eveonline.com via Contentful CDA) | balance changes, features, fixes, design rationale — each dated | static, dated (© CCP) | ✅ indexed (since 2019, incremental daily) |
| **Official Fenris Creations SDE** (JSONL) | skills, items, ships, modules, dogma, universe, blueprints, lore, sites/anomalies | static | ✅ indexed |
| **EVE University Wiki** | guides, terminology, mechanics, missions, wormholes, exploration | static (CC BY-NC-SA 4.0) | ✅ indexed |
| **EVE Sister Core Scanner Probe Wiki** (Fandom, DE) | exploration sites: anomalies, signatures, relic & data sites | static (CC-BY-SA) | ✅ indexed |
| **EVE Wiki** (eve.fandom.com, EN) | general EVE encyclopedia | static (CC-BY-SA) | ✅ indexed |
| **Riley Entertainment** (static guides) | combat-site ship fits, COSMOS guides, hacking/relic/data loot stats | static (no explicit licence) | ⚠️ opt-in (`--riley`, never in `--all`) |
| **eve-survival.org** | PVE mission guides (Wikka wiki) | static (licence not stated) | ✅ indexed |
| **Anoikis** (anoikis.info) | system effects and wormhole statics (J-space) | semi-static | ✅ indexed |
| **EVE Ref** (data.everef.net) | global reference prices (adjusted/average) | live | ✅ on-demand lookup (`/price`) |
| **eve-kill** (eve-kill.com/api) | killboard: character/corp/alliance stats, recent kills/losses, battles, intel | live | ✅ on-demand (`intel.mjs`/`esi.mjs`) |
| **eve-kill analitiche** (eve-kill.com/api/mcp/tools) | pre-computed analytics: capsuleer dossier (archetypes/wingmates/playstyle), route danger, war report, flies-with/hunts-in/hunted-by/preys-on, find battles, meta/doctrine pulse, expensive losses, killmail story/forensics, entity overview/timeline/kills, ships-used, entity-top rankings (ship/system/region/kill-death dims), global/system pulse | live | ✅ on-demand (`mcp.mjs` + `mcp-intel.mjs`); no auth, 600 req/15m per IP condivise con il REST (RateLimit-* su ogni risposta). Excludes `me_*`, offline-answered `item/ship/system_info`, fitting tools |
| **EVE-Scout** (api.eve-scout.com) | Thera/Turnur wormhole connections (signatures, ship size, lifetime) | live | ✅ on-demand (`eve-scout.mjs`) |
| **ESI** (esi.evetech.net) | official: corp/alliance records (CEO, members, founding), per-area system activity (jumps/ship/NPC kills) | live | ✅ on-demand (`esi.mjs`) |

## Other recommended authoritative sources (to integrate if needed)

| Source | What it provides | When to integrate it | Type |
|---|---|---|---|
| **ESI** (esi.evetech.net) — official Fenris Creations API | **live regional market orders** and historical data, universe, sovereignty; with OAuth: character skills/assets/wallet | for real per-hub prices (Jita) and account-linked features (e.g. "which skills am I missing for X") | live |
| **Fuzzwork Market API** | aggregated buy/sell prices per region/hub (min/max/percentiles) | for "how much does it cost at Jita" without handling raw ESI orders | live |
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
