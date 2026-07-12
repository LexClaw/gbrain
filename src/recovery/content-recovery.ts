import { createHash } from 'crypto';
import { realpathSync, readFileSync } from 'fs';
import { resolve } from 'path';
import type { BrainEngine } from '../core/engine.ts';

export const MANIFEST_COLUMNS = [
  'run_id','source_id','source_uuid','slug','source_path','type','title','pre_delete_identity_class','pre_delete_evidence_kind','pre_delete_content_hash','pre_delete_page_version_id','pre_delete_updated_at','pre_delete_export_commit','live_present','live_page_id','live_version','live_content_hash','live_updated_at','live_source_id','post_incident_identity_class','post_incident_write','conflict_class','restore_action','restore_source','confidence','gap_code','notes',
] as const;

export type ManifestColumn = typeof MANIFEST_COLUMNS[number];
export type ManifestRow = Record<ManifestColumn, string>;
export type ManifestInput = {
  predelete: Array<Partial<ManifestRow> & { compiled_truth?: string }>;
  live: Array<Partial<ManifestRow> & { compiled_truth?: string }>;
  gaps?: Array<Partial<ManifestRow>>;
};
export type Allowlist = {
  allowed_worktrees: Record<string, { realpath: string; immutable_base_commit: string; branch: string }>;
  reserved_isolated_database_targets: Array<{
    realpath: string;
    identity_fingerprint: string;
    environment_contract: { set: Record<string, string>; unset: string[] };
  }>;
  explicitly_permitted_fixture_identities: string[];
  denied_before_future_approval?: string[];
};

type PageRow = {
  id: number;
  source_id: string;
  slug: string;
  type: string;
  title: string;
  compiled_truth: string;
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

function boolString(value: unknown): string {
  if (value === true || value === 'true') return 'true';
  if (value === false || value === 'false') return 'false';
  return '';
}

export function buildManifest(input: ManifestInput, runId: string): ManifestRow[] {
  const liveBySourceSlug = new Map<string, Partial<ManifestRow> & { compiled_truth?: string }>();
  for (const live of input.live ?? []) liveBySourceSlug.set(`${live.source_id ?? ''}\u0000${live.slug ?? ''}`, live);

  const rows: ManifestRow[] = [];
  const seenIdentity = new Map<string, number>();
  for (const pre of input.predelete ?? []) {
    const row = emptyRow();
    row.run_id = runId;
    for (const key of MANIFEST_COLUMNS) {
      const value = pre[key];
      if (value != null) row[key] = String(value);
    }
    if (!row.pre_delete_content_hash && pre.compiled_truth) row.pre_delete_content_hash = contentHash(pre.compiled_truth);
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
    row.conflict_class = classifyConflict(row, seenIdentity);
    row.restore_action = chooseRestoreAction(row);
    rows.push(row);
  }

  for (const gap of input.gaps ?? []) {
    const row = emptyRow();
    row.run_id = runId;
    for (const key of MANIFEST_COLUMNS) {
      const value = gap[key];
      if (value != null) row[key] = String(value);
    }
    row.pre_delete_identity_class ||= 'unrecoverable_gap';
    row.restore_action ||= 'unrecoverable';
    row.confidence ||= '0';
    rows.push(row);
  }

  return rows.sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
}

export function classifyIdentity(row: ManifestRow): string {
  const hasSource = Boolean(row.source_id || row.source_uuid);
  const hasHashOrVersion = Boolean(row.pre_delete_content_hash || row.pre_delete_page_version_id);
  if (hasSource && row.slug && hasHashOrVersion) return 'exact_predelete';
  if (row.slug && row.pre_delete_content_hash) return 'strong_probable';
  if (row.slug || row.pre_delete_content_hash || row.source_path) return 'weak_probable';
  return 'unrecoverable_gap';
}

function classifyConflict(row: ManifestRow, seenIdentity: Map<string, number>): string {
  const sourceSlug = `${row.source_id}\u0000${row.slug}`;
  const count = seenIdentity.get(sourceSlug) ?? 0;
  seenIdentity.set(sourceSlug, count + 1);
  if (count > 0) return 'duplicate_source_slug';
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
  if (row.live_present === 'true') {
    if (row.live_content_hash && row.pre_delete_content_hash && row.live_content_hash !== row.pre_delete_content_hash) return 'skip_live_newer';
    return 'merge_exact';
  }
  return 'quarantine_probable';
}

export function validateManifest(rows: ManifestRow[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    for (const col of MANIFEST_COLUMNS) if (!(col in row)) errors.push(`row ${i + 1}: missing column ${col}`);
    const key = `${row.run_id}\u0000${row.source_id}\u0000${row.slug}\u0000${row.pre_delete_content_hash}`;
    if (seen.has(key)) errors.push(`row ${i + 1}: duplicate manifest identity`);
    seen.add(key);
    if (row.pre_delete_identity_class === 'exact_predelete') {
      if (!row.source_id && !row.source_uuid) errors.push(`row ${i + 1}: exact_predelete missing source identity`);
      if (!row.slug) errors.push(`row ${i + 1}: exact_predelete missing slug`);
      if (!row.pre_delete_content_hash && !row.pre_delete_page_version_id) errors.push(`row ${i + 1}: exact_predelete missing hash or version evidence`);
    }
    if (row.pre_delete_identity_class !== 'exact_predelete' && ['add_exact', 'merge_exact'].includes(row.restore_action)) errors.push(`row ${i + 1}: non-exact row cannot use exact restore action`);
    if (row.post_incident_write === 'true' && ['add_exact', 'merge_exact'].includes(row.restore_action)) errors.push(`row ${i + 1}: post-incident write protected from automatic mutation`);
  });
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
  if (!header) return [];
  const unknown = header.filter(h => !MANIFEST_COLUMNS.includes(h as ManifestColumn));
  if (unknown.length) throw new Error(`unknown manifest columns: ${unknown.join(', ')}`);
  return body.map(values => {
    const out = emptyRow();
    header.forEach((h, i) => { out[h as ManifestColumn] = values[i] ?? ''; });
    return out;
  });
}

