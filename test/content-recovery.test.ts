import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  applyRecoveryManifest,
  approvalHash,
  buildManifest,
  contentHash,
  createRecoveryPayloadBundle,
  gapLedger,
  manifestHash,
  payloadBundleHash,
  provisionRecoverySchema,
  rollbackBatch,
  rowActionHash,
  validateManifest,
  verifyRecovery,
  type ApprovalArtifact,
  type ManifestRow,
  type RecoveryPayloadBundle,
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

function exactRow(overrides: Partial<ManifestRow> = {}) {
  const predelete = [{
    source_id: 'src-a',
    source_uuid: 'uuid-a',
    slug: 'alpha',
    source_path: '/isolated/source-a',
    type: 'note',
    title: 'Alpha',
    compiled_truth: 'Recovered body',
    frontmatter: { recovered: true },
    pre_delete_evidence_kind: 'fixture',
    pre_delete_page_version_id: 'pv1',
    pre_delete_export_commit: 'export-sha',
    ...overrides,
  }];
  const bundle = createRecoveryPayloadBundle('run-test', predelete);
  const rows = buildManifest({
    predelete,
    live: [],
    batchId: 'b1',
    payloadBundleHash: payloadBundleHash(bundle),
    toolCommit: '6ada2d8e01b607bf6326b4f40c5e42f4c6e01378',
    targetIdentity: 'isolated-db',
    allowlistHash: 'a'.repeat(64),
  }, 'run-test');
  return { row: { ...rows[0], ...overrides }, bundle };
}

function approved(rows: ManifestRow[], bundle: RecoveryPayloadBundle): { approval: ApprovalArtifact; approvalHashValue: string; rows: ManifestRow[] } {
  const approval: ApprovalArtifact = {
    schema_version: 'recovery_approval_v1',
    run_id: 'run-test',
    batch_id: 'b1',
    manifest_hash: '',
    payload_bundle_hash: payloadBundleHash(bundle),
    row_action_hash: '',
    tool_commit: '6ada2d8e01b607bf6326b4f40c5e42f4c6e01378',
    target_identity: 'isolated-db',
    allowlist_hash: 'a'.repeat(64),
    approved_at: '2026-07-12T00:00:00.000Z',
    expires_at: '2999-01-01T00:00:00.000Z',
    signer: 'fixture-reviewer',
    signature: 'fixture-signature',
  };
  let patched = rows.map(row => ({ ...row, approval_hash: '0'.repeat(64) }));
  approval.manifest_hash = manifestHash(patched);
  approval.row_action_hash = rowActionHash(patched);
  const hash = approvalHash(approval);
  patched = rows.map(row => ({ ...row, approval_hash: hash }));
  approval.manifest_hash = manifestHash(patched);
  approval.row_action_hash = rowActionHash(patched);
  const finalHash = approvalHash(approval);
  patched = rows.map(row => ({ ...row, approval_hash: finalHash }));
  approval.manifest_hash = manifestHash(patched);
  approval.row_action_hash = rowActionHash(patched);
  return { approval, approvalHashValue: approvalHash(approval), rows: patched };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-recovery-test-'));
  engine = new PGLiteEngine();
  await engine.connect({ database_path: join(dir, 'brain.pglite') });
  await engine.initSchema();
  await provisionRecoverySchema(engine);
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await provisionRecoverySchema(engine);
  await seedSource();
});

