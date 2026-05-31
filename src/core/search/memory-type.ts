/**
 * v0.37 — Memory Type Classification + Filtering for Quarq-shaped retrieval.
 *
 * Maps GBrain's 22 PageType values to three Quarq memory categories:
 *   - semantic: durable facts about entities, concepts, domains
 *   - episodic: time-bound events, meetings, communications
 *   - procedural: instructions, code, reference material
 *
 * Pure module: classifyMemoryType is synchronous regex/lexicon-driven.
 * filterByMemoryType is a pure post-retrieval filter.
 * pageTypesForMemoryType is a lookup table.
 *
 * Threaded through SearchOpts.memoryType for pre-retrieval SQL filtering.
 *
 * Tested in test/memory-type.test.ts.
 */

import type { MemoryType, PageType, SearchResult } from '../types.ts';
import { ALL_PAGE_TYPES } from '../types.ts';

// ──────────────────────────────────────────────────────────────────────
// PageType → MemoryType mapping (exhaustive over all 22 PageType values)
// ──────────────────────────────────────────────────────────────────────

const PAGE_TYPE_TO_MEMORY: Record<PageType, MemoryType> = {
  // Semantic — durable facts
  person: 'semantic',
  company: 'semantic',
  deal: 'semantic',
  yc: 'semantic',
  civic: 'semantic',
  project: 'semantic',
  concept: 'semantic',
  source: 'semantic',
  analysis: 'semantic',
  guide: 'semantic',
  hardware: 'semantic',
  architecture: 'semantic',
  synthesis: 'semantic',
  // Episodic — time-bound events
  meeting: 'episodic',
  note: 'episodic',
  email: 'episodic',
  slack: 'episodic',
  'calendar-event': 'episodic',
  media: 'episodic',
  writing: 'episodic',
  // Procedural — instructions / reference
  code: 'procedural',
  // Explicit mapping for image (v0.27.1 multimodal)
  image: 'episodic',
} as const;

/** Reverse index: memory type → set of PageType values. Built once. */
const MEMORY_TO_PAGE_TYPES: Record<Exclude<MemoryType, 'general'>, PageType[]> = {
  semantic: [],
  episodic: [],
  procedural: [],
};

for (const [pt, mt] of Object.entries(PAGE_TYPE_TO_MEMORY)) {
  if (mt !== 'general') {
    MEMORY_TO_PAGE_TYPES[mt].push(pt as PageType);
  }
}

/**
 * Classify a user query into a memory type using deterministic heuristics.
 *
 * Uses keyword/regex signals to guess whether the query is likely looking for:
 *   - procedural: code, how-to, instructions, implementation details
 *   - episodic: meetings, events, emails, what happened, when
 *   - semantic: facts about people, companies, concepts, definitions
 *   - general: ambiguous or too short to classify (fallback)
 */
export function classifyMemoryType(query: string): MemoryType {
  const q = query.toLowerCase().trim();
  if (q.length === 0) return 'general';
  if (q.length < 4) return 'general';

  // Procedural signals: code, implementation, how-to, build, configure
  const PROCEDURAL = [
    /\b(how to|how do i|implement|build|configure|setup|set up|install|deploy|api|endpoint)\b/i,
    /\b(function|class|method|interface|type|module|package|library)\b/i,
    /\b(code|script|command|cli|sdk|framework|testing|unit test)\b/i,
    /\b(\w+\.ts|\w+\.js|\w+\.py|\w+\.go|--\w+|npm |yarn |git )/i,
  ];
  for (const re of PROCEDURAL) {
    if (re.test(q)) return 'procedural';
  }

  // Episodic signals: meetings, events, what happened, recency, communications
  const EPISODIC = [
    /\b(meet|met|meeting|event|happened|discussed|talk|call)\b/i,
    /\b(email|emails|slack|message|chat|note|memo)\b/i,
    /\b(yesterday|today|last week|recent|recently|when|date|schedule|calendar)\b/i,
    /\b(last|next|ago|since|before|after)\b/i,
  ];
  for (const re of EPISODIC) {
    if (re.test(q)) return 'episodic';
  }

  // Semantic signals: definitions, who is, what is, about
  const SEMANTIC = [
    /\b(who is|what is|what are|tell me about|define|definition)\b/i,
    /\b(founder|ceo|cto|president|vp|director|investor)\b/i,
    /\b(company|startup|firm|organization|product|service)\b/i,
  ];
  for (const re of SEMANTIC) {
    if (re.test(q)) return 'semantic';
  }

  return 'general';
}

/**
 * Return the PageType values that correspond to a given memory type.
 * For 'general', returns all PageType values (no restriction).
 */
export function pageTypesForMemoryType(type: MemoryType): PageType[] {
  if (type === 'general') return [...ALL_PAGE_TYPES];
  return MEMORY_TO_PAGE_TYPES[type] ?? [];
}

/**
 * Post-retrieval filter: keep only results whose PageType matches the memory type.
 * For 'general', returns results unchanged.
 */
export function filterByMemoryType(
  results: SearchResult[],
  memoryType: MemoryType,
): SearchResult[] {
  if (memoryType === 'general' || results.length === 0) return results;
  const allowed = new Set(pageTypesForMemoryType(memoryType));
  return results.filter(r => allowed.has(r.type));
}

/**
 * Validate that the mapping is exhaustive over all 22 PageType values.
 * Called by the contract test to ensure no PageType is unmapped.
 */
export function validateMemoryTypeExhaustive(): void {
  const mapped = new Set(Object.keys(PAGE_TYPE_TO_MEMORY));
  const missing = ALL_PAGE_TYPES.filter(pt => !mapped.has(pt));
  if (missing.length > 0) {
    throw new Error(
      `Memory type mapping is missing PageType values: ${missing.join(', ')}`,
    );
  }
}
