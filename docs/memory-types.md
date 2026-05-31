# Memory Types — Quarq Retrieval Categories

> **v0.37** — Maps GBrain's 22 `PageType` values to three Quarq memory categories
> for retrieval routing and classification.

## Overview

GBrain's search system supports 22 distinct `PageType` values (person, meeting,
code, note, etc.). The Quarq memory-type layer groups these into three semantic
categories that match how humans think about information:

| Memory Type | Purpose | Page Types |
|---|---|---|
| **semantic** | Durable facts about entities, concepts, domains | person, company, deal, yc, civic, project, concept, source, analysis, guide, hardware, architecture, synthesis |
| **episodic** | Time-bound events, meetings, communications | meeting, note, email, slack, calendar-event, media, writing, image |
| **procedural** | Instructions, code, reference material | code |
| **general** | Unclassified — no filter applied | (all types) |

## CLI Usage

```bash
# Search only semantic pages (durable facts)
gbrain query "who founded acme" --memory-type semantic

# Search only episodic pages (events, meetings)
gbrain query "what happened last week" --memory-type episodic

# Search only procedural pages (code, how-to)
gbrain query "how to deploy the API" --memory-type procedural

# Full Quarq pipeline: hypothesis expansion + memory-type + RRF + constraints
gbrain query "what did Alice Chen tell Bob about the merger" --quarq
```

## Automatic Classification

When `--quarq` is enabled, the query is automatically classified into a memory
type using deterministic heuristics:

| Signal | Classification |
|---|---|
| "how to", "implement", "build", ".ts", ".py", "function", "class" | procedural |
| "meeting", "email", "slack", "yesterday", "recent", "when" | episodic |
| "who is", "what is", "founder", "company", "define" | semantic |
| Short or ambiguous queries | general (no filter) |

Automatic classification accuracy on the 30-query benchmark: **25/30 (83%)**.

## Hypothesis Expansion

The Quarq pipeline decomposes queries into structured search hypotheses across
four dimensions:

- **Entity** — names, organizations, concepts (capitalized word sequences, quoted text, wikilinks)
- **Action** — verbs and events (met, invested, launched, hired, decided)
- **Temporal** — dates and time references (yesterday, last week, 2025-01-15, Q4 2025)
- **Topical** — domain keywords and topic phrases

Each hypothesis runs through hybrid search; results merge via Reciprocal Rank
Fusion (RRF) with RRF_K=60. Deterministic extraction caps at 3 hypotheses;
LLM escalation fires when deterministic produces < 2 hypotheses and the query
is ≥ 5 words.

## Architecture

The memory-type system is implemented across three modules:

```
src/core/types.ts              — MemoryType type definition (export)
src/core/search/memory-type.ts  — PageType → MemoryType mapping, classifier, filter
src/core/search/hypothesis-expansion.ts — Query decomposition engine
src/core/search/quarq-retrieval.ts — Orchestrator composing all stages
```

Integration points:

```
src/core/search/hybrid.ts      — Imports pageTypesForMemoryTypes, applies SQL filter
src/core/operations.ts          — memory_type param on query op, --quarq flag
```

## Reasoning Constraints

The Quarq pipeline attaches a diagnostic report to every retrieval result:

- **temporalAmbiguity** — query has temporal markers but results lack date anchors
- **numericalMismatch** — query expects numbers but results have none
- **entityConflation** — results span >5 distinct top-level namespaces
- **insufficientEvidence** — fewer than 3 results or all scores below threshold

These are diagnostic (not filtering). Consumers (e.g., LLM synthesis) should
flag or qualify responses when constraints fire.

## Benchmark

Run the 30-query benchmark:

```bash
bun run test/quarq-benchmark.ts          — static analysis (hypotheses, classification)
bun run test/quarq-benchmark.ts --baseline — export baseline NDJSON
```

The benchmark measures:
- Memory-type classification accuracy per bucket
- Hypothesis expansion coverage (avg hypotheses per query)
- Reasoning constraint activation rates

## Files

| File | Lines | Purpose |
|---|---|---|
| `src/core/search/memory-type.ts` | 150 | PageType→MemoryType mapping, classifier, post-retrieval filter |
| `src/core/search/hypothesis-expansion.ts` | 350 | Deterministic + LLM hypothesis decomposition |
| `src/core/search/quarq-retrieval.ts` | 325 | Top-level orchestrator, RRF fusion, reasoning constraints |
| `test/memory-type.test.ts` | 178 | 20 tests — mapping exhaustiveness, classification, filtering |
| `test/hypothesis-expansion.test.ts` | 130 | 15 tests — extraction, dedup, sanitization, ranking |
| `test/quarq-retrieval.test.ts` | 159 | 13 tests — temporal/numerical/entity/evidence constraints |
| `test/quarq-benchmark.ts` | 237 | 30-query benchmark suite with 5 buckets |
