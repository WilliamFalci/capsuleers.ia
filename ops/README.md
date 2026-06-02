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
- The EVE University Wiki has its own cadence: to update it, rerun the
  crawl (`run --wiki --dump ...`) and then `run --from-dump`. A similar
  timer can be added if needed.