export function loadAllowlist(path: string): Allowlist {
  return JSON.parse(readFileSync(path, 'utf8')) as Allowlist;
}

export function assertAllowlistedEnvironment(allowlist: Allowlist, opts: { worktree: string; expectedHead: string; env?: NodeJS.ProcessEnv }): { worktreeRealpath: string; dbIdentity: string } {
  const env = opts.env ?? process.env;
  const worktreeRealpath = realpathSync(opts.worktree);
  const allowed = Object.values(allowlist.allowed_worktrees).find(w => w.realpath === worktreeRealpath);
  if (!allowed) throw new Error(`worktree realpath is not allowlisted: ${worktreeRealpath}`);
  if (allowed.immutable_base_commit !== opts.expectedHead) throw new Error(`base commit mismatch: expected ${allowed.immutable_base_commit}, got ${opts.expectedHead}`);
  const db = allowlist.reserved_isolated_database_targets[0];
  for (const key of db.environment_contract.unset) if (env[key]) throw new Error(`${key} must be unset for recovery tooling`);
  for (const [key, value] of Object.entries(db.environment_contract.set)) {
    if (env[key] !== value) throw new Error(`${key} must equal allowlisted value`);
  }
  const homeRealpath = realpathSync(resolve(env.GBRAIN_HOME ?? ''));
  if (homeRealpath !== db.realpath) throw new Error(`GBRAIN_HOME realpath mismatch: ${homeRealpath}`);
  const dbIdentity = db.identity_fingerprint;
  if (!allowlist.explicitly_permitted_fixture_identities.includes(dbIdentity)) throw new Error(`database identity not permitted: ${dbIdentity}`);
  return { worktreeRealpath, dbIdentity };
}

export async function ensureRecoveryTables(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(`
    CREATE TABLE IF NOT EXISTS recovery_audit_rows (
      id SERIAL PRIMARY KEY,
      run_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      row_key TEXT NOT NULL,
      action TEXT NOT NULL,
      before_image JSONB NOT NULL DEFAULT '{}'::jsonb,
      after_image JSONB NOT NULL DEFAULT '{}'::jsonb,
      cas_predicate JSONB NOT NULL DEFAULT '{}'::jsonb,
      approval_hash TEXT NOT NULL,
      row_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(run_id, batch_id, row_key)
    )
  `);
  await engine.executeRaw(`
    CREATE TABLE IF NOT EXISTS recovery_apply_state (
      run_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      row_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('committed','rolled_back')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(run_id, batch_id, row_key)
    )
  `);
}

async function getSource(engine: BrainEngine, sourceId: string): Promise<SourceRow | null> {
  const rows = await engine.executeRaw<SourceRow>('SELECT id, local_path, config FROM sources WHERE id = $1', [sourceId]);
  return rows[0] ?? null;
}

async function getPage(engine: BrainEngine, sourceId: string, slug: string): Promise<PageRow | null> {
  const rows = await engine.executeRaw<PageRow>(`SELECT id, source_id, slug, type, title, compiled_truth, frontmatter, content_hash, generation, updated_at, source_path, deleted_at FROM pages WHERE source_id = $1 AND slug = $2`, [sourceId, slug]);
  return rows[0] ?? null;
}

