/**
 * v0.37 — Quarq-shaped Retrieval Orchestrator.
 *
 * Top-level entry point that composes hypothesis expansion + memory-type
 * filtering + hybrid search + reasoning constraints:
 *
 *   query
 *     → classifyMemoryType(query)        — which memory type to prioritize
 *     → expandHypotheses(query)           — N search hypotheses
 *     → hybridSearch(each hypothesis)     — parallel search
 *     → rrfFusionWeighted(all results)    — merge with RRF
 *     → applyReasoningConstraints()       — entity isolation, temporal, etc.
 *     → topK(results)                     — final output
 *
 * This is a new public API surface that existing callers can opt into.
 * The bare hybridSearch/hybridSearchCached paths are unchanged.
 *
 * Tested in test/quarq-retrieval.test.ts.
 */

import type { BrainEngine } from '../engine.ts';
import type { SearchResult, SearchOpts, MemoryType, PageType } from '../types.ts';
import { hybridSearch } from './hybrid.ts';
import { extractHypotheses, hypothesisQueries } from './hypothesis-expansion.ts';
import { classifyMemoryType, pageTypesForMemoryType, filterByMemoryType } from './memory-type.ts';
import { RRF_K } from './hybrid.ts';

// ──────────────────────────────────────────────────────────────────────
// RRF fusion
// ──────────────────────────────────────────────────────────────────────

/**
 * Compute a per-result RRF score from multiple ranked lists.
 * Each list contributes 1/(rrfK + rank) for each result it contains.
 * Results that appear in multiple lists get a higher score.
 */
