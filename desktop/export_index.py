"""Exports the vectors+metadata from Qdrant into the standalone app's index files.
(The vectors were already created with bge-m3 during ingestion -> fast reuse.)
"""
import json, struct, urllib.request, os

URL = "http://localhost:6333/collections/eve_knowledge/points/scroll"
os.makedirs("data", exist_ok=True)


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
with open("data/index.vec", "wb") as vec, open("data/index.meta.jsonl", "w", encoding="utf-8") as meta:
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
