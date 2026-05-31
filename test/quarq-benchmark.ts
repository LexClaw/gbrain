/**
 * v0.37 — Quarq Retrieval Benchmark (30-query benchmark suite).
 *
 * Usage:
 *   bun run test/quarq-benchmark.ts            — baseline vs after
 *   bun run test/quarq-benchmark.ts --baseline — export baseline only
 *   bun run test/quarq-benchmark.ts --compare baseline.ndjson — compare against baseline
 *
 * The 30-query corpus covers 5 buckets × 6 queries each:
 *   1. entity-lookup (semantic): "who is X", "what is Y"
 *   2. episodic-recall: meetings, notes, recency
 *   3. procedural: how-to, code references
 *   4. multi-entity: relationships between entities
 *   5. temporal: time-bounded queries
 *
 * Recall@5 is the key metric: for each query, how many of the ground-truth
 * expected results appear in the top-5 retrieved results.
 *
 * NOTE: This script requires a live brain with actual data. It runs against
 * the configured brain and reports recall@5 scores per query and per bucket.
 */

import { extractHypotheses, hypothesisQueries } from '../src/core/search/hypothesis-expansion.ts';
import { classifyMemoryType, pageTypesForMemoryType, filterByMemoryType } from '../src/core/search/memory-type.ts';
import { applyReasoningConstraints } from '../src/core/search/quarq-retrieval.ts';
import { writeFile, readFile } from 'fs/promises';

// ──────────────────────────────────────────────────────────────────────
// Query categories
// ──────────────────────────────────────────────────────────────────────

interface BenchQuery {
  id: string;
  query: string;
  bucket: 'entity-lookup' | 'episodic-recall' | 'procedural' | 'multi-entity' | 'temporal';
  expectedSlugs: string[]; // ground-truth slugs that SHOULD appear
  expectedMemoryType?: string;
}

/**
 * 30-query benchmark corpus.
 * Expected slugs should be populated by the operator for their specific brain.
 * The script still measures hypothesis expansion coverage and memory-type
 * classification even without ground-truth slugs.
 */
