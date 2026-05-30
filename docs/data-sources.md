# Authoritative data sources for EVE Online

Architectural principle: **static data** (knowledge that rarely changes) →
indexed in the RAG; **live data** (prices, orders, killmails, activity) → fetched
**on-demand** by API tools (they don't go into the index because they change constantly).

## In use

| Source | What it provides | Type | Status |
|---|---|---|---|
| **Official Fenris Creations SDE** (JSONL) | skills, items, ships, modules, dogma, universe, blueprints, lore, sites/anomalies | static | ✅ indexed |
| **EVE University Wiki** | guides, terminology, mechanics, missions, wormholes, exploration | static (CC-BY-SA) | ✅ indexed |
| **Anoikis** (anoikis.info) | system effects and wormhole statics (J-space) | semi-static | ✅ indexed |
| **EVE Ref** (data.everef.net) | global reference prices (adjusted/average) | live | ✅ on-demand lookup (`/price`) |

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
