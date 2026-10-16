# Moduli live-data, main process, auto-update

Leggi se tocchi i moduli di `desktop/src/` che chiamano servizi esterni (prices, capsuleers-api, intel, esi, eve-scout, eveworkbench, mcp), `clipboard-watch.mjs`, `main.mjs`, `assets.mjs` o lo User-Agent. Contratto API v1 condiviso con intel: `../docs/claude/cross-repo.md` della cartella CAPSULEERS.

### Live-data feature modules (`desktop/src/`)

- [`prices.mjs`](../../desktop/src/prices.mjs) — EVE Ref reference prices (`priceByName`, `isKnownType`).
- [`capsuleers-api.mjs`](../../desktop/src/capsuleers-api.mjs) — **capsuleers.app is the killboard/intel
  backend**, through the site's **public API v1** (`/api/v1/…`, contract in the site's
  `shared/api-v1.ts`: stable paths and shapes, rate-limited per IP and class, 404 "no such entity" kept
  apart from 503 "upstream unwell"). This is the only file that knows the routes. **Deploy order does not
  matter**: every v1 response carries `X-Capsuleers-Api`, and a response without it means the site in
  production predates v1 — the call is retried on the legacy route serving the same data and the verdict
  is remembered (`apiFamily()`). Every call returns `null` on any failure and the caller falls back to
  eve-kill direct, so a site outage degrades to the old behaviour. Measured: a 62-name Local takes **0.9-1.7 s via the site vs 30 s via eve-kill**
  (one scan request instead of ~3 per pilot). `node desktop/tools/verify-intel-backend.mjs` checks both
  paths live (`CAPSULEERS_SITE=http://127.0.0.1:9 … --fallback` for the eve-kill one).
- [`intel.mjs`](../../desktop/src/intel.mjs) — pilot/corp/alliance intel. Names → ids via **ESI
  `/universe/ids`** (L1, exact, every matching category = the disambiguation), with eve-kill search
  merged in for ticker-like queries (≤5 chars, no space: "CONDI" is a pilot's name AND an alliance
  ticker, and ESI cannot search tickers) and as the fallback for partial names. Pilot: lifetime totals
  from the site's `profile` (eve-kill behind the site's cache) + 90-day intel from its archive; the pilot
  card is built from those (no `capsuleer_dossier` call; that MCP tool is only the fallback). Corp /
  alliance: site `stats/alltime`; kills/losses: site `killboard/search`; battles: site entity panels.
  **The two windows are labelled on every line** ("Totali DI SEMPRE", "ultimi 90 giorni"): unlabelled,
  the model presented 6 224 lifetime kills as 90-day activity.
  The clipboard-scan paths: `localIntel()` (ESI ids + ONE site scan + ESI bulk affiliations; the
  numbers are the last **90 days**, `window: 90` on the row, "90g" in the UI; the danger thresholds are
  therefore 30/150 kills, not the lifetime 100/500 — measured on 30 real pilots, 20 of 30 same class, the
  rest being idle veterans a Local should NOT flag; the scan's `efficiency` is a kill/loss COUNT ratio,
  never shown as ISK efficiency),
  `analyzeDScan()` (offline D-Scan composition via the bundled `eve-fit-engine` SDE —
  `dataset.getType`→`groups`→`categories`; the SDE only bundles **fittable** types so
  celestials/deployables fall into "Others", but ship classes resolve perfectly + the
  system is inferred from celestial names), and the share helpers `sharePilotIntel()` /
  `shareDScan()` that POST to capsuleers.app (`/api/pilot-intel/shares/from-scan`,
  `/api/scans/from-dscan`) and return a 24h link.
- [`intel-history.mjs`](../../desktop/src/intel-history.mjs) — disk-persisted history of generated
  share links (`{userData}/intel-share-history.json`), `kind: 'intel'|'dscan'`, pruned past
  the 24h expiry on read. Surfaced in the header "Storico" modal with a live countdown.
- [`esi.mjs`](../../desktop/src/esi.mjs) — official ESI (corp summary, character affiliation, system activity).
- [`eve-scout.mjs`](../../desktop/src/eve-scout.mjs) — Thera/Turnur wormhole connections.
- [`eveworkbench.mjs`](../../desktop/src/eveworkbench.mjs) — EVE Workbench community-fit **search by need**
  ("voglio un fit PvP per la Vagabond"). `maybeWorkbench()` is a stateful two-step intent (NOT MCP;
  the engine runs it only when no MCP intent fired, folding the result into `mcp`): a SEARCH
  (`POST /Fit/PostSearchFits`) returns a `fitlist` card + remembers the results in module-scope
  `lastFitSearch`; a follow-up ("specifiche del #2") resolves a fit, pulls its full EFT via
  `GET /Fit/GetById` (`detailToEft` rebuilds slots + drones), and computes Pyfa-parity stats with
  `describeDoctrineFit` (`theory:true` + the EFT block). Headless (UA + origin only, no auth). A fit
  search and a doctrine search cross-clear each other (`resetFitMemory`/`resetDoctrineMemory`) so the
  "specs #N" follow-up always targets the most recent context.
