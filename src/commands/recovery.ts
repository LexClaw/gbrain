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
  gapLedger,
  loadAllowlist,
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
  verifyApprovalSignature,
  verifyRecovery,
  type ApprovalArtifact,
  type ExpectedStateArtifact,
  type ManifestInput,
  type RecoveryPayloadBundle,
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
    if (['json', 'yes'].includes(key)) { out[key] = true; continue; }
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
  const allowlist = loadAllowlist(allowlistPath);
  return assertAllowlistedRuntime(allowlist, {
    worktree,
    allowlistPath,
    engine,
    targetIdentity: maybeStr(opts, 'target-identity'),
  });
}

function loadApplyArtifacts(opts: Args) {
  const rows = parseCsv(readFileSync(str(opts, 'manifest'), 'utf8'));
  const payloadBundle = readJson<RecoveryPayloadBundle>(str(opts, 'payload-bundle'));
  const approval = readJson<ApprovalArtifact>(str(opts, 'approval'));
  const trustedApprovalKeys = readJson<TrustedApprovalKey[]>(str(opts, 'trusted-keys'));
  const batchId = str(opts, 'batch-id');
  const computedApprovalHash = approvalHash(approval);
  return { rows, payloadBundle, approval, trustedApprovalKeys, batchId, computedApprovalHash };
}

export async function runRecovery(engine: BrainEngine, args: string[]): Promise<void> {
  const [cmd, ...rest] = args;
  if (!cmd || cmd === '--help' || cmd === '-h') { console.log(HELP); return; }
  const opts = parseArgs(rest);

  if (cmd === 'schema-status') {
    const runtime = await bindRuntime(engine, opts);
    const status = await recoverySchemaStatus(engine);
    emit(opts, { command: cmd, ok: status.provisioned, runtime, status });
    if (!status.provisioned) process.exitCode = 2;
    return;
  }

  if (cmd === 'schema-provision') {
    if (opts.yes !== true) throw new Error('schema-provision requires --yes');
    const runtime = await bindRuntime(engine, opts);
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
    const approval = readJson<ApprovalArtifact>(str(opts, 'approval'));
    const trustedApprovalKeys = readJson<TrustedApprovalKey[]>(str(opts, 'trusted-keys'));
    verifyApprovalSignature(approval, trustedApprovalKeys);
    emit(opts, { command: cmd, ok: true, approval_hash: approvalHash(approval), signer: approval.signer });
    return;
  }

  if (cmd === 'dry-run' || cmd === 'apply') {
    const runtime = await bindRuntime(engine, opts);
    const a = loadApplyArtifacts(opts);
    if (a.approval.target_identity !== runtime.dbIdentity) throw new Error(`approval target_identity mismatch: ${a.approval.target_identity} != ${runtime.dbIdentity}`);
    const result = await applyRecoveryManifest(engine, a.rows, { batchId: a.batchId, approvalHash: a.computedApprovalHash, approval: a.approval, trustedApprovalKeys: a.trustedApprovalKeys, payloadBundle: a.payloadBundle, dryRun: cmd === 'dry-run' });
    emit(opts, { command: cmd, ok: true, runtime, manifest_hash: manifestHash(a.rows), payload_bundle_hash: payloadBundleHash(a.payloadBundle), row_action_hash: rowActionHash(a.rows), approval_hash: a.computedApprovalHash, result });
    return;
  }

  if (cmd === 'verify') {
    const runtime = await bindRuntime(engine, opts);
    const a = loadApplyArtifacts(opts);
    const runId = str(opts, 'run-id');
    const expectedState = maybeStr(opts, 'expected-state') ? readJson<ExpectedStateArtifact>(str(opts, 'expected-state')) : undefined;
    const checks = await verifyRecovery(engine, a.rows, runId, { batchId: a.batchId, payloadBundle: a.payloadBundle, approvalHash: a.computedApprovalHash, approval: a.approval, trustedApprovalKeys: a.trustedApprovalKeys, expectedState });
    const ok = Object.values(checks).every(c => c.pass);
    emit(opts, { command: cmd, ok, runtime, checks });
    if (!ok) process.exitCode = 3;
    return;
  }

  if (cmd === 'rollback') {
    const runtime = await bindRuntime(engine, opts);
    const result = await rollbackBatch(engine, str(opts, 'run-id'), str(opts, 'batch-id'));
    emit(opts, { command: cmd, ok: true, runtime, result });
    return;
  }

  if (cmd === 'db-identity') {
    emit(opts, { command: cmd, ok: true, identity: await connectedDatabaseIdentity(engine) });
    return;
  }

  throw new Error(`unknown recovery command: ${cmd}`);
}
