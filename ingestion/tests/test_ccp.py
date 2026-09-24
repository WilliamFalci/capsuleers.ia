"""CCP sources (L1): block conversion, sectioning, and the incremental update.

Offline: a fake provider and a fake Qdrant stand in for the network.
    ingestion/.venv/bin/python -m pytest ingestion/tests/test_ccp.py
"""

from __future__ import annotations

import json
import sys
import types

from capsuleers_ingestion.ccp.common import (
    Item, Provider, html_blocks, markdown_blocks, sectioned_documents)
from capsuleers_ingestion.models import Document


def test_quoted_heading_is_a_line_not_a_section():
    # "> ## Developer Comment:" promoted to h2 replaced the real path on every
    # section after it (patch notes 19.11).
    md = "## Ship Balance\n> ## Developer Comment:\n> We are rebalancing.\n### Procurer\n- Mass 20,000,000 kg"
    blocks = list(markdown_blocks(md))
    assert ("h", 2, "Ship Balance") in blocks
    assert ("p", 0, "Developer Comment:") in blocks
    assert not any(b[0] == "h" and "Developer" in b[2] for b in blocks)
    docs = sectioned_documents("x", "Patch Notes 19.11 (2021-12-08)", blocks, dtype="t",
                               source="s", url="u", metadata={})
    # Short sections merge into the group they follow, which is titled where it
    # STARTS: the path is "… › Ship Balance", never "… › Developer Comment".
    assert all("Developer" not in d.title for d in docs)
    assert any(d.title.endswith("Ship Balance") and "Procurer" in d.text for d in docs)


def test_mkdocs_directives_and_code_are_dropped():
    md = '# Title\n--8<-- "snippets/x.md"\n```python\nprint(1)\n```\nReal text.'
    assert [b[2] for b in markdown_blocks(md) if b[0] == "p"] == ["Real text."]


def test_html_blocks_headings_lists_tables():
    blocks = html_blocks("<h2>Rules</h2><p>Intro</p><ul><li>one</li><li>two</li></ul>"
                         "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>"
                         "<script>x()</script>")
    assert blocks == [("h", 2, "Rules"), ("p", 0, "Intro"), ("p", 0, "- one"), ("p", 0, "- two"),
                      ("p", 0, "A | B"), ("p", 0, "1 | 2")]


def test_sections_are_small_and_titled_without_repeats():
    blocks = [("h", 2, "Heron")] + [("p", 0, "x" * 90) for _ in range(20)]
    docs = sectioned_documents("id", "EVE Academy › Heron", blocks, dtype="t", source="s",
                               url="u", metadata={})
    assert len(docs) > 1 and all(len(d.text) < 900 for d in docs)
    assert all(d.title == "EVE Academy › Heron" for d in docs)       # no "› Heron › Heron"
    assert [d.id for d in docs] == [f"id:{i}" for i in range(len(docs))]


class FakeProvider(Provider):
    name = "fake"

    def __init__(self, items):
        self.items = items

    def list(self):
        return self.items

    def documents(self, item):
        n = int(item.data.get("n", 1))
        return [Document(id=f"fake:{item.key}:{i}", type="t", title=item.key, text=f"{item.key} {i}",
                         source="ccp_support", metadata={}) for i in range(n)]


def test_incremental_update(monkeypatch, tmp_path):
    import capsuleers_ingestion.ccp_update as U
    calls = {"del": [], "idx": []}
    fake_index = types.ModuleType("capsuleers_ingestion.index")
    fake_index.get_client = lambda: "C"
    fake_index.resolve_collection = lambda c, n: "coll"
    fake_index.delete_by_doc_ids = lambda c, ids, collection=None: calls["del"].append(sorted(ids))
    fake_index.index_chunks = lambda c, ch, collection=None, cache=None: calls["idx"].append(len(list(ch))) or 1
    fake_cache = types.ModuleType("capsuleers_ingestion.embedcache")
    fake_cache.EmbedCache = type("EC", (), {"__init__": lambda s, p: None, "close": lambda s: None})
    monkeypatch.setitem(sys.modules, "capsuleers_ingestion.index", fake_index)
    monkeypatch.setitem(sys.modules, "capsuleers_ingestion.embedcache", fake_cache)
    monkeypatch.setattr(U, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr("capsuleers_ingestion.ccp.common.DELAY_SECONDS", 0)
    prov = FakeProvider([Item("a", "1", "a", {"n": 3}), Item("b", "1", "b", {"n": 1})])
    monkeypatch.setattr(U, "providers", lambda only=None: [prov])
    fetch = prov.fetch
    monkeypatch.setattr(prov, "fetch", lambda items, delay=0: fetch(items, delay=0))

    U.run_update()
    assert calls["del"] == [] and len(calls["idx"]) == 2

    # "a" shrank from 3 to 1 Documents, "b" disappeared upstream.
    prov.items = [Item("a", "2", "a", {"n": 1})]
    calls.update({"del": [], "idx": []})
    U.run_update()
    assert ["fake:b:0"] in calls["del"]                                   # removed item purged
    assert ["fake:a:0", "fake:a:1", "fake:a:2"] in calls["del"]          # old ids, not new ones
    state = json.loads((tmp_path / "state.json").read_text())["providers"]["fake"]
    assert state == {"a": {"stamp": "2", "doc_ids": ["fake:a:0"]}}

    calls.update({"del": [], "idx": []})
    U.run_update()
    assert calls == {"del": [], "idx": []}
    assert U.check(None, False) is False