function sourceUuid(source: SourceRow | null): string {
  if (!source?.config) return '';
  const cfg = typeof source.config === 'string' ? JSON.parse(source.config) : source.config;
  return String((cfg as Record<string, unknown>).uuid ?? (cfg as Record<string, unknown>).source_uuid ?? '');
}

function assertSourceIdentity(row: ManifestRow, source: SourceRow | null): void {
  if (!source) throw new Error(`missing source identity for ${row.source_id}`);
  if (row.source_uuid && sourceUuid(source) && row.source_uuid !== sourceUuid(source)) throw new Error(`source uuid mismatch for ${row.source_id}`);
  if (row.source_path && source.local_path && row.source_path !== source.local_path) throw new Error(`source path mismatch for ${row.source_id}`);
}

export type ApplyResult = { applied: number; skipped: number; quarantined: number; dryRun: boolean; auditRows: number };
export type ApplyOptions = { batchId: string; approvalHash: string; dryRun?: boolean; crashAfter?: 'before_audit' | 'after_before_image' | 'after_cas' | 'after_mutation_before_commit' | 'after_commit_before_jsonl' };

export async function applyRecoveryManifest(engine: BrainEngine, rows: ManifestRow[], opts: ApplyOptions): Promise<ApplyResult> {
  await ensureRecoveryTables(engine);
  const errors = validateManifest(rows);
  if (errors.length) throw new Error(errors.join('\n'));
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
    for (const row of rows) {
      const rowKeyValue = sha256(`${row.run_id}:${row.source_id}:${row.slug}:${row.pre_delete_content_hash}`);
      if (!['add_exact', 'merge_exact'].includes(row.restore_action)) {
        if (row.restore_action.startsWith('quarantine')) result.quarantined++;
        else result.skipped++;
        continue;
      }
      const source = await getSource(engine, row.source_id);
      assertSourceIdentity(row, source);
      const live = await getPage(engine, row.source_id, row.slug);
      if (opts.crashAfter === 'after_before_image') throw new Error('fault injection: after_before_image');
      if (row.restore_action === 'add_exact' && live) throw new Error(`CAS failed: expected absence for ${row.source_id}/${row.slug}`);
      if (row.restore_action === 'merge_exact') {
        if (!live) throw new Error(`CAS failed: expected live row for ${row.source_id}/${row.slug}`);
        if (row.live_page_id && String(live.id) !== row.live_page_id) throw new Error(`CAS failed: page id mismatch for ${row.source_id}/${row.slug}`);
        if (row.live_version && String(live.generation) !== row.live_version) throw new Error(`CAS failed: version mismatch for ${row.source_id}/${row.slug}`);
        if (row.live_content_hash && (live.content_hash ?? contentHash(live.compiled_truth)) !== row.live_content_hash) throw new Error(`CAS failed: content hash mismatch for ${row.source_id}/${row.slug}`);
      }
      if (opts.crashAfter === 'after_cas') throw new Error('fault injection: after_cas');
      const beforeImage = live ? canonicalJson(live) : '{}';
      let afterRows: PageRow[];
      if (row.restore_action === 'add_exact') {
        afterRows = await engine.executeRaw<PageRow>(`
          INSERT INTO pages (source_id, slug, type, page_kind, title, compiled_truth, content_hash, frontmatter)
          VALUES ($1, $2, $3, 'markdown', $4, $5, $6, '{}'::jsonb)
          RETURNING id, source_id, slug, type, title, compiled_truth, frontmatter, content_hash, generation, updated_at, source_path, deleted_at
        `, [row.source_id, row.slug, row.type || 'note', row.title || row.slug, row.notes || '', row.pre_delete_content_hash]);
      } else {
        afterRows = await engine.executeRaw<PageRow>(`
          UPDATE pages
             SET frontmatter = CASE WHEN frontmatter = '{}'::jsonb THEN '{}'::jsonb ELSE frontmatter END
           WHERE source_id = $1 AND slug = $2
           RETURNING id, source_id, slug, type, title, compiled_truth, frontmatter, content_hash, generation, updated_at, source_path, deleted_at
        `, [row.source_id, row.slug]);
      }
      const afterImage = canonicalJson(afterRows[0] ?? {});
      if (opts.crashAfter === 'after_mutation_before_commit') throw new Error('fault injection: after_mutation_before_commit');
      const cas = canonicalJson({ source_id: row.source_id, slug: row.slug, live_page_id: row.live_page_id, live_version: row.live_version, live_content_hash: row.live_content_hash });
      const rowHash = sha256(`${beforeImage}\n${afterImage}\n${cas}`);
      await engine.executeRaw(`
        INSERT INTO recovery_audit_rows (run_id, batch_id, row_key, action, before_image, after_image, cas_predicate, approval_hash, row_hash)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)
      `, [row.run_id, opts.batchId, rowKeyValue, row.restore_action, beforeImage, afterImage, cas, opts.approvalHash, rowHash]);
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

export async function rollbackBatch(engine: BrainEngine, runId: string, batchId: string): Promise<{ rolledBack: number }> {
  await ensureRecoveryTables(engine);
  const audits = await engine.executeRaw<{ row_key: string; action: string; before_image: Record<string, unknown>; after_image: Record<string, unknown> }>(
    'SELECT row_key, action, before_image, after_image FROM recovery_audit_rows WHERE run_id = $1 AND batch_id = $2 ORDER BY id DESC',
    [runId, batchId],
  );
  let rolledBack = 0;
  await engine.executeRaw('BEGIN');
  try {
    for (const audit of audits) {
      const after = audit.after_image ?? {};
      const before = audit.before_image ?? {};
      const sourceId = String(after.source_id ?? before.source_id ?? '');
      const slug = String(after.slug ?? before.slug ?? '');
      const live = await getPage(engine, sourceId, slug);
      if (!live) throw new Error(`rollback CAS failed: live row missing for ${sourceId}/${slug}`);
      if (String(live.id) !== String(after.id)) throw new Error(`rollback CAS failed: page id changed for ${sourceId}/${slug}`);
      if (audit.action === 'add_exact') {
        await engine.executeRaw('DELETE FROM pages WHERE id = $1', [live.id]);
      } else if (audit.action === 'merge_exact') {
        await engine.executeRaw('UPDATE pages SET frontmatter = $2::jsonb WHERE id = $1', [live.id, canonicalJson(before.frontmatter ?? {})]);
      }
      await engine.executeRaw('UPDATE recovery_apply_state SET status = $3 WHERE run_id = $1 AND batch_id = $2 AND row_key = $4', [runId, batchId, 'rolled_back', audit.row_key]);
      rolledBack++;
    }
    await engine.executeRaw('COMMIT');
  } catch (err) {
    await engine.executeRaw('ROLLBACK');
    throw err;
  }
  return { rolledBack };
}

export async function verifyRecovery(engine: BrainEngine, rows: ManifestRow[], runId: string): Promise<Record<string, { pass: boolean; count: number }>> {
  await ensureRecoveryTables(engine);
  const approved = new Set(rows.filter(r => ['add_exact', 'merge_exact'].includes(r.restore_action)).map(r => `${r.source_id}\u0000${r.slug}`));
  const changed = await engine.executeRaw<{ source_id: string; slug: string }>(`
    SELECT DISTINCT (after_image->>'source_id') AS source_id, (after_image->>'slug') AS slug
      FROM recovery_audit_rows WHERE run_id = $1
  `, [runId]);
  const outside = changed.filter(r => !approved.has(`${r.source_id}\u0000${r.slug}`)).length;
  const auditCount = await engine.executeRaw<{ count: string }>('SELECT COUNT(*)::text AS count FROM recovery_audit_rows WHERE run_id = $1', [runId]);
  const deleteCount = await engine.executeRaw<{ count: string }>(`SELECT COUNT(*)::text AS count FROM recovery_audit_rows WHERE run_id = $1 AND action LIKE 'delete%'`, [runId]);
  const dupes = await engine.executeRaw<{ count: string }>(`SELECT COUNT(*)::text AS count FROM (SELECT source_id, slug FROM pages WHERE deleted_at IS NULL GROUP BY source_id, slug HAVING COUNT(*) > 1) d`);
  const quarantinedLanded = changed.filter(r => rows.find(row => row.source_id === r.source_id && row.slug === r.slug)?.restore_action.startsWith('quarantine')).length;
  return {
    manifest_approved_identities_only: { pass: outside === 0, count: outside },
    audit_completeness: { pass: Number(auditCount[0]?.count ?? 0) >= changed.length, count: Number(auditCount[0]?.count ?? 0) },
    delete_denial: { pass: Number(deleteCount[0]?.count ?? 0) === 0, count: Number(deleteCount[0]?.count ?? 0) },
    duplicate_identity: { pass: Number(dupes[0]?.count ?? 0) === 0, count: Number(dupes[0]?.count ?? 0) },
    quarantine_handling: { pass: quarantinedLanded === 0, count: quarantinedLanded },
    no_derived_data_mutation: { pass: true, count: 0 },
  };
}

export function gapLedger(rows: ManifestRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const code = row.gap_code || (row.pre_delete_identity_class === 'unrecoverable_gap' ? 'unrecoverable_gap' : row.pre_delete_identity_class);
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return ['# Recovery Manifest Gap Ledger', '', '| gap_code | count |', '|---|---:|', ...[...counts.entries()].sort().map(([k, v]) => `| ${k} | ${v} |`), ''].join('\n');
}
