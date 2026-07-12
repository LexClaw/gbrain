import { createHash, createPublicKey, sign as edSign, verify as edVerify } from 'crypto';
import { realpathSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { execFileSync } from 'child_process';
import type { BrainEngine } from '../core/engine.ts';

export const RECOVERY_SCHEMA_VERSION = 'recovery_v3_pre_rehearsal_1';

export const MANIFEST_COLUMNS = [
  'run_id','batch_id','source_id','source_uuid','slug','source_path','type','title','pre_delete_identity_class','pre_delete_evidence_kind','pre_delete_content_hash','pre_delete_page_version_id','pre_delete_updated_at','pre_delete_export_commit','recovery_payload_hash','payload_bundle_hash','approval_hash','tool_commit','target_identity','allowlist_hash','live_present','live_page_id','live_version','live_content_hash','live_updated_at','live_source_id','post_incident_identity_class','post_incident_write','conflict_class','restore_action','restore_source','confidence','gap_code','notes',
] as const;

export type ManifestColumn = typeof MANIFEST_COLUMNS[number];
export type ManifestRow = Record<ManifestColumn, string>;
export type RecoveryPayload = {
  source_id: string;
  source_uuid: string;
  slug: string;
  source_path: string;
  type: string;
  title: string;
  compiled_truth: string;
  frontmatter: unknown;
  timeline?: string;
  pre_delete_export_commit: string;
};
export type RecoveryPayloadBundle = {
  schema_version: 'recovery_payload_bundle_v1';
  run_id: string;
  payloads: Record<string, RecoveryPayload>;
};
export type ApprovalArtifact = {
  schema_version: 'recovery_approval_v1';
  run_id: string;
  batch_id: string;
  manifest_hash: string;
  payload_bundle_hash: string;
  row_action_hash: string;
  tool_commit: string;
  target_identity: string;
  allowlist_hash: string;
  approved_at: string;
  expires_at: string;
  signer: string;
  signature: string;
};
export type TrustedApprovalKey = { key_id: string; signer: string; public_key_pem: string; not_before?: string; not_after?: string };
export type ExpectedStateArtifact = {
  schema_version: 'recovery_expected_state_v1';
  run_id: string;
  batch_id: string;
  manifest_hash: string;
  payload_bundle_hash: string;
  approval_hash: string;
  expected_pages: Array<{ source_id: string; slug: string; content_hash: string; action: string }>;
  expected_audit_rows: number;
};
export type ManifestInput = {
  predelete: Array<Partial<ManifestRow> & { compiled_truth?: string; frontmatter?: unknown; timeline?: string }>;
  live: Array<Partial<ManifestRow> & { compiled_truth?: string }>;
  gaps?: Array<Partial<ManifestRow>>;
  batchId?: string;
  payloadBundleHash?: string;
  approvalHash?: string;
  toolCommit?: string;
  targetIdentity?: string;
  allowlistHash?: string;
};
export type Allowlist = {
  allowed_worktrees: Record<string, { realpath: string; immutable_base_commit: string; branch: string }>;
  reserved_isolated_database_targets: Array<{
    realpath: string;
    identity_fingerprint: string;
    environment_contract: { set: Record<string, string>; unset: string[] };
  }>;
  explicitly_permitted_fixture_identities: string[];
  trusted_approval_keys?: TrustedApprovalKey[];
  denied_before_future_approval?: string[];
};

type PageRow = {
  id: number;
  source_id: string;
  slug: string;
  type: string;
  title: string;
  compiled_truth: string;
  timeline?: string;
  frontmatter: unknown;
  content_hash: string | null;
  generation: number;
  updated_at: string;
  source_path?: string | null;
  deleted_at?: string | null;
};

type SourceRow = { id: string; local_path: string | null; config: Record<string, unknown> | string | null };

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function normalizeContent(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd() + '\n';
}

export function contentHash(text: string): string {
  return sha256(normalizeContent(text));
}

export function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function emptyRow(): ManifestRow {
  return Object.fromEntries(MANIFEST_COLUMNS.map(k => [k, ''])) as ManifestRow;
}

function rowKey(row: Partial<ManifestRow>): string {
  return `${row.source_id ?? ''}\u0000${row.slug ?? ''}\u0000${row.pre_delete_identity_class ?? ''}\u0000${row.pre_delete_content_hash ?? ''}`;
}

function sourceSlug(row: Partial<ManifestRow>): string {
  return `${row.source_id ?? ''}\u0000${row.slug ?? ''}`;
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function boolString(value: unknown): string {
  if (value === true || value === 'true') return 'true';
  if (value === false || value === 'false') return 'false';
  return '';
}

export function payloadHash(payload: RecoveryPayload): string {
  return sha256(canonicalJson({ ...payload, compiled_truth: normalizeContent(payload.compiled_truth) }));
}

export function createRecoveryPayloadBundle(runId: string, rows: Array<Partial<ManifestRow> & { compiled_truth?: string; frontmatter?: unknown; timeline?: string }>): RecoveryPayloadBundle {
  const payloads: Record<string, RecoveryPayload> = {};
  for (const row of rows) {
    if (!row.compiled_truth) continue;
    const payload: RecoveryPayload = {
      source_id: String(row.source_id ?? ''),
      source_uuid: String(row.source_uuid ?? ''),
      slug: String(row.slug ?? ''),
      source_path: String(row.source_path ?? ''),
      type: String(row.type ?? 'note'),
      title: String(row.title ?? row.slug ?? ''),
      compiled_truth: normalizeContent(row.compiled_truth),
      frontmatter: row.frontmatter ?? {},
      timeline: row.timeline ?? '',
      pre_delete_export_commit: String(row.pre_delete_export_commit ?? ''),
    };
    payloads[payloadHash(payload)] = payload;
  }
  return { schema_version: 'recovery_payload_bundle_v1', run_id: runId, payloads };
}

export function payloadBundleHash(bundle: RecoveryPayloadBundle): string {
  return sha256(canonicalJson(bundle));
}

export function manifestHash(rows: ManifestRow[]): string {
  // Approval hashes bind to the manifest but cannot include themselves.
  // Keep the committed CSV shape while zeroing the approval field for the binding hash.
  return sha256(toCsv(rows.map(row => ({ ...row, approval_hash: '' }))));
}

export function rowActionHash(rows: ManifestRow[]): string {
  return sha256(canonicalJson(rows.map(row => ({ run_id: row.run_id, batch_id: row.batch_id, source_id: row.source_id, slug: row.slug, action: row.restore_action, payload_hash: row.recovery_payload_hash })).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)))));
}

export function approvalSigningBytes(approval: ApprovalArtifact): Buffer {
  const { signature: _signature, ...unsigned } = approval;
  return Buffer.from(canonicalJson({ ...unsigned, signature_algorithm: 'Ed25519' }));
}

export function signApprovalArtifact(unsigned: Omit<ApprovalArtifact, 'signature'>, privateKeyPem: string): ApprovalArtifact {
  const artifact = { ...unsigned, signature: '' } as ApprovalArtifact;
  return { ...artifact, signature: edSign(null, approvalSigningBytes(artifact), privateKeyPem).toString('base64') };
}

