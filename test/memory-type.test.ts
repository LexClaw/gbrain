/**
 * v0.37 — Memory type classification + filtering tests.
 *
 * Tests:
 * - Exhaustive PageType mapping (all 22 values)
 * - classifyMemoryType deterministic signals
 * - pageTypesForMemoryType completeness
 * - filterByMemoryType correctness
 * - validateMemoryTypeExhaustive guard
 */

import { describe, test, expect } from 'bun:test';
import {
  classifyMemoryType,
  pageTypesForMemoryType,
  filterByMemoryType,
  validateMemoryTypeExhaustive,
} from '../src/core/search/memory-type.ts';
import type { MemoryType, PageType, SearchResult } from '../src/core/types.ts';
import { ALL_PAGE_TYPES } from '../src/core/types.ts';

describe('validateMemoryTypeExhaustive', () => {
  test('passes for the canonical mapping', () => {
    // Should not throw — all 22 PageTypes are mapped.
    expect(() => validateMemoryTypeExhaustive()).not.toThrow();
  });
});

describe('pageTypesForMemoryType', () => {
  test('semantic includes person, company, concept', () => {
    const types = pageTypesForMemoryType('semantic');
    expect(types).toContain('person');
    expect(types).toContain('company');
    expect(types).toContain('concept');
  });

  test('episodic includes meeting, note, email', () => {
    const types = pageTypesForMemoryType('episodic');
    expect(types).toContain('meeting');
    expect(types).toContain('note');
    expect(types).toContain('email');
  });

  test('procedural includes code', () => {
    const types = pageTypesForMemoryType('procedural');
    expect(types).toContain('code');
  });

  test('general returns all PageTypes', () => {
    const types = pageTypesForMemoryType('general');
    expect(types).toHaveLength(ALL_PAGE_TYPES.length);
  });

  test('all 22 PageTypes are covered by exactly one non-general memory type', () => {
    const semantic = pageTypesForMemoryType('semantic');
    const episodic = pageTypesForMemoryType('episodic');
    const procedural = pageTypesForMemoryType('procedural');
    const allNonGeneral = [...semantic, ...episodic, ...procedural];
    expect(allNonGeneral.length).toBe(ALL_PAGE_TYPES.length);
    // No overlap
    const seen = new Set<string>();
    for (const pt of allNonGeneral) {
      expect(seen.has(pt)).toBe(false);
      seen.add(pt);
    }
  });
});

describe('classifyMemoryType', () => {
  test('procedural: how-to queries', () => {
    expect(classifyMemoryType('How to deploy gbrain')).toBe('procedural');
    expect(classifyMemoryType('implement the API endpoint')).toBe('procedural');
  });

  test('procedural: code keywords', () => {
    expect(classifyMemoryType('function class method interface')).toBe('procedural');
    expect(classifyMemoryType('npm install the package')).toBe('procedural');
  });

  test('episodic: meeting queries', () => {
    expect(classifyMemoryType('When did we meet last week')).toBe('episodic');
    expect(classifyMemoryType('What happened in the meeting yesterday')).toBe('episodic');
  });

  test('episodic: communication queries', () => {
    expect(classifyMemoryType('Find the Slack message about the launch')).toBe('episodic');
    expect(classifyMemoryType('Recent emails about the funding')).toBe('episodic');
  });

  test('semantic: definition queries', () => {
    expect(classifyMemoryType('Who is the founder of Acme')).toBe('semantic');
    expect(classifyMemoryType('What is GBrain')).toBe('semantic');
  });

  test('semantic: entity queries', () => {
    expect(classifyMemoryType('Tell me about the startup')).toBe('semantic');
  });

  test('general: empty string', () => {
    expect(classifyMemoryType('')).toBe('general');
  });

  test('general: short query', () => {
    expect(classifyMemoryType('hi')).toBe('general');
  });

  test('general: ambiguous query returns general', () => {
    const result = classifyMemoryType('the thing over there');
    expect(result).toBe('general');
  });
});

describe('filterByMemoryType', () => {
  function makeResult(type: PageType, id: number): SearchResult {
    return {
      slug: `test-${id}`,
      page_id: id,
      title: `Test ${id}`,
      type,
      chunk_text: `chunk ${id}`,
      chunk_source: 'compiled_truth',
      chunk_id: id,
      chunk_index: 0,
      score: 0.5,
      stale: false,
    };
  }

  test('general returns all results', () => {
    const results = [
      makeResult('person', 1),
      makeResult('meeting', 2),
      makeResult('code', 3),
    ];
    const filtered = filterByMemoryType(results, 'general');
    expect(filtered).toHaveLength(3);
  });

  test('semantic filters to semantic types', () => {
    const results = [
      makeResult('person', 1),
      makeResult('meeting', 2),
      makeResult('company', 3),
    ];
    const filtered = filterByMemoryType(results, 'semantic');
    expect(filtered).toHaveLength(2);
    expect(filtered[0].type).toBe('person');
    expect(filtered[1].type).toBe('company');
  });

  test('episodic filters to episodic types', () => {
    const results = [
      makeResult('person', 1),
      makeResult('meeting', 2),
      makeResult('email', 3),
      makeResult('code', 4),
    ];
    const filtered = filterByMemoryType(results, 'episodic');
    expect(filtered).toHaveLength(2);
    expect(filtered.map(r => r.type).includes('meeting')).toBe(true);
    expect(filtered.map(r => r.type).includes('email')).toBe(true);
  });

  test('procedural filters to code only', () => {
    const results = [
      makeResult('person', 1),
      makeResult('code', 2),
    ];
    const filtered = filterByMemoryType(results, 'procedural');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].type).toBe('code');
  });

  test('empty results returns empty', () => {
    const filtered = filterByMemoryType([], 'semantic');
    expect(filtered).toHaveLength(0);
  });
});
