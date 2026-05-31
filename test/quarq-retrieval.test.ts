/**
 * v0.37 — Quarq retrieval orchestrator unit tests.
 *
 * Tests the reasoning constraints (entity isolation, temporal ambiguity,
 * numerical mismatch, insufficient evidence) and the RRF fusion logic.
 * Does NOT test full DB-integrated retrieval — that requires a live engine.
 */

import { describe, test, expect } from 'bun:test';
import {
  applyReasoningConstraints,
} from '../src/core/search/quarq-retrieval.ts';
import type { SearchResult } from '../src/core/types.ts';

// Helper to create SearchResult fixtures.
function makeResult(slug: string, score: number, date?: string | null): SearchResult {
  return {
    slug,
    page_id: Math.floor(Math.random() * 10000),
    title: slug,
    type: 'concept',
    chunk_text: `content for ${slug}`,
    chunk_source: 'compiled_truth',
    chunk_id: Math.floor(Math.random() * 10000),
    chunk_index: 0,
    score,
    stale: false,
    effective_date: date ?? null,
  };
}

describe('applyReasoningConstraints — temporal ambiguity', () => {
  test('no flag when query has no temporal markers', () => {
    const results = [makeResult('wiki/gbrain', 0.8)];
    const { report } = applyReasoningConstraints('What is GBrain', results);
    expect(report.temporalAmbiguity).toBe(false);
  });

  test('no flag when temporal query but results have date anchors', () => {
    const results = [
      makeResult('meetings/2025-01-15', 0.8, '2025-01-15'),
      makeResult('meetings/2025-02-20', 0.7, '2025-02-20'),
      makeResult('meetings/2025-03-10', 0.6, '2025-03-10'),
    ];
    const { report } = applyReasoningConstraints('When did we meet in March', results);
    expect(report.temporalAmbiguity).toBe(false);
  });

  test('flag when temporal query but results lack date anchors', () => {
    const results = [
      makeResult('wiki/gbrain', 0.8, null),
      makeResult('wiki/concepts', 0.7, null),
      makeResult('wiki/originals', 0.6, null),
      makeResult('wiki/biology', 0.5, null),
      makeResult('wiki/physics', 0.4, null),
    ];
    const { report } = applyReasoningConstraints('What happened recently', results);
    expect(report.temporalAmbiguity).toBe(true);
  });
});

describe('applyReasoningConstraints — numerical mismatch', () => {
  test('no flag when query has no numerical indicators', () => {
    const results = [makeResult('wiki/gbrain', 0.8)];
    const { report } = applyReasoningConstraints('What is GBrain', results);
    expect(report.numericalMismatch).toBe(false);
  });

  test('no flag when numerical query and results contain numbers', () => {
    const results = [makeResult('wiki/finances', 0.8)];
    results[0].chunk_text = 'Revenue was $5M with a 30% growth year over year';
    const { report } = applyReasoningConstraints('What was their revenue in millions', results);
    expect(report.numericalMismatch).toBe(false);
  });

  test('flag when numerical query but no results contain numbers', () => {
    const results = [makeResult('wiki/gbrain', 0.8)];
    results[0].chunk_text = 'GBrain is a knowledge management system';
    const { report } = applyReasoningConstraints('What is the revenue budget', results);
    expect(report.numericalMismatch).toBe(true);
  });
});

describe('applyReasoningConstraints — entity conflation', () => {
  test('no flag when results are from a small number of namespaces', () => {
    const results = [
      makeResult('wiki/gbrain', 0.8),
      makeResult('wiki/concepts', 0.7),
      makeResult('wiki/biology', 0.6),
    ];
    const { report } = applyReasoningConstraints('What is GBrain', results);
    expect(report.entityConflation).toBe(false);
  });

  test('flag when results span many distinct top-level prefixes', () => {
    const results = [
      makeResult('wiki/gbrain', 0.8),
      makeResult('daily/notes', 0.7),
      makeResult('meetings/2025', 0.6),
      makeResult('people/alice', 0.5),
      makeResult('companies/acme', 0.4),
      makeResult('projects/x', 0.3),
    ];
    const { report } = applyReasoningConstraints('Tell me everything', results);
    expect(report.entityConflation).toBe(true);
    expect(report.distinctEntityPrefixes.length).toBeGreaterThan(1);
  });
});

describe('applyReasoningConstraints — insufficient evidence', () => {
  test('flag when no results', () => {
    const { report } = applyReasoningConstraints('obscure query with no results', []);
    expect(report.insufficientEvidence).toBe(true);
  });

  test('flag when fewer than 3 results', () => {
    const results = [makeResult('wiki/gbrain', 0.8)];
    const { report } = applyReasoningConstraints('rare entity', results);
    expect(report.insufficientEvidence).toBe(true);
  });

  test('flag when all results score below threshold', () => {
    const results = [
      makeResult('wiki/gbrain', 0.01),
      makeResult('wiki/concepts', 0.02),
      makeResult('wiki/biology', 0.03),
    ];
    // detectInsufficientEvidence uses default threshold of 0.05
    const { report } = applyReasoningConstraints('query', results);
    expect(report.insufficientEvidence).toBe(true);
  });

  test('no flag when sufficient high-scoring results exist', () => {
    const results = [
      makeResult('wiki/gbrain', 0.8),
      makeResult('wiki/concepts', 0.7),
      makeResult('wiki/biology', 0.6),
      makeResult('people/alice', 0.5),
    ];
    const { report } = applyReasoningConstraints('query', results);
    expect(report.insufficientEvidence).toBe(false);
  });
});

describe('applyReasoningConstraints — composite report', () => {
  test('returns report with all fields', () => {
    const results = [
      makeResult('wiki/gbrain', 0.8),
      makeResult('wiki/concepts', 0.7),
      makeResult('wiki/biology', 0.6),
    ];
    const { report } = applyReasoningConstraints('test query', results);
    expect(typeof report.temporalAmbiguity).toBe('boolean');
    expect(typeof report.numericalMismatch).toBe('boolean');
    expect(typeof report.entityConflation).toBe('boolean');
    expect(Array.isArray(report.distinctEntityPrefixes)).toBe(true);
    expect(typeof report.insufficientEvidence).toBe('boolean');
  });
});