export function approvalHash(approval: ApprovalArtifact): string {
  return sha256(canonicalJson(approval));
}

function parseStrictIso(name: string, value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error(`${name} must be an RFC3339 UTC timestamp with milliseconds`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${name} is malformed`);
  return ms;
}

export function verifyApprovalSignature(approval: ApprovalArtifact, trustedKeys: TrustedApprovalKey[], now = Date.now()): void {
  if (approval.schema_version !== 'recovery_approval_v1') throw new Error('unsupported approval schema_version');
  for (const [key, value] of Object.entries(approval)) if (typeof value !== 'string' || value.length === 0) throw new Error(`approval field ${key} must be a non-empty string`);
  for (const field of ['manifest_hash','payload_bundle_hash','row_action_hash','allowlist_hash'] as const) if (!isSha256(approval[field])) throw new Error(`approval ${field} must be sha256`);
  if (!/^[a-f0-9]{40,64}$/.test(approval.tool_commit)) throw new Error('approval tool_commit must be an immutable git commit hash');
  const approvedAt = parseStrictIso('approved_at', approval.approved_at);
  const expiresAt = parseStrictIso('expires_at', approval.expires_at);
  if (approvedAt > now + 5 * 60_000) throw new Error('approval artifact is future-dated');
  if (expiresAt <= now) throw new Error('approval artifact is expired');
  if (expiresAt - approvedAt > 7 * 24 * 60 * 60_000) throw new Error('approval expiry exceeds seven days');
  const trusted = trustedKeys.find(key => key.key_id === approval.signer || key.signer === approval.signer);
  if (!trusted) throw new Error(`approval signer is not trusted: ${approval.signer}`);
  if (trusted.not_before && approvedAt < parseStrictIso('trusted key not_before', trusted.not_before)) throw new Error('approval predates trusted key validity');
  if (trusted.not_after && approvedAt > parseStrictIso('trusted key not_after', trusted.not_after)) throw new Error('approval postdates trusted key validity');
  let publicKey;
  try { publicKey = createPublicKey(trusted.public_key_pem); } catch { throw new Error('trusted approval public key is malformed'); }
  let signature: Buffer;
  try { signature = Buffer.from(approval.signature, 'base64'); } catch { throw new Error('approval signature is malformed base64'); }
  if (signature.length !== 64) throw new Error('approval signature has invalid Ed25519 length');
  if (!edVerify(null, approvalSigningBytes(approval), publicKey, signature)) throw new Error('approval signature verification failed');
}

export function buildManifest(input: ManifestInput, runId: string): ManifestRow[] {
  const liveBySourceSlug = new Map<string, Partial<ManifestRow> & { compiled_truth?: string }>();
  for (const live of input.live ?? []) liveBySourceSlug.set(`${live.source_id ?? ''}\u0000${live.slug ?? ''}`, live);
  const bundle = createRecoveryPayloadBundle(runId, input.predelete ?? []);
  const computedPayloadBundleHash = input.payloadBundleHash || payloadBundleHash(bundle);

  const rows: ManifestRow[] = [];
  for (const pre of input.predelete ?? []) {
    const row = emptyRow();
    row.run_id = runId;
    row.batch_id = input.batchId ?? row.batch_id;
    row.payload_bundle_hash = computedPayloadBundleHash;
    row.approval_hash = input.approvalHash ?? row.approval_hash;
    row.tool_commit = input.toolCommit ?? row.tool_commit;
    row.target_identity = input.targetIdentity ?? row.target_identity;
    row.allowlist_hash = input.allowlistHash ?? row.allowlist_hash;
    for (const key of MANIFEST_COLUMNS) {
      const value = pre[key];
      if (value != null) row[key] = String(value);
    }
    if (pre.compiled_truth) {
      row.pre_delete_content_hash ||= contentHash(pre.compiled_truth);
      const payload = createRecoveryPayloadBundle(runId, [pre]).payloads;
      row.recovery_payload_hash ||= Object.keys(payload)[0] ?? '';
      row.restore_source ||= 'recovery_payload_bundle_v1';
    }
    if (!row.pre_delete_identity_class) row.pre_delete_identity_class = classifyIdentity(row);
    const live = liveBySourceSlug.get(`${row.source_id}\u0000${row.slug}`);
    row.live_present = live ? 'true' : 'false';
    if (live) {
      const liveRecord = live as Record<string, unknown>;
      row.live_page_id = String(live.live_page_id ?? liveRecord.live_page_id ?? '');
      row.live_version = String(live.live_version ?? liveRecord.live_version ?? liveRecord.generation ?? '');
      row.live_content_hash = String(live.live_content_hash ?? (live.compiled_truth ? contentHash(live.compiled_truth) : ''));
      row.live_updated_at = String(live.live_updated_at ?? liveRecord.updated_at ?? '');
      row.live_source_id = String(live.live_source_id ?? live.source_id ?? '');
      row.post_incident_write = boolString(live.post_incident_write) || row.post_incident_write;
    }
    rows.push(row);
  }

  const duplicateGroups = new Set<string>();
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(sourceSlug(row), (counts.get(sourceSlug(row)) ?? 0) + 1);
  for (const [key, count] of counts) if (key !== '\u0000' && count > 1) duplicateGroups.add(key);
  for (const row of rows) {
    row.conflict_class = classifyConflict(row, duplicateGroups);
    row.restore_action = chooseRestoreAction(row);
  }

  for (const gap of input.gaps ?? []) {
    const row = emptyRow();
    row.run_id = runId;
    row.batch_id = input.batchId ?? '';
    for (const key of MANIFEST_COLUMNS) {
      const value = gap[key];
      if (value != null) row[key] = String(value);
    }
    row.pre_delete_identity_class ||= 'unrecoverable_gap';
    row.restore_action ||= 'unrecoverable';
    row.confidence ||= '0';
    rows.push(row);
  }

  return rows.sort((a, b) => rowKey(a).localeCompare(rowKey(b)) || a.title.localeCompare(b.title));
}

export function classifyIdentity(row: ManifestRow): string {
  if (row.source_id && row.source_uuid && row.slug && row.pre_delete_content_hash && row.recovery_payload_hash && row.pre_delete_export_commit) return 'exact_predelete';
  if (row.slug && row.pre_delete_content_hash && row.recovery_payload_hash) return 'strong_probable';
  if (row.slug || row.pre_delete_content_hash || row.source_path) return 'weak_probable';
  return 'unrecoverable_gap';
}

function classifyConflict(row: ManifestRow, duplicateGroups: Set<string>): string {
  if (duplicateGroups.has(sourceSlug(row))) return 'duplicate_source_slug';
  if (row.live_present === 'true' && row.live_content_hash && row.pre_delete_content_hash && row.live_content_hash !== row.pre_delete_content_hash) return 'hash_divergence';
  if (row.live_present === 'true' && row.live_source_id && row.source_id && row.live_source_id !== row.source_id) return 'source_identity_collision';
  return 'none';
}

function chooseRestoreAction(row: ManifestRow): string {
  if (row.pre_delete_identity_class === 'unrecoverable_gap') return 'unrecoverable';
  if (row.conflict_class && row.conflict_class !== 'none') return 'quarantine_conflict';
  if (row.pre_delete_identity_class !== 'exact_predelete') return 'quarantine_probable';
  if (row.post_incident_write === 'true') return 'skip_live_newer';
  if (row.live_present === 'false') return 'add_exact';
  if (row.live_present === 'true') return 'merge_exact';
  return 'quarantine_probable';
}

const ENUMS = {
  pre_delete_identity_class: new Set(['exact_predelete', 'strong_probable', 'weak_probable', 'unrecoverable_gap']),
  restore_action: new Set(['add_exact', 'merge_exact', 'skip_live_newer', 'quarantine_conflict', 'quarantine_probable', 'unrecoverable']),
  conflict_class: new Set(['none', 'duplicate_source_slug', 'hash_divergence', 'source_identity_collision']),
  live_present: new Set(['true', 'false']),
  post_incident_write: new Set(['', 'true', 'false']),
};

export function validateManifest(rows: ManifestRow[]): string[] {
  const errors: string[] = [];
  if (rows.length === 0) errors.push('manifest is empty');
  const runIds = new Set(rows.map(row => row.run_id));
  if (runIds.size !== 1 || runIds.has('')) errors.push('manifest must contain exactly one non-empty run_id');
  const seen = new Set<string>();
  const groups = new Map<string, ManifestRow[]>();
  rows.forEach((row, i) => {
    for (const col of MANIFEST_COLUMNS) if (!(col in row)) errors.push(`row ${i + 1}: missing column ${col}`);
    for (const col of ['pre_delete_content_hash', 'recovery_payload_hash', 'payload_bundle_hash', 'approval_hash', 'allowlist_hash'] as const) {
      if (row[col] && !isSha256(row[col])) errors.push(`row ${i + 1}: malformed sha256 ${col}`);
    }
    const key = `${row.run_id}\u0000${row.source_id}\u0000${row.slug}\u0000${row.pre_delete_content_hash}`;
    if (seen.has(key)) errors.push(`row ${i + 1}: duplicate manifest identity`);
    seen.add(key);
    groups.set(sourceSlug(row), [...(groups.get(sourceSlug(row)) ?? []), row]);
    if (!ENUMS.pre_delete_identity_class.has(row.pre_delete_identity_class)) errors.push(`row ${i + 1}: unknown identity class ${row.pre_delete_identity_class}`);
    if (!ENUMS.restore_action.has(row.restore_action)) errors.push(`row ${i + 1}: unknown restore action ${row.restore_action}`);
    if (!ENUMS.conflict_class.has(row.conflict_class || 'none')) errors.push(`row ${i + 1}: unknown conflict class ${row.conflict_class}`);
    if (row.live_present && !ENUMS.live_present.has(row.live_present)) errors.push(`row ${i + 1}: unknown live_present ${row.live_present}`);
    if (!ENUMS.post_incident_write.has(row.post_incident_write)) errors.push(`row ${i + 1}: unknown post_incident_write ${row.post_incident_write}`);
    if (row.pre_delete_identity_class === 'exact_predelete') {
      if (!row.source_id) errors.push(`row ${i + 1}: exact_predelete missing source_id`);
      if (!row.source_uuid) errors.push(`row ${i + 1}: exact_predelete missing source_uuid`);
      if (!row.slug) errors.push(`row ${i + 1}: exact_predelete missing slug`);
      if (!row.pre_delete_content_hash) errors.push(`row ${i + 1}: exact_predelete missing verified content hash`);
      if (!row.recovery_payload_hash) errors.push(`row ${i + 1}: exact_predelete missing authenticated payload`);
      if (!row.pre_delete_export_commit) errors.push(`row ${i + 1}: exact_predelete missing export commit`);
    }
    if (['add_exact', 'merge_exact'].includes(row.restore_action)) {
      for (const col of ['run_id','batch_id','source_id','source_uuid','slug','pre_delete_content_hash','recovery_payload_hash','payload_bundle_hash','approval_hash','tool_commit','target_identity','allowlist_hash'] as const) {
        if (!row[col]) errors.push(`row ${i + 1}: ${row.restore_action} missing ${col}`);
      }
    }
    if (row.restore_action === 'merge_exact') {
      for (const col of ['live_page_id','live_version','live_content_hash'] as const) if (!row[col]) errors.push(`row ${i + 1}: merge_exact missing CAS field ${col}`);
    }
    if (row.pre_delete_identity_class !== 'exact_predelete' && ['add_exact', 'merge_exact'].includes(row.restore_action)) errors.push(`row ${i + 1}: non-exact row cannot use exact restore action`);
    if (row.post_incident_write === 'true' && ['add_exact', 'merge_exact'].includes(row.restore_action)) errors.push(`row ${i + 1}: post-incident write protected from automatic mutation`);
  });
  for (const [key, group] of groups) {
    if (key === '\u0000' || group.length <= 1) continue;
    for (const row of group) if (row.restore_action !== 'quarantine_conflict') errors.push(`row ${rows.indexOf(row) + 1}: duplicate group member not quarantined`);
  }
  return errors;
}

export function toCsv(rows: ManifestRow[]): string {
  const escape = (value: string) => /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return [MANIFEST_COLUMNS.join(','), ...rows.map(row => MANIFEST_COLUMNS.map(col => escape(row[col] ?? '')).join(','))].join('\n') + '\n';
}

export function parseCsv(text: string): ManifestRow[] {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); records.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); records.push(row); }
  const [header, ...body] = records.filter(r => r.length > 1 || r[0] !== '');
  if (!header) throw new Error('manifest CSV is empty');
  const missing = MANIFEST_COLUMNS.filter(col => !header.includes(col));
  const unknown = header.filter(h => !MANIFEST_COLUMNS.includes(h as ManifestColumn));
  const duplicates = header.filter((h, i) => header.indexOf(h) !== i);
  if (missing.length) throw new Error(`missing manifest columns: ${missing.join(', ')}`);
  if (unknown.length) throw new Error(`unknown manifest columns: ${unknown.join(', ')}`);
  if (duplicates.length) throw new Error(`duplicate manifest columns: ${[...new Set(duplicates)].join(', ')}`);
  if (body.length === 0) throw new Error('manifest CSV has no rows');
  return body.map(values => {
    if (values.length !== MANIFEST_COLUMNS.length) throw new Error(`manifest row has ${values.length} columns, expected ${MANIFEST_COLUMNS.length}`);
    const out = emptyRow();
    header.forEach((h, i) => { out[h as ManifestColumn] = values[i] ?? ''; });
    return out;
  });
}

export function loadAllowlist(path: string): Allowlist {
  return JSON.parse(readFileSync(path, 'utf8')) as Allowlist;
}

export function allowlistHashBytes(path: string): { bytes: string; sha256: string } {
  const bytes = readFileSync(path, 'utf8');
  return { bytes, sha256: sha256(bytes) };
}

function git(worktree: string, args: string[]): string {
  return execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8' }).trim();
}

export function inspectGitWorktree(worktree: string): { gitRoot: string; head: string; branch: string; clean: boolean } {
  const gitRoot = realpathSync(git(worktree, ['rev-parse', '--show-toplevel']));
  const head = git(gitRoot, ['rev-parse', 'HEAD']);
  const branch = git(gitRoot, ['branch', '--show-current']);
  const clean = git(gitRoot, ['status', '--porcelain']) === '';
  return { gitRoot, head, branch, clean };
}

export async function connectedDatabaseIdentity(engine: BrainEngine): Promise<string> {
  try {
    const rows = await engine.executeRaw<{ database_name: string; server_addr: string | null; server_port: string | null; version: string }>(`SELECT current_database()::text AS database_name, inet_server_addr()::text AS server_addr, inet_server_port()::text AS server_port, version()::text AS version`);
    if (rows[0]) return sha256(canonicalJson({ kind: 'postgres', ...rows[0] }));
  } catch {
    const rows = await engine.executeRaw<{ table_count: string; version: string }>(`SELECT COUNT(*)::text AS table_count, version()::text AS version FROM information_schema.tables`);
    return sha256(canonicalJson({ kind: 'pglite', ...(rows[0] ?? {}) }));
  }
  throw new Error('unable to obtain connected database identity');
}

export async function assertAllowlistedRuntime(allowlist: Allowlist, opts: { worktree: string; allowlistPath: string; engine: BrainEngine; env?: NodeJS.ProcessEnv; targetIdentity?: string }): Promise<{ worktreeRealpath: string; gitRoot: string; head: string; branch: string; clean: boolean; dbIdentity: string; allowlistHash: string }> {
  const env = opts.env ?? process.env;
  const gitState = inspectGitWorktree(opts.worktree);
  const worktreeRealpath = gitState.gitRoot;
  const allowed = Object.values(allowlist.allowed_worktrees).find(w => w.realpath === worktreeRealpath && w.branch === gitState.branch);
  if (!allowed) throw new Error(`worktree realpath and branch are not allowlisted: ${worktreeRealpath} ${gitState.branch}`);
  if (allowed.immutable_base_commit !== gitState.head) throw new Error(`actual git HEAD mismatch: expected ${allowed.immutable_base_commit}, got ${gitState.head}`);
  if (!gitState.clean) throw new Error('worktree must be clean before rehearsal tooling mutates data');
  const { sha256: allowHash } = allowlistHashBytes(opts.allowlistPath);
  const dbIdentity = await connectedDatabaseIdentity(opts.engine);
  const matches = allowlist.reserved_isolated_database_targets.filter(db => db.identity_fingerprint === dbIdentity || (opts.targetIdentity && db.identity_fingerprint === opts.targetIdentity));
  if (matches.length !== 1) throw new Error(`expected exactly one allowlisted isolated database target, found ${matches.length}`);
  const db = matches[0];
  for (const key of db.environment_contract.unset) if (env[key]) throw new Error(`${key} must be unset for recovery tooling`);
  for (const [key, value] of Object.entries(db.environment_contract.set)) if (env[key] !== value) throw new Error(`${key} must equal allowlisted value`);
  if (opts.targetIdentity && opts.targetIdentity !== dbIdentity) throw new Error(`connected database identity mismatch: expected ${opts.targetIdentity}, got ${dbIdentity}`);
  if (!allowlist.explicitly_permitted_fixture_identities.includes(dbIdentity)) throw new Error(`database identity not permitted: ${dbIdentity}`);
  return { worktreeRealpath, gitRoot: gitState.gitRoot, head: gitState.head, branch: gitState.branch, clean: gitState.clean, dbIdentity, allowlistHash: allowHash };
}

export function assertAllowlistedEnvironment(allowlist: Allowlist, opts: { worktree: string; expectedHead: string; actualHead?: string; branch?: string; env?: NodeJS.ProcessEnv; targetIdentity?: string; clean?: boolean }): { worktreeRealpath: string; dbIdentity: string } {
  const env = opts.env ?? process.env;
  const gitState = inspectGitWorktree(opts.worktree);
  const worktreeRealpath = gitState.gitRoot;
  const actualHead = opts.actualHead ?? gitState.head;
  const branch = opts.branch ?? gitState.branch;
  const clean = opts.clean ?? gitState.clean;
  const allowed = Object.values(allowlist.allowed_worktrees).find(w => w.realpath === worktreeRealpath && w.branch === branch);
  if (!allowed) throw new Error(`worktree realpath and branch are not allowlisted: ${worktreeRealpath} ${branch}`);
  if (allowed.immutable_base_commit !== opts.expectedHead) throw new Error(`base commit mismatch: expected ${allowed.immutable_base_commit}, got ${opts.expectedHead}`);
  if (actualHead !== opts.expectedHead) throw new Error(`actual git HEAD mismatch: expected ${opts.expectedHead}, got ${actualHead}`);
  if (!clean) throw new Error('worktree must be clean before rehearsal tooling mutates data');
  if (!env.GBRAIN_HOME) throw new Error('GBRAIN_HOME is required for recovery tooling');
  for (const blocked of ['DATABASE_URL', 'POSTGRES_URL', 'SUPABASE_DB_URL']) if (env[blocked]) throw new Error(`${blocked} must be unset for recovery tooling`);
  const homeRealpath = realpathSync(resolve(env.GBRAIN_HOME));
  const matches = allowlist.reserved_isolated_database_targets.filter(db => db.realpath === homeRealpath && (!opts.targetIdentity || db.identity_fingerprint === opts.targetIdentity));
  if (matches.length !== 1) throw new Error(`expected exactly one allowlisted isolated database target, found ${matches.length}`);
  const db = matches[0];
  for (const key of db.environment_contract.unset) if (env[key]) throw new Error(`${key} must be unset for recovery tooling`);
  for (const [key, value] of Object.entries(db.environment_contract.set)) if (env[key] !== value) throw new Error(`${key} must equal allowlisted value`);
  const dbIdentity = db.identity_fingerprint;
  if (!allowlist.explicitly_permitted_fixture_identities.includes(dbIdentity)) throw new Error(`database identity not permitted: ${dbIdentity}`);
  return { worktreeRealpath, dbIdentity };
}

export const RECOVERY_MIGRATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS recovery_schema_version (
      version TEXT PRIMARY KEY,
      installed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  `INSERT INTO recovery_schema_version (version) VALUES ('${RECOVERY_SCHEMA_VERSION}') ON CONFLICT DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS recovery_audit_batches (
      run_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
      payload_bundle_hash TEXT NOT NULL CHECK (payload_bundle_hash ~ '^[a-f0-9]{64}$'),
      approval_hash TEXT NOT NULL CHECK (approval_hash ~ '^[a-f0-9]{64}$'),
      tool_commit TEXT NOT NULL,
      target_identity TEXT NOT NULL,
      allowlist_hash TEXT NOT NULL CHECK (allowlist_hash ~ '^[a-f0-9]{64}$'),
      batch_hash TEXT NOT NULL CHECK (batch_hash ~ '^[a-f0-9]{64}$'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(run_id, batch_id)
    )`,
  `CREATE TABLE IF NOT EXISTS recovery_audit_rows (
      id SERIAL PRIMARY KEY,
      run_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      row_key TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('add_exact','merge_exact')),
      canonical_manifest_row JSONB NOT NULL,
      before_image JSONB NOT NULL,
      after_image JSONB NOT NULL,
      cas_predicate JSONB NOT NULL,
      payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
      approval_hash TEXT NOT NULL CHECK (approval_hash ~ '^[a-f0-9]{64}$'),
      row_hash TEXT NOT NULL CHECK (row_hash ~ '^[a-f0-9]{64}$'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(run_id, batch_id, row_key)
    )`,
  `CREATE TABLE IF NOT EXISTS recovery_apply_state (
      run_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      row_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('committed','rolled_back')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(run_id, batch_id, row_key)
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS recovery_active_pages_source_slug_guard ON pages(source_id, slug) WHERE deleted_at IS NULL`,
];

export function recoverySchemaSql(): string {
  return RECOVERY_MIGRATION_STATEMENTS.join(';\n') + ';\n';
}

export async function provisionRecoverySchema(engine: BrainEngine): Promise<void> {
  for (const statement of RECOVERY_MIGRATION_STATEMENTS) await engine.executeRaw(statement);
}

export async function recoverySchemaStatus(engine: BrainEngine): Promise<{ provisioned: boolean; schema_version: string; checksum: string; missing: string[] }> {
  const required = ['recovery_schema_version','recovery_audit_batches','recovery_audit_rows','recovery_apply_state'];
  const rows = await engine.executeRaw<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('recovery_schema_version','recovery_audit_batches','recovery_audit_rows','recovery_apply_state')`);
  const present = new Set(rows.map(r => r.table_name));
  const missing = required.filter(t => !present.has(t));
  let versionRows: Array<{ version: string }> = [];
  if (!missing.includes('recovery_schema_version')) versionRows = await engine.executeRaw<{ version: string }>('SELECT version FROM recovery_schema_version WHERE version = $1', [RECOVERY_SCHEMA_VERSION]);
  const cols = await engine.executeRaw<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(`SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name IN ('recovery_schema_version','recovery_audit_batches','recovery_audit_rows','recovery_apply_state') ORDER BY table_name, ordinal_position`);
  return { provisioned: missing.length === 0 && versionRows.length === 1, schema_version: RECOVERY_SCHEMA_VERSION, checksum: sha256(canonicalJson(cols)), missing };
}

async function assertRecoverySchema(engine: BrainEngine): Promise<void> {
  const rows = await engine.executeRaw<{ version: string }>('SELECT version FROM recovery_schema_version WHERE version = $1', [RECOVERY_SCHEMA_VERSION]);
  if (rows.length !== 1) throw new Error(`recovery schema ${RECOVERY_SCHEMA_VERSION} is not provisioned`);
}

async function getSource(engine: BrainEngine, sourceId: string): Promise<SourceRow | null> {
  const rows = await engine.executeRaw<SourceRow>('SELECT id, local_path, config FROM sources WHERE id = $1', [sourceId]);
  return rows[0] ?? null;
}

async function getPage(engine: BrainEngine, sourceId: string, slug: string): Promise<PageRow | null> {
  const rows = await engine.executeRaw<PageRow>('SELECT * FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, slug]);
  return rows[0] ?? null;
}

function sourceUuid(source: SourceRow | null): string {
  if (!source?.config) return '';
  const cfg = typeof source.config === 'string' ? JSON.parse(source.config) : source.config;
  return String((cfg as Record<string, unknown>).uuid ?? (cfg as Record<string, unknown>).source_uuid ?? '');
}

function assertSourceIdentity(row: ManifestRow, source: SourceRow | null): void {
  if (!source) throw new Error(`missing source identity for ${row.source_id}`);
  const uuid = sourceUuid(source);
  if (!uuid) throw new Error(`database source uuid missing for ${row.source_id}`);
  if (row.source_uuid !== uuid) throw new Error(`source uuid mismatch for ${row.source_id}`);
  if (!source.local_path) throw new Error(`database source path missing for ${row.source_id}`);
  if (row.source_path && row.source_path !== source.local_path) throw new Error(`source path mismatch for ${row.source_id}`);
}

function assertPayload(row: ManifestRow, bundle: RecoveryPayloadBundle): RecoveryPayload {
  if (bundle.schema_version !== 'recovery_payload_bundle_v1') throw new Error('unsupported payload bundle schema');
  if (bundle.run_id !== row.run_id) throw new Error(`payload bundle run mismatch for ${row.source_id}/${row.slug}`);
  if (payloadBundleHash(bundle) !== row.payload_bundle_hash) throw new Error(`payload bundle hash mismatch for ${row.source_id}/${row.slug}`);
  const payload = bundle.payloads[row.recovery_payload_hash];
  if (!payload) throw new Error(`missing recovery payload for ${row.source_id}/${row.slug}`);
  if (payloadHash(payload) !== row.recovery_payload_hash) throw new Error(`recovery payload hash mismatch for ${row.source_id}/${row.slug}`);
  if (payload.source_id !== row.source_id || payload.source_uuid !== row.source_uuid || payload.slug !== row.slug) throw new Error(`recovery payload identity mismatch for ${row.source_id}/${row.slug}`);
  if (contentHash(payload.compiled_truth) !== row.pre_delete_content_hash) throw new Error(`recovery payload content hash mismatch for ${row.source_id}/${row.slug}`);
  return payload;
}

function assertApproval(rows: ManifestRow[], opts: ApplyOptions): void {
  if (!opts.approval) throw new Error('signed approval artifact is required');
  if (!opts.trustedApprovalKeys?.length) throw new Error('trusted approval key allowlist is required');
  const approval = opts.approval;
  verifyApprovalSignature(approval, opts.trustedApprovalKeys, opts.now);
  const hash = approvalHash(approval);
  if (hash !== opts.approvalHash) throw new Error('approval hash argument does not match approval artifact');
  if (rows.some(row => row.approval_hash !== hash)) throw new Error('manifest row approval hash is not bound to approval artifact');
  if (approval.batch_id !== opts.batchId || rows.some(row => row.batch_id !== opts.batchId)) throw new Error('approval batch mismatch');
  if (approval.run_id !== rows[0]?.run_id || rows.some(row => row.run_id !== approval.run_id)) throw new Error('approval run mismatch');
  if (approval.manifest_hash !== manifestHash(rows)) throw new Error('approval manifest hash mismatch');
  if (approval.payload_bundle_hash !== payloadBundleHash(opts.payloadBundle)) throw new Error('approval payload bundle hash mismatch');
  if (approval.row_action_hash !== rowActionHash(rows)) throw new Error('approval row action hash mismatch');
  for (const row of rows) {
    if (row.payload_bundle_hash && row.payload_bundle_hash !== approval.payload_bundle_hash) throw new Error('manifest payload bundle hash not bound to approval');
    if (row.tool_commit && row.tool_commit !== approval.tool_commit) throw new Error('manifest tool commit not bound to approval');
    if (row.target_identity && row.target_identity !== approval.target_identity) throw new Error('manifest target identity not bound to approval');
    if (row.allowlist_hash && row.allowlist_hash !== approval.allowlist_hash) throw new Error('manifest allowlist hash not bound to approval');
  }
}

export type ApplyResult = { applied: number; skipped: number; quarantined: number; dryRun: boolean; auditRows: number };
export type ApplyOptions = { batchId: string; approvalHash: string; approval: ApprovalArtifact; trustedApprovalKeys: TrustedApprovalKey[]; payloadBundle: RecoveryPayloadBundle; dryRun?: boolean; now?: number; crashAfter?: 'before_audit' | 'after_before_image' | 'after_cas' | 'after_mutation_before_commit' | 'after_commit_before_jsonl' | 'audit_write_failure' };

export async function applyRecoveryManifest(engine: BrainEngine, rows: ManifestRow[], opts: ApplyOptions): Promise<ApplyResult> {
  await assertRecoverySchema(engine);
  const errors = validateManifest(rows);
  if (errors.length) throw new Error(errors.join('\n'));
  assertApproval(rows, opts);
  const requiredPayloads = new Set(rows.filter(r => ['add_exact', 'merge_exact'].includes(r.restore_action)).map(r => r.recovery_payload_hash));
  const extraPayloads = Object.keys(opts.payloadBundle.payloads).filter(hash => !requiredPayloads.has(hash));
  if (extraPayloads.length) throw new Error(`payload bundle contains extra payloads: ${extraPayloads.join(',')}`);
  const result: ApplyResult = { applied: 0, skipped: 0, quarantined: 0, dryRun: Boolean(opts.dryRun), auditRows: 0 };
  if (opts.crashAfter === 'before_audit') throw new Error('fault injection: before_audit');
  if (opts.dryRun) {
    for (const row of rows) {
      if (['add_exact', 'merge_exact'].includes(row.restore_action)) result.applied++;
      else if (row.restore_action.startsWith('quarantine')) result.quarantined++;
      else result.skipped++;
    }
    return result;
  }

  await engine.executeRaw('BEGIN');
  try {
    const batchHash = sha256(canonicalJson({ manifest_hash: manifestHash(rows), payload_bundle_hash: payloadBundleHash(opts.payloadBundle), approval_hash: opts.approvalHash, row_action_hash: rowActionHash(rows) }));
    const batchRows = await engine.executeRaw<{ batch_hash: string; manifest_hash: string; payload_bundle_hash: string; approval_hash: string; tool_commit: string; target_identity: string; allowlist_hash: string }>(`
      INSERT INTO recovery_audit_batches (run_id, batch_id, manifest_hash, payload_bundle_hash, approval_hash, tool_commit, target_identity, allowlist_hash, batch_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (run_id, batch_id) DO UPDATE SET batch_hash = recovery_audit_batches.batch_hash
      RETURNING batch_hash, manifest_hash, payload_bundle_hash, approval_hash, tool_commit, target_identity, allowlist_hash
    `, [rows[0].run_id, opts.batchId, manifestHash(rows), payloadBundleHash(opts.payloadBundle), opts.approvalHash, opts.approval.tool_commit, opts.approval.target_identity, opts.approval.allowlist_hash, batchHash]);
    const batch = batchRows[0];
    if (!batch || batch.batch_hash !== batchHash || batch.manifest_hash !== manifestHash(rows) || batch.payload_bundle_hash !== payloadBundleHash(opts.payloadBundle) || batch.approval_hash !== opts.approvalHash || batch.tool_commit !== opts.approval.tool_commit || batch.target_identity !== opts.approval.target_identity || batch.allowlist_hash !== opts.approval.allowlist_hash) {
      throw new Error('audit batch identity was reused with different bound values');
    }

    for (const row of rows) {
      const rowKeyValue = sha256(canonicalJson({ run_id: row.run_id, batch_id: row.batch_id, source_id: row.source_id, slug: row.slug, payload_hash: row.recovery_payload_hash, action: row.restore_action }));
      if (!['add_exact', 'merge_exact'].includes(row.restore_action)) {
        if (row.restore_action.startsWith('quarantine')) result.quarantined++;
        else result.skipped++;
        continue;
      }
      const payload = assertPayload(row, opts.payloadBundle);
      const source = await getSource(engine, row.source_id);
      assertSourceIdentity(row, source);
      const live = await getPage(engine, row.source_id, row.slug);
      if (opts.crashAfter === 'after_before_image') throw new Error('fault injection: after_before_image');
      if (opts.crashAfter === 'after_cas') throw new Error('fault injection: after_cas');
      const beforeImage = live ? canonicalJson(live) : '{}';
      const beforeImageObj = JSON.parse(beforeImage);
      let afterRows: PageRow[];
      let cas: Record<string, unknown>;
      if (row.restore_action === 'add_exact') {
        cas = { source_id: row.source_id, slug: row.slug, expected_absent: true };
        afterRows = await engine.executeRaw<PageRow>(`
          INSERT INTO pages (source_id, slug, type, page_kind, title, compiled_truth, timeline, content_hash, frontmatter)
          SELECT $1, $2, $3, 'markdown', $4, $5, $6, $7, $8::jsonb
          WHERE NOT EXISTS (SELECT 1 FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL)
          RETURNING id, source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, generation, updated_at, source_path, deleted_at
        `, [row.source_id, row.slug, payload.type || 'note', payload.title || row.slug, normalizeContent(payload.compiled_truth), payload.timeline ?? '', row.pre_delete_content_hash, payload.frontmatter ?? {}]);
      } else {
        if (!live) throw new Error(`CAS failed: expected live row for ${row.source_id}/${row.slug}`);
        cas = { id: Number(row.live_page_id), source_id: row.source_id, slug: row.slug, generation: Number(row.live_version), content_hash: row.live_content_hash, deleted_at: null };
        afterRows = await engine.executeRaw<PageRow>(`
          UPDATE pages
             SET type = $6,
                 title = $7,
                 compiled_truth = $8,
                 timeline = $9,
                 content_hash = $10,
                 frontmatter = $11::jsonb,
                 deleted_at = NULL
           WHERE id = $1
             AND source_id = $2
             AND slug = $3
             AND generation = $4
             AND content_hash = $5
             AND deleted_at IS NULL
           RETURNING id, source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, generation, updated_at, source_path, deleted_at
        `, [Number(row.live_page_id), row.source_id, row.slug, Number(row.live_version), row.live_content_hash, payload.type || row.type || 'note', payload.title || row.title || row.slug, normalizeContent(payload.compiled_truth), payload.timeline ?? '', row.pre_delete_content_hash, payload.frontmatter ?? {}]);
      }
      if (afterRows.length !== 1) throw new Error(`CAS failed: expected exactly one affected row for ${row.source_id}/${row.slug}, got ${afterRows.length}`);
      if (contentHash(afterRows[0].compiled_truth) !== row.pre_delete_content_hash || afterRows[0].content_hash !== row.pre_delete_content_hash) throw new Error(`stored content hash verification failed for ${row.source_id}/${row.slug}`);
      const afterImage = canonicalJson(afterRows[0]);
      const afterImageObj = JSON.parse(afterImage);
      if (opts.crashAfter === 'after_mutation_before_commit') throw new Error('fault injection: after_mutation_before_commit');
      const rowHash = sha256(canonicalJson({ manifest_row: row, before_image: beforeImageObj, after_image: afterImageObj, cas, payload_hash: row.recovery_payload_hash, approval_hash: opts.approvalHash, batch_hash: batchHash }));
      if (opts.crashAfter === 'audit_write_failure') throw new Error('fault injection: audit_write_failure');
      await engine.executeRaw(`
        INSERT INTO recovery_audit_rows (run_id, batch_id, row_key, action, canonical_manifest_row, before_image, after_image, cas_predicate, payload_hash, approval_hash, row_hash)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11)
      `, [row.run_id, opts.batchId, rowKeyValue, row.restore_action, row, beforeImageObj, afterImageObj, cas, row.recovery_payload_hash, opts.approvalHash, rowHash]);
      await engine.executeRaw(`
        INSERT INTO recovery_apply_state (run_id, batch_id, row_key, status)
        VALUES ($1, $2, $3, 'committed')
      `, [row.run_id, opts.batchId, rowKeyValue]);
      result.applied++;
      result.auditRows++;
    }
    await engine.executeRaw('COMMIT');
  } catch (err) {
    await engine.executeRaw('ROLLBACK');
    throw err;
  }
  if (opts.crashAfter === 'after_commit_before_jsonl') throw new Error('fault injection: after_commit_before_jsonl');
  return result;
}

function assertLiveEqualsAfter(live: PageRow, after: Record<string, unknown>): void {
  const expectedHash = String(after.content_hash ?? '');
  if (String(live.id) !== String(after.id)) throw new Error(`rollback CAS failed: page id changed for ${after.source_id}/${after.slug}`);
  if (String(live.generation) !== String(after.generation)) throw new Error(`rollback CAS failed: generation changed for ${after.source_id}/${after.slug}`);
  if ((live.content_hash ?? '') !== expectedHash) throw new Error(`rollback CAS failed: content hash changed for ${after.source_id}/${after.slug}`);
  if (contentHash(live.compiled_truth) !== expectedHash) throw new Error(`rollback CAS failed: body changed for ${after.source_id}/${after.slug}`);
}

export async function rollbackBatch(engine: BrainEngine, runId: string, batchId: string): Promise<{ rolledBack: number }> {
  await assertRecoverySchema(engine);
  const audits = await engine.executeRaw<{ row_key: string; action: string; canonical_manifest_row: Record<string, unknown>; before_image: Record<string, unknown>; after_image: Record<string, unknown>; cas_predicate: Record<string, unknown>; payload_hash: string; approval_hash: string; row_hash: string }>(
    'SELECT row_key, action, canonical_manifest_row, before_image, after_image, cas_predicate, payload_hash, approval_hash, row_hash FROM recovery_audit_rows WHERE run_id = $1 AND batch_id = $2 ORDER BY id DESC',
    [runId, batchId],
  );
  let rolledBack = 0;
  await engine.executeRaw('BEGIN');
  try {
    for (const audit of audits) {
      const batchRows = await engine.executeRaw<{ batch_hash: string }>('SELECT batch_hash FROM recovery_audit_batches WHERE run_id = $1 AND batch_id = $2', [runId, batchId]);
      const rowHash = sha256(canonicalJson({ manifest_row: audit.canonical_manifest_row, before_image: audit.before_image, after_image: audit.after_image, cas: audit.cas_predicate, payload_hash: audit.payload_hash, approval_hash: audit.approval_hash, batch_hash: batchRows[0]?.batch_hash ?? '' }));
      if (rowHash !== audit.row_hash) throw new Error(`audit row hash verification failed for ${audit.row_key}`);
      const state = await engine.executeRaw<{ status: string }>('SELECT status FROM recovery_apply_state WHERE run_id = $1 AND batch_id = $2 AND row_key = $3', [runId, batchId, audit.row_key]);
      if (state[0]?.status === 'rolled_back') continue;
      const after = audit.after_image ?? {};
      const before = audit.before_image ?? {};
      const sourceId = String(after.source_id ?? before.source_id ?? '');
      const slug = String(after.slug ?? before.slug ?? '');
      const live = await getPage(engine, sourceId, slug);
      if (!live) throw new Error(`rollback CAS failed: live row missing for ${sourceId}/${slug}`);
      assertLiveEqualsAfter(live, after);
      let changed: PageRow[] = [];
      if (audit.action === 'add_exact') {
        changed = await engine.executeRaw<PageRow>(`
          UPDATE pages SET deleted_at = now()
           WHERE id = $1 AND generation = $2 AND content_hash = $3 AND deleted_at IS NULL
           RETURNING id, source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, generation, updated_at, source_path, deleted_at
        `, [live.id, Number(after.generation), String(after.content_hash)]);
      } else if (audit.action === 'merge_exact') {
        changed = await engine.executeRaw<PageRow>(`
          UPDATE pages
             SET type = $4,
                 title = $5,
                 compiled_truth = $6,
                 timeline = $7,
                 content_hash = $8,
                 frontmatter = $9::jsonb,
                 deleted_at = $10::timestamptz
           WHERE id = $1 AND generation = $2 AND content_hash = $3 AND deleted_at IS NULL
           RETURNING id, source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, generation, updated_at, source_path, deleted_at
        `, [live.id, Number(after.generation), String(after.content_hash), before.type, before.title, before.compiled_truth, before.timeline ?? '', before.content_hash, before.frontmatter ?? {}, before.deleted_at ?? null]);
      }
      if (changed.length !== 1) throw new Error(`rollback CAS failed: expected exactly one affected row for ${sourceId}/${slug}, got ${changed.length}`);
      await engine.executeRaw('UPDATE recovery_apply_state SET status = $3, updated_at = now() WHERE run_id = $1 AND batch_id = $2 AND row_key = $4', [runId, batchId, 'rolled_back', audit.row_key]);
      rolledBack++;
    }
    await engine.executeRaw('COMMIT');
  } catch (err) {
    await engine.executeRaw('ROLLBACK');
    throw err;
  }
  return { rolledBack };
}

export async function verifyRecovery(engine: BrainEngine, rows: ManifestRow[], runId: string, opts: { batchId: string; payloadBundle: RecoveryPayloadBundle; approvalHash: string; approval?: ApprovalArtifact; trustedApprovalKeys?: TrustedApprovalKey[]; expectedState?: ExpectedStateArtifact }): Promise<Record<string, { pass: boolean; count: number }>> {
  await assertRecoverySchema(engine);
  const approvedRows = rows.filter(r => ['add_exact', 'merge_exact'].includes(r.restore_action));
  if (opts.approval && opts.trustedApprovalKeys?.length) verifyApprovalSignature(opts.approval, opts.trustedApprovalKeys);
  if (manifestHash(rows) !== opts.approval?.manifest_hash && opts.approval) throw new Error('approval manifest hash mismatch during verify');
  if (payloadBundleHash(opts.payloadBundle) !== (opts.approval?.payload_bundle_hash ?? rows[0]?.payload_bundle_hash)) throw new Error('payload bundle hash mismatch during verify');
  const auditRows = await engine.executeRaw<{ row_key: string; action: string; canonical_manifest_row: Record<string, unknown>; before_image: Record<string, unknown>; after_image: Record<string, unknown>; cas_predicate: Record<string, unknown>; payload_hash: string; approval_hash: string; row_hash: string }>(
    'SELECT row_key, action, canonical_manifest_row, before_image, after_image, cas_predicate, payload_hash, approval_hash, row_hash FROM recovery_audit_rows WHERE run_id = $1 AND batch_id = $2',
    [runId, opts.batchId],
  );
  const batchRows = await engine.executeRaw<{ batch_hash: string }>('SELECT batch_hash FROM recovery_audit_batches WHERE run_id = $1 AND batch_id = $2', [runId, opts.batchId]);
  const auditHashFailures = auditRows.filter(a => sha256(canonicalJson({ manifest_row: a.canonical_manifest_row, before_image: a.before_image, after_image: a.after_image, cas: a.cas_predicate, payload_hash: a.payload_hash, approval_hash: a.approval_hash, batch_hash: batchRows[0]?.batch_hash ?? '' })) !== a.row_hash).length;
  let storedHashFailures = 0;
  for (const row of approvedRows) {
    const page = await getPage(engine, row.source_id, row.slug);
    if (!page || page.content_hash !== row.pre_delete_content_hash || contentHash(page.compiled_truth) !== row.pre_delete_content_hash) storedHashFailures++;
  }
  const approvedKeys = new Set(approvedRows.map(r => `${r.source_id}\u0000${r.slug}`));
  const auditedKeys = new Set(auditRows.map(r => `${String(r.after_image.source_id)}\u0000${String(r.after_image.slug)}`));
  const outOfManifest = [...auditedKeys].filter(k => !approvedKeys.has(k)).length;
  const missingAudit = [...approvedKeys].filter(k => !auditedKeys.has(k)).length;
  const quarantinedAudits = auditRows.filter(a => rows.find(r => r.source_id === a.after_image.source_id && r.slug === a.after_image.slug)?.restore_action.startsWith('quarantine')).length;
  const deleteCount = await engine.executeRaw<{ count: string }>(`SELECT COUNT(*)::text AS count FROM recovery_audit_rows WHERE run_id = $1 AND batch_id = $2 AND action LIKE 'delete%'`, [runId, opts.batchId]);
  const hardDeletes = await engine.executeRaw<{ count: string }>(`SELECT COUNT(*)::text AS count FROM recovery_audit_rows a WHERE run_id = $1 AND batch_id = $2 AND action = 'add_exact' AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = ((a.after_image->>'id')::int))`, [runId, opts.batchId]);
  const dupes = await engine.executeRaw<{ count: string }>(`SELECT COUNT(*)::text AS count FROM (SELECT source_id, slug FROM pages WHERE deleted_at IS NULL GROUP BY source_id, slug HAVING COUNT(*) > 1) d`);
  const approvalMismatches = auditRows.filter(a => a.approval_hash !== opts.approvalHash || !opts.payloadBundle.payloads[a.payload_hash]).length;
  const derivedChanged = await engine.executeRaw<{ count: string }>(`SELECT COUNT(*)::text AS count FROM content_chunks c JOIN recovery_audit_rows a ON c.page_id = ((a.after_image->>'id')::int) WHERE a.run_id = $1 AND a.batch_id = $2`, [runId, opts.batchId]);
  let expectedStateFailures = 0;
  if (opts.expectedState) {
    const expected = opts.expectedState;
    if (expected.schema_version !== 'recovery_expected_state_v1' || expected.run_id !== runId || expected.batch_id !== opts.batchId || expected.manifest_hash !== manifestHash(rows) || expected.payload_bundle_hash !== payloadBundleHash(opts.payloadBundle) || expected.approval_hash !== opts.approvalHash || expected.expected_audit_rows !== auditRows.length) expectedStateFailures++;
    for (const page of expected.expected_pages) {
      const live = await getPage(engine, page.source_id, page.slug);
      if (!live || live.content_hash !== page.content_hash) expectedStateFailures++;
    }
  }
  return {
    manifest_approved_identities_only: { pass: outOfManifest === 0, count: outOfManifest },
    audit_completeness: { pass: auditRows.length === approvedRows.length && missingAudit === 0, count: auditRows.length },
    stored_content_hashes: { pass: storedHashFailures === 0, count: storedHashFailures },
    approval_and_payload_binding: { pass: approvalMismatches === 0, count: approvalMismatches },
    delete_denial: { pass: Number(deleteCount[0]?.count ?? 0) === 0 && Number(hardDeletes[0]?.count ?? 0) === 0, count: Number(deleteCount[0]?.count ?? 0) + Number(hardDeletes[0]?.count ?? 0) },
    duplicate_identity: { pass: Number(dupes[0]?.count ?? 0) === 0, count: Number(dupes[0]?.count ?? 0) },
    quarantine_handling: { pass: quarantinedAudits === 0, count: quarantinedAudits },
    audit_integrity: { pass: auditHashFailures === 0, count: auditHashFailures },
    expected_state: { pass: expectedStateFailures === 0, count: expectedStateFailures },
    no_derived_data_mutation: { pass: Number(derivedChanged[0]?.count ?? 0) === 0, count: Number(derivedChanged[0]?.count ?? 0) },
  };
}

export function gapLedger(rows: ManifestRow[]): string {
  const lines = ['# Recovery Manifest Gap Ledger', '', '| identity | gap_code | missing_evidence | class | confidence | disposition | owner_status | mutation_blocked |', '|---|---|---|---|---:|---|---|---|'];
  let mutationBlocked = 0;
  for (const row of rows) {
    const blocked = !['add_exact', 'merge_exact'].includes(row.restore_action);
    if (blocked) mutationBlocked++;
    const missing = [
      !row.source_id && 'source_id',
      !row.source_uuid && 'source_uuid',
      !row.slug && 'slug',
      !row.pre_delete_content_hash && 'content_hash',
      !row.recovery_payload_hash && 'payload',
      !row.live_page_id && row.restore_action === 'merge_exact' && 'live_page_id',
      !row.live_version && row.restore_action === 'merge_exact' && 'live_version',
    ].filter(Boolean).join(';') || 'none';
    const identity = `${row.source_id || '?'}:${row.slug || '?'}`;
    const code = row.gap_code || (row.conflict_class !== 'none' ? row.conflict_class : row.pre_delete_identity_class);
    lines.push(`| ${identity} | ${code} | ${missing} | ${row.pre_delete_identity_class} | ${row.confidence || '0'} | ${row.restore_action} | ${row.notes || 'unassigned/open'} | ${blocked ? 'true' : 'false'} |`);
  }
  lines.push('', `Totals: manifest_rows=${rows.length}; mutable=${rows.length - mutationBlocked}; mutation_blocked=${mutationBlocked}`);
  return lines.join('\n') + '\n';
}