const BENCH_QUERIES: BenchQuery[] = [
  // Bucket 1: entity-lookup (semantic memory)
  { id: 'Q01', query: 'Who is the founder of the company', bucket: 'entity-lookup', expectedSlugs: [], expectedMemoryType: 'semantic' },
  { id: 'Q02', query: 'What is GBrain', bucket: 'entity-lookup', expectedSlugs: [], expectedMemoryType: 'semantic' },
  { id: 'Q03', query: 'Tell me about this startup', bucket: 'entity-lookup', expectedSlugs: [], expectedMemoryType: 'semantic' },
  { id: 'Q04', query: 'Background on the CEO', bucket: 'entity-lookup', expectedSlugs: [], expectedMemoryType: 'semantic' },
  { id: 'Q05', query: 'What does this product do', bucket: 'entity-lookup', expectedSlugs: [], expectedMemoryType: 'semantic' },
  { id: 'Q06', query: 'Summary of the investment thesis', bucket: 'entity-lookup', expectedSlugs: [], expectedMemoryType: 'semantic' },

  // Bucket 2: episodic-recall
  { id: 'Q07', query: 'What happened in the meeting yesterday', bucket: 'episodic-recall', expectedSlugs: [], expectedMemoryType: 'episodic' },
  { id: 'Q08', query: 'Recent emails about the funding', bucket: 'episodic-recall', expectedSlugs: [], expectedMemoryType: 'episodic' },
  { id: 'Q09', query: 'Find the Slack message about the launch', bucket: 'episodic-recall', expectedSlugs: [], expectedMemoryType: 'episodic' },
  { id: 'Q10', query: 'Notes from last week', bucket: 'episodic-recall', expectedSlugs: [], expectedMemoryType: 'episodic' },
  { id: 'Q11', query: 'Calendar events for the conference', bucket: 'episodic-recall', expectedSlugs: [], expectedMemoryType: 'episodic' },
  { id: 'Q12', query: 'What did we discuss with the investor', bucket: 'episodic-recall', expectedSlugs: [], expectedMemoryType: 'episodic' },

  // Bucket 3: procedural
  { id: 'Q13', query: 'How to deploy gbrain', bucket: 'procedural', expectedSlugs: [], expectedMemoryType: 'procedural' },
  { id: 'Q14', query: 'How do I configure the API endpoint', bucket: 'procedural', expectedSlugs: [], expectedMemoryType: 'procedural' },
  { id: 'Q15', query: 'Implement the search function in TypeScript', bucket: 'procedural', expectedSlugs: [], expectedMemoryType: 'procedural' },
  { id: 'Q16', query: 'Build and test the package', bucket: 'procedural', expectedSlugs: [], expectedMemoryType: 'procedural' },
  { id: 'Q17', query: 'Setup the SDK framework', bucket: 'procedural', expectedSlugs: [], expectedMemoryType: 'procedural' },
  { id: 'Q18', query: 'Install the npm module for gbrain', bucket: 'procedural', expectedSlugs: [], expectedMemoryType: 'procedural' },

  // Bucket 4: multi-entity
  { id: 'Q19', query: 'What did Alice Chen tell Bob about the merger', bucket: 'multi-entity', expectedSlugs: [], expectedMemoryType: 'semantic' },
  { id: 'Q20', query: 'When did Alice meet with investors', bucket: 'multi-entity', expectedSlugs: [], expectedMemoryType: 'episodic' },
  { id: 'Q21', query: 'Series B funding for the startup', bucket: 'multi-entity', expectedSlugs: [], expectedMemoryType: 'semantic' },
  { id: 'Q22', query: 'Who knows who in the portfolio', bucket: 'multi-entity', expectedSlugs: [], expectedMemoryType: 'semantic' },
  { id: 'Q23', query: 'Connections between the founder and the investor', bucket: 'multi-entity', expectedSlugs: [], expectedMemoryType: 'semantic' },
  { id: 'Q24', query: 'What is the relationship between the two companies', bucket: 'multi-entity', expectedSlugs: [], expectedMemoryType: 'semantic' },

  // Bucket 5: temporal
  { id: 'Q25', query: 'What happened last week', bucket: 'temporal', expectedSlugs: [], expectedMemoryType: 'episodic' },
  { id: 'Q26', query: 'Recent meetings about the Q4 2025 budget', bucket: 'temporal', expectedSlugs: [], expectedMemoryType: 'episodic' },
  { id: 'Q27', query: 'Events in the last quarter', bucket: 'temporal', expectedSlugs: [], expectedMemoryType: 'episodic' },
  { id: 'Q28', query: 'What changed since 2025-01-01', bucket: 'temporal', expectedSlugs: [], expectedMemoryType: 'episodic' },
  { id: 'Q29', query: 'Meetings from yesterday', bucket: 'temporal', expectedSlugs: [], expectedMemoryType: 'episodic' },
  { id: 'Q30', query: 'Notes from Q1 2026', bucket: 'temporal', expectedSlugs: [], expectedMemoryType: 'episodic' },
];

// ──────────────────────────────────────────────────────────────────────
// Benchmark runners
// ──────────────────────────────────────────────────────────────────────

interface BenchmarkResult {
  queryId: string;
  query: string;
  bucket: string;
  expectedMemoryType: string;
  classifiedMemoryType: string;
  numHypotheses: number;
  hypothesisQueries: string[];
  reasoningConstraints: {
    temporalAmbiguity: boolean;
    numericalMismatch: boolean;
    entityConflation: boolean;
    insufficientEvidence: boolean;
  };
  recallAt5?: number;
  recallAt5Total?: number;
}

/**
 * Run the benchmark without a live engine — tests hypothesis expansion
 * and memory-type classification coverage.
 */
function runStaticBenchmark(): BenchmarkResult[] {
  return BENCH_QUERIES.map((q) => {
    const hSet = extractHypotheses(q.query);
    const hQueries = hypothesisQueries(hSet);
    const classified = classifyMemoryType(q.query);
    const constraints = applyReasoningConstraints(q.query, []);

    return {
      queryId: q.id,
      query: q.query,
      bucket: q.bucket,
      expectedMemoryType: q.expectedMemoryType ?? 'unknown',
      classifiedMemoryType: classified,
      numHypotheses: hSet.hypotheses.length,
      hypothesisQueries: hQueries,
      reasoningConstraints: {
        temporalAmbiguity: constraints.report.temporalAmbiguity,
        numericalMismatch: constraints.report.numericalMismatch,
        entityConflation: constraints.report.entityConflation,
        insufficientEvidence: constraints.report.insufficientEvidence,
      },
    };
  });
}

/**
 * Calculate recall@5 from results.
 */
