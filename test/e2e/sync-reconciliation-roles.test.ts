import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { getCapabilities } from '../../src/commands/capabilities.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;
const root = join(import.meta.dir, '..', '..');

async function initRoleBoundarySchema(engine: PostgresEngine, sql: any) {
  try {
    await engine.initSchema();
    return;
  } catch (error) {
    if (!String(error).includes('extension "vector" is not available')) throw error;
  }

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      local_path TEXT,
      last_commit TEXT,
      last_sync_at TIMESTAMPTZ,
      newest_content_at TIMESTAMPTZ,
      chunker_version TEXT,
      registration_generation BIGINT NOT NULL DEFAULT 1
    );
    INSERT INTO sources (id, name) VALUES ('default', 'default') ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS pages (
      id SERIAL PRIMARY KEY,
      source_id TEXT NOT NULL DEFAULT 'default' REFERENCES sources(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      type TEXT NOT NULL,
      page_kind TEXT NOT NULL DEFAULT 'markdown',
      title TEXT NOT NULL,
      compiled_truth TEXT NOT NULL DEFAULT '',
      frontmatter JSONB NOT NULL DEFAULT '{}',
      timeline TEXT NOT NULL DEFAULT '',
      raw_path TEXT,
      source_path TEXT,
      content_hash TEXT,
      embedding TEXT,
      embedding_voyage TEXT,
      embedding_model TEXT,
      embedding_dimensions INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      effective_date TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      contextual_retrieval_mode TEXT,
      corpus_generation TEXT,
      generation BIGINT NOT NULL DEFAULT 1,
      UNIQUE (source_id, slug)
    );

    CREATE TABLE IF NOT EXISTS content_chunks (
      id SERIAL PRIMARY KEY,
      page_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
      chunk_index INTEGER,
      chunk_text TEXT NOT NULL DEFAULT '',
      chunk_source TEXT NOT NULL DEFAULT 'compiled_truth'
    );

    CREATE TABLE IF NOT EXISTS ingest_log (
      id SERIAL PRIMARY KEY,
      source_id TEXT NOT NULL DEFAULT 'default',
      source_type TEXT NOT NULL DEFAULT 'test',
      source_ref TEXT NOT NULL DEFAULT 'test',
      status TEXT NOT NULL DEFAULT 'success'
    );

    ALTER TABLE sources ADD COLUMN IF NOT EXISTS registration_generation BIGINT NOT NULL DEFAULT 1;
    CREATE TABLE IF NOT EXISTS sync_reconciliation_audit (
      operation_id text PRIMARY KEY,
      manifest_hash text NOT NULL,
      source_id text NOT NULL,
      actor text NOT NULL,
      role text NOT NULL,
      reason text NOT NULL,
      candidate_count integer NOT NULL,
      population_count integer NOT NULL,
      threshold_absolute integer NOT NULL,
      threshold_percentage double precision NOT NULL,
      authorized boolean NOT NULL,
      override_reason text,
      before_state jsonb NOT NULL,
      after_state jsonb,
      result text NOT NULL,
      failure text,
      apply_attempt integer NOT NULL DEFAULT 0,
      applying_claimed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS sync_reconciliation_role_policy (
      role_name text PRIMARY KEY,
      can_normal_sync boolean NOT NULL DEFAULT false,
      can_approve_reconciliation boolean NOT NULL DEFAULT false,
      can_apply_reconciliation boolean NOT NULL DEFAULT false,
      can_repair_source_root boolean NOT NULL DEFAULT false,
      can_hard_purge boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO sync_reconciliation_role_policy
      (role_name, can_normal_sync, can_approve_reconciliation, can_apply_reconciliation, can_repair_source_root, can_hard_purge)
    VALUES
      ('gbrain_normal_sync', true, false, false, false, false),
      ('gbrain_reconciliation_approve', false, true, false, false, false),
      ('gbrain_reconciliation_apply', false, false, true, false, false),
      ('gbrain_source_repair', false, false, false, true, false),
      ('gbrain_hard_purge', false, false, false, false, true)
    ON CONFLICT (role_name) DO UPDATE SET
      can_normal_sync = EXCLUDED.can_normal_sync,
      can_approve_reconciliation = EXCLUDED.can_approve_reconciliation,
      can_apply_reconciliation = EXCLUDED.can_apply_reconciliation,
      can_repair_source_root = EXCLUDED.can_repair_source_root,
      can_hard_purge = EXCLUDED.can_hard_purge;
  `);
}

async function expectDenied(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const message = String(error);
    if (
      message.includes('permission denied') ||
      message.includes('is not allowed') ||
      message.includes('must increment') ||
      message.includes('may only change')
    ) return;
  }
  throw new Error('expected permission denial');
}

describe.skipIf(skip)('sync reconciliation role boundary (Postgres E2E)', () => {
  let engine: PostgresEngine;
  let sql: any;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
    sql = (engine as any).sql;
    await initRoleBoundarySchema(engine, sql);
    await sql.unsafe(readFileSync(join(root, 'artifacts/dba/sync-reconciliation-roles.sql'), 'utf8'));
    for (const role of ['gbrain_normal_sync', 'gbrain_reconciliation_approve', 'gbrain_reconciliation_apply', 'gbrain_source_repair', 'gbrain_hard_purge']) {
      await sql.unsafe(`GRANT ${role} TO CURRENT_USER`);
    }
  }, 30_000);

  afterAll(async () => {
    try { await sql?.unsafe('RESET ROLE'); } catch {}
    await engine.disconnect();
  });

  test('normal sync cannot tombstone, self-approve, mutate policy, apply, repair, or purge', async () => {
    await sql.unsafe('RESET ROLE');
    await sql.unsafe(`DELETE FROM sync_reconciliation_audit WHERE operation_id LIKE 'role-test-%'`);
    await sql.unsafe(`DELETE FROM pages WHERE slug LIKE 'role-test/%'`);
    await sql`
      INSERT INTO pages (source_id, slug, type, title, compiled_truth, content_hash, source_path)
      VALUES ('default', 'role-test/normal', 'note', 'Role Test', 'body', 'hash', 'role-test/normal.md')
    `;
    await sql`
      INSERT INTO sync_reconciliation_audit
        (operation_id, manifest_hash, source_id, actor, role, reason, candidate_count, population_count,
         threshold_absolute, threshold_percentage, authorized, before_state, result)
      VALUES
        ('role-test-normal', 'hash', 'default', 'owner', 'owner', 'incremental_deleted', 1, 10,
         100, 0.25, false, '{}'::jsonb, 'proposed')
    `;

    await sql.unsafe('SET ROLE gbrain_normal_sync');
    await expectDenied(sql`UPDATE pages SET deleted_at = now() WHERE slug = 'role-test/normal'`);
    await expectDenied(sql`UPDATE sync_reconciliation_audit SET result = 'approved' WHERE operation_id = 'role-test-normal'`);
    await expectDenied(sql`UPDATE sync_reconciliation_role_policy SET can_apply_reconciliation = true WHERE role_name = 'gbrain_normal_sync'`);
    await expectDenied(sql`DELETE FROM pages WHERE slug = 'role-test/normal'`);
    await sql.unsafe('RESET ROLE');
  }, 30_000);

  test('apply role cannot alter immutable manifest/source/hash facts', async () => {
    await sql.unsafe('RESET ROLE');
    await sql.unsafe(`DELETE FROM sync_reconciliation_audit WHERE operation_id = 'role-test-apply'`);
    await sql`
      INSERT INTO sync_reconciliation_audit
        (operation_id, manifest_hash, source_id, actor, role, reason, candidate_count, population_count,
         threshold_absolute, threshold_percentage, authorized, before_state, result)
      VALUES
        ('role-test-apply', 'hash', 'default', 'owner', 'owner', 'incremental_deleted', 1, 10,
         100, 0.25, true, '{}'::jsonb, 'approved')
    `;

    await sql.unsafe('SET ROLE gbrain_reconciliation_apply');
    await expectDenied(sql`UPDATE sync_reconciliation_audit SET manifest_hash = 'evil' WHERE operation_id = 'role-test-apply'`);
    await expectDenied(sql`UPDATE sync_reconciliation_audit SET source_id = 'evil' WHERE operation_id = 'role-test-apply'`);
    await expectDenied(sql`UPDATE sync_reconciliation_audit SET before_state = '{"evil":true}'::jsonb WHERE operation_id = 'role-test-apply'`);
    await sql`UPDATE sync_reconciliation_audit SET result = 'applying' WHERE operation_id = 'role-test-apply'`;
    await sql.unsafe('RESET ROLE');
  }, 30_000);

  test('apply role cannot claim unapproved or unauthorized rows', async () => {
    await sql.unsafe('RESET ROLE');
    await sql.unsafe(`DELETE FROM sync_reconciliation_audit WHERE operation_id IN ('role-test-unauth', 'role-test-proposed')`);
    await sql`
      INSERT INTO sync_reconciliation_audit
        (operation_id, manifest_hash, source_id, actor, role, reason, candidate_count, population_count,
         threshold_absolute, threshold_percentage, authorized, before_state, result)
      VALUES
        ('role-test-unauth', 'hash', 'default', 'owner', 'owner', 'incremental_deleted', 1, 10, 100, 0.25, false, '{}'::jsonb, 'approved'),
        ('role-test-proposed', 'hash', 'default', 'owner', 'owner', 'incremental_deleted', 1, 10, 100, 0.25, false, '{}'::jsonb, 'proposed')
    `;

    await sql.unsafe('SET ROLE gbrain_reconciliation_apply');
    await expectDenied(sql`UPDATE sync_reconciliation_audit SET result = 'applying' WHERE operation_id = 'role-test-unauth'`);
    await expectDenied(sql`UPDATE sync_reconciliation_audit SET result = 'applying' WHERE operation_id = 'role-test-proposed'`);
    await sql.unsafe('RESET ROLE');
  }, 30_000);

  test('source repair role can only move root when generation increments', async () => {
    await sql.unsafe('RESET ROLE');
    await sql`UPDATE sources SET local_path = NULL, registration_generation = 1 WHERE id = 'default'`;
    await sql.unsafe('SET ROLE gbrain_source_repair');
    await expectDenied(sql`UPDATE sources SET local_path = '/tmp/new-root' WHERE id = 'default'`);
    await sql`UPDATE sources SET local_path = '/tmp/new-root', registration_generation = registration_generation + 1 WHERE id = 'default'`;
    await expectDenied(sql`UPDATE pages SET deleted_at = now() WHERE slug = 'role-test/normal'`);
    await sql.unsafe('RESET ROLE');
  }, 30_000);

  test('source repair role rejects generation-only and non-plus-one root tamper', async () => {
    await sql.unsafe('RESET ROLE');
    await sql`UPDATE sources SET local_path = '/tmp/base-root', registration_generation = 10 WHERE id = 'default'`;
    await sql.unsafe('SET ROLE gbrain_source_repair');
    await expectDenied(sql`UPDATE sources SET registration_generation = registration_generation + 1 WHERE id = 'default'`);
    await expectDenied(sql`UPDATE sources SET local_path = '/tmp/bad-root', registration_generation = registration_generation + 2 WHERE id = 'default'`);
    await sql`UPDATE sources SET local_path = '/tmp/good-root', registration_generation = registration_generation + 1 WHERE id = 'default'`;
    await sql.unsafe('RESET ROLE');
  }, 30_000);

  test('apply role cannot recover applying rows before the fixed DB lease', async () => {
    await sql.unsafe('RESET ROLE');
    await sql.unsafe(`DELETE FROM sync_reconciliation_audit WHERE operation_id = 'role-test-lease'`);
    await sql`
      INSERT INTO sync_reconciliation_audit
        (operation_id, manifest_hash, source_id, actor, role, reason, candidate_count, population_count,
         threshold_absolute, threshold_percentage, authorized, before_state, result, applying_claimed_at)
      VALUES
        ('role-test-lease', 'hash', 'default', 'owner', 'owner', 'incremental_deleted', 1, 10,
         100, 0.25, true, '{}'::jsonb, 'applying', now())
    `;
    await sql.unsafe('SET ROLE gbrain_reconciliation_apply');
    await expectDenied(sql`
      UPDATE sync_reconciliation_audit
      SET result = 'failed', failure = 'abandoned applying lease recovered', completed_at = now()
      WHERE operation_id = 'role-test-lease'
    `);
    await sql.unsafe('RESET ROLE');
  }, 30_000);

  test('capability attestation rejects decoy schema, extra grants, and owner drift', async () => {
    await sql.unsafe('RESET ROLE');
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS sync_decoy`);
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS sync_decoy.sync_reconciliation_audit (id int)`);
    await sql.unsafe(`GRANT UPDATE (manifest_hash) ON sync_reconciliation_audit TO gbrain_reconciliation_apply`);
    let caps = await getCapabilities(engine) as any;
    expect(caps.sync_safety.postgres_checks.role_privileges_ok).toBe(false);
    await sql.unsafe(`REVOKE UPDATE (manifest_hash) ON sync_reconciliation_audit FROM gbrain_reconciliation_apply`);

    await sql.unsafe(`ALTER ROLE gbrain_reconciliation_owner LOGIN`);
    caps = await getCapabilities(engine) as any;
    expect(caps.sync_safety.postgres_checks.owner_role_ok).toBe(false);
    await sql.unsafe(`ALTER ROLE gbrain_reconciliation_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);

    caps = await getCapabilities(engine) as any;
    expect(caps.sync_safety.postgres_checks.guard_ok).toBe(true);
    expect(caps.sync_safety.postgres_checks.role_privileges_ok).toBe(true);
    expect(caps.sync_safety.postgres_checks.owner_role_ok).toBe(true);
  }, 30_000);

  test('capabilities reports PostgreSQL roles and current session facts', async () => {
    await sql.unsafe('RESET ROLE');
    const caps = await getCapabilities(engine) as any;
    expect(caps.backend).toBe('postgres');
    expect(caps.database.current_user).toBeTruthy();
    expect(caps.database.session_user).toBeTruthy();
    expect(caps.sync_safety.capabilities.db_roles).toBe(true);
    expect(caps.sync_safety.supported).toBe(true);
    expect(caps.sync_safety.postgres_checks.guard_ok).toBe(true);
    expect(caps.sync_safety.postgres_checks.role_privileges_ok).toBe(true);
    expect(caps.sync_safety.postgres_checks.owner_role_ok).toBe(true);
    expect(caps.sync_safety.roles.map((row: any) => row.role_name).sort()).toEqual([
      'gbrain_hard_purge',
      'gbrain_normal_sync',
      'gbrain_reconciliation_apply',
      'gbrain_reconciliation_approve',
      'gbrain_reconciliation_owner',
      'gbrain_source_repair',
    ]);
  });
});
