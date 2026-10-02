"""capsuleers.app articles (L3): listing, both languages, localised URLs.

Offline: the site's /api/articles response is faked.
    ingestion/.venv/bin/python -m pytest ingestion/tests/test_capsuleers_articles.py
"""

from __future__ import annotations

from capsuleers_ingestion.capsuleers_app import articles as A


def _page(elements, tot=1):
    return {"elements": elements, "totPages": tot, "totalElements": len(elements)}


ART = {
    "id": 7, "status": "published", "published_at": "2026-10-02T10:00:00Z",
    "updated_at": "2026-10-02T20:43:11Z", "author_name": "TremalJack", "tags": ["Pochven"],
    "titolo_eng": "Crimson Harvest 2026", "slug_eng": "crimson-harvest-2026",
    "content_eng": "<p>Intro.</p><h3>PvP changes</h3><p>90% loot drop outside highsec.</p>",
    "titolo_ita": "Crimson Harvest 2026 (IT)", "slug_ita": "crimson-harvest-2026-it",
    "content_ita": "<p>Introduzione.</p><h3>PvP</h3><p>Drop al 90% fuori dall'highsec.</p>",
}


def test_list_pages_and_skips_unpublished(monkeypatch):
    pages = {1: _page([ART, {**ART, "id": 8, "status": "pending"}], tot=2),
             2: _page([{**ART, "id": 9, "slug_eng": ""}], tot=2)}
    seen = []

    def fake(url):
        seen.append(url)
        return pages[int(url.split("page=")[1].split("&")[0])]
    monkeypatch.setattr(A, "http_json", fake)
    items = A.ArticlesProvider("https://example.test/").list()
    assert [i.key for i in items] == ["7"]                      # pending and slug-less dropped
    assert items[0].stamp == "2026-10-02T20:43:11Z"             # updated_at is the change signal
    assert len(seen) == 2 and seen[0].startswith("https://example.test/api/articles?")


def test_documents_both_languages_with_localised_urls():
    prov = A.ArticlesProvider("https://example.test")
    item = A.Item("7", "s", "x", ART)
    docs = prov.documents(item)
    en = [d for d in docs if d.metadata["lang"] == "en"]
    it = [d for d in docs if d.metadata["lang"] == "it"]
    assert en and it
    assert all(d.url == "https://example.test/articles/crimson-harvest-2026" for d in en)
    assert all(d.url == "https://example.test/it/articles/crimson-harvest-2026-it" for d in it)
    assert all(d.source == "capsuleers_articles" and d.type == "article" for d in docs)
    assert en[0].title.startswith("Crimson Harvest 2026 (2026-10-02)")   # dated like CCP news
    assert any("90% loot drop" in d.text for d in en)
    assert len({d.id for d in docs}) == len(docs)                         # EN/IT ids never collide


def test_untranslated_article_keeps_english():
    prov = A.ArticlesProvider("https://example.test")
    docs = prov.documents(A.Item("7", "s", "x", {**ART, "content_ita": None}))
    assert docs and {d.metadata["lang"] for d in docs} == {"en"}
