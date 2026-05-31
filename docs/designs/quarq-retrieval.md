# Quarq-Shaped Retrieval — GBrain v2

> **Card:** kn79t1b52hd4atw6302hhgbbtn87k5bc
> **Wave:** 3 — GBrain v2 retrieval improvements
> **Date:** 2026-05-29
> **Status:** Implemented (v0.37)

## Problem

GBrain's current retrieval pipeline (`src/core/search/hybrid.ts`) is strong on vector + keyword + RRF fusion but lacks three structural capabilities identified by the Quarq Labs reference architecture (open-sourced as `agent-oss`, described in `export/sources/sydneyrunkle/2026-05-27-quarq-agent-open-sourced-4-layer-memory-system.md`):

1. **Hypothesis expansion** — queries run as-is. GBrain's existing `expandQuery` in `src/core/search/expansion.ts` produces synonym variants but does NOT decompose a query into *search hypotheses* (people, actions, dates, entities) — the core Quarq retrieval insight.

2. **Memory-type filtering** — GBrain has 22 `PageType` values (`person`, `meeting`, `note`, `code`, etc.) but no way to map them to *memory type* semantics (semantic = durable facts, episodic = time-bound events, procedural = instructions/rules) for retrieval routing.

3. **Reasoning constraints** — no explicit post-retrieval safeguards for entity isolation, temporal ambiguity, or insufficient-evidence detection at the retrieval layer.

## Solution: Three Files

### 1. `src/core/search/hypothesis-expansion.ts` — Hypothesis Expansion

Replaces / extends the existing `expandQuery` with Quarq-style hypothesis decomposition:

- Takes a user query and produces **structured search hypotheses** across multiple dimensions:
  - **Entity hypotheses** — names, organizations, concepts mentioned or implied
  - **Action hypotheses** — verbs, events, relationships (met, discussed, invested, launched)
  - **Temporal hypotheses** — dates, time ranges, recency cues
  - **Topical hypotheses** — domain keywords, synonyms, related concepts

- Each hypothesis runs through the existing hybrid search pipeline; results merge via RRF.
- Deterministic (regex + lexicon) first, with optional LLM escalation when the deterministic pass produces < 2 hypotheses.
- Reuses GBrain's existing `gatewayExpand` pathway for the LLM branch; adds a `HypothesisSet` type for structured hypotheses.

### 2. `src/core/search/memory-type.ts` — Memory Type Classification + Filtering

A pure module that maps GBrain's `PageType` values to Quarq's three memory categories:

| Memory Type | GBrain Page Types | Purpose |
|---|---|---|
| `semantic` | `person`, `company`, `deal`, `yc`, `civic`, `project`, `concept`, `source`, `analysis`, `guide`, `hardware`, `architecture`, `synthesis` | Durable facts about user/world |
| `episodic` | `meeting`, `note`, `email`, `slack`, `calendar-event`, `media`, `writing` | Events at a point in time |
| `procedural` | `code` | Behavioral instructions / reference material |

Exports:
- `classifyMemoryType(query: string): 'semantic' | 'episodic' | 'procedural' | 'general'` — deterministic classifier
- `pageTypesForMemoryType(type): PageType[]` — lookup table
- `filterByMemoryType(results, type): SearchResult[]` — post-retrieval filter
- Threaded through `SearchOpts.memoryType?: MemoryType` for pre-retrieval SQL filtering

### 3. `src/core/search/quarq-retrieval.ts` — Orchestrator

The top-level entry point that composes hypothesis expansion + memory-type filtering + search:

```
query
  → classifyMemoryType(query)       — which memory type to prioritize
  → expandHypotheses(query)         — N search hypotheses
  → hybridSearch(each hypothesis)   — parallel search
  → rrfFusionWeighted(all results)  — merge
  → applyReasoningConstraints()     — entity isolation, temporal checks
  → topK(results)                   — final output
```

This is a **new public API surface** for `gbrain query` / MCP `search` ops to opt into. Existing code paths (bare `hybridSearch`, `hybridSearchCached`) are unchanged.

## Integration Points

| Existing File | Change |
|---|---|
| `src/core/types.ts` | Add `MemoryType` type + `SearchOpts.memoryType` field |
| `src/core/search/hybrid.ts` | Respect `opts.memoryType` in keyword/vector SQL filters |
| `src/core/pglite-engine.ts` | Add `memoryType` filter to `searchKeyword` + `searchVector` SQL |
| `src/core/postgres-engine.ts` | Same — parallel update for Postgres engine |
| `src/core/engine.ts` | Add `memoryType` to `SearchOpts` interface doc |
| `src/core/operations.ts` | Wire `memoryType` from query op → `SearchOpts` |
| `test/quarq-retrieval.test.ts` | Unit tests for all three modules |

## Design Decisions

1. **Deterministic-then-LLM**: Hypothesis expansion starts with regex/lexicon extraction (free, instant). LLM escalation fires only when deterministic produces < 2 hypotheses **and** the query is ≥ 5 words. This mirrors gbrain's existing `classifyQuery` pattern and keeps the cheap path cheap.

2. **Memory type as opt-in filter**: `SearchOpts.memoryType` is undefined by default. When set, it adds a `WHERE p.type = ANY(...)` clause to the SQL — exactly the same pattern as the existing `types` filter. Zero behavior change for existing callers.

3. **No DB migration needed**: Memory type is a pure classification over existing `PageType` values. No schema change, no new columns, no index additions.

4. **Reasoning constraints are post-retrieval**: They run as a pure function over `SearchResult[]` — no DB, no LLM. This makes them testable, composable, and safe to skip. v1 implements entity isolation (dedup-by-entity); temporal and insufficient-evidence detection are v2 follow-ups.

## Testing

- `test/hypothesis-expansion.test.ts` — deterministic extraction, LLM fallback, sanitization
- `test/memory-type.test.ts` — classification accuracy, filtering, PageType exhaustiveness
- `test/quarq-retrieval.test.ts` — end-to-end pipeline, RRF merge, reasoning constraints

## Success Criteria

- Hypothesis expansion produces ≥ 2 hypotheses for 80%+ of queries that would previously get 0 from `expandQuery` (measured by replay on eval corpus)
- Memory-type filtering correctly maps all 22 PageType values (tested by exhaustive PageType contract test)
- Quarq retrieval returns equivalent or better results than bare `hybridSearch` on LongMemEval benchmark (Δ P@5 ≥ 0)
- Zero behavior change for any caller that doesn't explicitly use the new API