function rrfFusion(
  rankedLists: SearchResult[][],
  rrfK: number = RRF_K,
): SearchResult[] {
  // Composite key: (source_id, slug) for multi-source safety.
  const scoreMap = new Map<string, { score: number; result: SearchResult }>();
  const originalOrder = new Map<string, number>();

  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank];
      const key = `${r.source_id ?? 'default'}::${r.slug}`;
      const addend = 1 / (rrfK + (rank + 1));
      if (!scoreMap.has(key)) {
        scoreMap.set(key, { score: 0, result: r });
        originalOrder.set(key, scoreMap.size);
      }
      scoreMap.get(key)!.score += addend;
    }
  }

  // Normalize: divide by number of lists so scores are comparable.
  const nLists = Math.max(rankedLists.length, 1);
  const results: SearchResult[] = [];
  for (const entry of scoreMap.values()) {
    entry.result.score = entry.score / nLists;
    results.push(entry.result);
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ──────────────────────────────────────────────────────────────────────
// Reasoning Constraints (post-retrieval)
// ──────────────────────────────────────────────────────────────────────

/**
 * Reasoning constraint: temporal ambiguity detection.
 * When the query contains temporal markers (when, last year, etc.) but
 * results lack effective_date anchors, flag lower confidence.
 */
function detectTemporalAmbiguity(
  query: string,
  results: SearchResult[],
): { results: SearchResult[]; flagged: boolean } {
  const TEMPORAL_MARKERS = [
    /\b(when|date|time|year|month|week|day|ago|since|before|after)\b/i,
    /\b(\d{4}[-/]\d{1,2}[-/]\d{1,2})\b/,
    /\b(last|next|this)\s+(week|month|quarter|year)\b/i,
    /\b(recently|lately|just|now|today|yesterday)\b/i,
  ];
  const hasTemporal = TEMPORAL_MARKERS.some(re => re.test(query));
  if (!hasTemporal) return { results, flagged: false };

  // Count results with no effective_date anchor.
  const unanchored = results.filter(
    r => !r.effective_date || r.effective_date === 'null',
  ).length;
  const ratio = results.length > 0 ? unanchored / results.length : 0;

  if (ratio > 0.7) {
    // Majority of results lack temporal anchors — flag but don't drop.
    return { results, flagged: true };
  }

  return { results, flagged: false };
}

/**
 * Reasoning constraint: numerical constraint detection.
 * When the query contains numerical expectations (revenue figures, counts,
 * percentages) and results contain no matching numerical claims, flag.
 */
function detectNumericalMismatch(
  query: string,
  results: SearchResult[],
): { flagged: boolean } {
  // Check if query contains numerical indicators.
  const hasNumericalQuery = /\b(\$|percent|revenue|valuation|mrr|arr|count|number|total|budget|cost|\d{2,}|million|billion|thousand)\b/i.test(query);
  if (!hasNumericalQuery) return { flagged: false };

  // Check if any result contains numerical data.
  const hasNumerals = results.some(r => /\$|\d{2,}|percent|million|billion/i.test(r.chunk_text));
  return { flagged: !hasNumerals && results.length > 0 };
}

/**
 * Reasoning constraint: entity isolation.
 * When results mix chunks from different entity types that shouldn't be
 * merged (e.g., "Apple" the company vs apple the fruit), detect and
 * report entity ambiguity.
 *
 * For now, implements dedup-by-entity-slug which is already handled by
 * the existing dedup pipeline. This function reports when the close-set
 * contains multiple top-level prefixes indicating potential conflation.
 */
function detectEntityConflation(
  results: SearchResult[],
): { flagged: boolean; distinctPrefixes: string[] } {
  // Extract top-level prefixes (first path segment of each slug).
  const prefixes = new Set<string>();
  for (const r of results) {
    const slashIdx = r.slug.indexOf('/');
    const prefix = slashIdx > 0 ? r.slug.substring(0, slashIdx) : r.slug;
    prefixes.add(prefix);
  }

  // If results span too many distinct top-level namespaces, flag.
  const distinct = Array.from(prefixes);
  return {
    flagged: distinct.length > 5,
    distinctPrefixes: distinct,
  };
}

/**
 * Reasoning constraint: insufficient evidence detection.
 * When the close-set has fewer than 3 results, or all results are scored
 * below a confidence threshold, flag as insufficient evidence.
 */
function detectInsufficientEvidence(
  results: SearchResult[],
  scoreThreshold: number = 0.05,
): { flagged: boolean } {
  if (results.length === 0) return { flagged: true };
  if (results.length < 3) return { flagged: true };
  const aboveThreshold = results.filter(r => r.score >= scoreThreshold).length;
  if (aboveThreshold === 0) return { flagged: true };
  return { flagged: false };
}

/**
 * Reasoning constraints report attached to QuarqResult.
 */
export interface ReasoningConstraintsReport {
  temporalAmbiguity: boolean;
  numericalMismatch: boolean;
  entityConflation: boolean;
  distinctEntityPrefixes: string[];
  insufficientEvidence: boolean;
}

/**
 * Apply all reasoning constraints to a result set.
 * Returns the results (unchanged — these are diagnostic, not filtering)
 * plus a constraints report.
 */
export function applyReasoningConstraints(
  query: string,
  results: SearchResult[],
): { results: SearchResult[]; report: ReasoningConstraintsReport } {
  const temporal = detectTemporalAmbiguity(query, results);
  const numerical = detectNumericalMismatch(query, results);
  const entity = detectEntityConflation(results);
  const evidence = detectInsufficientEvidence(results);

  return {
    results,
    report: {
      temporalAmbiguity: temporal.flagged,
      numericalMismatch: numerical.flagged,
      entityConflation: entity.flagged,
      distinctEntityPrefixes: entity.distinctPrefixes,
      insufficientEvidence: evidence.flagged,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Quarq Retrieval
// ──────────────────────────────────────────────────────────────────────

/**
 * Options for quarqRetrieve.
 * Extends SearchOpts with Quarq-specific toggles.
 */
export interface QuarqRetrieveOpts extends SearchOpts {
  /**
   * Whether to run hypothesis expansion. Default true.
   * When false, runs only the original query through hybrid search.
   */
  hypothesisExpansion?: boolean;
  /** Whether to run reasoning constraints post-retrieval. Default true. */
  reasoningConstraints?: boolean;
  /** Override RRF k parameter (default: 60). */
  rrfK?: number;
  /** Maximum hypotheses to run in parallel (default: 4). */
  maxHypotheses?: number;
}

/**
 * Full result from quarqRetrieve, including the constraints report.
 */
export interface QuarqResult {
  results: SearchResult[];
  hypothesisCount: number;
  memoryType: MemoryType;
  constraints: ReasoningConstraintsReport | null;
  /** Which hypotheses actually ran (for telemetry/debugging). */
  ranQueries: string[];
}

/**
 * Quarq-shaped retrieval: hypothesis expansion + memory-type filtering
 * + hybrid search + reasoning constraints.
 *
 * This is the new public API. Existing hybridSearch callers are unchanged.
 */
export async function quarqRetrieve(
  engine: BrainEngine,
  query: string,
  opts?: QuarqRetrieveOpts,
): Promise<QuarqResult> {
  const useHypothesis = opts?.hypothesisExpansion !== false;
  const useConstraints = opts?.reasoningConstraints !== false;
  const maxHypotheses = opts?.maxHypotheses ?? 4;

  // 1. Classify memory type.
  const memoryType = opts?.memoryType ?? classifyMemoryType(query);

  // 2. Resolve page types for the memory type.
  const memoryPageTypes = pageTypesForMemoryType(memoryType);

  // 3. Build search hypotheses.
  const hypothesisSet = extractHypotheses(query);
  const queries = useHypothesis
    ? hypothesisQueries(hypothesisSet).slice(0, maxHypotheses)
    : [query.trim()].slice(0, maxHypotheses);

  // 4. Run parallel hybrid searches, threading memory type filter.
  const searchOpts: SearchOpts = {
    limit: opts?.limit ?? 10,
    detail: opts?.detail,
    language: opts?.language,
    symbolKind: opts?.symbolKind,
    types: opts?.types ?? memoryPageTypes,
    afterDate: opts?.afterDate,
    beforeDate: opts?.beforeDate,
    sourceId: opts?.sourceId,
    sourceIds: opts?.sourceIds,
    embeddingColumn: opts?.embeddingColumn,
    since: opts?.since,
    until: opts?.until,
    salience: opts?.salience,
    recency: opts?.recency,
    tokenBudget: opts?.tokenBudget,
    useCache: opts?.useCache,
    intentWeighting: opts?.intentWeighting,
    floorRatio: opts?.floorRatio,
    crossModal: opts?.crossModal,
    reranker: opts?.reranker,
    exclude_slugs: opts?.exclude_slugs,
    exclude_slug_prefixes: opts?.exclude_slug_prefixes,
    include_slug_prefixes: opts?.include_slug_prefixes,
  };

  const rankedLists: SearchResult[][] = [];
  for (const q of queries) {
    try {
      const results = await hybridSearch(engine, q, searchOpts);
      // Post-filter by memory type if the engine-level filter didn't catch all.
      if (memoryType !== 'general') {
        rankedLists.push(filterByMemoryType(results, memoryType));
      } else {
        rankedLists.push(results);
      }
    } catch {
      // Fail open: skip this hypothesis, continue with others.
      rankedLists.push([]);
    }
  }

  // 5. RRF fusion.
  const merged = rrfFusion(rankedLists, opts?.rrfK);

  // 6. Reasoning constraints (diagnostic, not filtering).
  let constraints: ReasoningConstraintsReport | null = null;
  if (useConstraints) {
    constraints = applyReasoningConstraints(query, merged).report;
  }

  return {
    results: merged,
    hypothesisCount: queries.length,
    memoryType,
    constraints,
    ranQueries: queries,
  };
}
