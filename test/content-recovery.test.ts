import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  applyRecoveryManifest,
  buildManifest,
  contentHash,
  rollbackBatch,
  validateManifest,
  verifyRecovery,
  type ManifestRow,
} from '../src/recovery/content-recovery.ts';

let engine: PGLiteEngine;
let dir: string;

async function seedSource(id = 'src-a') {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config)
     VALUES ($1, $1, '/isolated/source-a', '{"uuid":"uuid-a"}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [id],
  );
}

async function seedPage(body: string, slug = 'alpha') {
  const hash = contentHash(body);
  const rows = await engine.executeRaw<{ id: number; generation: number; updated_at: string }>(
    `INSERT INTO pages (source_id, slug, type, title, compiled_truth, content_hash)
     VALUES ('src-a', $1, 'note', 'Alpha', $2, $3)
     RETURNING id, generation, updated_at`,
    [slug, body, hash],
  );
  return { ...rows[0], hash };
}

function exactRow(overrides: Partial<ManifestRow> = {}): ManifestRow {
  const rows = buildManifest({
    predelete: [{
      source_id: 'src-a',
      source_uuid: 'uuid-a',
      slug: 'alpha',
      source_path: '/isolated/source-a',
      type: 'note',
      title: 'Alpha',
      compiled_truth: 'Recovered body',
      pre_delete_evidence_kind: 'fixture',
      pre_delete_page_version_id: 'pv1',
      pre_delete_export_commit: 'export-sha',
      ...overrides,
    }],
    live: [],
  }, 'run-test');
  return { ...rows[0], ...overrides };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-recovery-test-'));
  engine = new PGLiteEngine();
  await engine.connect({ database_path: join(dir, 'brain.pglite') });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await seedSource();
});

describe('content recovery manifest classification', () => {
  test('quarantines source and slug collisions deterministically', () => {
    const rows = buildManifest({
      predelete: [
        { source_id: 'src-a', source_uuid: 'uuid-a', slug: 'same', type: 'note', title: 'One', compiled_truth: 'one' },
        { source_id: 'src-a', source_uuid: 'uuid-a', slug: 'same', type: 'note', title: 'Two', compiled_truth: 'two' },
      ],
      live: [],
    }, 'run-test');
    expect(rows.map(r => r.restore_action).sort()).toEqual(['add_exact', 'quarantine_conflict']);
    expect(rows.some(r => r.conflict_class === 'duplicate_source_slug')).toBe(true);
  });

  test('missing identity cannot be claimed as exact', () => {
    const row = exactRow({ source_id: '', source_uuid: '' });
    row.pre_delete_identity_class = 'exact_predelete';
    expect(validateManifest([row]).join('\n')).toContain('exact_predelete missing source identity');
  });

  test('post-incident live writes are protected', () => {
    const rows = buildManifest({
      predelete: [{ source_id: 'src-a', source_uuid: 'uuid-a', slug: 'alpha', type: 'note', title: 'Alpha', compiled_truth: 'old' }],
      live: [{ source_id: 'src-a', slug: 'alpha', compiled_truth: 'new', post_incident_write: 'true' }],
    }, 'run-test');
    expect(rows[0].restore_action).toBe('quarantine_conflict');
  });
});

describe('content recovery applicator', () => {
  test('dry-run is deterministic and writes no audit rows', async () => {
    const row = exactRow();
    const result = await applyRecoveryManifest(engine, [row], { batchId: 'b1', approvalHash: 'approval', dryRun: true });
    expect(result).toMatchObject({ applied: 1, dryRun: true, auditRows: 0 });
    const audit = await engine.executeRaw<{ count: string }>('SELECT COUNT(*)::text AS count FROM recovery_audit_rows');
    expect(audit[0]?.count ?? '0').toBe('0');
  });

  test('applies exact add rows and machine acceptance passes', async () => {
    const row = exactRow();
    const result = await applyRecoveryManifest(engine, [row], { batchId: 'b1', approvalHash: 'approval' });
    expect(result.applied).toBe(1);
    const pages = await engine.executeRaw<{ slug: string }>(`SELECT slug FROM pages WHERE source_id='src-a' AND slug='alpha'`);
    expect(pages).toHaveLength(1);
    const acceptance = await verifyRecovery(engine, [row], 'run-test');
    expect(Object.values(acceptance).every(v => v.pass)).toBe(true);
  });

  test('CAS failure aborts the batch', async () => {
    const live = await seedPage('live body');
    const row = exactRow({ restore_action: 'merge_exact', live_present: 'true', live_page_id: String(live.id), live_version: String(live.generation + 1), live_content_hash: live.hash });
    await expect(applyRecoveryManifest(engine, [row], { batchId: 'b1', approvalHash: 'approval' })).rejects.toThrow('CAS failed');
    const audit = await engine.executeRaw<{ count: string }>('SELECT COUNT(*)::text AS count FROM recovery_audit_rows');
    expect(audit[0]?.count ?? '0').toBe('0');
  });

  test('mid-batch crash rolls back uncommitted mutation', async () => {
    const row = exactRow();
    await expect(applyRecoveryManifest(engine, [row], { batchId: 'b1', approvalHash: 'approval', crashAfter: 'after_mutation_before_commit' })).rejects.toThrow('fault injection');
    const pages = await engine.executeRaw<{ count: string }>(`SELECT COUNT(*)::text AS count FROM pages WHERE source_id='src-a' AND slug='alpha'`);
    expect(pages[0]?.count ?? '0').toBe('0');
  });

  test('rollback after committed failure removes exact additions', async () => {
    const row = exactRow();
    await expect(applyRecoveryManifest(engine, [row], { batchId: 'b1', approvalHash: 'approval', crashAfter: 'after_commit_before_jsonl' })).rejects.toThrow('fault injection');
    let pages = await engine.executeRaw<{ count: string }>(`SELECT COUNT(*)::text AS count FROM pages WHERE source_id='src-a' AND slug='alpha'`);
    expect(pages[0]?.count ?? '0').toBe('1');
    const rollback = await rollbackBatch(engine, 'run-test', 'b1');
    expect(rollback.rolledBack).toBe(1);
    pages = await engine.executeRaw<{ count: string }>(`SELECT COUNT(*)::text AS count FROM pages WHERE source_id='src-a' AND slug='alpha'`);
    expect(pages[0]?.count ?? '0').toBe('0');
  });
});
