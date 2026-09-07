"""Exports the vectors+metadata from Qdrant into the standalone app's index files.
(The vectors were already created with bge-m3 during ingestion -> fast reuse.)
"""
import json, struct, urllib.request, os

# Qdrant non sta sempre su localhost. Sulla postazione che ha sempre fatto
# l'ingestione si', ma li' `localhost` risolve a ::1 mentre podman rootless
# espone solo IPv4 — e nel cluster Qdrant e' un Service, non un processo locale.
# Con l'indirizzo scritto in duro il primo caso obbligava a tenere una COPIA
# modificata di questo file (fuori dal versionamento, quindi divergente) e il
# secondo non poteva esportare affatto. Il default lascia invariata ogni
# invocazione locale esistente.
QDRANT_URL = os.environ.get("QDRANT_URL", "http://localhost:6333").rstrip("/")
COLLECTION = os.environ.get("QDRANT_COLLECTION", "eve_knowledge")
OUT_DIR = os.environ.get("EXPORT_OUT_DIR", "data")

URL = f"{QDRANT_URL}/collections/{COLLECTION}/points/scroll"
os.makedirs(OUT_DIR, exist_ok=True)


def scroll(offset):
    body = {"limit": 2000, "with_vector": True,
            "with_payload": ["text", "title", "type", "url"]}
    if offset is not None:
        body["offset"] = offset
    req = urllib.request.Request(URL, data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)["result"]


n, off = 0, None
with open(os.path.join(OUT_DIR, "index.vec"), "wb") as vec, \
        open(os.path.join(OUT_DIR, "index.meta.jsonl"), "w", encoding="utf-8") as meta:
    while True:
        res = scroll(off)
        pts = res.get("points", [])
        if not pts:
            break
        for p in pts:
            v = p.get("vector")
            if not isinstance(v, list):
                continue
            vec.write(struct.pack(f"<{len(v)}f", *v))
            pl = p.get("payload", {})
            meta.write(json.dumps({"id": str(p["id"]), "text": pl.get("text", ""),
                                   "title": pl.get("title"), "type": pl.get("type"),
                                   "url": pl.get("url")}, ensure_ascii=False) + "\n")
            n += 1
        off = res.get("next_page_offset")
        if off is None:
            break
        if n % 10000 == 0:
            print(n, "esportati")
print("TOTALE esportati:", n)
