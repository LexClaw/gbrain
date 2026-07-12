import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import {
  applyRecoveryManifest,
  approvalHash,
  assertAllowlistedRuntime,
  buildManifest,
  canonicalJson,
  connectedDatabaseIdentity,
  createRecoveryPayloadBundle,
  downRecoverySchema,
  gapLedger,
  loadAllowlistEnvelope,
  manifestHash,
  parseCsv,
  payloadBundleHash,
  provisionRecoverySchema,
  recoverySchemaSql,
  recoverySchemaStatus,
  rollbackBatch,
  rowActionHash,
  sha256,
  toCsv,
  trustedKeysFromAllowlist,
  verifyApprovalSignature,
  verifyDisposableRehearsalAllowlistEnvelope,
  verifyRecovery,
  type AllowlistEnvelope,
  type ApprovalArtifact,
  type ExpectedStateArtifact,
  type ManifestInput,
  type RecoveryPayloadBundle,
  type RollbackAuthorizationArtifact,
  type TrustedApprovalKey,
} from '../recovery/content-recovery.ts';

const HELP = `gbrain recovery <command> [flags]

Commands:
  schema-status      Inspect recovery schema, no writes
  schema-provision   Provision recovery schema, requires --yes
  manifest           Build manifest.csv, payload-bundle.json, gap-ledger.md
  approval-verify    Verify signed approval artifact against trusted keys
  dry-run            Validate and count mutations, no writes
  apply              Apply approved manifest
  verify             Acceptance verify approved manifest and optional expected state
  rollback           Roll back one applied run and batch
  rehearsal-allowlist-verify  Disposable non-production allowlist verification
  schema-down        Remove unused recovery schema, requires --yes

Required runtime binding for schema-status, schema-provision, dry-run, apply, verify, rollback:
  --worktree <path> --allowlist <path> [--target-identity <sha256>]

Common artifact flags:
  --manifest <csv> --payload-bundle <json> --approval <json> --trusted-keys <json>
  --batch-id <id> --run-id <id> --expected-state <json> --receipt-dir <dir> --json
`;

type Args = { _: string[] } & { [key: string]: string | boolean | string[] };

function parseArgs(args: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (['json', 'yes', 'isolated-disposable-rehearsal'].includes(key)) { out[key] = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    out[key] = value;
  }
  return out;
}

function str(opts: Args, key: string): string {
  const v = opts[key];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`missing required --${key}`);
  return v;
}

