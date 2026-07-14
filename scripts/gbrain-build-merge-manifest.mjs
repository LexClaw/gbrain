#!/usr/bin/env bun
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { basename, join, resolve } from 'path';
import postgres from 'postgres';
import {
  MANIFEST_COLUMNS,
  contentHash as applicatorContentHash,
  payloadBundleHash,
  payloadHash,
} from '../src/recovery/content-recovery.ts';

export const EXIT = Object.freeze({
  ok: 0,
  unknownSource: 2,
  class6Cap: 3,
  sourceUuid: 4,
  pinnedInput: 5,
  duplicateOrAccounting: 6,
  w2Bound: 7,
  productionDenied: 8,
  noWriteProof: 9,
  usage: 64,
  internal: 70,
});

export class M4Error extends Error {
  constructor(exitCode, message, detail = undefined) {
    super(message);
    this.name = 'M4Error';
    this.exitCode = exitCode;
    this.detail = detail;
  }
}

export const SNAPSHOT_CUT = '2026-06-20T00:40:00.000Z';
export const W2_START = '2026-07-04T00:00:00.000Z';
export const W2_END = '2026-07-12T00:00:00.000Z';
export const PRODUCTION_DSN = 'postgres://TJ@127.0.0.1:5432/gbrain';
export const PRODUCTION_DBNAME = 'gbrain';
export const PRODUCTION_PORT = '5432';
export const PRODUCTION_OID = '16384';
export const REQUIRED_PRODUCTION_DENY_HASH = '0b574ab18a0d6d42523781b0fc020f9c8a738d58596a0cc2f782386773bc5265';
export const REQUIRED_RUNTIME_HEAD = 'bc85238a6ba1dc36e98f1719508b36158982278e';
export const REQUIRED_RUNTIME_HEAD_SHA256 = 'c48ec2cf8507922e8ba59c45666027bc34436d912ee580552ddd0adcaa2042b6';

export const REQUIRED_FILE_HASHES = Object.freeze({
  decisions: '9ec0ae1a9f3a6e493a55accbb7b72c31d1e28477afb58b7fabe654105a8d3ab5',
  m2Receipt: 'bf0ccf7b160bbdc9cb0aee890fe6b529e5b9b20cce37a512e8c94c5c856b9dcb',
  m2UuidGate: 'a568d9493e642a49e7fe55cfb5066adda6a854411633d126b34bfae6e7904c30',
  m2Preflight: '646827c5ea66b798ea77e0eac5bb1a595a80cfb5073be8662ba1a2a999c460f4',
  m3Receipt: '78a1b48add7c31065febc1e9b02c6acafe4f7e864294f6cd1f24bc3e14710529',
  m3Overlap: '1f54af290eaf9f73610ba5f5ae3d668136e6e7fca40afeb450a6a375936500d8',
  plan: 'ddc893d7d6d43923125692ba6268e9645db876f7fdd244861631ee277139a5ed',
});

export const SOURCE_MAP = Object.freeze([
  { corpus: 'historical', input_source_id: 'default', target_source_id: 'default', target_source_uuid: '9e589d6a-f73f-4533-817f-5cdc91d12c1f', eligibility: 'eligible' },
  { corpus: 'current', input_source_id: 'default', target_source_id: 'default', target_source_uuid: '9e589d6a-f73f-4533-817f-5cdc91d12c1f', eligibility: 'eligible' },
  { corpus: 'current', input_source_id: 'vault', target_source_id: 'vault', target_source_uuid: 'b37a5d03-53b2-469b-aede-0a9c126a59c5', eligibility: 'eligible' },
  { corpus: 'current', input_source_id: 'gstack-code-gstac-26360719b3ad9c', target_source_id: 'gstack-code-gstac-26360719b3ad9c', target_source_uuid: 'ae47e7a7-107e-4277-9b12-d6432c33c4f2', eligibility: 'eligible' },
  { corpus: 'current', input_source_id: 'brain-sync-remote-sdekfy', target_source_id: '', target_source_uuid: '', eligibility: 'quarantined_zero_active' },
]);

const REQUIRED_FLAGS = Object.freeze([
  'historical-dsn',
  'current-dsn',
  'decisions',
  'm2-receipt',
  'm2-uuid-gate',
  'm2-preflight',
  'production-deny-identity-hash',
  'm3-receipt',
  'm3-overlap',
  'plan',
  'runtime',
  'runtime-head',
  'run-id',
  'out-dir',
]);
const OPTIONAL_EXACT = Object.freeze({
  'class6-cap': '1000',
  'w2-net-bound': '3067',
  'w2-gross-bound': '4977',
});

export const DRAFT_COLUMNS = Object.freeze([
  ...MANIFEST_COLUMNS,
  'v43_class',
  'canonical_source_id',
  'target_source_id',
  'target_source_uuid',
  'content_identity_hash',
  'metadata_hash',
  'draft_apply_eligible',
  'draft_non_apply_reason',
  'page_version_marker',
]);

export const SOURCE_CENSUS_SQL = `SELECT s.id,
       s.name,
       s.local_path,
       s.config,
       COALESCE(s.config->>'uuid', s.config->>'source_uuid', '') AS effective_source_uuid,
       COUNT(p.*) FILTER (WHERE p.deleted_at IS NULL)::bigint AS active_pages,
       COUNT(p.*)::bigint AS total_pages,
       COUNT(p.*) FILTER (WHERE p.deleted_at IS NOT NULL)::bigint AS tombstoned_pages
FROM sources s
LEFT JOIN pages p ON p.source_id = s.id
GROUP BY s.id, s.name, s.local_path, s.config
ORDER BY s.id COLLATE "C"`;

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function utf8(value) {
  return Buffer.from(String(value), 'utf8');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function byteCompare(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function canonicalJsonBytewise(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonBytewise).join(',')}]`;
  if (!isPlainObject(value)) return JSON.stringify(String(value));
  const entries = Object.entries(value).sort(([a], [b]) => byteCompare(a, b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonBytewise(v)}`).join(',')}}`;
}

export function normalizeContentIdentity(input) {
  return String(input ?? '')
    .normalize('NFC')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n+$/g, '');
}

export function contentIdentityHash(input) {
  return sha256Bytes(utf8(normalizeContentIdentity(input)));
}

export function isoUtcMilliseconds(value) {
  const date = value instanceof Date ? value : new Date(String(value));
  const ms = date.getTime();
  if (!Number.isFinite(ms)) throw new M4Error(EXIT.internal, `invalid timestamp: ${value}`);
  return date.toISOString().replace(/\.\d{3}Z$/, (m) => m);
}

function isoOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  return isoUtcMilliseconds(value);
}

function valueOrNull(value) {
  return value === undefined || value === '' ? null : value;
}

export function metadataHash(row) {
  return sha256Bytes(utf8(canonicalJsonBytewise({
    type: valueOrNull(row.type),
    title: valueOrNull(row.title),
    page_kind: valueOrNull(row.page_kind),
    frontmatter: row.frontmatter ?? null,
    effective_date: isoOrNull(row.effective_date),
    source_path: valueOrNull(row.source_path),
  })));
}

export function pageVersionMarker(row) {
  const markerInput = {
    schema_version: 'gbrain_m4_page_version_marker_v1',
    input_source_id: String(row.input_source_id ?? ''),
    slug: String(row.slug ?? ''),
    page_id: String(row.page_id),
    page_version_id: String(row.page_version_id),
    snapshot_at: isoUtcMilliseconds(row.snapshot_at),
    compiled_truth_normalized: normalizeContentIdentity(row.compiled_truth),
    frontmatter_canonical_json: canonicalJsonBytewise(row.frontmatter ?? null),
  };
  return sha256Bytes(utf8(canonicalJsonBytewise(markerInput) + '\n'));
}

export function parseRunId(runId) {
  const match = /^gbrain-merge-v4-m4-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(runId);
  if (!match) throw new M4Error(EXIT.usage, 'invalid --run-id');
  const [, y, mo, d, h, mi, s] = match;
  if (s === '60') throw new M4Error(EXIT.usage, 'invalid --run-id leap second');
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`) {
    throw new M4Error(EXIT.usage, 'invalid --run-id timestamp');
  }
  return { runId, generated_at_utc: iso };
}

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--json') {
      opts.json = true;
      continue;
    }
    if (!token.startsWith('--')) throw new M4Error(EXIT.usage, `unexpected positional argument ${token}`);
    const key = token.slice(2);
    if (![...REQUIRED_FLAGS, ...Object.keys(OPTIONAL_EXACT)].includes(key)) {
      throw new M4Error(EXIT.usage, `unknown flag --${key}`);
    }
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new M4Error(EXIT.usage, `missing value for --${key}`);
    opts[key] = value;
  }
  for (const key of REQUIRED_FLAGS) {
    if (!opts[key]) throw new M4Error(EXIT.usage, `missing required --${key}`);
  }
  for (const [key, value] of Object.entries(OPTIONAL_EXACT)) {
    if (opts[key] !== undefined && opts[key] !== value) throw new M4Error(EXIT.usage, `invalid --${key}`);
  }
  if (!opts.json) throw new M4Error(EXIT.usage, '--json is required');
  parseRunId(opts['run-id']);
  return opts;
}

