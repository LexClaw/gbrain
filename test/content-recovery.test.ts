import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { generateKeyPairSync } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runRecovery } from '../src/commands/recovery.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { verifyRehearsalAllowlistEnvelope } from './helpers/recovery-rehearsal-root.ts';
import {
  applyRecoveryManifest,
  approvalHash,
  buildManifest,
  canonicalJson,
  contentHash,
  connectedDatabaseIdentity,
  downRecoverySchema,
  createRecoveryPayloadBundle,
  gapLedger,
  manifestHash,
  payloadBundleHash,
  provisionRecoverySchema,
  rollbackBatch,
  rollbackAuditBatchAuthorizationHash,
  rollbackAuditRowsAuthorizationHash,
  rollbackStateHashFromAuditRows,
  rowActionHash,
  signAllowlistEnvelope,
  validateManifest,
  verifyRecovery,
  recoverySchemaStatus,
  signApprovalArtifact,
  signExpectedStateArtifact,
  signRollbackAuthorizationArtifact,
  sha256,
  toCsv,
  verifyAllowlistEnvelope,
  verifyApprovalSignature,
  type ApprovalArtifact,
  type ManifestRow,
  type RecoveryPayloadBundle,
  type RollbackAuditRow,
  type TrustedApprovalKey,
} from '../src/recovery/content-recovery.ts';