function maybeStr(opts: Args, key: string): string | undefined {
  const v = opts[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function requireWriteGate(opts: Args, command: string): void {
  if (opts.yes !== true) throw new Error(`${command} requires --yes`);
  if (opts['isolated-disposable-rehearsal'] !== true) throw new Error(`${command} requires --isolated-disposable-rehearsal`);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function atomicWrite(path: string, bytes: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}

function emit(opts: Args, payload: Record<string, unknown>): void {
  const body = { schema_version: 'recovery_cli_receipt_v1', ...payload };
  const json = canonicalJson(body) + '\n';
  const receiptDir = maybeStr(opts, 'receipt-dir');
  if (receiptDir) {
    const hash = sha256(json);
    atomicWrite(join(receiptDir, `${hash}.json`), json);
    if (opts.json) console.log(canonicalJson({ ...body, receipt_hash: hash, receipt_path: join(receiptDir, `${hash}.json`) }));
    else console.log(`receipt ${hash} ${join(receiptDir, `${hash}.json`)}`);
    return;
  }
  if (opts.json) console.log(json.trimEnd());
  else console.log(JSON.stringify(body, null, 2));
}

async function bindRuntime(engine: BrainEngine, opts: Args) {
  const worktree = str(opts, 'worktree');
  const allowlistPath = str(opts, 'allowlist');
  const allowlist = loadAllowlistEnvelope(allowlistPath);
  const runtime = await assertAllowlistedRuntime(allowlist, {
    worktree,
    allowlistPath,
    engine,
    targetIdentity: maybeStr(opts, 'target-identity'),
  });
  return { runtime, allowlist, allowlistPath };
}

function loadApplyArtifacts(opts: Args, allowlist: ReturnType<typeof loadAllowlistEnvelope>, allowlistPath: string) {
  if (opts['trusted-keys']) throw new Error('--trusted-keys is forbidden; approval keys must come from the allowlist trust root');
  const rows = parseCsv(readFileSync(str(opts, 'manifest'), 'utf8'));
  const payloadBundle = readJson<RecoveryPayloadBundle>(str(opts, 'payload-bundle'));
  const approval = readJson<ApprovalArtifact>(str(opts, 'approval'));
  const trustedApprovalKeys = trustedKeysFromAllowlist(allowlist, 'approval', allowlistPath);
  const trustedExpectedStateKeys = trustedKeysFromAllowlist(allowlist, 'expected_state', allowlistPath);
  const batchId = str(opts, 'batch-id');
  const computedApprovalHash = approvalHash(approval);
  return { rows, payloadBundle, approval, trustedApprovalKeys, trustedExpectedStateKeys, batchId, computedApprovalHash };
}

export async function runRecovery(engine: BrainEngine, args: string[]): Promise<void> {
  const [cmd, ...rest] = args;
  if (!cmd || cmd === '--help' || cmd === '-h') { console.log(HELP); return; }
  const opts = parseArgs(rest);

  if (cmd === 'schema-status') {
    const { runtime } = await bindRuntime(engine, opts);
    const status = await recoverySchemaStatus(engine);
    emit(opts, { command: cmd, ok: status.provisioned, runtime, status });
    if (!status.provisioned) process.exitCode = 2;
    return;
  }

  if (cmd === 'schema-provision') {
    requireWriteGate(opts, 'schema-provision');
    const { runtime } = await bindRuntime(engine, opts);
    await provisionRecoverySchema(engine);
    const status = await recoverySchemaStatus(engine);
    emit(opts, { command: cmd, ok: status.provisioned, runtime, migration_checksum: sha256(recoverySchemaSql()), status });
    if (!status.provisioned) process.exitCode = 2;
    return;
  }

  if (cmd === 'manifest') {
    const runId = str(opts, 'run-id');
    const outDir = str(opts, 'out-dir');
    const input = readJson<ManifestInput>(str(opts, 'input'));
    const rows = buildManifest(input, runId);
    const bundle = createRecoveryPayloadBundle(runId, input.predelete ?? []);
    const manifestCsv = toCsv(rows);
    const payloadJson = canonicalJson(bundle) + '\n';
    const ledger = gapLedger(rows);
    atomicWrite(join(outDir, 'manifest.csv'), manifestCsv);
    atomicWrite(join(outDir, 'payload-bundle.json'), payloadJson);
    atomicWrite(join(outDir, 'gap-ledger.md'), ledger);
    emit(opts, { command: cmd, ok: true, artifacts: { manifest: join(outDir, 'manifest.csv'), payload_bundle: join(outDir, 'payload-bundle.json'), gap_ledger: join(outDir, 'gap-ledger.md') }, hashes: { manifest_hash: sha256(manifestCsv), payload_bundle_hash: sha256(payloadJson), gap_ledger_hash: sha256(ledger) }, rows: rows.length });
    return;
  }

  if (cmd === 'approval-verify') {
    const allowlistPath = str(opts, 'allowlist');
    if (opts['trusted-keys']) throw new Error('--trusted-keys is forbidden; approval keys must come from the allowlist trust root');
    const allowlist = loadAllowlistEnvelope(allowlistPath);
    const approval = readJson<ApprovalArtifact>(str(opts, 'approval'));
    const trustedApprovalKeys = trustedKeysFromAllowlist(allowlist, 'approval', allowlistPath);
    verifyApprovalSignature(approval, trustedApprovalKeys);
    emit(opts, { command: cmd, ok: true, approval_hash: approvalHash(approval), signer: approval.signer });
    return;
  }

  if (cmd === 'rehearsal-allowlist-verify') {
    if (opts['isolated-disposable-rehearsal'] !== true) throw new Error('rehearsal-allowlist-verify requires --isolated-disposable-rehearsal');
    const envelope = readJson<AllowlistEnvelope>(str(opts, 'allowlist'));
    const trustedRoots = readJson<TrustedApprovalKey[]>(str(opts, 'trusted-rehearsal-keys'));
    const allowlist = verifyDisposableRehearsalAllowlistEnvelope(envelope, trustedRoots);
    emit(opts, { command: cmd, ok: true, rehearsal: 'isolated-disposable', trusted_roots: trustedRoots.length, allowlist_hash: sha256(canonicalJson(allowlist)) });
    return;
  }

  if (cmd === 'dry-run' || cmd === 'apply') {
    if (cmd === 'apply') requireWriteGate(opts, 'apply');
    const { runtime, allowlist, allowlistPath } = await bindRuntime(engine, opts);
    const a = loadApplyArtifacts(opts, allowlist, allowlistPath);
    const result = await applyRecoveryManifest(engine, a.rows, { batchId: a.batchId, approvalHash: a.computedApprovalHash, approval: a.approval, trustedApprovalKeys: a.trustedApprovalKeys, payloadBundle: a.payloadBundle, runtimeBinding: runtime, dryRun: cmd === 'dry-run' });
    emit(opts, { command: cmd, ok: true, runtime, manifest_hash: manifestHash(a.rows), payload_bundle_hash: payloadBundleHash(a.payloadBundle), row_action_hash: rowActionHash(a.rows), approval_hash: a.computedApprovalHash, result });
    return;
  }

  if (cmd === 'verify') {
    const { runtime, allowlist, allowlistPath } = await bindRuntime(engine, opts);
    const a = loadApplyArtifacts(opts, allowlist, allowlistPath);
    const runId = str(opts, 'run-id');
    const expectedState = maybeStr(opts, 'expected-state') ? readJson<ExpectedStateArtifact>(str(opts, 'expected-state')) : undefined;
    const checks = await verifyRecovery(engine, a.rows, runId, { batchId: a.batchId, payloadBundle: a.payloadBundle, approvalHash: a.computedApprovalHash, approval: a.approval, trustedApprovalKeys: a.trustedApprovalKeys, expectedState, trustedExpectedStateKeys: a.trustedExpectedStateKeys, runtimeBinding: runtime });
    const ok = Object.values(checks).every(c => c.pass);
    emit(opts, { command: cmd, ok, runtime, checks });
    if (!ok) process.exitCode = 3;
    return;
  }

  if (cmd === 'rollback') {
    requireWriteGate(opts, 'rollback');
    const { runtime, allowlist, allowlistPath } = await bindRuntime(engine, opts);
    const authorization = readJson<RollbackAuthorizationArtifact>(str(opts, 'rollback-authorization'));
    const trustedRollbackKeys = trustedKeysFromAllowlist(allowlist, 'approval', allowlistPath);
    const result = await rollbackBatch(engine, str(opts, 'run-id'), str(opts, 'batch-id'), { authorization, trustedRollbackKeys, runtimeBinding: runtime, expectedRollbackStateHash: str(opts, 'expected-rollback-state-hash') });
    emit(opts, { command: cmd, ok: true, runtime, rollback_authorization_hash: sha256(canonicalJson(authorization)), result });
    return;
  }


  if (cmd === 'schema-down') {
    requireWriteGate(opts, 'schema-down');
    const { runtime } = await bindRuntime(engine, opts);
    await downRecoverySchema(engine);
    const status = await recoverySchemaStatus(engine);
    emit(opts, { command: cmd, ok: !status.provisioned, runtime, status });
    return;
  }

  if (cmd === 'db-identity') {
    emit(opts, { command: cmd, ok: true, identity: await connectedDatabaseIdentity(engine) });
    return;
  }

  throw new Error(`unknown recovery command: ${cmd}`);
}
