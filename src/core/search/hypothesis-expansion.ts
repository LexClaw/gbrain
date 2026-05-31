/**
 * v0.37 — Hypothesis Expansion for Quarq-shaped retrieval.
 *
 * Replaces / extends the existing synonym-based `expandQuery` with structured
 * hypothesis decomposition: a single query is analyzed across multiple
 * dimensions (entity, action, temporal, topical) and each dimension produces
 * focused search hypotheses. These feed the hybrid search pipeline
 * independently; results merge via RRF.
 *
 * Design per Quarq Labs' Layer 1 pattern:
 * "Each question expands into multiple search hypotheses (people, actions,
 * dates, locations, entities). Each hypothesis runs across both vector AND
 * keyword indices. Results merged + deduplicated + ranked."
 *
 * Pure module + async LLM branch:
 *   - extractHypotheses(query) is synchronous, regex/lexicon-driven
 *   - expandHypothesesWithLLM(query) fires only when deterministic pass
 *     produces < 2 hypotheses AND query is ≥ 5 words. Fails open.
 *
 * Tested in test/hypothesis-expansion.test.ts.
 */

import type { PageType } from '../types.ts';
import { expand as gatewayExpand, isAvailable as gatewayIsAvailable } from '../ai/gateway.ts';

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export type HypothesisKind = 'entity' | 'action' | 'temporal' | 'topical';

export interface Hypothesis {
  /** What dimension this hypothesis targets */
  kind: HypothesisKind;
  /** The search term(s) for this hypothesis */
  query: string;
  /** Confidence 0..1 in how well this hypothesis fits the original query */
  confidence: number;
  /** Optional PageType hints — e.g. entity → ['person', 'company'] */
  suggestedTypes?: PageType[];
}

export interface HypothesisSet {
  /** Original query (always included as a hypothesis) */
  original: string;
  /** Decomposed search hypotheses */
  hypotheses: Hypothesis[];
}

/**
 * Convert a HypothesisSet to a flat list of query strings suitable
 * for iteration through the hybrid search pipeline.
 * Returns: [original, hypothesis1, hypothesis2, ...]
 */
export function hypothesisQueries(set: HypothesisSet): string[] {
  return [set.original, ...set.hypotheses.map(h => h.query)];
}

// ──────────────────────────────────────────────────────────────────────
// Lexicon banks (deterministic extraction)
// ──────────────────────────────────────────────────────────────────────

/**
 * Named entity patterns: capitalized words, known person/company markers.
 */
const ENTITY_PATTERNS = [
  // Capitalized word sequences (names): "Alice Chen", "Acme Corp"
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/g,
  // Quoted entities: "Alex", "the Johnson account"
  /"([^"]{2,40})"/g,
  // Double-bracket wikilink style: [[Alice Chen]]
  /\[\[([^\]|]{2,40})(?:\|[^\]]+)?\]\]/g,
  // Markdown link text: [Alice](...)
  /\[([^\]]{2,40})\]\(/g,
];

/**
 * Action/event verb patterns.
 */
const ACTION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(meet|met|meeting|saw|seen|talk|spoke|call|chat|discuss)\w*\b/gi, label: 'meeting' },
  { re: /\b(invest|funded|funding|backed|backing|portfolio)\w*\b/gi, label: 'investment' },
  { re: /\b(launch|release|ship|announce|announced)\w*\b/gi, label: 'launch' },
  { re: /\b(raise|raised|fund|funding|series|round)\w*\b/i, label: 'fundraising' },
  { re: /\b(work|working|role|position|job|hired)\w*\b/gi, label: 'employment' },
  { re: /\b(decid|opt|chose|pick|recommend)\w*\b/gi, label: 'decision' },
];

/**
 * Temporal patterns that suggest time-bound searches.
 */