describe('content recovery manifest classification', () => {
  test('quarantines every member of a duplicate source and slug group deterministically', () => {
    const rows = buildManifest({
      predelete: [
        { source_id: 'src-a', source_uuid: 'uuid-a', slug: 'same', source_path: '/isolated/source-a', type: 'note', title: 'One', compiled_truth: 'one', pre_delete_export_commit: 'export-sha' },
        { source_id: 'src-a', source_uuid: 'uuid-a', slug: 'same', source_path: '/isolated/source-a', type: 'note', title: 'Two', compiled_truth: 'two', pre_delete_export_commit: 'export-sha' },
      ],
      live: [],
    }, 'run-test');
    expect(rows.map(r => r.restore_action).sort()).toEqual(['quarantine_conflict', 'quarantine_conflict']);
    expect(rows.every(r => r.conflict_class === 'duplicate_source_slug')).toBe(true);

    const reversed = buildManifest({
      predelete: [
        { source_id: 'src-a', source_uuid: 'uuid-a', slug: 'same', source_path: '/isolated/source-a', type: 'note', title: 'Two', compiled_truth: 'two', pre_delete_export_commit: 'export-sha' },
        { source_id: 'src-a', source_uuid: 'uuid-a', slug: 'same', source_path: '/isolated/source-a', type: 'note', title: 'One', compiled_truth: 'one', pre_delete_export_commit: 'export-sha' },
      ],
      live: [],
    }, 'run-test');
    expect(reversed.map(r => `${r.title}:${r.restore_action}`)).toEqual(rows.map(r => `${r.title}:${r.restore_action}`));
  });

  test('missing exact identity fields fail closed', () => {
    const { row } = exactRow({ source_id: '', source_uuid: '' });
    row.pre_delete_identity_class = 'exact_predelete';
    const errors = validateManifest([row]).join('\n');
    expect(errors).toContain('exact_predelete missing source_id');
    expect(errors).toContain('exact_predelete missing source_uuid');
  });

  test('row-level gap ledger reconciles mutation blocked rows', () => {
    const rows = buildManifest({
      predelete: [{ source_id: 'src-a', slug: 'probable', compiled_truth: 'body' }],
      gaps: [{ slug: 'missing', gap_code: 'no_payload' }],
      live: [],
    }, 'run-test');
    const ledger = gapLedger(rows);
    expect(ledger).toContain('| src-a:probable |');
    expect(ledger).toContain('mutation_blocked=2');
  });
});

