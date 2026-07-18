import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildChecks } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM facts WHERE source LIKE 'cli:extract-conversation-facts%'`);
  await engine.executeRaw(`DELETE FROM ingest_log WHERE source_type = 'facts:absorb'`);
});

describe('facts_extraction_health — conversation extraction yield', () => {
  test('warns when extract-conversation-facts completes pages but inserts zero facts', async () => {
    await engine.insertFacts([
      {
        fact: 'EXTRACTION_COMPLETE',
        kind: 'fact',
        entity_slug: null,
        source: 'cli:extract-conversation-facts:terminal',
        source_session: 'cli:extract-conversation-facts:terminal:sessions/example-zero',
        confidence: 1,
        notability: 'low',
        row_num: 0,
        source_markdown_slug: 'sessions/example-zero',
      },
    ] as never, { source_id: 'default' });

    const checks = await buildChecks(engine, ['--json', '--scope=brain']);
    const check = checks.find(c => c.name === 'facts_extraction_health');
    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('zero extracted facts');
    expect(check?.message).toContain('default: 0 fact row(s) from 0/1 completed page(s)');
  }, 20_000);

  test('stays ok when completed pages have per-segment fact rows', async () => {
    await engine.insertFacts([
      {
        fact: 'Alice Example joined Acme Corp.',
        kind: 'event',
        entity_slug: 'people/alice-example',
        source: 'cli:extract-conversation-facts',
        source_session: 'cli:extract-conversation-facts:sessions/example-ok',
        confidence: 1,
        notability: 'high',
        row_num: 0,
        source_markdown_slug: 'sessions/example-ok',
      },
      {
        fact: 'EXTRACTION_COMPLETE',
        kind: 'fact',
        entity_slug: null,
        source: 'cli:extract-conversation-facts:terminal',
        source_session: 'cli:extract-conversation-facts:terminal:sessions/example-ok',
        confidence: 1,
        notability: 'low',
        row_num: 1,
        source_markdown_slug: 'sessions/example-ok',
      },
    ] as never, { source_id: 'default' });

    const checks = await buildChecks(engine, ['--json', '--scope=brain']);
    const check = checks.find(c => c.name === 'facts_extraction_health');
    expect(check?.status).toBe('ok');
    expect(check?.message).toContain('default: 2 fact row(s) from 1/1 completed page(s)');
  }, 20_000);
});