let engine: PGLiteEngine;
let dir: string;
let runtimeWorktree: string;
let runtimeHead: string;
let runtimeAllowlistPath: string;
let runtimeAllowlistHash = 'a'.repeat(64);
let runtimeDbIdentity = 'isolated-db';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const TRUSTED_KEYS: TrustedApprovalKey[] = [{ key_id: 'fixture-reviewer', signer: 'fixture-reviewer', public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
const TRUSTED_EXPECTED_KEYS: TrustedApprovalKey[] = [{ key_id: 'fixture-expected', signer: 'fixture-expected', role: 'expected_state', public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
const FIXTURE_NOW = Date.now();
const APPROVED_AT = new Date(FIXTURE_NOW - 60_000).toISOString();
const EXPIRES_AT = new Date(FIXTURE_NOW + 24 * 60 * 60_000).toISOString();
const EXPIRED_AT = new Date(FIXTURE_NOW - 24 * 60 * 60_000).toISOString();
const FUTURE_AT = new Date(FIXTURE_NOW + 24 * 60 * 60_000).toISOString();
const APPLY = { trustedApprovalKeys: TRUSTED_KEYS, now: FIXTURE_NOW };
function recoveryRuntime() {
  return {
    allowlist: {
      allowed_worktrees: { fixture: { realpath: realpathSync(runtimeWorktree), immutable_base_commit: runtimeHead, branch: 'main' } },
      reserved_isolated_database_targets: [{ realpath: join(dir, 'brain.pglite'), identity_fingerprint: runtimeDbIdentity, environment_contract: { set: {}, unset: [] } }],
      explicitly_permitted_fixture_identities: [runtimeDbIdentity],
      trusted_approval_keys: TRUSTED_KEYS,
    },
    allowlistPath: runtimeAllowlistPath,
    worktree: runtimeWorktree,
    targetIdentity: runtimeDbIdentity,
  };
}

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
    toolCommit: runtimeHead,
    targetIdentity: runtimeDbIdentity,
    allowlistHash: runtimeAllowlistHash,
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
    tool_commit: runtimeHead,
    target_identity: runtimeDbIdentity,
    allowlist_hash: runtimeAllowlistHash,
    approved_at: APPROVED_AT,
    expires_at: EXPIRES_AT,
    key_id: 'fixture-reviewer',
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

function rollbackAuth(overrides: Partial<Parameters<typeof signRollbackAuthorizationArtifact>[0]> = {}) {
  return signRollbackAuthorizationArtifact({
    schema_version: 'recovery_rollback_authorization_v1',
    run_id: 'run-test',
    batch_id: 'b1',
    tool_commit: runtimeHead,
    target_identity: runtimeDbIdentity,
    allowlist_hash: runtimeAllowlistHash,
    original_approval_hash: '0'.repeat(64),
    audit_batch_hash: '0'.repeat(64),
    row_action_hash: '0'.repeat(64),
    expected_rollback_state_hash: '0'.repeat(64),
    approved_at: APPROVED_AT,
    expires_at: EXPIRES_AT,
    key_id: 'fixture-reviewer',
    signer: 'fixture-reviewer',
    ...overrides,
  }, PRIVATE_KEY_PEM);
}

async function rollbackAuthForBatch() {
  const batch = (await engine.executeRaw<{ batch_hash: string; manifest_hash: string; payload_bundle_hash: string; approval_hash: string; tool_commit: string; target_identity: string; allowlist_hash: string }>("SELECT batch_hash, manifest_hash, payload_bundle_hash, approval_hash, tool_commit, target_identity, allowlist_hash FROM recovery_audit_batches WHERE run_id='run-test' AND batch_id='b1'"))[0];
  const audits = await engine.executeRaw<RollbackAuditRow>("SELECT row_key, action, canonical_manifest_row, before_image, after_image, cas_predicate, payload_hash, approval_hash, row_hash FROM recovery_audit_rows WHERE run_id='run-test' AND batch_id='b1' ORDER BY id DESC");
  const expectedRollbackStateHash = rollbackStateHashFromAuditRows(audits);
  return {
    expectedRollbackStateHash,
    authorization: rollbackAuth({
      original_approval_hash: batch.approval_hash,
      audit_batch_hash: rollbackAuditBatchAuthorizationHash(batch, audits),
      row_action_hash: rollbackAuditRowsAuthorizationHash(audits),
      expected_rollback_state_hash: expectedRollbackStateHash,
    }),
  };
}

async function provisionIndependentTargetIdentity() {
  await engine.executeRaw(`CREATE TABLE IF NOT EXISTS recovery_target_identity (
    id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
    nonce TEXT NOT NULL CHECK (nonce ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await engine.executeRaw('DELETE FROM recovery_target_identity');
  await engine.executeRaw('INSERT INTO recovery_target_identity (id, nonce) VALUES (true, $1)', ['c'.repeat(64)]);
}

async function runRecoveryJson(args: string[]) {
  const oldLog = console.log;
  const oldExitCode = process.exitCode;
  let stdout = '';
  console.log = (message?: unknown) => { stdout += `${String(message ?? '')}\n`; };
  process.exitCode = undefined;
  try {
    await runRecovery(engine, args);
    return { exitCode: process.exitCode ?? 0, body: JSON.parse(stdout) as Record<string, any> };
  } finally {
    console.log = oldLog;
    process.exitCode = oldExitCode;
  }
}

function writeRehearsalArtifacts(name: string) {
  const previousAllowlistHash = runtimeAllowlistHash;
  const root = join(dir, name);
  const allowlistPath = join(root, 'allowlist.json');
  const trustedRootsPath = join(root, 'trusted-roots.json');
  mkdirSync(root, { recursive: true });
  const envelope = signAllowlistEnvelope({
    schema_version: 'recovery_allowlist_envelope_v1',
    allowlist: recoveryRuntime().allowlist,
    approved_at: APPROVED_AT,
    expires_at: EXPIRES_AT,
    key_id: 'fixture-reviewer',
    signer: 'fixture-reviewer',
  }, PRIVATE_KEY_PEM);
  const envelopeJson = canonicalJson(envelope) + '\n';
  writeFileSync(allowlistPath, envelopeJson);
  runtimeAllowlistHash = sha256(envelopeJson);
  const { row, bundle } = exactRow();
  const approval = approved([row], bundle);
  const expectedState = signExpectedStateArtifact({
    schema_version: 'recovery_expected_state_v1',
    run_id: 'run-test',
    batch_id: 'b1',
    manifest_hash: manifestHash(approval.rows),
    payload_bundle_hash: payloadBundleHash(bundle),
    approval_hash: approval.approvalHashValue,
    expected_pages: [{ source_id: 'src-a', slug: 'alpha', content_hash: row.pre_delete_content_hash, action: 'add_exact' }],
    expected_audit_rows: 1,
    approved_at: APPROVED_AT,
    expires_at: EXPIRES_AT,
    key_id: 'fixture-expected',
    signer: 'fixture-expected',
  }, PRIVATE_KEY_PEM);
  const files = {
    allowlistPath,
    trustedRootsPath,
    manifestPath: join(root, 'manifest.csv'),
    payloadPath: join(root, 'payload-bundle.json'),
    approvalPath: join(root, 'approval.json'),
    expectedStatePath: join(root, 'expected-state.json'),
    rollbackPath: join(root, 'rollback.json'),
  };
  writeFileSync(files.trustedRootsPath, canonicalJson(TRUSTED_KEYS) + '\n');
  writeFileSync(files.manifestPath, toCsv(approval.rows));
  writeFileSync(files.payloadPath, canonicalJson(bundle) + '\n');
  writeFileSync(files.approvalPath, canonicalJson(approval.approval) + '\n');
  writeFileSync(files.expectedStatePath, canonicalJson(expectedState) + '\n');
  writeFileSync(files.rollbackPath, canonicalJson(rollbackAuth()) + '\n');
  return { files, restore: () => { runtimeAllowlistHash = previousAllowlistHash; } };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-recovery-test-'));
  runtimeWorktree = join(dir, 'runtime-worktree');
  execFileSync('git', ['init', '-b', 'main', runtimeWorktree]);
  execFileSync('git', ['-C', runtimeWorktree, 'config', 'user.email', 'fixture@example.com']);
  execFileSync('git', ['-C', runtimeWorktree, 'config', 'user.name', 'Fixture']);
  writeFileSync(join(runtimeWorktree, 'README.md'), 'fixture\n');
  execFileSync('git', ['-C', runtimeWorktree, 'add', 'README.md']);
  execFileSync('git', ['-C', runtimeWorktree, 'commit', '-m', 'fixture']);
  runtimeHead = execFileSync('git', ['-C', runtimeWorktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  runtimeAllowlistPath = join(dir, 'runtime-allowlist.json');
  writeFileSync(runtimeAllowlistPath, 'placeholder\n');
  engine = new PGLiteEngine();
  await engine.connect({ database_path: join(dir, 'brain.pglite') });
  await engine.initSchema();
  await provisionIndependentTargetIdentity();
  runtimeDbIdentity = await connectedDatabaseIdentity(engine);
  writeFileSync(runtimeAllowlistPath, canonicalJson(recoveryRuntime().allowlist) + '\n');
  runtimeAllowlistHash = sha256(readFileSync(runtimeAllowlistPath));
  await provisionRecoverySchema(engine);
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await provisionIndependentTargetIdentity();
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
    const expectedState = signExpectedStateArtifact({
      schema_version: 'recovery_expected_state_v1',
      run_id: 'run-test',
      batch_id: 'b1',
      manifest_hash: manifestHash(approval.rows),
      payload_bundle_hash: payloadBundleHash(bundle),
      approval_hash: approval.approvalHashValue,
      expected_pages: [{ source_id: 'src-a', slug: 'alpha', content_hash: row.pre_delete_content_hash, action: 'add_exact' }],
      expected_audit_rows: 1,
      approved_at: APPROVED_AT,
      expires_at: EXPIRES_AT,
      key_id: 'fixture-expected',
      signer: 'fixture-expected',
    }, PRIVATE_KEY_PEM);
    const acceptance = await verifyRecovery(engine, approval.rows, 'run-test', { batchId: 'b1', payloadBundle: bundle, ...APPLY, approval: approval.approval, approvalHash: approval.approvalHashValue, expectedState, trustedExpectedStateKeys: TRUSTED_EXPECTED_KEYS });
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
    const auth = await rollbackAuthForBatch();
    const rollback = await rollbackBatch(engine, 'run-test', 'b1', { authorization: auth.authorization, expectedRollbackStateHash: auth.expectedRollbackStateHash, trustedRollbackKeys: TRUSTED_KEYS, runtime: recoveryRuntime(), now: APPLY.now });
    expect(rollback.rolledBack).toBe(1);
    const repeated = await rollbackBatch(engine, 'run-test', 'b1', { authorization: auth.authorization, expectedRollbackStateHash: auth.expectedRollbackStateHash, trustedRollbackKeys: TRUSTED_KEYS, runtime: recoveryRuntime(), now: APPLY.now });
    expect(repeated.rolledBack).toBe(0);
    pages = await engine.executeRaw<{ active: string; deleted: string }>(`SELECT COUNT(*) FILTER (WHERE deleted_at IS NULL)::text AS active, COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)::text AS deleted FROM pages WHERE source_id='src-a' AND slug='alpha'`);
    expect(pages[0]).toMatchObject({ active: '0', deleted: '1' });
  });

  test('rollback refuses after post-apply mutation changes the after-image', async () => {
    const { row, bundle } = exactRow();
    const approval = approved([row], bundle);
    await applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle, ...APPLY });
    await engine.executeRaw(`UPDATE pages SET compiled_truth='operator edit', content_hash=$1 WHERE source_id='src-a' AND slug='alpha'`, [contentHash('operator edit')]);
    const auth = await rollbackAuthForBatch();
    await expect(rollbackBatch(engine, 'run-test', 'b1', { authorization: auth.authorization, expectedRollbackStateHash: auth.expectedRollbackStateHash, trustedRollbackKeys: TRUSTED_KEYS, runtime: recoveryRuntime(), now: APPLY.now })).rejects.toThrow('rollback CAS failed');
  });

  test('partial rollback post-state mismatch is detected from actual database state', async () => {
    const { row, bundle } = exactRow();
    const approval = approved([row], bundle);
    await expect(applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle, ...APPLY, crashAfter: 'after_commit_before_jsonl' })).rejects.toThrow('fault injection');
    const auth = await rollbackAuthForBatch();
    await engine.executeRaw("UPDATE recovery_apply_state SET status='rolled_back' WHERE run_id='run-test' AND batch_id='b1'");
    await expect(rollbackBatch(engine, 'run-test', 'b1', { authorization: auth.authorization, expectedRollbackStateHash: auth.expectedRollbackStateHash, trustedRollbackKeys: TRUSTED_KEYS, runtime: recoveryRuntime(), now: APPLY.now })).rejects.toThrow('rollback post-state hash mismatch');
  });

  test('rollback requires runtime derivation inputs for library callers', async () => {
    const { row, bundle } = exactRow();
    const approval = approved([row], bundle);
    await expect(applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle, ...APPLY, crashAfter: 'after_commit_before_jsonl' })).rejects.toThrow('fault injection');
    const auth = await rollbackAuthForBatch();
    await expect(rollbackBatch(engine, 'run-test', 'b1', { authorization: auth.authorization, expectedRollbackStateHash: auth.expectedRollbackStateHash, trustedRollbackKeys: TRUSTED_KEYS, runtimeBinding: { head: runtimeHead, dbIdentity: runtimeDbIdentity, allowlistHash: runtimeAllowlistHash }, now: APPLY.now } as any)).rejects.toThrow('runtime derivation');
  });

  test('rollback independently recomputes and rejects corrupted stored batch hash', async () => {
    const { row, bundle } = exactRow();
    const approval = approved([row], bundle);
    await expect(applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle, ...APPLY, crashAfter: 'after_commit_before_jsonl' })).rejects.toThrow('fault injection');
    const corruptedBatchHash = 'b'.repeat(64);
    await engine.executeRaw("UPDATE recovery_audit_batches SET batch_hash=$1 WHERE run_id='run-test' AND batch_id='b1'", [corruptedBatchHash]);
    const audits = await engine.executeRaw<RollbackAuditRow>("SELECT row_key, action, canonical_manifest_row, before_image, after_image, cas_predicate, payload_hash, approval_hash, row_hash FROM recovery_audit_rows WHERE run_id='run-test' AND batch_id='b1'");
    for (const audit of audits) {
      const rowHash = sha256(canonicalJson({ manifest_row: audit.canonical_manifest_row, before_image: audit.before_image, after_image: audit.after_image, cas: audit.cas_predicate, payload_hash: audit.payload_hash, approval_hash: audit.approval_hash, batch_hash: corruptedBatchHash }));
      await engine.executeRaw('UPDATE recovery_audit_rows SET row_hash=$1 WHERE row_key=$2', [rowHash, audit.row_key]);
    }
    const auth = await rollbackAuthForBatch();
    await expect(rollbackBatch(engine, 'run-test', 'b1', { authorization: auth.authorization, expectedRollbackStateHash: auth.expectedRollbackStateHash, trustedRollbackKeys: TRUSTED_KEYS, runtime: recoveryRuntime(), now: APPLY.now })).rejects.toThrow('audit batch hash verification failed');
  });

  test('phantom audit insertion protocol is rejected before rollback mutation', async () => {
    const { row, bundle } = exactRow();
    const approval = approved([row], bundle);
    await expect(applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle, ...APPLY, crashAfter: 'after_commit_before_jsonl' })).rejects.toThrow('fault injection');
    const batch = (await engine.executeRaw<{ batch_hash: string }>("SELECT batch_hash FROM recovery_audit_batches WHERE run_id='run-test' AND batch_id='b1'"))[0];
    const audit = (await engine.executeRaw<RollbackAuditRow>("SELECT row_key, action, canonical_manifest_row, before_image, after_image, cas_predicate, payload_hash, approval_hash, row_hash FROM recovery_audit_rows WHERE run_id='run-test' AND batch_id='b1'"))[0];
    const phantom = { ...audit, row_key: `${audit.row_key}:phantom` };
    const rowHash = sha256(canonicalJson({ manifest_row: phantom.canonical_manifest_row, before_image: phantom.before_image, after_image: phantom.after_image, cas: phantom.cas_predicate, payload_hash: phantom.payload_hash, approval_hash: phantom.approval_hash, batch_hash: batch.batch_hash }));
    await engine.executeRaw(`INSERT INTO recovery_audit_rows (run_id, batch_id, row_key, action, canonical_manifest_row, before_image, after_image, cas_predicate, payload_hash, approval_hash, row_hash) VALUES ('run-test','b1',$1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9)`, [phantom.row_key, phantom.action, phantom.canonical_manifest_row, phantom.before_image, phantom.after_image, phantom.cas_predicate, phantom.payload_hash, phantom.approval_hash, rowHash]);
    const auth = await rollbackAuthForBatch();
    await expect(rollbackBatch(engine, 'run-test', 'b1', { authorization: auth.authorization, expectedRollbackStateHash: auth.expectedRollbackStateHash, trustedRollbackKeys: TRUSTED_KEYS, runtime: recoveryRuntime(), now: APPLY.now })).rejects.toThrow('derived audit rows');
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
    expect(() => verifyApprovalSignature({ ...approval.approval, expires_at: EXPIRED_AT }, TRUSTED_KEYS, APPLY.now)).toThrow('expired');
    expect(() => verifyApprovalSignature({ ...approval.approval, approved_at: FUTURE_AT }, TRUSTED_KEYS, APPLY.now)).toThrow('future');
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
    const expectedState = signExpectedStateArtifact({
      schema_version: 'recovery_expected_state_v1',
      run_id: 'run-test',
      batch_id: 'b1',
      manifest_hash: manifestHash(approval.rows),
      payload_bundle_hash: payloadBundleHash(bundle),
      approval_hash: approval.approvalHashValue,
      expected_pages: [{ source_id: 'src-a', slug: 'alpha', content_hash: row.pre_delete_content_hash, action: 'add_exact' }],
      expected_audit_rows: 1,
      approved_at: APPROVED_AT,
      expires_at: EXPIRES_AT,
      key_id: 'fixture-expected',
      signer: 'fixture-expected',
    }, PRIVATE_KEY_PEM);
    const acceptance = await verifyRecovery(engine, approval.rows, 'run-test', {
      batchId: 'b1',
      payloadBundle: bundle,
      approvalHash: approval.approvalHashValue,
      approval: approval.approval,
      trustedApprovalKeys: TRUSTED_KEYS,
      expectedState,
      trustedExpectedStateKeys: TRUSTED_EXPECTED_KEYS,
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
    const rows = buildManifest({ predelete, live: [], batchId: 'b1', payloadBundleHash: payloadBundleHash(bundle), toolCommit: runtimeHead, targetIdentity: runtimeDbIdentity, allowlistHash: runtimeAllowlistHash }, 'run-test');
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

  test('wrong runtime binding and missing row binding fail closed', async () => {
    const { row, bundle } = exactRow();
    const approval = approved([row], bundle);
    await expect(applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle, ...APPLY, runtimeBinding: { head: 'f'.repeat(40), dbIdentity: 'isolated-db', allowlistHash: 'a'.repeat(64) } })).rejects.toThrow('runtime head');
    const missing = [{ ...approval.rows[0], tool_commit: '' }];
    expect(validateManifest(missing).join('\n')).toContain('missing binding field tool_commit');
  });

  test('key substitution and duplicate trust mappings fail closed', () => {
    const { row, bundle } = exactRow();
    const approval = approved([row], bundle);
    expect(() => verifyApprovalSignature({ ...approval.approval, key_id: 'substituted' }, TRUSTED_KEYS, APPLY.now)).toThrow('key_id is not trusted');
    expect(() => verifyApprovalSignature(approval.approval, [...TRUSTED_KEYS, TRUSTED_KEYS[0]], APPLY.now)).toThrow('duplicate trusted key_id');
    expect(() => verifyApprovalSignature(approval.approval, [...TRUSTED_KEYS, { ...TRUSTED_KEYS[0], key_id: 'second-key' }], APPLY.now)).toThrow('duplicate trusted signer');
  });

  test('allowlist envelope requires a reviewed trust-root source', () => {
    const envelope = signAllowlistEnvelope({
      schema_version: 'recovery_allowlist_envelope_v1',
      allowlist: {
        allowed_worktrees: {},
        reserved_isolated_database_targets: [],
        explicitly_permitted_fixture_identities: [],
        trusted_approval_keys: TRUSTED_KEYS,
      },
      approved_at: APPROVED_AT,
      expires_at: EXPIRES_AT,
      key_id: 'fixture-reviewer',
      signer: 'fixture-reviewer',
    }, PRIVATE_KEY_PEM);
    expect(() => verifyAllowlistEnvelope(envelope, APPLY.now)).toThrow('key_id is not trusted');
    expect(verifyRehearsalAllowlistEnvelope(envelope, TRUSTED_KEYS, APPLY.now).trusted_approval_keys).toEqual(TRUSTED_KEYS);
    expect(() => verifyRehearsalAllowlistEnvelope({ ...envelope, unexpected: true } as any, TRUSTED_KEYS, APPLY.now)).toThrow('unknown field');
    expect(() => verifyRehearsalAllowlistEnvelope({ ...envelope, allowlist: { ...envelope.allowlist, allowed_worktrees: undefined } } as any, TRUSTED_KEYS, APPLY.now)).toThrow('missing required field allowed_worktrees');
    const envelopePath = join(dir, 'rehearsal-allowlist.json');
    const keysPath = join(dir, 'rehearsal-keys.json');
    writeFileSync(envelopePath, JSON.stringify(envelope));
    writeFileSync(keysPath, JSON.stringify(TRUSTED_KEYS));
    const proc = Bun.spawnSync({ cmd: ['bun', 'run', 'src/cli.ts', 'recovery', 'rehearsal-allowlist-verify', '--allowlist', envelopePath, '--trusted-rehearsal-keys', keysPath, '--isolated-disposable-rehearsal', '--json'], cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test' } });
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString()).rehearsal).toBe('isolated-disposable');
  });

  test('production allowlist trust root is compiled and fail-closed by key mapping', () => {
    const productionEnvelope = signAllowlistEnvelope({
      schema_version: 'recovery_allowlist_envelope_v1',
      allowlist: {
        allowed_worktrees: {},
        reserved_isolated_database_targets: [],
        explicitly_permitted_fixture_identities: [],
        trusted_approval_keys: TRUSTED_KEYS,
      },
      approved_at: APPROVED_AT,
      expires_at: EXPIRES_AT,
      key_id: 'gbrain-prod-recovery-20260712-primary',
      signer: 'lex-grant-prod-recovery',
    }, PRIVATE_KEY_PEM);

    expect(() => verifyAllowlistEnvelope(productionEnvelope, APPLY.now)).toThrow('signature verification failed');
    expect(() => verifyAllowlistEnvelope({ ...productionEnvelope, key_id: 'fixture-reviewer' }, APPLY.now)).toThrow('key_id is not trusted');
    expect(() => verifyAllowlistEnvelope({ ...productionEnvelope, signer: 'fixture-reviewer' }, APPLY.now)).toThrow('signer does not match key_id');
    expect(() => verifyAllowlistEnvelope({ ...productionEnvelope, expires_at: EXPIRED_AT }, APPLY.now)).toThrow('expired');
  });

  test('production recovery trust source contains only public key material', () => {
    const source = readFileSync(join(process.cwd(), 'src/recovery/content-recovery.ts'), 'utf8');
    expect(source).toContain('gbrain-prod-recovery-20260712-primary');
    expect(source).toContain('lex-grant-prod-recovery');
    expect(source).toContain('MCowBQYDK2VwAyEAmeff1NuMND6nAMQhOBEM3dIAMfXrHem5HxKafMZP49o=');
    expect(source).not.toContain(['BEGIN', 'PRIVATE KEY'].join(' '));
    expect(source).not.toContain(['', 'private'].join('.'));
  });

  test('rehearsal post-commit fault still attempts rollback and preserves evidence on rollback failure', async () => {
    const { files, restore } = writeRehearsalArtifacts('rehearsal-post-commit-fault');
    try {
      const result = await runRecoveryJson([
        'rehearsal', '--yes', '--isolated-disposable-rehearsal', '--json',
        '--worktree', runtimeWorktree, '--allowlist', files.allowlistPath, '--trusted-rehearsal-keys', files.trustedRootsPath,
        '--manifest', files.manifestPath, '--payload-bundle', files.payloadPath, '--approval', files.approvalPath,
        '--expected-state', files.expectedStatePath, '--rollback-authorization', files.rollbackPath,
        '--run-id', 'run-test', '--batch-id', 'b1', '--expected-rollback-state-hash', '0'.repeat(64),
        '--crash-after-apply', 'after_commit_before_jsonl',
      ]);
      expect(result.exitCode).toBe(3);
      expect(result.body.error).toContain('after_commit_before_jsonl');
      expect(result.body.phases.rollback_cleanup.pass).toBe(false);
      expect(result.body.cleanup).toMatchObject({ rollback_proof: false, evidence_preserved: true, schema_teardown: false, external_target_destruction: false });
      const status = await recoverySchemaStatus(engine);
      expect(status.provisioned).toBe(true);
      const audit = await engine.executeRaw<{ audit_rows: string; committed_rows: string }>("SELECT (SELECT COUNT(*)::text FROM recovery_audit_rows WHERE run_id='run-test' AND batch_id='b1') AS audit_rows, (SELECT COUNT(*)::text FROM recovery_apply_state WHERE run_id='run-test' AND batch_id='b1' AND status='committed') AS committed_rows");
      expect(audit[0]).toMatchObject({ audit_rows: '1', committed_rows: '1' });
    } finally {
      await engine.executeRaw("UPDATE recovery_apply_state SET status='rolled_back' WHERE run_id='run-test' AND batch_id='b1'").catch(() => undefined);
      await downRecoverySchema(engine).catch(() => undefined);
      await provisionRecoverySchema(engine).catch(() => undefined);
      restore();
    }
  });

  test('rehearsal refuses schema teardown when rollback evidence is still live', async () => {
    const { files, restore } = writeRehearsalArtifacts('rehearsal-evidence-preserve');
    try {
      const result = await runRecoveryJson([
        'rehearsal', '--yes', '--isolated-disposable-rehearsal', '--json',
        '--worktree', runtimeWorktree, '--allowlist', files.allowlistPath, '--trusted-rehearsal-keys', files.trustedRootsPath,
        '--manifest', files.manifestPath, '--payload-bundle', files.payloadPath, '--approval', files.approvalPath,
        '--expected-state', files.expectedStatePath, '--rollback-authorization', files.rollbackPath,
        '--run-id', 'run-test', '--batch-id', 'b1', '--expected-rollback-state-hash', '0'.repeat(64),
      ]);
      expect(result.exitCode).toBe(3);
      expect(result.body.phases.committed_evidence).toMatchObject({ committed: true, auditRows: 1, applyRows: 1 });
      expect(result.body.phases.rollback_cleanup.pass).toBe(false);
      expect(result.body.phases.schema_down_cleanup.reason).toBe('rollback_evidence_preserved');
      expect(result.body.cleanup).toMatchObject({ rollback_proof: false, evidence_preserved: true, schema_teardown: false, external_target_destruction: false });
      expect((await recoverySchemaStatus(engine)).provisioned).toBe(true);
    } finally {
      await engine.executeRaw("UPDATE recovery_apply_state SET status='rolled_back' WHERE run_id='run-test' AND batch_id='b1'").catch(() => undefined);
      await downRecoverySchema(engine).catch(() => undefined);
      await provisionRecoverySchema(engine).catch(() => undefined);
      restore();
    }
  });

  test('migration drift, structural drift, and down reapply are detected', async () => {
    const originalChecksum = (await engine.executeRaw<{ migration_sha256: string }>("SELECT migration_sha256 FROM recovery_schema_version WHERE version = 'recovery_v3_pre_rehearsal_1'"))[0].migration_sha256;
    await engine.executeRaw("UPDATE recovery_schema_version SET migration_sha256 = $1 WHERE version = $2", ['b'.repeat(64), 'recovery_v3_pre_rehearsal_1']);
    let status = await recoverySchemaStatus(engine);
    expect(status.provisioned).toBe(false);
    expect(status.mismatches.join('\n')).toContain('migration byte checksum mismatch');
    await expect(provisionRecoverySchema(engine)).rejects.toThrow('refusing recovery schema provision');
    await engine.executeRaw("UPDATE recovery_schema_version SET migration_sha256 = $1 WHERE version = 'recovery_v3_pre_rehearsal_1'", [originalChecksum]);
    await downRecoverySchema(engine);
    await provisionRecoverySchema(engine);
    await engine.executeRaw('BEGIN');
    await engine.executeRaw('ALTER TABLE pages ADD COLUMN recovery_surprise_mutable TEXT');
    status = await recoverySchemaStatus(engine);
    expect(status.provisioned).toBe(false);
    expect(status.mismatches.join('\n')).toContain('unknown pages column outside recovery contract');
    await engine.executeRaw('ROLLBACK');
    await downRecoverySchema(engine);
    status = await recoverySchemaStatus(engine);
    expect(status.provisioned).toBe(false);
    await provisionRecoverySchema(engine);
    status = await recoverySchemaStatus(engine);
    expect(status.provisioned).toBe(true);
  });

  test('merge rollback restores every declared mutable page field exactly', async () => {
    const live = await seedPage('live body');
    await engine.executeRaw(`UPDATE pages SET page_kind='markdown', timeline='old timeline', frontmatter=$2::jsonb, emotional_weight=0.75, effective_date='2026-07-01T00:00:00.000Z', effective_date_source='fixture', import_filename='old.md', salience_touched_at='2026-07-02T00:00:00.000Z', last_retrieved_at='2026-07-03T00:00:00.000Z', links_extracted_at='2026-07-04T00:00:00.000Z', contextual_retrieval_mode='balanced', corpus_generation='gen-old' WHERE id=$1`, [live.id, { before: true }]);
    const before = (await engine.executeRaw<Record<string, unknown>>(`SELECT type, page_kind, title, compiled_truth, timeline, frontmatter, content_hash, emotional_weight::text, effective_date::text, effective_date_source, import_filename, salience_touched_at::text, last_retrieved_at::text, links_extracted_at::text, contextual_retrieval_mode, corpus_generation, deleted_at::text FROM pages WHERE id=$1`, [live.id]))[0];
    const refreshed = (await engine.executeRaw<{ generation: number; content_hash: string }>('SELECT generation, content_hash FROM pages WHERE id=$1', [live.id]))[0];
    const { row, bundle } = exactRow({ restore_action: 'merge_exact', live_present: 'true', live_page_id: String(live.id), live_version: String(refreshed.generation), live_content_hash: refreshed.content_hash });
    const approval = approved([row], bundle);
    await applyRecoveryManifest(engine, approval.rows, { batchId: 'b1', approvalHash: approval.approvalHashValue, approval: approval.approval, payloadBundle: bundle, ...APPLY });
    const auth = await rollbackAuthForBatch();
    await rollbackBatch(engine, 'run-test', 'b1', { authorization: auth.authorization, expectedRollbackStateHash: auth.expectedRollbackStateHash, trustedRollbackKeys: TRUSTED_KEYS, runtime: recoveryRuntime(), now: APPLY.now });
    const after = (await engine.executeRaw<Record<string, unknown>>(`SELECT type, page_kind, title, compiled_truth, timeline, frontmatter, content_hash, emotional_weight::text, effective_date::text, effective_date_source, import_filename, salience_touched_at::text, last_retrieved_at::text, links_extracted_at::text, contextual_retrieval_mode, corpus_generation, deleted_at::text FROM pages WHERE id=$1`, [live.id]))[0];
    expect(after).toEqual(before);
  });

  test('artifact bytes are deterministic across clean subprocesses and locales', async () => {
    const inputPath = join(dir, 'manifest-input.json');
    const outA = join(dir, 'manifest-a');
    const outB = join(dir, 'manifest-b');
    writeFileSync(inputPath, JSON.stringify({ predelete: [{ source_id: 'src-a', source_uuid: 'uuid-a', slug: 'alpha', source_path: '/isolated/source-a', type: 'note', title: 'Alpha', compiled_truth: 'Recovered body', frontmatter: { recovered: true }, pre_delete_export_commit: 'export-sha' }], live: [], batchId: 'b1', toolCommit: runtimeHead, targetIdentity: runtimeDbIdentity, allowlistHash: 'a'.repeat(64) }));
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