const TEMPORAL_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(today|yesterday|tonight)\b/gi, label: 'today' },
  { re: /\b(this|last|next)\s+(week|month|quarter|year)\b/gi, label: 'relative' },
  { re: /\b(\d{4}[-/]\d{1,2}[-/]\d{1,2})\b/g, label: 'date' },
  { re: /\b(recently|lately|just|now)\b/gi, label: 'recent' },
  { re: /\b(sin(?:ce|ce)|ago|before|after|until|by)\s+/gi, label: 'relative' },
  { re: /\b(Q[1-4]\s+20\d{2}|20\d{2}\s+Q[1-4])\b/gi, label: 'quarter' },
];

/**
 * Topical keyword patterns — domain-specific terms.
 */
const TOPICAL_PATTERNS = [
  // Quoted topic phrases
  /about\s+(?:the\s+)?(.{3,50}?)(?:\?|\.|$)/i,
  // "what is X" style queries extract X
  /\b(?:what|who|where|when|why|how)\s+(?:is|are|do|does|did|was|were)\s+([A-Za-z][\w\s\-]{2,30}?)(?:\?|\.|$)/i,
  // General keyword extraction: nouns after prepositions
  /\b(?:in|at|on|for|of|with|from)\s+(the\s+)?([\w\s\-]{2,30}?)(?:\s+(?:that|which|who|is|are|was|were|do|have|can|should)|\?|\.|$)/i,
];

// ──────────────────────────────────────────────────────────────────────
// Deterministic hypothesis extraction
// ──────────────────────────────────────────────────────────────────────

/**
 * Sanitize a candidate hypothesis string.
 */
function sanitizeHypothesis(raw: string): string | null {
  let s = raw.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (s.length < 2 || s.length > 200) return null;
  // Strip leading/trailing function words
  s = s.replace(/^(a|an|the|some|any|this|that|these|those)\s+/i, '');
  if (s.length < 2) return null;
  return s;
}

/**
 * Deduplicate hypotheses by normalized (lowercased, trimmed) query string.
 */
