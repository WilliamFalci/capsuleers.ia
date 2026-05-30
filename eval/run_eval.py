"""End-to-end evaluation harness: queries the API and measures the answers.

For each question in the golden set it sends a POST /ask request, collects the
streamed (SSE) response, and checks that it contains the expected facts.

Requires the API to be running (and therefore Qdrant + Ollama + a populated index).
Stdlib only.

    python eval/run_eval.py                          # substring match
    python eval/run_eval.py --judge                  # semantic grading via LLM
    python eval/run_eval.py --api http://host:3000
"""

from __future__ import annotations

import argparse
import json
import urllib.request
from collections import defaultdict
from pathlib import Path


def ask(api: str, message: str) -> tuple[str, list]:
    """Sends the question to the API and reconstructs answer + sources from the SSE stream."""
    req = urllib.request.Request(
        f"{api}/ask",
        data=json.dumps({"message": message}).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    answer, sources = [], []
    with urllib.request.urlopen(req, timeout=180) as resp:
        event = None
        for raw in resp:
            line = raw.decode("utf-8").rstrip("\n")
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                payload = line[5:].strip()
                if event == "token":
                    answer.append(json.loads(payload).get("text", ""))
                elif event == "sources":
                    sources = json.loads(payload)
    return "".join(answer), sources


def judge(api: str, ollama: str, model: str, question: str, answer: str, expect: list[str]) -> bool:
    """Semantic grading: asks an LLM whether the answer is correct. Best-effort."""
    prompt = (
        f"Domanda: {question}\nFatti attesi: {', '.join(expect)}\n"
        f"Risposta del sistema: {answer}\n\n"
        "La risposta è corretta e copre i fatti attesi? Rispondi solo SI o NO."
    )
    req = urllib.request.Request(
        f"{ollama}/api/chat",
        data=json.dumps({"model": model, "stream": False,
                         "messages": [{"role": "user", "content": prompt}]}).encode("utf-8"),
        headers={"content-type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        out = json.loads(resp.read())["message"]["content"].strip().lower()
    return out.startswith("si") or out.startswith("sì") or out.startswith("yes")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=str(Path(__file__).with_name("dataset.jsonl")))
    ap.add_argument("--api", default="http://localhost:3000")
    ap.add_argument("--judge", action="store_true", help="voto semantico via LLM")
    ap.add_argument("--ollama", default="http://localhost:11434")
    ap.add_argument("--model", default="qwen2.5:7b-instruct")
    args = ap.parse_args()

    tests = [json.loads(l) for l in open(args.dataset, encoding="utf-8") if l.strip()]
    by_cat: dict[str, list[bool]] = defaultdict(list)
    failures = []

    for t in tests:
        try:
            answer, _ = ask(args.api, t["question"])
        except Exception as e:  # noqa: BLE001
            print(f"  [ERR ] {t['id']}: {e}")
            by_cat[t["category"]].append(False)
            failures.append(t["id"])
            continue

        if args.judge:
            ok = judge(args.api, args.ollama, args.model, t["question"], answer, t["expect"])
        else:
            low = answer.lower()
            ok = all(e.lower() in low for e in t["expect"])

        by_cat[t["category"]].append(ok)
        print(f"  [{'PASS' if ok else 'FAIL'}] {t['id']:24} {t['category']}")
        if not ok:
            failures.append(t["id"])

    print("\n=== Risultati per categoria ===")
    for cat, results in sorted(by_cat.items()):
        print(f"  {cat:14} {sum(results)}/{len(results)}")
    total = sum(len(v) for v in by_cat.values())
    passed = sum(sum(v) for v in by_cat.values())
    mode = "giudice LLM" if args.judge else "substring"
    print(f"\nScore ({mode}): {passed}/{total} = {100 * passed // total if total else 0}%")
    if failures:
        print("Falliti:", ", ".join(failures))


if __name__ == "__main__":
    main()
