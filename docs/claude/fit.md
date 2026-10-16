# Analisi fit (delegata a `eve-fit-engine`)

Leggi se tocchi `desktop/src/fit.mjs`, il flusso doctrine specs o il packaging dell'SDE.

[`desktop/src/fit.mjs`](../../desktop/src/fit.mjs) computes fit stats by delegating **all** the math to
the [`eve-fit-engine`](https://www.npmjs.com/package/eve-fit-engine) npm package (the same
Pyfa-parity engine extracted from capsuleers.website; suite di parità attuale in `capsuleers.fitting-engine/docs/claude/parity.md`). The engine
ships its **own version-pinned SDE bundle**, so the numbers are **authoritative, offline and
Pyfa-parity**; nothing is sent to a server.

What `fit.mjs` still owns:
- `looksLikeFit(text)` — detect a pasted EFT block (first line `[Ship, Name]`).
- `parseEft(text)` — extract ship + module/charge **names verbatim** (for the price lookup and the
  module listing shown to the LLM; the engine's `Fit` carries only typeIDs).
- `describeFit(fit, eftText)` — re-parse the raw EFT through the engine and render the computed
  `DerivedStats` into the Italian context block (fitting resources, slots/hardpoints, DPS with
  weapon/drone/fighter split + alpha + sustained, weapon ranges, EHP + per-layer resistances,
  active/passive tank, cap stability, navigation, targeting).
- `describeDoctrineFit(eft)` — doctrine-fit variant used by the **doctrine specs** flow (see the
  MCP section). Same authoritative tank/cap/nav/targeting block, but contrasts the offense at the
  **highest-damage** vs the **longest-range** ammo (the "max/min" damage spread the user asked for).
  Killmail loss fits usually have no ammo, so `pickAmmoExtremes()` injects the two extreme charges:
  exact charge-size match; turret long-range = lowest-damage ammo; **missile long-range = genuinely
  longest flight range** (`maxVelocity × flightTime`, ranked on base attrs since the ship/skill/rig
  multipliers preserve the ordering). Missile flight range is surfaced via the engine's
  `offense.missileRange` (added in eve-fit-engine 0.1.4).
- `warmFitEngine()` — called once from `engine.init()` to preload the ~8 MB bundled SDE so the
  first pasted fit doesn't stall. Fire-and-forget; loads lazily on demand if it didn't run.

Imports from `eve-fit-engine/node`: `loadBundledDataset`, `buildAllVSkillProfile`, `computeFit`,
`parseEft`, `defaultStateForModule`, `moduleAcceptsChargeType`, `isTurretWeapon`, `isMissileLauncher`.

### Fit traps

- **`eve-fit-engine/data/**` MUST be `asarUnpack`'d** ([`desktop/electron-builder.yml`](../../desktop/electron-builder.yml)) —
  the package's `/node` loader reads its bundled SDE (`manifest.json` + `v<hash>/*.json`) from disk
  via `fs`, which fails inside `app.asar`.
- **Promote modules to their natural state on import** — `defaultStateForModule(type, dataset.effects)`,
  exactly as the editor does on EFT import. Otherwise weapons/props sit `ONLINE` and contribute 0 DPS.
- **Drones must be launched explicitly** — EFT lists the drone *bay*; the engine's OFFENSE only counts
  drones with `countActive > 0`. `launchDrones()` deploys greedily in EFT order, capped by ship drone
  bandwidth + the All-V 5-drone limit, and sets `countActive` so headline DPS matches Pyfa.
- **Removed in the eve-fit-engine migration** (don't reintroduce): the old custom All-V estimator,
  the Python `sde/fitlookup.py` → `fit_lookup.json` artifact, and the opt-in `precise`/`preciso`/`dogma`
  keyword that ran a remote eve-kill `dogma_eval`. Stats are now always authoritative + offline.
  `dogmaEval()` still exists in [`mcp-intel.mjs`](../../desktop/src/mcp-intel.mjs) but is no longer wired into
  `ask()`.
