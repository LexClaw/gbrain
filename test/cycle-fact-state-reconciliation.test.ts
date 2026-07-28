/**
 * Regression: fence reconciliation must preserve runtime-derived fact state.
 *
 * Exercises the normal cycle ordering across two sources:
 *   extract_facts -> consolidate -> extract_facts -> consolidate.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';
import { configureGateway } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

const SLUG = 'people/alice-example';
const OLD_DATES = ['2020-01-01', '2021-01-01', '2022-01-01'];

function fence(claims: string[]): string {
  const rows = claims.map((claim, i) =>
    `| ${i + 1} | ${claim} | fact | 0.9 | world | high | ${OLD_DATES[i]} |  | meeting-notes:weekly |  |`,
  ).join('\n');
  return `# Alice Example

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows}
<!--- gbrain:facts:end -->
`;
}

function unitVec(): string {
  const values = new Float32Array(1536);
  values[0] = 1;
  return `[${Array.from(values).join(',')}]`;
}

async function putSourcePage(sourceId: string, claims: string[]): Promise<void> {
  await engine.putPage(SLUG, {
    title: `Alice Example (${sourceId})`,
    type: 'person',
    compiled_truth: fence(claims),
    frontmatter: {},
    timeline: '',
  }, { sourceId });
}

interface FactState {
  id: number;
  source_id: string;
  row_num: number;
  fact: string;
  valid_until: Date | null;
  expired_at: Date | null;
  superseded_by: number | null;
  consolidated_at: Date | null;
  consolidated_into: number | null;
}

async function states(sourceId: string): Promise<FactState[]> {
  return engine.executeRaw<FactState>(
    `SELECT id, source_id, row_num, fact, valid_until, expired_at,
            superseded_by, consolidated_at, consolidated_into
       FROM facts
      WHERE source_id = $1 AND source_markdown_slug = $2
      ORDER BY row_num`,
    [sourceId, SLUG],
  );
}

beforeAll(async () => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: {},
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM facts');
  await engine.executeRaw('DELETE FROM takes');
  await engine.executeRaw("DELETE FROM pages WHERE slug = 'people/alice-example'");
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES
       ('work', 'work', '{}'::jsonb),
       ('home', 'home', '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
  );
});

describe('extract_facts consolidation-state reconciliation', () => {
  test('preserves stable groups, invalidates a changed consolidation group, and stays source-scoped', async () => {
    const workClaims = ['Work fact one', 'Work fact two', 'Work fact three'];
    const homeClaims = ['Home fact one', 'Home fact two', 'Home fact three'];
    await putSourcePage('work', workClaims);
    await putSourcePage('home', homeClaims);

    await runExtractFacts(engine, { slugs: [SLUG], sourceId: 'work' });
    await runExtractFacts(engine, { slugs: [SLUG], sourceId: 'home' });
    await engine.executeRaw(
      `UPDATE facts SET embedding = $1::vector, embedded_at = now()
        WHERE source_id IN ('work', 'home') AND source_markdown_slug = $2`,
      [unitVec(), SLUG],
    );

    const firstConsolidate = await runPhaseConsolidate(engine, {
      minOldestAgeMs: 0,
      minFactsPerBucket: 3,
    });
    expect(firstConsolidate.details.facts_consolidated).toBe(6);

    const workAfterFirst = await states('work');
    const homeAfterFirst = await states('home');
    expect(workAfterFirst.every(row => row.consolidated_at && row.consolidated_into)).toBe(true);
    expect(workAfterFirst.slice(0, 2).every(row => row.valid_until)).toBe(true);

    await runExtractFacts(engine, { slugs: [SLUG], sourceId: 'work' });
    const workAfterStableExtract = await states('work');
    expect(workAfterStableExtract.map(row => ({
      fact: row.fact,
      valid_until: row.valid_until,
      expired_at: row.expired_at,
      consolidated_at: row.consolidated_at,
      consolidated_into: row.consolidated_into,
    }))).toEqual(workAfterFirst.map(row => ({
      fact: row.fact,
      valid_until: row.valid_until,
      expired_at: row.expired_at,
      consolidated_at: row.consolidated_at,
      consolidated_into: row.consolidated_into,
    })));
    expect(await states('home')).toEqual(homeAfterFirst);

    const stableConsolidate = await runPhaseConsolidate(engine, {
      minOldestAgeMs: 0,
      minFactsPerBucket: 3,
    });
    expect(stableConsolidate.details.facts_consolidated).toBe(0);

    await putSourcePage('work', [workClaims[0], 'Work fact two changed', workClaims[2]]);
    await runExtractFacts(engine, { slugs: [SLUG], sourceId: 'work' });

    const workAfterChangedExtract = await states('work');
    expect(workAfterChangedExtract[0]).toEqual(expect.objectContaining({
      fact: workClaims[0],
      valid_until: null,
      consolidated_at: null,
      consolidated_into: null,
    }));
    expect(workAfterChangedExtract[1]).toEqual(expect.objectContaining({
      fact: 'Work fact two changed',
      valid_until: null,
      expired_at: null,
      consolidated_at: null,
      consolidated_into: null,
    }));
    expect(workAfterChangedExtract[2]).toEqual(expect.objectContaining({
      fact: workClaims[2],
      consolidated_at: null,
      consolidated_into: null,
    }));
    expect(await states('home')).toEqual(homeAfterFirst);

    await engine.executeRaw(
      `UPDATE facts SET embedding = $1::vector, embedded_at = now()
        WHERE source_id = 'work' AND source_markdown_slug = $2`,
      [unitVec(), SLUG],
    );
    const changedConsolidate = await runPhaseConsolidate(engine, {
      minOldestAgeMs: 0,
      minFactsPerBucket: 3,
    });
    expect(changedConsolidate.details.facts_consolidated).toBe(3);
  });

  test('remaps superseded_by when stable fence rows receive new database ids', async () => {
    await putSourcePage('work', ['Fact one', 'Fact two', 'Fact three']);
    await runExtractFacts(engine, { slugs: [SLUG], sourceId: 'work' });

    const before = await states('work');
    await engine.executeRaw(
      `UPDATE facts SET expired_at = now(), superseded_by = $1 WHERE id = $2`,
      [before[1].id, before[0].id],
    );

    await runExtractFacts(engine, { slugs: [SLUG], sourceId: 'work' });
    const after = await states('work');

    expect(after[0].id).not.toBe(before[0].id);
    expect(after[1].id).not.toBe(before[1].id);
    expect(after[0].expired_at).not.toBeNull();
    expect(after[0].superseded_by).toBe(after[1].id);
  });
});
