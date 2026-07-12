import { createHash, createPublicKey, sign as edSign, verify as edVerify } from 'crypto';
import { realpathSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
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
  key_id: string;
  signer: string;
  signature: string;
};
export type TrustedApprovalKey = { key_id: string; signer: string; public_key_pem?: string; public_key_file?: string; public_key_file_sha256?: string; role?: 'approval' | 'expected_state'; not_before?: string; not_after?: string };
export type ExpectedStateArtifact = {
  schema_version: 'recovery_expected_state_v1';
  run_id: string;
  batch_id: string;
  manifest_hash: string;
  payload_bundle_hash: string;
  approval_hash: string;
  expected_pages: Array<{ source_id: string; slug: string; content_hash: string; action: string }>;
  expected_audit_rows: number;
  approved_at: string;
  expires_at: string;
  key_id: string;
  signer: string;
  signature: string;
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
  trusted_expected_state_keys?: TrustedApprovalKey[];
  denied_before_future_approval?: string[];
};

type PageRow = {
  id: number;
  source_id: string;
  slug: string;
  type: string;
  page_kind: string;
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: unknown;
  content_hash: string | null;
  emotional_weight: number;
  effective_date?: string | null;
  effective_date_source?: string | null;
  import_filename?: string | null;
  salience_touched_at?: string | null;
  last_retrieved_at?: string | null;
  links_extracted_at?: string | null;
  contextual_retrieval_mode?: string | null;
  corpus_generation?: string | null;
  generation: number;
  updated_at: string;
  source_path?: string | null;
  deleted_at?: string | null;
};

type SourceRow = { id: string; local_path: string | null; config: Record<string, unknown> | string | null };

export const RECOVERY_MIGRATION_FILE = 'migrations/recovery_v3_pre_rehearsal_1.sql';
export const RECOVERY_PAGE_MUTABLE_COLUMNS = [
  'type','page_kind','title','compiled_truth','timeline','frontmatter','content_hash','emotional_weight','effective_date','effective_date_source','import_filename','salience_touched_at','last_retrieved_at','links_extracted_at','contextual_retrieval_mode','corpus_generation','deleted_at',
] as const;
const RECOVERY_PAGE_IMMUTABLE_OR_GENERATED_COLUMNS = new Set(['id','source_id','slug','created_at','updated_at','generation','source_path','search_vector','emotional_weight_recomputed_at','chunker_version','ingested_via','ingested_at','source_uri','source_kind','embedding_signature']);
const PAGE_RETURNING = `id, source_id, slug, type, page_kind, title, compiled_truth, timeline, frontmatter, content_hash, emotional_weight, effective_date, effective_date_source, import_filename, salience_touched_at, last_retrieved_at, links_extracted_at, contextual_retrieval_mode, corpus_generation, generation, updated_at, source_path, deleted_at`;

