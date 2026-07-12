import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
  recoverySchemaStatus,
  signApprovalArtifact,
  verifyApprovalSignature,
  type ApprovalArtifact,
  type ManifestRow,
  type RecoveryPayloadBundle,
  type TrustedApprovalKey,
} from '../src/recovery/content-recovery.ts';

let engine: PGLiteEngine;
let dir: string;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const TRUSTED_KEYS: TrustedApprovalKey[] = [{ key_id: 'fixture-reviewer', signer: 'fixture-reviewer', public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
const APPLY = { trustedApprovalKeys: TRUSTED_KEYS, now: Date.parse('2026-07-12T00:00:01.000Z') };

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
  let patched = rows.map(row => ({ ...row, approval_hash: '0'.repeat(64) }));
  let approval: ApprovalArtifact = signApprovalArtifact({
    schema_version: 'recovery_approval_v1',
    run_id: 'run-test',
    batch_id: 'b1',
    manifest_hash: manifestHash(patched),
    payload_bundle_hash: payloadBundleHash(bundle),
    row_action_hash: rowActionHash(patched),
    tool_commit: '6ada2d8e01b607bf6326b4f40c5e42f4c6e01378',
    target_identity: 'isolated-db',
    allowlist_hash: 'a'.repeat(64),
    approved_at: '2026-07-12T00:00:00.000Z',
    expires_at: '2026-07-13T00:00:00.000Z',
    signer: 'fixture-reviewer',
  }, PRIVATE_KEY_PEM);
  for (let i = 0; i < 3; i++) {
    const hash = approvalHash(approval);
    patched = rows.map(row => ({ ...row, approval_hash: hash }));
    const { signature: _signature, ...unsignedApproval } = approval;
    approval = signApprovalArtifact({ ...unsignedApproval, manifest_hash: manifestHash(patched), row_action_hash: rowActionHash(patched) }, PRIVATE_KEY_PEM);
  }
  const finalHash = approvalHash(approval);
  patched = rows.map(row => ({ ...row, approval_hash: finalHash }));
  const { signature: _finalSignature, ...unsignedFinalApproval } = approval;
  approval = signApprovalArtifact({ ...unsignedFinalApproval, manifest_hash: manifestHash(patched), row_action_hash: rowActionHash(patched) }, PRIVATE_KEY_PEM);
  return { approval, approvalHashValue: approvalHash(approval), rows: rows.map(row => ({ ...row, approval_hash: approvalHash(approval) })) };
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
    const result = await applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle, ...APPLY, dryRun: true });
    expect(result).toMatchObject({ applied: 1, dryRun: true, auditRows: 0 });
    const audit = await engine.executeRaw<{ count: string }>('SELECT COUNT(*)::text AS count FROM recovery_audit_rows');
    expect(audit[0]?.count ?? '0').toBe('0');
  });

  test('applies exact add rows from authenticated payload bytes and machine acceptance passes', async () => {
    const { row, bundle } = exactRow();
    const approval = approved([row], bundle);
    const result = await applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle, ...APPLY });
    expect(result.applied).toBe(1);
    const pages = await engine.executeRaw<{ slug: string; compiled_truth: string; content_hash: string }>(`SELECT slug, compiled_truth, content_hash FROM pages WHERE source_id='src-a' AND slug='alpha' AND deleted_at IS NULL`);
    expect(pages).toHaveLength(1);
    expect(pages[0].compiled_truth).toBe('Recovered body\n');
    expect(pages[0].content_hash).toBe(row.pre_delete_content_hash);
    const acceptance = await verifyRecovery(engine, approval.rows, 'run-test', { batchId: 'b1', payloadBundle: bundle, ...APPLY, approvalHash: approval.approvalHashValue });
    expect(Object.values(acceptance).every(v => v.pass)).toBe(true);
  });

  test('rejects payload bytes whose content hash does not match the manifest', async () => {
    const { row, bundle } = exactRow();
    const tampered: RecoveryPayloadBundle = { ...bundle, payloads: { ...bundle.payloads } };
    tampered.payloads[row.recovery_payload_hash] = { ...tampered.payloads[row.recovery_payload_hash], compiled_truth: 'different bytes' };
    const approval = approved([row], tampered);
    await expect(applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: tampered, ...APPLY })).rejects.toThrow('manifest payload bundle hash not bound to approval');
  });

  test('merge_exact restores complete content through an atomic CAS predicate', async () => {
    const live = await seedPage('live body');
    const { row, bundle } = exactRow({ restore_action: 'merge_exact', live_present: 'true', live_page_id: String(live.id), live_version: String(live.generation), live_content_hash: live.hash });
    const approval = approved([row], bundle);
    const result = await applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle, ...APPLY });
    expect(result.applied).toBe(1);
    const pages = await engine.executeRaw<{ compiled_truth: string; content_hash: string }>(`SELECT compiled_truth, content_hash FROM pages WHERE id=$1`, [live.id]);
    expect(pages[0].compiled_truth).toBe('Recovered body\n');
    expect(pages[0].content_hash).toBe(row.pre_delete_content_hash);
  });

  test('CAS failure aborts the batch without audit rows', async () => {
    const live = await seedPage('live body');
    const { row, bundle } = exactRow({ restore_action: 'merge_exact', live_present: 'true', live_page_id: String(live.id), live_version: String(live.generation + 1), live_content_hash: live.hash });
    const approval = approved([row], bundle);
    await expect(applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle, ...APPLY })).rejects.toThrow('CAS failed');
    const audit = await engine.executeRaw<{ count: string }>('SELECT COUNT(*)::text AS count FROM recovery_audit_rows');
    expect(audit[0]?.count ?? '0').toBe('0');
  });

  test('source uuid and path mismatches fail closed', async () => {
    const { row, bundle } = exactRow({ source_uuid: 'wrong-uuid' });
    const approval = approved([row], bundle);
    await expect(applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle, ...APPLY })).rejects.toThrow('source uuid mismatch');
  });

  test('mid-batch crash rolls back uncommitted mutation', async () => {
    const { row, bundle } = exactRow();
    const approval = approved([row], bundle);
    await expect(applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle, ...APPLY, crashAfter: 'after_mutation_before_commit' })).rejects.toThrow('fault injection');
    const pages = await engine.executeRaw<{ count: string }>(`SELECT COUNT(*)::text AS count FROM pages WHERE source_id='src-a' AND slug='alpha'`);
    expect(pages[0]?.count ?? '0').toBe('0');
  });

  test('rollback uses no-delete state transition and is idempotent', async () => {
    const { row, bundle } = exactRow();
    const approval = approved([row], bundle);
    await expect(applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle, ...APPLY, crashAfter: 'after_commit_before_jsonl' })).rejects.toThrow('fault injection');
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
    await applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle, ...APPLY });
    await engine.executeRaw(`UPDATE pages SET compiled_truth='operator edit', content_hash=$1 WHERE source_id='src-a' AND slug='alpha'`, [contentHash('operator edit')]);
    await expect(rollbackBatch(engine, 'run-test', 'b1')).rejects.toThrow('rollback CAS failed');
  });

  test('schema status returns a structural checksum after provisioning', async () => {
    const status = await recoverySchemaStatus(engine);
    expect(status.provisioned).toBe(true);
    expect(status.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  test('approval verification rejects malformed, expired, future, wrong-key, and tampered artifacts', () => {
    const { row, bundle } = exactRow();
    const approval = approved([row], bundle);
    expect(() => verifyApprovalSignature(approval.approval, TRUSTED_KEYS, APPLY.now)).not.toThrow();
    expect(() => verifyApprovalSignature({ ...approval.approval, approved_at: 'bad-date' }, TRUSTED_KEYS, APPLY.now)).toThrow('approved_at');
    expect(() => verifyApprovalSignature({ ...approval.approval, expires_at: '2026-07-11T00:00:00.000Z' }, TRUSTED_KEYS, APPLY.now)).toThrow('expired');
    expect(() => verifyApprovalSignature({ ...approval.approval, approved_at: '2026-08-12T00:00:00.000Z' }, TRUSTED_KEYS, APPLY.now)).toThrow('future');
    expect(() => verifyApprovalSignature(approval.approval, [{ ...TRUSTED_KEYS[0], key_id: 'wrong', signer: 'wrong' }], APPLY.now)).toThrow('not trusted');
    expect(() => verifyApprovalSignature({ ...approval.approval, manifest_hash: 'b'.repeat(64) }, TRUSTED_KEYS, APPLY.now)).toThrow('signature verification failed');
  });

  test('audit batch replay is insert-or-exact-match CAS', async () => {
    const { row, bundle } = exactRow();
    const approval = approved([row], bundle);
    await applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle, ...APPLY });
    await engine.executeRaw(`UPDATE recovery_audit_batches SET batch_hash=$1 WHERE run_id='run-test' AND batch_id='b1'`, ['b'.repeat(64)]);
    await expect(applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle, ...APPLY })).rejects.toThrow('audit batch identity was reused');
  });

  test('audit write failure rolls back the page mutation atomically', async () => {
    const { row, bundle } = exactRow();
    const approval = approved([row], bundle);
    await expect(applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle, ...APPLY, crashAfter: 'audit_write_failure' })).rejects.toThrow('audit_write_failure');
    const pages = await engine.executeRaw<{ count: string }>(`SELECT COUNT(*)::text AS count FROM pages WHERE source_id='src-a' AND slug='alpha'`);
    expect(pages[0]?.count ?? '0').toBe('0');
  });

  test('extra payloads are rejected before mutation', async () => {
    const { row, bundle } = exactRow();
    const approval = approved([row], bundle);
    const extraBundle: RecoveryPayloadBundle = { ...bundle, payloads: { ...bundle.payloads, ['b'.repeat(64)]: Object.values(bundle.payloads)[0] } };
    await expect(applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: extraBundle, ...APPLY })).rejects.toThrow('approval payload bundle hash mismatch');
  });

  test('expected-state artifact is independently checked during acceptance', async () => {
    const { row, bundle } = exactRow();
    const approval = approved([row], bundle);
    await applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle, ...APPLY });
    const acceptance = await verifyRecovery(engine, approval.rows, 'run-test', {
      batchId: 'b1',
      payloadBundle: bundle,
      approvalHash: approval.approvalHashValue,
      expectedState: { schema_version: 'recovery_expected_state_v1', run_id: 'run-test', batch_id: 'b1', manifest_hash: manifestHash(approval.rows), payload_bundle_hash: payloadBundleHash(bundle), approval_hash: approval.approvalHashValue, expected_pages: [{ source_id: 'src-a', slug: 'alpha', content_hash: row.pre_delete_content_hash, action: 'add_exact' }], expected_audit_rows: 1 },
    });
    expect(acceptance.expected_state.pass).toBe(true);
  });

  test('multi-row apply is atomic when a later row fails CAS', async () => {
    const live = await seedPage('live body', 'beta');
    const predelete = [
      { source_id: 'src-a', source_uuid: 'uuid-a', slug: 'alpha', source_path: '/isolated/source-a', type: 'note', title: 'Alpha', compiled_truth: 'Recovered alpha', frontmatter: {}, pre_delete_export_commit: 'export-sha' },
      { source_id: 'src-a', source_uuid: 'uuid-a', slug: 'beta', source_path: '/isolated/source-a', type: 'note', title: 'Beta', compiled_truth: 'Recovered beta', frontmatter: {}, pre_delete_export_commit: 'export-sha' },
    ];
    const bundle = createRecoveryPayloadBundle('run-test', predelete);
    const rows = buildManifest({ predelete, live: [], batchId: 'b1', payloadBundleHash: payloadBundleHash(bundle), toolCommit: '6ada2d8e01b607bf6326b4f40c5e42f4c6e01378', targetIdentity: 'isolated-db', allowlistHash: 'a'.repeat(64) }, 'run-test');
    rows[1].restore_action = 'merge_exact';
    rows[1].live_present = 'true';
    rows[1].live_page_id = String(live.id);
    rows[1].live_version = String(live.generation + 1);
    rows[1].live_content_hash = live.hash;
    const approval = approved(rows, bundle);
    await expect(applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle, ...APPLY })).rejects.toThrow('CAS failed');
    const pages = await engine.executeRaw<{ count: string }>(`SELECT COUNT(*)::text AS count FROM pages WHERE source_id='src-a' AND slug='alpha'`);
    expect(pages[0]?.count ?? '0').toBe('0');
  });

  test('artifact bytes are deterministic across clean subprocesses and locales', async () => {
    const inputPath = join(dir, 'manifest-input.json');
    const outA = join(dir, 'manifest-a');
    const outB = join(dir, 'manifest-b');
    writeFileSync(inputPath, JSON.stringify({ predelete: [{ source_id: 'src-a', source_uuid: 'uuid-a', slug: 'alpha', source_path: '/isolated/source-a', type: 'note', title: 'Alpha', compiled_truth: 'Recovered body', frontmatter: { recovered: true }, pre_delete_export_commit: 'export-sha' }], live: [], batchId: 'b1', toolCommit: '6ada2d8e01b607bf6326b4f40c5e42f4c6e01378', targetIdentity: 'isolated-db', allowlistHash: 'a'.repeat(64) }));
    const run = (out: string, locale: string) => Bun.spawnSync({ cmd: ['bun', 'run', 'src/cli.ts', 'recovery', 'manifest', '--run-id', 'run-test', '--input', inputPath, '--out-dir', out, '--json'], cwd: process.cwd(), env: { ...process.env, LC_ALL: locale, LANG: locale, NODE_ENV: 'test' } });
    const a = run(outA, 'C');
    const b = run(outB, 'en_US.UTF-8');
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    for (const name of ['manifest.csv', 'payload-bundle.json', 'gap-ledger.md']) {
      expect(readFileSync(join(outA, name), 'utf8')).toBe(readFileSync(join(outB, name), 'utf8'));
    }
  });

  test('CLI manifest writes atomic content-addressed receipt', async () => {
    const inputPath = join(dir, 'manifest-input-receipt.json');
    const outDir = join(dir, 'manifest-receipt');
    const receiptDir = join(dir, 'receipts');
    writeFileSync(inputPath, JSON.stringify({ predelete: [{ source_id: 'src-a', source_uuid: 'uuid-a', slug: 'alpha', source_path: '/isolated/source-a', type: 'note', title: 'Alpha', compiled_truth: 'Recovered body', frontmatter: {}, pre_delete_export_commit: 'export-sha' }], live: [], batchId: 'b1' }));
    const proc = Bun.spawnSync({ cmd: ['bun', 'run', 'src/cli.ts', 'recovery', 'manifest', '--run-id', 'run-test', '--input', inputPath, '--out-dir', outDir, '--receipt-dir', receiptDir, '--json'], cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test' } });
    expect(proc.exitCode).toBe(0);
    const stdout = proc.stdout.toString();
    const receiptPath = JSON.parse(stdout).receipt_path;
    expect(existsSync(receiptPath)).toBe(true);
    expect(readFileSync(receiptPath, 'utf8')).toContain('recovery_cli_receipt_v1');
  });
});