describe('content recovery applicator', () => {
  test('dry-run is deterministic and writes no audit rows', async () => {
    const { row, bundle } = exactRow();
    const approval = approved([row], bundle);
    const result = await applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle, dryRun: true });
    expect(result).toMatchObject({ applied: 1, dryRun: true, auditRows: 0 });
    const audit = await engine.executeRaw<{ count: string }>('SELECT COUNT(*)::text AS count FROM recovery_audit_rows');
    expect(audit[0]?.count ?? '0').toBe('0');
  });

  test('applies exact add rows from authenticated payload bytes and machine acceptance passes', async () => {
    const { row, bundle } = exactRow();
    const approval = approved([row], bundle);
    const result = await applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle });
    expect(result.applied).toBe(1);
    const pages = await engine.executeRaw<{ slug: string; compiled_truth: string; content_hash: string }>(`SELECT slug, compiled_truth, content_hash FROM pages WHERE source_id='src-a' AND slug='alpha' AND deleted_at IS NULL`);
    expect(pages).toHaveLength(1);
    expect(pages[0].compiled_truth).toBe('Recovered body\n');
    expect(pages[0].content_hash).toBe(row.pre_delete_content_hash);
    const acceptance = await verifyRecovery(engine, approval.rows, 'run-test', { batchId: 'b1', payloadBundle: bundle, approvalHash: approval.approvalHashValue });
    expect(Object.values(acceptance).every(v => v.pass)).toBe(true);
  });

  test('rejects payload bytes whose content hash does not match the manifest', async () => {
    const { row, bundle } = exactRow();
    const tampered: RecoveryPayloadBundle = { ...bundle, payloads: { ...bundle.payloads } };
    tampered.payloads[row.recovery_payload_hash] = { ...tampered.payloads[row.recovery_payload_hash], compiled_truth: 'different bytes' };
    const approval = approved([row], tampered);
    await expect(applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: tampered })).rejects.toThrow('payload bundle hash mismatch');
  });

  test('merge_exact restores complete content through an atomic CAS predicate', async () => {
    const live = await seedPage('live body');
    const { row, bundle } = exactRow({ restore_action: 'merge_exact', live_present: 'true', live_page_id: String(live.id), live_version: String(live.generation), live_content_hash: live.hash });
    const approval = approved([row], bundle);
    const result = await applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle });
    expect(result.applied).toBe(1);
    const pages = await engine.executeRaw<{ compiled_truth: string; content_hash: string }>(`SELECT compiled_truth, content_hash FROM pages WHERE id=$1`, [live.id]);
    expect(pages[0].compiled_truth).toBe('Recovered body\n');
    expect(pages[0].content_hash).toBe(row.pre_delete_content_hash);
  });

  test('CAS failure aborts the batch without audit rows', async () => {
    const live = await seedPage('live body');
    const { row, bundle } = exactRow({ restore_action: 'merge_exact', live_present: 'true', live_page_id: String(live.id), live_version: String(live.generation + 1), live_content_hash: live.hash });
    const approval = approved([row], bundle);
    await expect(applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle })).rejects.toThrow('CAS failed');
    const audit = await engine.executeRaw<{ count: string }>('SELECT COUNT(*)::text AS count FROM recovery_audit_rows');
    expect(audit[0]?.count ?? '0').toBe('0');
  });

  test('source uuid and path mismatches fail closed', async () => {
    const { row, bundle } = exactRow({ source_uuid: 'wrong-uuid' });
    const approval = approved([row], bundle);
    await expect(applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle })).rejects.toThrow('source uuid mismatch');
  });

  test('mid-batch crash rolls back uncommitted mutation', async () => {
    const { row, bundle } = exactRow();
    const approval = approved([row], bundle);
    await expect(applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle, crashAfter: 'after_mutation_before_commit' })).rejects.toThrow('fault injection');
    const pages = await engine.executeRaw<{ count: string }>(`SELECT COUNT(*)::text AS count FROM pages WHERE source_id='src-a' AND slug='alpha'`);
    expect(pages[0]?.count ?? '0').toBe('0');
  });

  test('rollback uses no-delete state transition and is idempotent', async () => {
    const { row, bundle } = exactRow();
    const approval = approved([row], bundle);
    await expect(applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle, crashAfter: 'after_commit_before_jsonl' })).rejects.toThrow('fault injection');
    let pages = await engine.executeRaw<{ active: string; deleted: string }>(`SELECT COUNT(*) FILTER (WHERE deleted_at IS NULL)::text AS active, COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)::text AS deleted FROM pages WHERE source_id='src-a' AND slug='alpha'`);
    expect(pages[0]).toMatchObject({ active: '1', deleted: '0' });
    const rollback = await rollbackBatch(engine, 'run-test', 'b1');
    expect(rollback.rolledBack).toBe(1);
    const repeated = await rollbackBatch(engine, 'run-test', 'b1');
    expect(repeated.rolledBack).toBe(0);
    pages = await engine.executeRaw<{ active: string; deleted: string }>(`SELECT COUNT(*) FILTER (WHERE deleted_at IS NULL)::text AS active, COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)::text AS deleted FROM pages WHERE source_id='src-a' AND slug='alpha'`);
    expect(pages[0]).toMatchObject({ active: '0', deleted: '1' });
  });

  test('rollback refuses after post-apply mutation changes the after-image', async () => {
    const { row, bundle } = exactRow();
    const approval = approved([row], bundle);
    await applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle });
    await engine.executeRaw(`UPDATE pages SET compiled_truth='operator edit', content_hash=$1 WHERE source_id='src-a' AND slug='alpha'`, [contentHash('operator edit')]);
    await expect(rollbackBatch(engine, 'run-test', 'b1')).rejects.toThrow('rollback CAS failed');
  });
});