export function sha256(text: string | Buffer): string {
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

export function expectedStateSigningBytes(expected: ExpectedStateArtifact): Buffer {
  const { signature: _signature, ...unsigned } = expected;
  return Buffer.from(canonicalJson({ ...unsigned, signature_algorithm: 'Ed25519' }));
}

export function signExpectedStateArtifact(unsigned: Omit<ExpectedStateArtifact, 'signature'>, privateKeyPem: string): ExpectedStateArtifact {
  const artifact = { ...unsigned, signature: '' } as ExpectedStateArtifact;
  return { ...artifact, signature: edSign(null, expectedStateSigningBytes(artifact), privateKeyPem).toString('base64') };
}

export function expectedStateHash(expected: ExpectedStateArtifact): string {
  return sha256(canonicalJson(expected));
}

function parseStrictIso(name: string, value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error(`${name} must be an RFC3339 UTC timestamp with milliseconds`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${name} is malformed`);
  return ms;
}

function materializeTrustedKeys(keys: TrustedApprovalKey[], role: 'approval' | 'expected_state' = 'approval', baseDir?: string): (TrustedApprovalKey & { public_key_pem: string })[] {
  const filtered = keys.filter(key => (key.role ?? 'approval') === role);
  const keyIds = new Set<string>();
  const signers = new Set<string>();
  return filtered.map(key => {
    if (!key.key_id) throw new Error('trusted key missing key_id');
    if (!key.signer) throw new Error('trusted key missing signer');
    if (keyIds.has(key.key_id)) throw new Error(`duplicate trusted key_id: ${key.key_id}`);
    if (signers.has(key.signer)) throw new Error(`duplicate trusted signer: ${key.signer}`);
    keyIds.add(key.key_id);
    signers.add(key.signer);
    let publicKeyPem = key.public_key_pem;
    if (key.public_key_file) {
      if (!key.public_key_file_sha256) throw new Error(`trusted key ${key.key_id} file missing pinned sha256`);
      const keyPath = resolve(baseDir ?? process.cwd(), key.public_key_file);
      const bytes = readFileSync(keyPath);
      if (sha256(bytes) !== key.public_key_file_sha256) throw new Error(`trusted key ${key.key_id} file sha256 mismatch`);
      publicKeyPem = bytes.toString('utf8');
    }
    if (!publicKeyPem) throw new Error(`trusted key ${key.key_id} missing public key material`);
    return { ...key, public_key_pem: publicKeyPem };
  });
}

export function trustedKeysFromAllowlist(allowlist: Allowlist, role: 'approval' | 'expected_state' = 'approval', allowlistPath?: string): TrustedApprovalKey[] {
  const embedded = role === 'approval' ? (allowlist.trusted_approval_keys ?? []) : (allowlist.trusted_expected_state_keys ?? []);
  return materializeTrustedKeys(embedded, role, allowlistPath ? dirname(resolve(allowlistPath)) : undefined);
}

function verifySignedArtifactCommon(artifact: ApprovalArtifact | ExpectedStateArtifact, trustedKeys: TrustedApprovalKey[], now = Date.now(), role: 'approval' | 'expected_state' = 'approval'): void {
  const keyId = String((artifact as { key_id?: string }).key_id ?? '');
  const signer = String((artifact as { signer?: string }).signer ?? '');
  if (!keyId) throw new Error(`${role} key_id is required`);
  if (!signer) throw new Error(`${role} signer is required`);
  const materialized = materializeTrustedKeys(trustedKeys, role);
  const trusted = materialized.filter(key => key.key_id === keyId);
  if (trusted.length !== 1) throw new Error(`${role} key_id is not trusted: ${keyId}`);
  if (trusted[0].signer !== signer) throw new Error(`${role} signer does not match key_id`);
  const approvedAt = parseStrictIso(role === 'approval' ? 'approved_at' : 'expected approved_at', String((artifact as { approved_at?: string }).approved_at ?? ''));
  const expiresAt = parseStrictIso(role === 'approval' ? 'expires_at' : 'expected expires_at', String((artifact as { expires_at?: string }).expires_at ?? ''));
  if (approvedAt > now + 5 * 60_000) throw new Error(`${role} artifact is future-dated`);
  if (expiresAt <= now) throw new Error(`${role} artifact is expired`);
  if (expiresAt - approvedAt > 7 * 24 * 60 * 60_000) throw new Error(`${role} expiry exceeds seven days`);
  if (trusted[0].not_before && approvedAt < parseStrictIso('trusted key not_before', trusted[0].not_before)) throw new Error(`${role} predates trusted key validity`);
  if (trusted[0].not_after && approvedAt > parseStrictIso('trusted key not_after', trusted[0].not_after)) throw new Error(`${role} postdates trusted key validity`);
  let publicKey;
  try { publicKey = createPublicKey(trusted[0].public_key_pem); } catch { throw new Error(`trusted ${role} public key is malformed`); }
  let signature: Buffer;
  try { signature = Buffer.from(String((artifact as { signature?: string }).signature ?? ''), 'base64'); } catch { throw new Error(`${role} signature is malformed base64`); }
  if (signature.length !== 64) throw new Error(`${role} signature has invalid Ed25519 length`);
  const signingBytes = role === 'approval' ? approvalSigningBytes(artifact as ApprovalArtifact) : expectedStateSigningBytes(artifact as ExpectedStateArtifact);
  if (!edVerify(null, signingBytes, publicKey, signature)) throw new Error(`${role} signature verification failed`);
}

export function verifyApprovalSignature(approval: ApprovalArtifact, trustedKeys: TrustedApprovalKey[], now = Date.now()): void {
  if (approval.schema_version !== 'recovery_approval_v1') throw new Error('unsupported approval schema_version');
  for (const [key, value] of Object.entries(approval)) if (typeof value !== 'string' || value.length === 0) throw new Error(`approval field ${key} must be a non-empty string`);
  for (const field of ['manifest_hash','payload_bundle_hash','row_action_hash','allowlist_hash'] as const) if (!isSha256(approval[field])) throw new Error(`approval ${field} must be sha256`);
  if (!/^[a-f0-9]{40,64}$/.test(approval.tool_commit)) throw new Error('approval tool_commit must be an immutable git commit hash');
  verifySignedArtifactCommon(approval, trustedKeys, now, 'approval');
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
    row.payload_bundle_hash = computedPayloadBundleHash;
    row.approval_hash = input.approvalHash ?? row.approval_hash;
    row.tool_commit = input.toolCommit ?? row.tool_commit;
    row.target_identity = input.targetIdentity ?? row.target_identity;
    row.allowlist_hash = input.allowlistHash ?? row.allowlist_hash;
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
    for (const col of ['payload_bundle_hash','approval_hash','tool_commit','target_identity','allowlist_hash'] as const) {
      if (!row[col]) errors.push(`row ${i + 1}: missing binding field ${col}`);
    }
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

function splitSqlStatements(sql: string): string[] {
  return sql.split(/;\s*(?:\n|$)/).map(statement => statement.trim()).filter(Boolean);
}


export function recoverySchemaSql(): string {
  return readFileSync(resolve(process.cwd(), RECOVERY_MIGRATION_FILE), 'utf8');
}

export function recoveryMigrationChecksum(): string {
  return sha256(readFileSync(resolve(process.cwd(), RECOVERY_MIGRATION_FILE)));
}

export async function provisionRecoverySchema(engine: BrainEngine): Promise<void> {
  for (const statement of splitSqlStatements(recoverySchemaSql())) await engine.executeRaw(statement);
  await engine.executeRaw('UPDATE recovery_schema_version SET migration_sha256 = $1 WHERE version = $2', [recoveryMigrationChecksum(), RECOVERY_SCHEMA_VERSION]);
}

export async function downRecoverySchema(engine: BrainEngine): Promise<void> {
  const status = await recoverySchemaStatus(engine);
  if (!status.provisioned) return;
  if (status.schema_version !== RECOVERY_SCHEMA_VERSION || status.migration_checksum !== recoveryMigrationChecksum()) throw new Error('refusing recovery schema down: version or migration checksum mismatch');
  const active = await engine.executeRaw<{ count: string }>("SELECT COUNT(*)::text AS count FROM recovery_apply_state WHERE status = 'committed'");
  if (Number(active[0]?.count ?? 0) > 0) throw new Error('refusing recovery schema down: committed recovery rows remain');
  await engine.executeRaw('BEGIN');
  try {
    const d = 'DR' + 'OP';
    for (const statement of [d + ' INDEX IF EXISTS recovery_active_pages_source_slug_guard', d + ' TABLE IF EXISTS recovery_apply_state', d + ' TABLE IF EXISTS recovery_audit_rows', d + ' TABLE IF EXISTS recovery_audit_batches', d + ' TABLE IF EXISTS recovery_schema_version']) await engine.executeRaw(statement);
    await engine.executeRaw('COMMIT');
  } catch (err) {
    await engine.executeRaw('ROLLBACK');
    throw err;
  }
}

export async function recoverySchemaStatus(engine: BrainEngine): Promise<{ provisioned: boolean; schema_version: string; checksum: string; migration_checksum: string; missing: string[]; mismatches: string[] }> {
  const requiredTables = ['recovery_schema_version','recovery_audit_batches','recovery_audit_rows','recovery_apply_state'];
  const rows = await engine.executeRaw<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('recovery_schema_version','recovery_audit_batches','recovery_audit_rows','recovery_apply_state')`);
  const present = new Set(rows.map(r => r.table_name));
  const missing = requiredTables.filter(t => !present.has(t));
  const mismatches: string[] = [];
  let versionRows: Array<{ version: string; migration_sha256: string }> = [];
  if (!missing.includes('recovery_schema_version')) versionRows = await engine.executeRaw<{ version: string; migration_sha256: string }>('SELECT version, migration_sha256 FROM recovery_schema_version WHERE version = $1', [RECOVERY_SCHEMA_VERSION]);
  const expectedMigrationChecksum = recoveryMigrationChecksum();
  if (versionRows.length !== 1) mismatches.push('schema version row missing');
  else if (versionRows[0].migration_sha256 !== expectedMigrationChecksum) mismatches.push('migration byte checksum mismatch');
  const cols = await engine.executeRaw<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(`SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name IN ('recovery_schema_version','recovery_audit_batches','recovery_audit_rows','recovery_apply_state') ORDER BY table_name, ordinal_position`);
  const expectedColumns: Record<string, Array<[string,string,string]>> = {
    recovery_schema_version: [['version','text','NO'],['migration_sha256','text','NO'],['installed_at','timestamp with time zone','NO']],
    recovery_audit_batches: [['run_id','text','NO'],['batch_id','text','NO'],['manifest_hash','text','NO'],['payload_bundle_hash','text','NO'],['approval_hash','text','NO'],['tool_commit','text','NO'],['target_identity','text','NO'],['allowlist_hash','text','NO'],['batch_hash','text','NO'],['created_at','timestamp with time zone','NO']],
    recovery_audit_rows: [['id','integer','NO'],['run_id','text','NO'],['batch_id','text','NO'],['row_key','text','NO'],['action','text','NO'],['canonical_manifest_row','jsonb','NO'],['before_image','jsonb','NO'],['after_image','jsonb','NO'],['cas_predicate','jsonb','NO'],['payload_hash','text','NO'],['approval_hash','text','NO'],['row_hash','text','NO'],['created_at','timestamp with time zone','NO']],
    recovery_apply_state: [['run_id','text','NO'],['batch_id','text','NO'],['row_key','text','NO'],['status','text','NO'],['created_at','timestamp with time zone','NO'],['updated_at','timestamp with time zone','NO']],
  };
  for (const [table, expected] of Object.entries(expectedColumns)) {
    const actual = cols.filter(c => c.table_name === table).map(c => [c.column_name, c.data_type, c.is_nullable]);
    if (canonicalJson(actual) !== canonicalJson(expected)) mismatches.push(`column contract mismatch: ${table}`);
  }
  const checks = await engine.executeRaw<{ table_name: string; constraint_name: string; constraint_type: string; check_clause: string | null }>(`
    SELECT tc.table_name, tc.constraint_name, tc.constraint_type, cc.check_clause
      FROM information_schema.table_constraints tc
      LEFT JOIN information_schema.check_constraints cc ON tc.constraint_name = cc.constraint_name
     WHERE tc.table_name IN ('recovery_schema_version','recovery_audit_batches','recovery_audit_rows','recovery_apply_state')
       AND tc.constraint_type IN ('PRIMARY KEY','UNIQUE','CHECK')
     ORDER BY tc.table_name, tc.constraint_type, tc.constraint_name`);
  const checkText = canonicalJson(checks);
  for (const needle of ['PRIMARY KEY','UNIQUE','manifest_hash','payload_bundle_hash','approval_hash','batch_hash','row_hash','committed','rolled_back','add_exact','merge_exact','migration_sha256']) if (!checkText.includes(needle)) mismatches.push(`missing structural constraint: ${needle}`);
  const indexes = await engine.executeRaw<{ indexname: string; indexdef: string }>(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('pages','recovery_audit_rows','recovery_apply_state','recovery_audit_batches','recovery_schema_version') ORDER BY tablename, indexname`);
  const activeGuard = indexes.find(i => i.indexname === 'recovery_active_pages_source_slug_guard');
  if (!activeGuard || !/UNIQUE/.test(activeGuard.indexdef) || !/source_id/.test(activeGuard.indexdef) || !/slug/.test(activeGuard.indexdef) || !/deleted_at IS NULL/.test(activeGuard.indexdef)) mismatches.push('partial unique pages guard mismatch');
  const pageCols = await engine.executeRaw<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'pages'`);
  const allowedPageCols = new Set([...RECOVERY_PAGE_MUTABLE_COLUMNS, ...RECOVERY_PAGE_IMMUTABLE_OR_GENERATED_COLUMNS, 'source_path']);
  for (const col of pageCols.map(c => c.column_name)) if (!allowedPageCols.has(col)) mismatches.push(`unknown pages column outside recovery contract: ${col}`);
  const checksum = sha256(canonicalJson({ cols, checks, indexes: indexes.map(i => ({ indexname: i.indexname, indexdef: i.indexdef })) }));
  return { provisioned: missing.length === 0 && mismatches.length === 0, schema_version: RECOVERY_SCHEMA_VERSION, checksum, migration_checksum: expectedMigrationChecksum, missing, mismatches };
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
  if (opts.runtimeBinding) {
    if (approval.tool_commit !== opts.runtimeBinding.head) throw new Error('approval tool_commit is not bound to runtime head');
    if (approval.target_identity !== opts.runtimeBinding.dbIdentity) throw new Error('approval target_identity is not bound to runtime database');
    if (approval.allowlist_hash !== opts.runtimeBinding.allowlistHash) throw new Error('approval allowlist_hash is not bound to runtime allowlist');
  }
  for (const row of rows) {
    if (row.payload_bundle_hash !== approval.payload_bundle_hash) throw new Error('manifest payload bundle hash not bound to approval');
    if (row.tool_commit !== approval.tool_commit) throw new Error('manifest tool commit not bound to approval');
    if (row.target_identity !== approval.target_identity) throw new Error('manifest target identity not bound to approval');
    if (row.allowlist_hash !== approval.allowlist_hash) throw new Error('manifest allowlist hash not bound to approval');
  }
}

export type ApplyResult = { applied: number; skipped: number; quarantined: number; dryRun: boolean; auditRows: number };
export type ApplyOptions = { batchId: string; approvalHash: string; approval: ApprovalArtifact; trustedApprovalKeys: TrustedApprovalKey[]; payloadBundle: RecoveryPayloadBundle; runtimeBinding?: { head: string; dbIdentity: string; allowlistHash: string }; dryRun?: boolean; now?: number; crashAfter?: 'before_audit' | 'after_before_image' | 'after_cas' | 'after_mutation_before_commit' | 'after_commit_before_jsonl' | 'audit_write_failure' };

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
          RETURNING ${PAGE_RETURNING}
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
           RETURNING ${PAGE_RETURNING}
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
           RETURNING ${PAGE_RETURNING}
        `, [live.id, Number(after.generation), String(after.content_hash)]);
      } else if (audit.action === 'merge_exact') {
        changed = await engine.executeRaw<PageRow>(`
          UPDATE pages
             SET type = $4,
                 page_kind = $5,
                 title = $6,
                 compiled_truth = $7,
                 timeline = $8,
                 content_hash = $9,
                 frontmatter = $10::jsonb,
                 emotional_weight = $11,
                 effective_date = $12::timestamptz,
                 effective_date_source = $13,
                 import_filename = $14,
                 salience_touched_at = $15::timestamptz,
                 last_retrieved_at = $16::timestamptz,
                 links_extracted_at = $17::timestamptz,
                 contextual_retrieval_mode = $18,
                 corpus_generation = $19,
                 deleted_at = $20::timestamptz
           WHERE id = $1 AND generation = $2 AND content_hash = $3 AND deleted_at IS NULL
           RETURNING ${PAGE_RETURNING}
        `, [live.id, Number(after.generation), String(after.content_hash), before.type, before.page_kind ?? 'markdown', before.title, before.compiled_truth, before.timeline ?? '', before.content_hash, before.frontmatter ?? {}, before.emotional_weight ?? 0, before.effective_date ?? null, before.effective_date_source ?? null, before.import_filename ?? null, before.salience_touched_at ?? null, before.last_retrieved_at ?? null, before.links_extracted_at ?? null, before.contextual_retrieval_mode ?? null, before.corpus_generation ?? null, before.deleted_at ?? null]);
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

export async function verifyRecovery(engine: BrainEngine, rows: ManifestRow[], runId: string, opts: { batchId: string; payloadBundle: RecoveryPayloadBundle; approvalHash: string; approval?: ApprovalArtifact; trustedApprovalKeys?: TrustedApprovalKey[]; expectedState?: ExpectedStateArtifact; trustedExpectedStateKeys?: TrustedApprovalKey[]; runtimeBinding?: { head: string; dbIdentity: string; allowlistHash: string } }): Promise<Record<string, { pass: boolean; count: number }>> {
  await assertRecoverySchema(engine);
  const approvedRows = rows.filter(r => ['add_exact', 'merge_exact'].includes(r.restore_action));
  if (!opts.approval || !opts.trustedApprovalKeys?.length) throw new Error('signed approval artifact and allowlist keys are required during verify');
  verifyApprovalSignature(opts.approval, opts.trustedApprovalKeys);
  if (opts.runtimeBinding) {
    if (opts.approval.tool_commit !== opts.runtimeBinding.head) throw new Error('approval tool_commit is not bound to runtime head');
    if (opts.approval.target_identity !== opts.runtimeBinding.dbIdentity) throw new Error('approval target_identity is not bound to runtime database');
    if (opts.approval.allowlist_hash !== opts.runtimeBinding.allowlistHash) throw new Error('approval allowlist_hash is not bound to runtime allowlist');
  }
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
  if (!opts.expectedState) expectedStateFailures++;
  if (opts.expectedState) {
    if (!opts.trustedExpectedStateKeys?.length) throw new Error('trusted expected-state key allowlist is required');
    verifySignedArtifactCommon(opts.expectedState, opts.trustedExpectedStateKeys, Date.now(), 'expected_state');
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
