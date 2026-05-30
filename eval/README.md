# Capsuleers.IA — Evaluation

A set of "golden" questions to measure the AI's accuracy on skills, fitting,
terminology, ships/modules, universe, industry, and lore.

## Files

- `dataset.jsonl` — questions with their expected facts (`expect`). Fields: `id`,
  `category`, `source` (`sde`/`wiki`/`mixed`), `question`, `expect` (a list of
  facts that a correct answer must contain).
- `validate_dataset.py` — verifies that the expected facts are present in the corpus
  (JSONL dump). **Requires no infrastructure.** It checks the coverage and correctness
  of the golden set: if a fact isn't in the corpus, the RAG can never answer it.
- `run_eval.py` — end-to-end harness: queries the `/ask` API and verifies the
  answers (substring match or semantic grading via LLM). **Requires the API to be running.**

## Usage

```bash
# 1. Coverage (offline, against the ingestion dumps)
python eval/validate_dataset.py

# 2. End-to-end quality (API running: Qdrant + Ollama + populated index)
python eval/run_eval.py            # substring match of the expected facts
python eval/run_eval.py --judge    # semantic grading via LLM
```

## Interpretation

- `validate_dataset` measures whether the **data exists** to answer (coverage).
- `run_eval` measures whether the **system retrieves and answers** correctly (retrieval +
  generation quality). The gap between the two points to retrieval or
  prompt problems, not data problems.

Extending the set is encouraged: add rows to `dataset.jsonl` for every
real use case (questions asked by the site's users).