function deduplicateHypotheses(hypotheses: Hypothesis[]): Hypothesis[] {
  const seen = new Set<string>();
  const out: Hypothesis[] = [];
  for (const h of hypotheses) {
    const key = h.query.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/**
 * Extract entities from the query using regex pattern banks.
 */
function extractEntities(query: string): Hypothesis[] {
  const results: Hypothesis[] = [];
  for (const pattern of ENTITY_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = [...query.matchAll(new RegExp(pattern.source, pattern.flags))];
    for (const m of matches) {
      const candidate = (m[1] ?? m[0]).trim();
      const sanitized = sanitizeHypothesis(candidate);
      if (sanitized && sanitized.length >= 2) {
        results.push({
          kind: 'entity',
          query: sanitized,
          confidence: 0.7,
          suggestedTypes: ['person', 'company', 'project'],
        });
      }
    }
  }
  return results;
}

/**
 * Extract action-based hypotheses from the query.
 */
function extractActions(query: string): Hypothesis[] {
  const results: Hypothesis[] = [];
  for (const { re, label } of ACTION_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(query)) {
      results.push({
        kind: 'action',
        query: label,
        confidence: 0.6,
      });
    }
  }
  return results;
}

/**
 * Extract temporal hypotheses from the query.
 */
function extractTemporal(query: string): Hypothesis[] {
  const results: Hypothesis[] = [];
  for (const { re, label } of TEMPORAL_PATTERNS) {
    re.lastIndex = 0;
    const match = re.exec(query);
    if (match) {
      const candidate = match[0].trim();
      results.push({
        kind: 'temporal',
        query: candidate,
        confidence: 0.8,
      });
    }
  }
  return results;
}

/**
 * Extract topical hypotheses from the query.
 */
function extractTopical(query: string): Hypothesis[] {
  const results: Hypothesis[] = [];
  for (const pattern of TOPICAL_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(query);
    if (match) {
      const candidate = (match[1] ?? match[0]).trim();
      const sanitized = sanitizeHypothesis(candidate);
      if (sanitized && sanitized.length >= 2) {
        results.push({
          kind: 'topical',
          query: sanitized,
          confidence: 0.5,
        });
      }
    }
  }
  return results;
}

/**
 * Deterministic hypothesis extraction from a user query.
 * Returns a HypothesisSet containing the original query plus structured
 * hypotheses across entity, action, temporal, and topical dimensions.
 *
 * Pure function. No DB, no LLM, no async.
 */
export function extractHypotheses(query: string): HypothesisSet {
  const sanitized = query.trim();
  if (sanitized.length === 0) {
    return { original: '', hypotheses: [] };
  }

  const entityHypotheses = extractEntities(sanitized);
  const actionHypotheses = extractActions(sanitized);
  const temporalHypotheses = extractTemporal(sanitized);
  const topicalHypotheses = extractTopical(sanitized);

  // Combine and deduplicate, favoring higher-confidence hypotheses.
  const all = [
    ...entityHypotheses,
    ...actionHypotheses,
    ...temporalHypotheses,
    ...topicalHypotheses,
  ];

  // Sort by confidence descending, then by kind priority (entity > action > temporal > topical).
  const kindPriority: Record<HypothesisKind, number> = {
    entity: 0,
    action: 1,
    temporal: 2,
    topical: 3,
  };

  all.sort((a, b) => {
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return kindPriority[a.kind] - kindPriority[b.kind];
  });

  // Take up to 3 hypotheses (Quarq pattern: 2-3 variants).
  const top = deduplicateHypotheses(all).slice(0, 3);

  // Remove any hypothesis whose query is identical to the original (case-insensitive).
  const lowerOriginal = sanitized.toLowerCase();
  const filtered = top.filter(h => h.query.toLowerCase() !== lowerOriginal);

  return { original: sanitized, hypotheses: filtered };
}

// ──────────────────────────────────────────────────────────────────────
// LLM-based hypothesis expansion (fails open)
// ──────────────────────────────────────────────────────────────────────

/**
 * Minimum query length (in words) to trigger LLM expansion.
 */
const MIN_WORDS_FOR_LLM = 5;

/**
 * Maximum number of hypotheses the LLM may produce.
 */
const MAX_LLM_HYPOTHESES = 3;

/**
 * Expand hypotheses using the AI gateway as a fallback
 * when the deterministic pass produces < 2 hypotheses.
 *
 * Returns the union of deterministic + LLM hypotheses, deduplicated.
 * Fails open — if the LLM call errors, returns the deterministic set.
 */
export async function expandHypothesesWithLLM(query: string): Promise<HypothesisSet> {
  const deterministic = extractHypotheses(query);

  // Already have enough hypotheses — skip LLM call.
  if (deterministic.hypotheses.length >= 2) return deterministic;

  // Too short for meaningful expansion.
  const wordCount = query.split(/\s+/).filter(w => w.length > 0).length;
  if (wordCount < MIN_WORDS_FOR_LLM) return deterministic;

  // Gateway has no expansion provider — fail open.
  if (!gatewayIsAvailable('expansion')) return deterministic;

  try {
    const prompt =
      `Decompose this search query into ${MAX_LLM_HYPOTHESES} distinct search hypotheses. ` +
      `Each hypothesis should target a different aspect: an entity (person, company, product), ` +
      `an action or event, a time reference, or a topic. ` +
      `Return ONLY the hypotheses, one per line, without numbering or explanation.\n\n` +
      `Query: "${query}"`;

    const gatewayResults = await gatewayExpand(prompt);

    // Parse LLM output into structured hypotheses.
    const hypotheses: Hypothesis[] = [];
    for (const line of gatewayResults.slice(1)) {
      const sanitized = sanitizeHypothesis(line);
      if (sanitized && sanitized.toLowerCase() !== query.toLowerCase().trim()) {
        hypotheses.push({
          kind: 'topical', // LLM output doesn't distinguish; classify generically
          query: sanitized,
          confidence: 0.5,
        });
      }
      if (hypotheses.length >= MAX_LLM_HYPOTHESES) break;
    }

    // Merge with deterministic (deduplicated).
    const merged = deduplicateHypotheses([
      ...deterministic.hypotheses,
      ...hypotheses,
    ]).slice(0, MAX_LLM_HYPOTHESES);

    return { original: query.trim(), hypotheses: merged };
  } catch {
    // Fail open: return deterministic set.
    return deterministic;
  }
}
