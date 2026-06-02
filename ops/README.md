# Capsuleers.IA — Operations: SDE auto-update

Fenris Creations releases new SDEs periodically (expansions, balance passes). This job
checks **every day** whether the SDE has changed and, if so, rebuilds the index
**with no downtime**.

## How it works

1. **Change detection** — downloads only `latest.jsonl` from the official Fenris Creations SDE
   (a few bytes) and compares the **build number** with the one saved in
   `ingestion/data/sde_version.json`. If equal → it does nothing.
2. **Rebuild** — if different: it downloads/extracts the new SDE, regenerates the Documents and
   indexes them into a **new versioned collection** (`eve_knowledge_<md5>`).
   Unchanged embeddings are reused from the **cache** (`embed_cache.sqlite`),
   so an update only touches the few documents that actually changed → fast.
3. **Atomic swap** — the Qdrant alias `eve_knowledge` (queried by the API) is
   moved to the new collection; the old versions are deleted.
   The API doesn't notice anything (zero-downtime).

## Manual commands

```bash
cd ingestion
python -m capsuleers_ingestion.update --check   # check only (exit 1 = update available)
python -m capsuleers_ingestion.update           # update if changed
python -m capsuleers_ingestion.update --force    # rebuild anyway
```

## Scheduling with systemd (user)

```bash
mkdir -p ~/.config/systemd/user
cp ops/capsuleers-sde-update.service ~/.config/systemd/user/
cp ops/capsuleers-sde-update.timer   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now capsuleers-sde-update.timer
# To survive logout (useful on a server):
loginctl enable-linger "$USER"

systemctl --user list-timers | grep capsuleers   # next run
journalctl --user -u capsuleers-sde-update.service -f   # logs
```

> The `.service` assumes the repo is at `~/Documenti/WORK/Capsuleers.IA`. Edit
> `ExecStart` if it's elsewhere. The Python dependencies must be available
> (a venv in `ingestion/.venv` is recommended, automatically detected by `update.sh`).

## Alternative: cron

```cron
# m h  dom mon dow  command
0 11 * * *  /path/Capsuleers.IA/ops/update.sh >> ~/capsuleers-sde-update.log 2>&1
```

## Notes

- The first full run (~59k chunks) takes ~45 min of embedding on CPU; subsequent
  runs are much faster thanks to the cache.
- The EVE University Wiki has its own incremental daily job — see below.

## EVE University wiki auto-update

The wiki has its own daily job, analogous to the SDE one but **incremental**.

1. **Change detection** — queries the MediaWiki `recentchanges` API (the structured
   equivalent of `Special:RecentChanges`) for ns0 edits/new pages + delete/move logs
   since the timestamp saved in `ingestion/data/wiki_state.json`. Skips bot edits.
2. **Incremental re-index** — re-scrapes ONLY the changed titles, removes their old
   chunks (delete-by `doc_id`) and re-inserts the current content **in place** on the
   live collection (SDE + missions untouched). Embeds only the changed pages; the
   embed cache dedupes the rest → seconds, not the ~45 min of a full rebuild.

```bash
cd ingestion
python -m capsuleers_ingestion.wiki_update --check   # how many pages changed (exit 1 = changes)
python -m capsuleers_ingestion.wiki_update           # apply the incremental update
python -m capsuleers_ingestion.wiki_update --force    # ignore saved state, re-scan last 7 days
```

Schedule it like the SDE timer (runs 11:30, offset from the SDE's 11:00):

```bash
cp ops/capsuleers-wiki-update.service ~/.config/systemd/user/
cp ops/capsuleers-wiki-update.timer   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now capsuleers-wiki-update.timer
```

> A full wiki rebuild (the source of truth) is still `run --wiki --dump …` →
> `run --from-dump`; `wiki_update` only keeps the index fresh between rebuilds.

## Publishing the desktop index (reaching end-users)

The SDE/wiki jobs above refresh the **server** Qdrant collection. The desktop app
ships a **flat file index** (`index.vec` + meta + names) hosted on the GitHub release
`index-<date>`. `ops/publish-index.sh` closes the loop:

```bash
ops/publish-index.sh        # export flat index from Qdrant → gh release index-<date> → bump manifest
```

It exports the current Qdrant collection, recomputes sizes/sha256, bumps
`desktop/src/assets-manifest.json` (`index.version`/`baseUrl`/`files`) and pushes it.
**Desktop apps fetch that manifest at launch** (`assets.mjs` `INDEX_MANIFEST_URL`) and
auto-download the new index when the version changes (offering a restart). Requires an
authenticated `gh`. Because the vector file is ~290 MB, run this on a **slow cadence**
(e.g. weekly, or only when the wiki/SDE jobs reported changes) — not per edit.