- [`mcp.mjs`](../../desktop/src/mcp.mjs) + [`mcp-intel.mjs`](../../desktop/src/mcp-intel.mjs) — eve-kill **MCP**
  analytics (dossier, flies-with/hunts/preys/hunted, safe routes, battles, meta/doctrines, killmail
  forensics, entity overview/timeline/kills, ships-used, entity-top rankings, global/system pulse).
  Deliberately NOT wired: `me_*` (no pilot context), `item/ship/system_info` (answered offline),
  fitting (`dogma_eval`/`fit_compare`/`ship_compare`), `kills_with`≈`flies_with`, `compare`≈`war_report`.
  - **Doctrine specs (two-turn flow).** A `doctrine_detect` answer ("which doctrines does corp/alliance
    X use") caches its clusters in module-scope `lastDoctrine` (`{ entity, clusters[] }`). A follow-up
    like *"specifiche della Muninn"* / *"il fitting della Muninn"* / *"specs #2"* / *"a quanto spara la
    Crusader"* resolves the
    cluster (by ordinal or ship name via `resolveCluster`), pulls its example killmail's EFT
    (`killmail_fitting` `format:"eft"`), and computes the fit stats locally via `describeDoctrineFit`
    (max/min damage). The returned block carries `theory:true`, which triggers a theorycrafting
    directive in [`engine.mjs`](../../desktop/src/engine.mjs). `resetConversation()` clears `lastDoctrine`
    via the exported `resetDoctrineMemory()`. The specs intent (#5-bis) is gated on `lastDoctrine`
    and must precede the doctrine-list intent (#5).
- [`clipboard-watch.mjs`](../../desktop/src/clipboard-watch.mjs) — opt-in clipboard watcher.
  `detectClipboard()` discriminates a **Local roster** (`isLocalList`) from a **D-Scan**
  (`isDScan` — ≥4 tab cols, numeric typeID col0, distance-like last col), returning a
  discriminated `{ kind: 'local'|'dscan', … }` payload. Ignores content already present
  when enabled (so re-copying the same scan is a no-op). **Reads via `wl-paste` on Wayland**
  (`readClipboardText()`, gated on `process.platform === 'linux' && WAYLAND_DISPLAY`): Electron's
  `clipboard.readText()` only returns fresh content while the window is focused on Wayland, so a
  scan copied with the app in the background would go unseen — `wl-paste -n` (wl-clipboard, via
  `execFileSync`) reads through the data-control protocol regardless of focus. Falls back to
  `clipboard.readText()` everywhere else, and permanently after a `wl-paste` `ENOENT` (wl-clipboard
  not installed).
- [`links.mjs`](../../desktop/src/links.mjs) — `linkify` + `detectLang`.

**Outbound User-Agent** — every external request (in both halves) must identify the app via a single
constant. JS: [`desktop/src/user-agent.mjs`](../../desktop/src/user-agent.mjs) exports `USER_AGENT`
(version read from `package.json` via `createRequire`); Python: `USER_AGENT` in
[`config.py`](../../ingestion/capsuleers_ingestion/config.py). Both render
`Capsuleers.IA/<version> (+https://capsuleers.app; info@capsuleers.app)` (CCP `App/version (+url; contact)`
format). Don't hardcode a UA string at a call site — import the constant; change contact/version in those
two files only.
- [`main.mjs`](../../desktop/src/main.mjs) — Electron main process, tray/mini window, electron-updater
  auto-update, `refreshDataFiles()` (re-downloads index/data files whose size no longer matches
  the effective manifest) + `checkIndexUpdateInBackground()` (post-boot: if a newer **compatible**
  RAG index is published, downloads it + offers a restart). `setupInfo()` returns a `dataOnly` flag
  (a catalog chat model is already installed and only the base assets — index/embedding — are
  missing): the renderer's `#setup` overlay then switches to a **data-update** presentation (distinct
  title/intro, no model picker, size shown in MB, "Aggiorna e avvia") instead of the full first-run
  model picker. Same download/cancel/resume machinery for both modes. Also hosts the **RAG index
  panel** handlers (`rag:info` / `rag:redownload` / `rag:redownload-cancel` + `app:relaunch`): the
  toolbar **RAG** button opens a panel showing the installed index version / embedder / dim / total
  size / per-file list, flags when a newer **compatible** index is published, and offers a **forced
  full re-download** with live progress + cancel followed by a "restart to apply". The forced path
  uses `downloadFile`'s `force` flag — bypasses the idempotent size-match skip while keeping the old
  file until the new one is verified and atomically renamed over it, so a cancel never breaks a
  working index; the handlers resolve the data dir via the engine (`assetPaths`) so it works in BOTH
  dev and packaged builds. `data:wipe-all` clears all downloaded models + RAG index + caches.
  **Both `models:catalog` and `models:download` resolve `modelsDir` via `assetPaths()`** (not the
  `assetDirs` guard) so the model catalog + on-demand downloads work in dev too, not only packaged.
- **RAG index auto-update**: [`assets.mjs`](../../desktop/src/assets.mjs) fetches the index manifest at
  runtime (`INDEX_MANIFEST_URL`, raw `assets-manifest.json` on `main`) like the model catalog. A
  newer `index.version` with matching `embedModel`/`dim` is downloaded + persisted to
  `dataDir/index-manifest.json` (the new baseline; bundled manifest is the offline floor). The
  server side that republishes the index is [`ops/publish-index.sh`](../../ops/publish-index.sh); the
  daily wiki/SDE jobs keep Qdrant fresh. See [`RELEASING.md`](../../RELEASING.md).