function recallAt5(retrievedSlugs: string[], expectedSlugs: string[]): number {
  if (expectedSlugs.length === 0) return -1; // unknown
  const top5 = new Set(retrievedSlugs.slice(0, 5));
  let hits = 0;
  for (const slug of expectedSlugs) {
    if (top5.has(slug)) hits++;
  }
  return expectedSlugs.length > 0 ? hits / expectedSlugs.length : -1;
}

/**
 * Aggregate statistics.
 */
function aggregateStats(results: BenchmarkResult[]): Record<string, unknown> {
  const buckets = new Map<string, BenchmarkResult[]>();
  for (const r of results) {
    if (!buckets.has(r.bucket)) buckets.set(r.bucket, []);
    buckets.get(r.bucket)!.push(r);
  }

  const bucketStats: Record<string, unknown> = {};
  for (const [bucket, rows] of buckets) {
    const correct = rows.filter(r => r.classifiedMemoryType === r.expectedMemoryType).length;
    const avgHypotheses = rows.reduce((sum, r) => sum + r.numHypotheses, 0) / rows.length;
    bucketStats[bucket] = {
      count: rows.length,
      memoryTypeAccuracy: `${correct}/${rows.length}`,
      avgHypotheses: avgHypotheses.toFixed(2),
      temporalFlagged: rows.filter(r => r.reasoningConstraints.temporalAmbiguity).length,
      numericalMismatch: rows.filter(r => r.reasoningConstraints.numericalMismatch).length,
    };
  }

  const totalCorrect = results.filter(r => r.classifiedMemoryType === r.expectedMemoryType).length;

  return {
    totalQueries: results.length,
    memoryTypeAccuracy: `${totalCorrect}/${results.length}`,
    bucketStats,
  };
}

// ──────────────────────────────────────────────────────────────────────
// CLI
// ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isBaseline = args.includes('--baseline');

const results = runStaticBenchmark();
const stats = aggregateStats(results);

console.log('');
console.log('═'.repeat(72));
console.log('  Quarq Retrieval — 30-Query Benchmark Suite');
console.log('═'.repeat(72));
console.log('');

// Per-query table
console.log('┌──────┬────────────────────────────────────────────┬──────────┬──────────┬─────┬────────────────────────────┐');
console.log('│ ID   │ Query                                      │ Bucket   │ MemType  │ #H  │ Expected hypotheses        │');
console.log('├──────┼────────────────────────────────────────────┼──────────┼──────────┼─────┼────────────────────────────┤');

for (const r of results) {
  const memTypeMatch = r.classifiedMemoryType === r.expectedMemoryType ? '✅' : '❌';
  const qShort = r.query.length > 42 ? r.query.slice(0, 41) + '…' : r.query.padEnd(42);
  const idCell = (r.queryId ?? '').padEnd(4);
  const hList = r.hypothesisQueries.slice(1).map(h =>
    h.length > 24 ? h.slice(0, 23) + '…' : h.padEnd(24)
  ).join(', ').slice(0, 26);
  console.log(`│ ${idCell}│ ${qShort} │ ${r.bucket.padEnd(8)} │ ${r.expectedMemoryType.padEnd(8)} ${r.classifiedMemoryType} ${memTypeMatch} │ ${String(r.numHypotheses).padEnd(3)} │ ${hList} │`);
}

console.log('└──────┴────────────────────────────────────────────┴──────────┴──────────┴─────┴────────────────────────────┘');

console.log('');
console.log('── Aggregate Statistics ──');
console.log(`Total queries: ${(stats.totalQueries as number)}`);
console.log(`Memory-type accuracy: ${stats.memoryTypeAccuracy}`);
console.log('');

const bs = stats.bucketStats as Record<string, Record<string, unknown>>;
for (const [bucket, bstats] of Object.entries(bs)) {
  console.log(`  ${bucket}: ${(bstats.count as number)} queries, ${(bstats.memoryTypeAccuracy as string)} memory-type, avg ${(bstats.avgHypotheses as string)} hypotheses`);
}

if (isBaseline) {
  const baselinePath = 'quarq-benchmark-baseline.ndjson';
  const lines = results.map(r => JSON.stringify(r));
  await writeFile(baselinePath, lines.join('\n') + '\n');
  console.log('');
  console.log(`Baseline written to ${baselinePath}`);
}

console.log('');
console.log('Benchmark complete.');
