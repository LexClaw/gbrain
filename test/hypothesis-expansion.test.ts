/**
 * v0.37 — Hypothesis expansion unit tests.
 *
 * Tests the deterministic extraction across entity, action, temporal,
 * and topical dimensions plus sanitization and deduplication.
 */

import { describe, test, expect } from 'bun:test';
import { extractHypotheses, hypothesisQueries } from '../src/core/search/hypothesis-expansion.ts';
import type { HypothesisKind } from '../src/core/search/hypothesis-expansion.ts';

describe('extractHypotheses', () => {
  test('returns original query with empty hypotheses for empty string', () => {
    const result = extractHypotheses('');
    expect(result.original).toBe('');
    expect(result.hypotheses.length).toBe(0);
  });

  test('extracts entity hypotheses from capitalized names', () => {
    const result = extractHypotheses('What did Alice Chen tell Bob about the merger');
    const entities = result.hypotheses.filter(h => h.kind === 'entity');
    expect(entities.length).toBeGreaterThan(0);
    const names = entities.map(h => h.query.toLowerCase());
    expect(names.some(n => n.includes('alice'))).toBe(true);
  });

  test('extracts action hypotheses from meeting verbs', () => {
    const result = extractHypotheses('When did Alice meet with investors');
    const actions = result.hypotheses.filter(h => h.kind === 'action');
    expect(actions.some(a => a.query === 'meeting')).toBe(true);
  });

  test('extracts action hypotheses from investment verbs', () => {
    const result = extractHypotheses('Series B funding for the startup');
    const actions = result.hypotheses.filter(h => h.kind === 'action');
    expect(actions.some(a => a.query === 'investment' || a.query === 'fundraising')).toBe(true);
  });

  test('extracts temporal hypotheses from date expressions', () => {
    const result = extractHypotheses('What happened last week');
    const temporal = result.hypotheses.filter(h => h.kind === 'temporal');
    expect(temporal.length).toBeGreaterThan(0);
  });

  test('extracts temporal hypotheses from relative time', () => {
    const result = extractHypotheses('Recent meetings about the Q4 2025 budget');
    const temporal = result.hypotheses.filter(h => h.kind === 'temporal');
    expect(temporal.length).toBeGreaterThan(0);
  });

  test('extracts topical hypotheses from what-is queries', () => {
    const result = extractHypotheses('What is GBrain');
    const topical = result.hypotheses.filter(h => h.kind === 'topical');
    expect(topical.length).toBeGreaterThan(0);
  });

  test('caps hypotheses to 3 maximum', () => {
    const result = extractHypotheses('When did Alice Chen meet the investors last quarter about the merger');
    expect(result.hypotheses.length).toBeLessThanOrEqual(3);
  });

  test('deduplicates hypotheses with same normalized query', () => {
    const result = extractHypotheses('What is Alice Alice');
    const queries = result.hypotheses.map(h => h.query.toLowerCase());
    const uniqueQueries = new Set(queries);
    expect(uniqueQueries.size).toBe(queries.length);
  });

  test('filters out hypotheses identical to the original query', () => {
    const result = extractHypotheses('GBrain');
    const filtered = result.hypotheses.filter(
      h => h.query.toLowerCase() === 'gbrain',
    );
    expect(filtered.length).toBe(0);
  });

  test('sanitizes control characters from hypotheses', () => {
    const result = extractHypotheses('[[Alice\x01Chen]]');
    const entities = result.hypotheses.filter(h => h.kind === 'entity');
    for (const h of entities) {
      expect(h.query).not.toMatch(/[\x00-\x1f\x7f]/);
    }
  });

  test('rejects hypotheses longer than 200 chars', () => {
    const longString = 'A'.repeat(250);
    const result = extractHypotheses(`What is ${longString}`);
    for (const h of result.hypotheses) {
      expect(h.query.length).toBeLessThanOrEqual(200);
    }
  });

  test('sorts hypotheses by confidence then kind priority', () => {
    const result = extractHypotheses('When did Alice invest in the startup yesterday');
    if (result.hypotheses.length >= 2) {
      for (let i = 0; i < result.hypotheses.length - 1; i++) {
        if (result.hypotheses[i].confidence === result.hypotheses[i + 1].confidence) {
          // Same confidence: check kind priority ordering
          const kindPriority: Record<HypothesisKind, number> = {
            entity: 0, action: 1, temporal: 2, topical: 3,
          };
          expect(kindPriority[result.hypotheses[i].kind]).toBeLessThanOrEqual(
            kindPriority[result.hypotheses[i + 1].kind],
          );
        } else {
          expect(result.hypotheses[i].confidence).toBeGreaterThanOrEqual(
            result.hypotheses[i + 1].confidence,
          );
        }
      }
    }
  });
});

describe('hypothesisQueries', () => {
  test('returns original as first query followed by hypotheses', () => {
    const set = extractHypotheses('What did Alice do');
    const queries = hypothesisQueries(set);
    expect(queries[0]).toBe(set.original);
    for (let i = 1; i < queries.length; i++) {
      expect(queries[i]).toBe(set.hypotheses[i - 1].query);
    }
  });

  test('returns only original when no hypotheses', () => {
    const set = extractHypotheses('x');
    const queries = hypothesisQueries(set);
    expect(queries).toEqual([set.original]);
  });
});
