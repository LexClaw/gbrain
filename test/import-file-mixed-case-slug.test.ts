/**
 * Regression: `put` / importFromContent with a mixed-case slug.
 *
 * Bug: putPage lowercases the slug via validateSlug() (pglite-engine.ts:909 /
 * postgres-engine.ts:951), but _upsertChunksOnce looked up the page by the RAW
 * slug (`WHERE slug = $slug`), so the just-inserted lowercased row was never
 * found and the chunk step threw `Page not found: <slug> (source=default)`.
 * Every `gbrain put` whose slug contained an uppercase character failed
 * (e.g. `INDEX`, `Shared/*`, `lessons/L###-*`, `meta/*`), while all-lowercase
 * slugs worked.
 *
 * Fix: importFromContent canonicalizes the slug once, up front, so every
 * per-page tx write keys on the same string putPage stores under.
 *
 * Uses a real PGLiteEngine (not the Proxy mock in import-file.test.ts, whose
 * putPage does not lowercase and so cannot reproduce the divergence).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ type: 'pglite' } as never);
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

const CONTENT = `---
type: concept
title: Mixed Case Slug Regression
---

This body must chunk and land under the canonical (lowercased) slug so the
chunk-upsert page-id lookup finds the row putPage inserted.
`;

describe('importFromContent canonicalizes mixed-case slugs across the whole tx', () => {
  test('uppercase slug does not throw "Page not found" and chunks attach', async () => {
    // Pre-fix this threw: Page not found: lessons/L007-Mixed-Case (source=default).
    const result = await importFromContent(engine, 'lessons/L007-Mixed-Case', CONTENT, {
      noEmbed: true,
    });

    expect(result.status).toBe('imported');
    // Returned slug is canonical (matches the stored row + write-through path).
    expect(result.slug).toBe('lessons/l007-mixed-case');

    // Exactly one page row, stored under the lowercased slug.
    const pageRows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = $1 AND source_id = 'default'`,
      ['lessons/l007-mixed-case'],
    );
    expect(pageRows.length).toBe(1);

    // Chunks actually attached to that page (the throw path is gone).
    const chunkRows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_chunks WHERE page_id = $1`,
      [pageRows[0].id],
    );
    expect(chunkRows[0].n).toBeGreaterThan(0);

    // No orphan row survives at the raw mixed-case slug.
    const rawCase = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages WHERE slug = $1`,
      ['lessons/L007-Mixed-Case'],
    );
    expect(rawCase[0].n).toBe(0);
  });

  test('all-lowercase slug still works (control)', async () => {
    const result = await importFromContent(engine, 'lessons/l007-lower', CONTENT, {
      noEmbed: true,
    });
    expect(result.status).toBe('imported');
    expect(result.slug).toBe('lessons/l007-lower');
  });
});