export function renderSanitizedCommandLog(opts) {
  const ordered = [];
  for (const key of REQUIRED_FLAGS) {
    let value = String(opts[key] ?? '');
    if (key === 'historical-dsn' || key === 'current-dsn') value = parseDsnIdentity(value).canonical;
    ordered.push(`--${key} ${value}`);
  }
  for (const key of Object.keys(OPTIONAL_EXACT)) {
    if (opts[key] !== undefined) ordered.push(`--${key} ${opts[key]}`);
  }
  ordered.push('--json');
  return `bun scripts/gbrain-build-merge-manifest.mjs ${ordered.join(' ')}\n`;
}

export function assertNoForbiddenPlaceholders(text, fileName = 'output') {
  const forbidden = /\b(TBD|TODO|PLACEHOLDER|PENDING|unknown)\b|0{64}|00000000-0000-0000-0000-000000000000/;
  if (forbidden.test(text)) throw new M4Error(EXIT.internal, `${fileName} contains forbidden placeholder text`);
}

export function parseDsnIdentity(dsn) {
  let url;
  try {
    url = new URL(dsn);
  } catch {
    throw new M4Error(EXIT.usage, 'invalid DSN');
  }
  return {
    raw: dsn,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || '5432',
    database_name: url.pathname.replace(/^\//, ''),
    canonical: `${url.protocol}//${url.username}${url.password ? ':***' : ''}@${url.hostname}:${url.port || '5432'}${url.pathname}`,
  };
}

export function assertDsnNotProduction(dsn, denyHash = REQUIRED_PRODUCTION_DENY_HASH) {
  if (denyHash !== REQUIRED_PRODUCTION_DENY_HASH) throw new M4Error(EXIT.pinnedInput, 'production deny hash mismatch');
  let identity;
  try {
    identity = parseDsnIdentity(dsn);
  } catch {
    throw new M4Error(EXIT.productionDenied, 'input DSN is malformed');
  }
  if (dsn === PRODUCTION_DSN || identity.port === PRODUCTION_PORT || identity.database_name === PRODUCTION_DBNAME) {
    throw new M4Error(EXIT.productionDenied, 'input DSN matches production deny identity');
  }
  return identity;
}

function isFullProductionIdentity(identity) {
  const host = String(identity.host ?? identity.server_addr ?? identity.inet_server_addr ?? '');
  const currentUser = String(identity.current_user ?? identity.user ?? '');
  const schemaVersion = String(identity.schema_version ?? '');
  const recoveryIdentityPresent = identity.recovery_identity_present === false || identity.recovery_identity_present === 'false';
  return (
    host === '127.0.0.1/32' &&
    String(identity.server_port ?? identity.port ?? '') === PRODUCTION_PORT &&
    String(identity.database_name ?? identity.dbname ?? '') === PRODUCTION_DBNAME &&
    currentUser === 'TJ' &&
    String(identity.database_oid ?? '') === PRODUCTION_OID &&
    schemaVersion === '118' &&
    recoveryIdentityPresent
  );
}

export function assertConnectedIdentityAllowed(identity, expected, denyHash = REQUIRED_PRODUCTION_DENY_HASH) {
  if (denyHash !== REQUIRED_PRODUCTION_DENY_HASH) throw new M4Error(EXIT.pinnedInput, 'production deny hash mismatch');
  const port = String(identity.server_port ?? identity.port ?? '');
  const dbname = String(identity.database_name ?? identity.dbname ?? '');
  if (dbname === PRODUCTION_DBNAME || port === PRODUCTION_PORT || isFullProductionIdentity(identity)) {
    throw new M4Error(EXIT.productionDenied, 'connected identity matches production deny identity');
  }
  for (const [key, value] of Object.entries(expected)) {
    if (String(identity[key]) !== String(value)) throw new M4Error(EXIT.pinnedInput, `database identity mismatch for ${key}`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), obj);
}

function expectEq(actual, expected, label) {
  if (actual !== expected) throw new M4Error(EXIT.pinnedInput, `${label} mismatch`);
}

function expectTrue(actual, label) {
  if (actual !== true) throw new M4Error(EXIT.pinnedInput, `${label} mismatch`);
}

function expectNumber(actual, expected, label) {
  if (Number(actual) !== expected) throw new M4Error(EXIT.pinnedInput, `${label} mismatch`);
}

function expectSourceUuidRows(rows, label) {
  if (rows && !Array.isArray(rows) && typeof rows === 'object') {
    rows = Object.entries(rows).map(([id, uuid]) => ({ id, effective_source_uuid: uuid }));
  }
  for (const expected of SOURCE_MAP.filter((entry) => entry.eligibility === 'eligible')) {
    const row = (rows ?? []).find((candidate) =>
      candidate?.input_source_id === expected.input_source_id ||
      candidate?.source_id === expected.input_source_id ||
      candidate?.id === expected.input_source_id
    );
    if (!row) throw new M4Error(EXIT.pinnedInput, `${label} missing ${expected.input_source_id}`);
    expectEq(row.target_source_id ?? row.targetSourceId ?? row.id ?? expected.target_source_id, expected.target_source_id, `${label} target source ${expected.input_source_id}`);
    expectEq(row.target_source_uuid ?? row.targetSourceUuid ?? row.effective_source_uuid ?? row.uuid, expected.target_source_uuid, `${label} target uuid ${expected.input_source_id}`);
  }
}

export function verifyFileHash(path, expected, label) {
  const bytes = readFileSync(path);
  const actual = sha256Bytes(bytes);
  if (actual !== expected) throw new M4Error(EXIT.pinnedInput, `${label} sha256 mismatch`, { actual, expected, path });
  return actual;
}

export function assertNoWriteProof(beforeCounts, afterCounts) {
  if (canonicalJsonBytewise(beforeCounts) !== canonicalJsonBytewise(afterCounts)) {
    throw new M4Error(EXIT.noWriteProof, 'before/after count proof changed');
  }
  return true;
}

export function validatePinnedInputSemantics(opts, docs) {
  const runtimeHeadHash = sha256Bytes(utf8(`${opts['runtime-head']}\n`));
  if (opts['runtime-head'] !== REQUIRED_RUNTIME_HEAD || runtimeHeadHash !== REQUIRED_RUNTIME_HEAD_SHA256) {
    throw new M4Error(EXIT.pinnedInput, 'runtime head mismatch');
  }

  const decisions = docs.decisions;
  expectEq(decisions.schema_version, 'gbrain_merge_human_decision_packet_v1', 'decisions schema_version');
  expectTrue(decisions.approved, 'decisions approved');
  expectEq(decisions.approved_by, 'TJ', 'decisions approved_by');
  expectEq(decisions.approved_at_utc, '2026-07-13T16:01:35Z', 'decisions approved_at_utc');
  expectSourceUuidRows(getPath(decisions, 'D2.source_map') ?? getPath(decisions, 'D2.assignments') ?? getPath(decisions, 'd2.source_map') ?? getPath(decisions, 'decisions.D2.source_map') ?? decisions.source_map, 'decisions D2');
  const quarantinedDecision = getPath(decisions, 'D2.quarantined_source') ?? getPath(decisions, 'D2.quarantined_sources.0') ?? getPath(decisions, 'd2.quarantined_source') ?? decisions.quarantined_source;
  expectEq(quarantinedDecision, 'brain-sync-remote-sdekfy', 'decisions D2 quarantined source');
  expectEq(getPath(decisions, 'D3.path') ?? getPath(decisions, 'D3.canonical_default_local_path') ?? getPath(decisions, 'd3.path') ?? decisions.wiki_path, '/Users/TJ/hermes-workspace/Lex-Workspace/wiki', 'decisions D3 path');

  const m2Receipt = docs.m2Receipt;
  expectEq(m2Receipt.status, 'PASS', 'm2 receipt status');
  expectTrue(m2Receipt.success, 'm2 receipt success');
  expectTrue(getPath(m2Receipt, 'exit_gate.uuid_gate_green'), 'm2 uuid gate green');
  expectTrue(getPath(m2Receipt, 'exit_gate.m4_planning_may_begin'), 'm2 m4 gate');
  expectTrue(getPath(m2Receipt, 'exit_gate.production_untouched_where_comparable'), 'm2 production proof');

  const uuidGate = docs.m2UuidGate;
  expectTrue(uuidGate.pass, 'm2 uuid pass');
  expectTrue(getPath(uuidGate, 'checks.each_actionable_source_has_nonempty_effective_uuid'), 'm2 uuid nonempty check');
  expectTrue(getPath(uuidGate, 'checks.all_three_unique'), 'm2 uuid unique check');
  expectSourceUuidRows(uuidGate.rows ?? uuidGate.source_rows ?? uuidGate.sources, 'm2 uuid gate');
  expectNumber(getPath(uuidGate, 'quarantined_source.active_pages') ?? getPath(uuidGate, 'quarantined.active_pages') ?? getPath(uuidGate, 'quarantined_sources.0.active_pages_in_m3_r2') ?? uuidGate.quarantined_source_active_pages, 0, 'm2 quarantined active pages');

  const preflight = docs.m2Preflight;
  const denyHash = getPath(preflight, 'production_readonly_identity_denial_proof.comparable_identity_hash');
  if (!/^[a-f0-9]{64}$/.test(String(denyHash ?? ''))) throw new M4Error(EXIT.pinnedInput, 'production deny field malformed');
  if (denyHash !== opts['production-deny-identity-hash'] || denyHash !== REQUIRED_PRODUCTION_DENY_HASH) {
    throw new M4Error(EXIT.pinnedInput, 'production deny identity hash mismatch');
  }
  expectEq(preflight.merge_target_identity_hash ?? getPath(preflight, 'merge_target.recovery_identity_hash'), 'fdb43be2976e613335ad0d1f9ea587c63b957c3160959ef68da6f2274e03e079', 'm2 merge target identity hash');
  expectEq(getPath(preflight, 'production_readonly_identity_denial_proof.dsn_redacted') ?? preflight.dsn_redacted, PRODUCTION_DSN, 'production dsn deny');
  expectEq(String(getPath(preflight, 'production_readonly_identity_denial_proof.identity.dbname') ?? getPath(preflight, 'identity.dbname')), PRODUCTION_DBNAME, 'production dbname deny');
  expectEq(String(getPath(preflight, 'production_readonly_identity_denial_proof.identity.port') ?? getPath(preflight, 'identity.port')), PRODUCTION_PORT, 'production port deny');
  expectEq(String(getPath(preflight, 'production_readonly_identity_denial_proof.identity.database_oid') ?? getPath(preflight, 'identity.database_oid')), PRODUCTION_OID, 'production oid deny');
  expectTrue(preflight.pass, 'm2 preflight pass');
  expectTrue(preflight.differs_from_merge ?? getPath(preflight, 'production_readonly_identity_denial_proof.differs_from_merge'), 'm2 preflight differs_from_merge');
  expectTrue(preflight.read_only_probe_only ?? getPath(preflight, 'production_readonly_identity_denial_proof.read_only_probe_only'), 'm2 preflight read_only_probe_only');
  expectTrue(getPath(preflight, 'runtime_head.clean') ?? getPath(preflight, 'runtime.clean'), 'm2 runtime head clean');

  const m3Receipt = docs.m3Receipt;
  expectEq(m3Receipt.status, 'PASS', 'm3 receipt status');
  expectTrue(m3Receipt.success, 'm3 receipt success');
  expectTrue(getPath(m3Receipt, 'dump.hash_matches_required'), 'm3 dump hash');
  const activeBySource = getPath(m3Receipt, 'source_uuid_census.active_pages_by_source');
  const activePages = getPath(m3Receipt, 'dump.active_pages') ?? getPath(m3Receipt, 'active_pages') ?? (activeBySource ? Object.values(activeBySource).reduce((sum, value) => Number(sum) + Number(value), 0) : undefined);
  expectNumber(activePages, 21492, 'm3 active pages');
  const mutationFlags = getPath(m3Receipt, 'production_mutation_flags') ?? getPath(m3Receipt, 'dump.production_mutation_flags') ?? getPath(m3Receipt, 'writes') ?? {};
  const requiredFalseFlags = ['failed_database_mutated', 'production_database_mutation_commands_executed', 'production_redump_executed', 'm2_or_m4_commands_executed', 'service_or_config_changes_executed', 'repository_or_code_edits_executed'];
  for (const key of requiredFalseFlags) {
    if (key in mutationFlags && mutationFlags[key] !== false) throw new M4Error(EXIT.pinnedInput, `m3 production mutation flag ${key} mismatch`);
  }
  for (const [key, value] of Object.entries(getPath(m3Receipt, 'production_mutation_flags') ?? getPath(m3Receipt, 'dump.production_mutation_flags') ?? {})) {
    if (value !== false) throw new M4Error(EXIT.pinnedInput, `m3 production mutation flag ${key} mismatch`);
  }

  const overlap = docs.m3Overlap;
  const expectedOverlap = {
    default_overlap: 11843,
    identical: 11639,
    divergent: 204,
    historical_only: 94684,
    current_default_only: 8107,
  };
  const overlapAliases = {
    default_overlap: ['default_overlap', 'counts.default_overlap', 'candidate_snapshot_default_to_prod_default.overlap', 'previous_m3_overlap_decision_inputs.slug_overlap'],
    identical: ['identical', 'counts.identical', 'candidate_snapshot_default_to_prod_default.identical_content_hash', 'previous_m3_overlap_decision_inputs.identical_content_hash'],
    divergent: ['divergent', 'counts.divergent', 'candidate_snapshot_default_to_prod_default.divergent_content_hash', 'previous_m3_overlap_decision_inputs.divergent_content_hash'],
    historical_only: ['historical_only', 'counts.historical_only', 'candidate_snapshot_default_to_prod_default.snapshot_only', 'previous_m3_overlap_decision_inputs.snapshot_only'],
    current_default_only: ['current_default_only', 'counts.current_default_only', 'candidate_snapshot_default_to_prod_default.prod_only', 'previous_m3_overlap_decision_inputs.prod_only'],
  };
  for (const [key, value] of Object.entries(expectedOverlap)) {
    const actual = overlapAliases[key].map((path) => (path.includes('.') ? getPath(overlap, path) : overlap[path])).find((candidate) => candidate !== undefined);
    if (Number(actual) !== value) throw new M4Error(EXIT.pinnedInput, `m3 overlap ${key} mismatch`);
  }
  expectTrue(overlap.candidate_matches_previous_m3, 'm3 overlap previous candidate');

  return { production_deny_identity_hash: denyHash };
}

export function verifyPinnedInputs(opts) {
  const hashes = {
    decisions: verifyFileHash(opts.decisions, REQUIRED_FILE_HASHES.decisions, 'decisions'),
    m2Receipt: verifyFileHash(opts['m2-receipt'], REQUIRED_FILE_HASHES.m2Receipt, 'm2 receipt'),
    m2UuidGate: verifyFileHash(opts['m2-uuid-gate'], REQUIRED_FILE_HASHES.m2UuidGate, 'm2 uuid gate'),
    m2Preflight: verifyFileHash(opts['m2-preflight'], REQUIRED_FILE_HASHES.m2Preflight, 'm2 preflight'),
    m3Receipt: verifyFileHash(opts['m3-receipt'], REQUIRED_FILE_HASHES.m3Receipt, 'm3 receipt'),
    m3Overlap: verifyFileHash(opts['m3-overlap'], REQUIRED_FILE_HASHES.m3Overlap, 'm3 overlap'),
    plan: verifyFileHash(opts.plan, REQUIRED_FILE_HASHES.plan, 'plan'),
  };
  const semantic = validatePinnedInputSemantics(opts, {
    decisions: readJson(opts.decisions),
    m2Receipt: readJson(opts['m2-receipt']),
    m2UuidGate: readJson(opts['m2-uuid-gate']),
    m2Preflight: readJson(opts['m2-preflight']),
    m3Receipt: readJson(opts['m3-receipt']),
    m3Overlap: readJson(opts['m3-overlap']),
  });
  return { hashes, production_deny_identity_hash: semantic.production_deny_identity_hash };
}

function sourceEntry(corpus, inputSourceId) {
  return SOURCE_MAP.find((entry) => entry.corpus === corpus && entry.input_source_id === inputSourceId);
}

function assertSourceCensus(corpus, sources) {
  const historicalUuids = [];
  const historicalSourceIds = [];
  for (const source of sources ?? []) {
    const entry = sourceEntry(corpus, source.id);
    if (!entry) {
      if (Number(source.active_pages ?? 0) > 0) throw new M4Error(EXIT.unknownSource, `unmapped source ${source.id}`);
      continue;
    }
    if (entry.eligibility === 'quarantined_zero_active' && Number(source.active_pages ?? 0) !== 0) {
      throw new M4Error(EXIT.unknownSource, `${source.id} has active pages`);
    }
    if (entry.eligibility === 'eligible') {
      const uuid = String(source.effective_source_uuid ?? source.config?.uuid ?? source.config?.source_uuid ?? '');
      if (corpus === 'historical') {
        if (!uuid) throw new M4Error(EXIT.sourceUuid, `target source uuid missing for ${source.id}`);
        historicalUuids.push(uuid);
        historicalSourceIds.push(source.id);
      }
      if (uuid && uuid !== entry.target_source_uuid) throw new M4Error(EXIT.sourceUuid, `target source uuid mismatch for ${source.id}`);
    }
  }
  if (corpus === 'historical' && new Set(historicalUuids).size !== historicalUuids.length) {
    throw new M4Error(EXIT.sourceUuid, 'duplicate target source uuid');
  }
  if (corpus === 'historical' && new Set(historicalSourceIds).size !== historicalSourceIds.length) {
    throw new M4Error(EXIT.sourceUuid, 'duplicate target source row');
  }
}

function sourceUuidFromRow(source) {
  return String(source?.effective_source_uuid ?? source?.config?.uuid ?? source?.config?.source_uuid ?? '');
}

export function buildHistoricalTargetSourceMap(sources) {
  const expectedTargets = new Map(SOURCE_MAP.filter((entry) => entry.eligibility === 'eligible').map((entry) => [entry.target_source_id, entry.target_source_uuid]));
  const rowsByTarget = new Map();
  for (const source of sources ?? []) {
    const targetUuid = expectedTargets.get(source.id);
    if (!targetUuid) continue;
    rowsByTarget.set(source.id, [...(rowsByTarget.get(source.id) ?? []), source]);
  }
  return rowsByTarget;
}

function assertHistoricalTargetSourceForDraft(sourceRow, historicalTargetSources) {
  const targetSourceId = String(sourceRow.target_source_id ?? '');
  const targetUuid = String(sourceRow.target_source_uuid ?? '');
  const rows = historicalTargetSources.get(targetSourceId) ?? [];
  if (rows.length !== 1) throw new M4Error(EXIT.sourceUuid, `target source row count invalid for ${targetSourceId}`);
  const historicalUuid = sourceUuidFromRow(rows[0]);
  if (!historicalUuid) throw new M4Error(EXIT.sourceUuid, `target source uuid missing for ${targetSourceId}`);
  if (historicalUuid !== targetUuid) throw new M4Error(EXIT.sourceUuid, `target source uuid mismatch for ${targetSourceId}`);
}

function enrichPage(row, corpus, sourceLocalPaths = new Map()) {
  const inputSourceId = row.input_source_id ?? row.source_id;
  const entry = sourceEntry(corpus, inputSourceId);
  const authoritativeSourcePath = String(row.source_local_path ?? sourceLocalPaths.get(inputSourceId) ?? '');
  if (!entry) {
    return { ...row, corpus, canonical_source_id: '', target_source_id: '', target_source_uuid: '', authoritative_source_path: authoritativeSourcePath, content_identity_hash: contentIdentityHash(row.compiled_truth), metadata_hash: metadataHash(row), source_map_status: 'unmapped' };
  }
  return {
    ...row,
    corpus,
    input_source_id: inputSourceId,
    canonical_source_id: entry.target_source_id,
    target_source_id: entry.target_source_id,
    target_source_uuid: entry.target_source_uuid,
    authoritative_source_path: authoritativeSourcePath,
    content_identity_hash: contentIdentityHash(row.compiled_truth),
    metadata_hash: metadataHash(row),
    app_content_hash: applicatorContentHash(String(row.compiled_truth ?? '')),
    source_map_status: entry.eligibility,
  };
}

function pageIdentity(row) {
  return `${row.canonical_source_id}\u0000${row.slug}`;
}

function sideRows(rows, side, deleted) {
  return rows.filter((row) => row.corpus === side && Boolean(row.deleted_at) === deleted);
}

function strictTruncationEvidence(historical, current) {
  const h = normalizeContentIdentity(historical.compiled_truth);
  const c = normalizeContentIdentity(current.compiled_truth);
  if (c.length < 1 || !(c.length < h.length * 0.6)) return null;
  const prefix = h.startsWith(c);
  const firstHeadingOnly = /^# +[^\n]+$/.test(c) && h.startsWith(`${c}\n`);
  if (!prefix && !firstHeadingOnly) return null;
  const currentParagraphs = c.split(/\n{2,}/).filter(Boolean);
  const noAbsentParagraph = currentParagraphs.every((p) => h.includes(p));
  if (!noAbsentParagraph) return null;
  if (historical.metadata_hash !== current.metadata_hash) return null;
  let offset = 0;
  while (offset < h.length && offset < c.length && h.charCodeAt(offset) === c.charCodeAt(offset)) offset++;
  return {
    kind: 'strict_truncation',
    historical_length: h.length,
    current_length: c.length,
    prefix_proof: prefix || firstHeadingOnly,
    first_differing_byte_offset: Buffer.byteLength(c.slice(0, offset), 'utf8'),
    historical_content_identity_hash: historical.content_identity_hash,
    current_content_identity_hash: current.content_identity_hash,
  };
}

function stubEvidence(historical, current) {
  const h = normalizeContentIdentity(historical.compiled_truth);
  const c = normalizeContentIdentity(current.compiled_truth).replace(/^#+\s*/gm, '').trim();
  if (h.length > 200 && /^(TODO|TBD|stub|placeholder)$/i.test(c)) {
    return {
      kind: 'stub',
      historical_length: h.length,
      current_length: c.length,
      historical_content_identity_hash: historical.content_identity_hash,
      current_content_identity_hash: current.content_identity_hash,
    };
  }
  return null;
}

function hasHumanClass5Disposition(historical, current, dispositions = []) {
  return dispositions.some((d) =>
    d?.canonical_source_id === historical.canonical_source_id &&
    d?.slug === historical.slug &&
    String(d?.historical_page_id) === String(historical.id) &&
    String(d?.current_page_id) === String(current.id) &&
    d?.historical_content_identity_hash === historical.content_identity_hash &&
    d?.current_content_identity_hash === current.content_identity_hash &&
    d?.approve_historical_preservation === true
  );
}

function postSnapshot(row) {
  return Date.parse(row.created_at ?? '1970-01-01T00:00:00.000Z') > Date.parse(SNAPSHOT_CUT)
    || Date.parse(row.updated_at ?? '1970-01-01T00:00:00.000Z') > Date.parse(SNAPSHOT_CUT);
}

function pageVersionEvidenceFor(pageVersions, identity, current) {
  return pageVersions.filter((pv) =>
    pv.canonical_source_id === identity.canonical_source_id &&
    pv.slug === identity.slug &&
    Date.parse(pv.snapshot_at) > Date.parse(SNAPSHOT_CUT) &&
    applicatorContentHash(String(pv.compiled_truth ?? '')) === current.app_content_hash
  );
}

function classifyIdentity(group, pageVersions, dispositions) {
  if (group.every((row) => row.derived_only === true)) return { class: 8, disposition: 'derived_dependent_data_metadata_only' };
  const historicalActive = sideRows(group, 'historical', false);
  const currentActive = sideRows(group, 'current', false);
  const historicalTombstone = sideRows(group, 'historical', true);
  const currentTombstone = sideRows(group, 'current', true);
  if (group.some((row) => row.source_map_status === 'unmapped')) return { class: 9, disposition: 'blocking_unmapped_source' };
  if (historicalActive.length > 1 || currentActive.length > 1) return { class: 9, disposition: 'blocking_duplicate_active_identity' };
  if (historicalActive.length === 0 && currentActive.length === 0) return { class: 7, disposition: 'ledger_tombstone_or_noncanonical' };
  const h = historicalActive[0];
  const c = currentActive[0];
  if (h && h.source_map_status === 'quarantined_zero_active') return { class: 7, disposition: 'quarantined_source_ledger_only' };
  if (c && c.source_map_status === 'quarantined_zero_active') return { class: 7, disposition: 'quarantined_source_ledger_only' };
  if (h && c && h.content_identity_hash === c.content_identity_hash) return { class: 1, disposition: 'keep_base_fold_evidence' };
  if (h && c) {
    const versionEvidence = pageVersionEvidenceFor(pageVersions, h, c);
    if (postSnapshot(c) || (Date.parse(c.updated_at ?? 0) > Date.parse(h.updated_at ?? 0) && versionEvidence.length > 0)) {
      return { class: 4, disposition: 'draft_merge_exact_eligible', pageVersionMarkers: versionEvidence.map((pv) => pv.page_version_marker) };
    }
    const proof = strictTruncationEvidence(h, c) ?? stubEvidence(h, c);
    if (proof || hasHumanClass5Disposition(h, c, dispositions)) return { class: 5, disposition: 'preserve_historical_row_level_proof', class5Proof: proof ?? { kind: 'human_disposition' } };
    return { class: 6, disposition: 'quarantine_divergent_unresolved' };
  }
  if (h && !c && currentTombstone.length === 0) return { class: 2, disposition: 'w1_restore_scope_ledger_only' };
  if (c && !h && historicalTombstone.length === 0) return { class: 3, disposition: 'draft_add_exact_eligible' };
  return { class: 7, disposition: 'ledger_tombstone_or_noncanonical' };
}

function recoveryPayloadFor(row) {
  return {
    source_id: row.target_source_id,
    source_uuid: row.target_source_uuid,
    slug: row.slug,
    source_path: String(row.authoritative_source_path ?? ''),
    type: String(row.type ?? 'note'),
    title: String(row.title ?? row.slug),
    compiled_truth: String(row.compiled_truth ?? ''),
    frontmatter: row.frontmatter ?? {},
    timeline: row.timeline ?? '',
    pre_delete_export_commit: REQUIRED_RUNTIME_HEAD,
  };
}

function buildDraftRow({ runId, batchId, action, sourceRow, liveRow, v43Class, pageVersionMarkerValue = '' }) {
  const payload = recoveryPayloadFor(sourceRow);
  const recoveryPayloadHash = payloadHash(payload);
  const base = Object.fromEntries(DRAFT_COLUMNS.map((col) => [col, '']));
  Object.assign(base, {
    run_id: runId,
    batch_id: batchId,
    source_id: sourceRow.target_source_id,
    source_uuid: sourceRow.target_source_uuid,
    slug: sourceRow.slug,
    source_path: String(sourceRow.authoritative_source_path ?? ''),
    type: String(sourceRow.type ?? 'note'),
    title: String(sourceRow.title ?? sourceRow.slug),
    pre_delete_identity_class: 'exact_predelete',
    pre_delete_evidence_kind: action === 'add_exact' ? 'current_active_exact' : 'current_post_snapshot_exact',
    pre_delete_content_hash: sourceRow.app_content_hash,
    pre_delete_page_version_id: pageVersionMarkerValue ? String(pageVersionMarkerValue) : '',
    pre_delete_updated_at: isoOrNull(sourceRow.updated_at) ?? '',
    pre_delete_export_commit: REQUIRED_RUNTIME_HEAD,
    recovery_payload_hash: recoveryPayloadHash,
    tool_commit: REQUIRED_RUNTIME_HEAD,
    live_present: liveRow ? 'true' : 'false',
    live_page_id: liveRow ? String(liveRow.id) : '',
    live_version: liveRow ? String(liveRow.generation ?? '') : '',
    live_content_hash: liveRow ? String(liveRow.stored_content_hash ?? liveRow.app_content_hash ?? '') : '',
    live_updated_at: liveRow ? (isoOrNull(liveRow.updated_at) ?? '') : '',
    live_source_id: liveRow ? String(liveRow.target_source_id) : '',
    post_incident_identity_class: action === 'add_exact' ? 'absent' : 'current_post_snapshot',
    post_incident_write: action === 'merge_exact' ? 'true' : 'false',
    conflict_class: 'none',
    restore_action: action,
    restore_source: 'm4_draft_planner',
    confidence: '1.0',
    notes: 'M4 draft row; non-apply-ready until M9 finalizer binds approval target and allowlist',
    v43_class: String(v43Class),
    canonical_source_id: sourceRow.canonical_source_id,
    target_source_id: sourceRow.target_source_id,
    target_source_uuid: sourceRow.target_source_uuid,
    content_identity_hash: sourceRow.content_identity_hash,
    metadata_hash: sourceRow.metadata_hash,
    draft_apply_eligible: 'true',
    draft_non_apply_reason: 'missing_m9_approval_target_allowlist',
    page_version_marker: pageVersionMarkerValue,
  });
  return { row: base, payload };
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv(columns, rows) {
  return [columns.join(','), ...rows.map((row) => columns.map((col) => csvEscape(row[col] ?? '')).join(','))].join('\n') + '\n';
}

function makeLedgerRow(inputRow, cls, identityClass, extra = {}) {
  return {
    input_corpus: inputRow.corpus,
    input_page_id: String(inputRow.id),
    input_source_id: String(inputRow.input_source_id),
    page_source_path: String(inputRow.source_path ?? ''),
    authoritative_source_path: String(inputRow.authoritative_source_path ?? ''),
    canonical_source_id: String(inputRow.canonical_source_id),
    slug: String(inputRow.slug),
    deleted: inputRow.deleted_at ? 'true' : 'false',
    v43_class: String(cls),
    identity_class: String(identityClass),
    content_identity_hash: inputRow.content_identity_hash,
    applicator_content_hash: inputRow.app_content_hash,
    metadata_hash: inputRow.metadata_hash,
    page_version_marker: extra.page_version_marker ?? '',
    disposition: extra.disposition ?? '',
  };
}

export function buildPlanFromSnapshots(input) {
  const run = parseRunId(input.runId);
  const batchId = input.batchId ?? 'm4-draft';
  const class6Cap = Number(input.class6Cap ?? 1000);
  const w2NetBound = Number(input.w2NetBound ?? 3067);
  const w2GrossBound = Number(input.w2GrossBound ?? 4977);
  const sourceCensus = { historical: input.historical?.sources ?? [], current: input.current?.sources ?? [] };
  assertSourceCensus('historical', sourceCensus.historical);
  assertSourceCensus('current', sourceCensus.current);
  const sourceLocalPaths = {
    historical: new Map(sourceCensus.historical.map((source) => [source.id, String(source.local_path ?? '')])),
    current: new Map(sourceCensus.current.map((source) => [source.id, String(source.local_path ?? '')])),
  };
  const historicalRows = (input.historical?.pages ?? []).map((row) => enrichPage(row, 'historical', sourceLocalPaths.historical));
  const currentRows = (input.current?.pages ?? []).map((row) => enrichPage(row, 'current', sourceLocalPaths.current));
  const allRows = [...historicalRows, ...currentRows];
  const historicalTargetSources = buildHistoricalTargetSourceMap(sourceCensus.historical);

  const pageVersions = [...(input.historical?.pageVersions ?? []), ...(input.current?.pageVersions ?? [])].map((row) => {
    const corpus = row.corpus ?? (historicalRows.some((p) => String(p.id) === String(row.page_id)) ? 'historical' : 'current');
    const enriched = enrichPage({ ...row, id: row.page_id, input_source_id: row.input_source_id, type: null, title: null, page_kind: null, source_path: null }, corpus);
    return { ...row, corpus, canonical_source_id: enriched.canonical_source_id, target_source_id: enriched.target_source_id, page_version_marker: pageVersionMarker(row) };
  });

  const groups = new Map();
  for (const row of allRows) {
    const key = row.canonical_source_id ? pageIdentity(row) : `${row.corpus}\u0000${row.input_source_id}\u0000${row.slug}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const ledger = [];
  const draft = [];
  const payloads = {};
  const identityClasses = new Map();
  const classCounts = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i + 1), 0]));
  const residues = [];
  for (const [identity, group] of [...groups.entries()].sort(([a], [b]) => byteCompare(a, b))) {
    const classified = classifyIdentity(group, pageVersions, input.humanDispositions ?? []);
    const cls = classified.class;
    classCounts[String(cls)]++;
    identityClasses.set(identity, cls);
    for (const row of group.sort((a, b) => byteCompare(`${a.corpus}\u0000${a.id}`, `${b.corpus}\u0000${b.id}`))) {
      ledger.push(makeLedgerRow(row, cls, identity, { disposition: classified.disposition, page_version_marker: (classified.pageVersionMarkers ?? [])[0] ?? '' }));
    }
    if (cls === 9) {
      if (classified.disposition.includes('duplicate')) throw new M4Error(EXIT.duplicateOrAccounting, classified.disposition);
      throw new M4Error(EXIT.unknownSource, classified.disposition);
    }
    if (cls === 3) {
      const c = sideRows(group, 'current', false)[0];
      assertHistoricalTargetSourceForDraft(c, historicalTargetSources);
      const { row, payload } = buildDraftRow({ runId: run.runId, batchId, action: 'add_exact', sourceRow: c, liveRow: null, v43Class: cls });
      draft.push(row);
      payloads[payloadHash(payload)] = payload;
    }
    if (cls === 4) {
      const h = sideRows(group, 'historical', false)[0];
      const c = sideRows(group, 'current', false)[0];
      assertHistoricalTargetSourceForDraft(c, historicalTargetSources);
      const marker = (classified.pageVersionMarkers ?? [])[0] ?? '';
      const { row, payload } = buildDraftRow({ runId: run.runId, batchId, action: 'merge_exact', sourceRow: c, liveRow: h, v43Class: cls, pageVersionMarkerValue: marker });
      draft.push(row);
      payloads[payloadHash(payload)] = payload;
    }
  }

  const activeClass6 = [...identityClasses.values()].filter((cls) => cls === 6).length;
  if (activeClass6 > class6Cap) throw new M4Error(EXIT.class6Cap, 'class 6 cap exceeded', { activeClass6, class6Cap });

  const duplicateDraftKeys = new Set();
  for (const row of draft) {
    const key = `${row.source_id}\u0000${row.slug}`;
    if (duplicateDraftKeys.has(key)) throw new M4Error(EXIT.duplicateOrAccounting, 'duplicate draft identity');
    duplicateDraftKeys.add(key);
  }

  const equations = computeAccounting(allRows, identityClasses);
  residues.push(...equations.residue_arrays.flatMap((entry) => entry.values));
  if (residues.length) throw new M4Error(EXIT.duplicateOrAccounting, 'accounting residue');

  const w2 = computeW2(allRows, pageVersions);
  const w2Exceeded = w2.net > w2NetBound || w2.gross > w2GrossBound;
  const effectiveDraft = w2Exceeded ? [] : draft;
  const effectivePayloads = w2Exceeded ? {} : payloads;

  const bundle = { schema_version: 'recovery_payload_bundle_v1', run_id: run.runId, payloads: effectivePayloads };
  const bundleHash = payloadBundleHash(bundle);
  for (const row of effectiveDraft) row.payload_bundle_hash = bundleHash;

  const metadata = {
    schema_version: 'gbrain_m4_manifest_metadata_v1',
    run_id: run.runId,
    generated_at_utc: run.generated_at_utc,
    direct_apply_ready: false,
    validate_manifest_expected_to_pass: false,
    non_apply_ready_reason: w2Exceeded ? 'M4 blocked because W2 loss-window bounds exceed the approved limit' : 'M4 draft lacks M9 approval_hash/target_identity/allowlist_hash and includes non-final ledger rows',
    source_map: SOURCE_MAP,
    production_deny_identity: { comparable_identity_hash: input.productionDenyIdentityHash ?? REQUIRED_PRODUCTION_DENY_HASH, dsn_redacted: PRODUCTION_DSN, dbname: PRODUCTION_DBNAME, port: Number(PRODUCTION_PORT), database_oid: PRODUCTION_OID },
    output_hashes: {},
    blocking: w2Exceeded,
    blocking_findings: w2Exceeded ? [{ code: 'W2_BOUNDS_EXCEEDED', exit_code: EXIT.w2Bound, w2, bounds: { net: w2NetBound, gross: w2GrossBound } }] : [],
    count_summary: { classes: classCounts, draft_rows: effectiveDraft.length, ledger_rows: ledger.length, payloads: Object.keys(effectivePayloads).length },
  };

  const accounting = {
    schema_version: 'gbrain_m4_accounting_proof_v1',
    pass: !w2Exceeded,
    blocking: w2Exceeded,
    blocking_exit_code: w2Exceeded ? EXIT.w2Bound : 0,
    equations,
    duplicate_checks: {
      active_duplicate_per_side_after_mapping: [],
      duplicate_draft_identity: [],
    },
    w1: { historical_only_restoration_scope: classCounts['2'] },
    w2,
    residue_arrays: [],
  };

  return { run, manifestDraftRows: effectiveDraft, ledgerRows: ledger, payloadBundle: bundle, manifestMetadata: metadata, accountingProof: accounting, pageVersions };
}

export function computeAccounting(rows, identityClasses) {
  const accountingRows = rows.filter((row) => row.derived_only !== true);
  const count = (predicate) => accountingRows.filter(predicate).length;
  const classOf = (row) => identityClasses.get(row.canonical_source_id ? pageIdentity(row) : `${row.corpus}\u0000${row.input_source_id}\u0000${row.slug}`);
  const equations = {
    historical_active: {
      observed: count((r) => r.corpus === 'historical' && !r.deleted_at),
      computed: count((r) => r.corpus === 'historical' && !r.deleted_at && [1, 2, 4, 5, 6, 9].includes(classOf(r))),
    },
    current_active: {
      observed: count((r) => r.corpus === 'current' && !r.deleted_at),
      computed: count((r) => r.corpus === 'current' && !r.deleted_at && [1, 3, 4, 5, 6, 9].includes(classOf(r))),
    },
    historical_tombstoned: {
      observed: count((r) => r.corpus === 'historical' && r.deleted_at),
      computed: count((r) => r.corpus === 'historical' && r.deleted_at && [7, 9].includes(classOf(r))),
    },
    current_tombstoned: {
      observed: count((r) => r.corpus === 'current' && r.deleted_at),
      computed: count((r) => r.corpus === 'current' && r.deleted_at && [7, 9].includes(classOf(r))),
    },
  };
  const residue_arrays = Object.entries(equations)
    .filter(([, v]) => v.observed !== v.computed)
    .map(([name, v]) => ({ name, values: [`${v.observed}:${v.computed}`] }));
  return { ...equations, identity_union_count: identityClasses.size, distinct_page_identity: identityClasses.size, residue_arrays };
}

function inW2(value) {
  const t = Date.parse(value ?? '');
  return Number.isFinite(t) && t >= Date.parse(W2_START) && t < Date.parse(W2_END);
}

export function computeW2(rows, pageVersions) {
  const currentTombstones = rows.filter((row) => row.corpus === 'current' && row.deleted_at && inW2(row.deleted_at)).length;
  const versionEvidence = pageVersions.filter((row) => inW2(row.snapshot_at)).length;
  return { net: currentTombstones, gross: currentTombstones + versionEvidence, current_inventory_tombstones: currentTombstones, page_version_evidence: versionEvidence };
}

async function extractDb(dsn, expectedIdentity) {
  assertDsnNotProduction(dsn);
  const sql = postgres(dsn, { max: 1, idle_timeout: 1, connect_timeout: 10 });
  try {
    await sql.unsafe('BEGIN READ ONLY');
    await sql.unsafe("SET LOCAL default_transaction_read_only = on");
    await sql.unsafe("SET LOCAL statement_timeout = '10min'");
    await sql.unsafe("SET LOCAL idle_in_transaction_session_timeout = '10min'");
    const ro = await sql.unsafe('SHOW transaction_read_only');
    if (String(ro[0]?.transaction_read_only ?? ro[0]?.transaction_read_only ?? '').toLowerCase() !== 'on') throw new M4Error(EXIT.noWriteProof, 'transaction is not read-only');
    const identity = (await sql.unsafe(`SELECT current_database() AS database_name,
       (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS database_oid,
       inet_server_addr()::text AS server_addr,
       inet_server_port()::text AS server_port,
       (SELECT value FROM config WHERE key='version') AS schema_version,
       COUNT(*) FILTER (WHERE p.deleted_at IS NULL)::bigint AS active_pages,
       COUNT(*)::bigint AS total_pages
FROM pages p
GROUP BY 1,2,3,4,5`))[0];
    assertConnectedIdentityAllowed(identity, expectedIdentity);
    const beforeCounts = await readNoWriteCounts(sql);
    const sources = await sql.unsafe(SOURCE_CENSUS_SQL);
    const pages = await sql.unsafe(`SELECT p.id,
       p.source_id AS input_source_id,
       p.slug,
       p.type,
       p.page_kind,
       p.title,
       p.compiled_truth,
       p.timeline,
       p.frontmatter,
       p.content_hash AS stored_content_hash,
       p.created_at,
       p.updated_at,
       p.source_path,
       p.deleted_at,
       p.emotional_weight,
       p.effective_date,
       p.effective_date_source,
       p.import_filename,
       p.salience_touched_at,
       p.last_retrieved_at,
       p.links_extracted_at,
       p.contextual_retrieval_mode,
       p.corpus_generation,
       p.generation,
       p.embedding_signature,
       s.local_path AS source_local_path,
       s.config AS source_config
FROM pages p
JOIN sources s ON s.id = p.source_id
ORDER BY p.source_id COLLATE "C", p.slug COLLATE "C", p.id`);
    const pageVersions = await sql.unsafe(`SELECT pv.id AS page_version_id,
       pv.page_id,
       p.source_id AS input_source_id,
       p.slug,
       pv.snapshot_at,
       pv.compiled_truth,
       pv.frontmatter
FROM page_versions pv
JOIN pages p ON p.id = pv.page_id
ORDER BY p.source_id COLLATE "C", p.slug COLLATE "C", pv.snapshot_at, pv.id`);
    const afterCounts = await readNoWriteCounts(sql);
    assertNoWriteProof(beforeCounts, afterCounts);
    await sql.unsafe('ROLLBACK');
    return { identity, beforeCounts, afterCounts, sources, pages, pageVersions };
  } catch (err) {
    await sql.unsafe('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function readNoWriteCounts(sql) {
  const tables = ['pages', 'sources', 'page_versions', 'content_chunks', 'links', 'timeline_entries', 'facts', 'tags'];
  const recoveryTables = await sql.unsafe("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'recovery\\_%' ESCAPE '\\' ORDER BY tablename COLLATE \"C\"");
  const result = {};
  for (const table of [...tables, ...recoveryTables.map((r) => r.tablename)]) {
    const safe = String(table).replace(/"/g, '""');
    result[table] = String((await sql.unsafe(`SELECT COUNT(*)::bigint AS count FROM "${safe}"`))[0].count);
  }
  return result;
}

function atomicWrite(path, content) {
  assertNoForbiddenPlaceholders(content, basename(path));
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function renderOutputs(plan, extra = {}) {
  const manifestDraftCsv = rowsToCsv(DRAFT_COLUMNS, plan.manifestDraftRows);
  const ledgerColumns = ['input_corpus', 'input_page_id', 'input_source_id', 'page_source_path', 'authoritative_source_path', 'canonical_source_id', 'slug', 'deleted', 'v43_class', 'identity_class', 'content_identity_hash', 'applicator_content_hash', 'metadata_hash', 'page_version_marker', 'disposition'];
  const ledgerCsv = rowsToCsv(ledgerColumns, plan.ledgerRows);
  const gapLedger = '# M4 Gap Ledger\n\nNo blocking class 9 gaps in this draft.\n';
  const blockingLine = plan.accountingProof.blocking ? '\nBLOCKING: W2 bounds exceeded; M4 exits 7 and no draft rows are applyable from this output.\n' : '';
  const lossWindow = `# M4 Loss Window Report\n${blockingLine}\nW1 historical-only scope: ${plan.accountingProof.w1.historical_only_restoration_scope}\nW2 net: ${plan.accountingProof.w2.net}\nW2 gross: ${plan.accountingProof.w2.gross}\n`;
  const conflictReport = `# M4 Conflict Report\n\nClass 6 unresolved divergent identities: ${plan.manifestMetadata.count_summary.classes['6']}\n`;
  const sourceDisposition = {
    schema_version: 'gbrain_m4_source_disposition_v1',
    sources: SOURCE_MAP,
  };
  const files = {
    'manifest-draft.csv': manifestDraftCsv,
    'classification-ledger.csv': ledgerCsv,
    'accounting-proof.json': canonicalJsonBytewise(plan.accountingProof) + '\n',
    'gap-ledger.md': gapLedger,
    'loss-window-report.md': lossWindow,
    'conflict-report.md': conflictReport,
    'source-disposition.json': canonicalJsonBytewise(sourceDisposition) + '\n',
    'command-log.txt': extra.commandLine ?? 'not executed against real database in tests\n',
  };
  const metadata = { ...plan.manifestMetadata, input_hashes: extra.inputHashes ?? {}, output_hashes: {} };
  for (const [name, content] of Object.entries(files)) metadata.output_hashes[name] = sha256Bytes(utf8(content));
  files['manifest-metadata.json'] = canonicalJsonBytewise(metadata) + '\n';
  const sums = Object.entries(files).map(([name, content]) => [name, sha256Bytes(utf8(content))]).sort(([a], [b]) => byteCompare(a, b));
  files['SHA256SUMS.txt'] = sums.map(([name, hash]) => `${hash}  ${name}`).join('\n') + '\n';
  for (const [name, content] of Object.entries(files)) assertNoForbiddenPlaceholders(content, name);
  return files;
}

export function writeOutputs(outDir, plan, extra = {}) {
  mkdirSync(outDir, { recursive: true });
  const files = renderOutputs(plan, extra);
  for (const [name, content] of Object.entries(files)) atomicWrite(join(outDir, name), content);
  return files;
}

export function writeOutputsAndReturnExitCode(outDir, plan, extra = {}) {
  writeOutputs(outDir, plan, extra);
  return plan.accountingProof.blocking ? EXIT.w2Bound : EXIT.ok;
}

async function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const verified = verifyPinnedInputs({
      decisions: resolve(opts.decisions),
      'm2-receipt': resolve(opts['m2-receipt']),
      'm2-uuid-gate': resolve(opts['m2-uuid-gate']),
      'm2-preflight': resolve(opts['m2-preflight']),
      'm3-receipt': resolve(opts['m3-receipt']),
      'm3-overlap': resolve(opts['m3-overlap']),
      plan: resolve(opts.plan),
      'runtime-head': opts['runtime-head'],
      'production-deny-identity-hash': opts['production-deny-identity-hash'],
    });
    assertDsnNotProduction(opts['historical-dsn'], verified.production_deny_identity_hash);
    assertDsnNotProduction(opts['current-dsn'], verified.production_deny_identity_hash);
    const historical = await extractDb(opts['historical-dsn'], { database_name: 'gbrain_merge_v4', server_port: '5433', schema_version: '118', active_pages: '106527', total_pages: '106541' });
    const current = await extractDb(opts['current-dsn'], { database_name: 'gbrain_prod_inventory_r2', server_port: '5433', schema_version: '118', active_pages: '21492', total_pages: '21492' });
    const plan = buildPlanFromSnapshots({
      runId: opts['run-id'],
      class6Cap: Number(opts['class6-cap'] ?? 1000),
      w2NetBound: Number(opts['w2-net-bound'] ?? 3067),
      w2GrossBound: Number(opts['w2-gross-bound'] ?? 4977),
      productionDenyIdentityHash: verified.production_deny_identity_hash,
      historical,
      current,
    });
    const exitCode = writeOutputsAndReturnExitCode(resolve(opts['out-dir']), plan, { inputHashes: verified.hashes, commandLine: renderSanitizedCommandLog(opts) });
    console.log(JSON.stringify({ ok: exitCode === EXIT.ok, exit_code: exitCode, out_dir: resolve(opts['out-dir']), rows: plan.manifestDraftRows.length, ledger_rows: plan.ledgerRows.length, blocking: exitCode !== EXIT.ok }, null, 2));
    process.exit(exitCode);
  } catch (err) {
    const code = err instanceof M4Error ? err.exitCode : EXIT.internal;
    const body = { ok: false, exit_code: code, error: err instanceof Error ? err.message : String(err) };
    console.error(JSON.stringify(body, null, 2));
    process.exit(code);
  }
}

if (import.meta.main) await main();
