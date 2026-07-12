import type { BrainEngine } from '../core/engine.ts';
import { LATEST_VERSION } from '../core/migrate.ts';
import { VERSION } from '../version.ts';

const REQUIRED_SYNC_TOKENS = [
  'explicit-source',
  'root-identity',
  'reconciliation-manifest',
  'db-roles',
  'schema-v2',
] as const;

const RECONCILIATION_ROLES = [
  'gbrain_normal_sync',
  'gbrain_reconciliation_approve',
  'gbrain_reconciliation_apply',
  'gbrain_source_repair',
  'gbrain_hard_purge',
] as const;

const RECONCILIATION_CLUSTER_ROLES = [
  'gbrain_reconciliation_owner',
  ...RECONCILIATION_ROLES,
] as const;

const REQUIRED_SCHEMA_VERSION = 118;

const EXPECTED_POLICY: Record<string, Record<string, boolean>> = {
  gbrain_normal_sync: {
    can_normal_sync: true,
    can_approve_reconciliation: false,
    can_apply_reconciliation: false,
    can_repair_source_root: false,
    can_hard_purge: false,
  },
  gbrain_reconciliation_approve: {
    can_normal_sync: false,
    can_approve_reconciliation: true,
    can_apply_reconciliation: false,
    can_repair_source_root: false,
    can_hard_purge: false,
  },
  gbrain_reconciliation_apply: {
    can_normal_sync: false,
    can_approve_reconciliation: false,
    can_apply_reconciliation: true,
    can_repair_source_root: false,
    can_hard_purge: false,
  },
  gbrain_source_repair: {
    can_normal_sync: false,
    can_approve_reconciliation: false,
    can_apply_reconciliation: false,
    can_repair_source_root: true,
    can_hard_purge: false,
  },
  gbrain_hard_purge: {
    can_normal_sync: false,
    can_approve_reconciliation: false,
    can_apply_reconciliation: false,
    can_repair_source_root: false,
    can_hard_purge: true,
  },
};

async function checked<T>(diagnostics: string[], label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    diagnostics.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
}

async function tableExists(engine: BrainEngine, table: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return Number(rows[0]?.n ?? 0) === 1;
}

async function columnExists(engine: BrainEngine, table: string, column: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return Number(rows[0]?.n ?? 0) === 1;
}

async function rolePolicyRows(engine: BrainEngine, hasApproveColumn: boolean): Promise<Record<string, unknown>[]> {
  if (!(await tableExists(engine, 'sync_reconciliation_role_policy'))) return [];
  const approveExpr = hasApproveColumn ? 'can_approve_reconciliation' : 'false AS can_approve_reconciliation';
  return await engine.executeRaw<Record<string, unknown>>(
    `SELECT role_name, can_normal_sync, ${approveExpr}, can_apply_reconciliation, can_repair_source_root, can_hard_purge
     FROM sync_reconciliation_role_policy ORDER BY role_name`,
  );
}

function policyIsExact(policies: Record<string, unknown>[]): boolean {
  if (policies.length !== RECONCILIATION_ROLES.length) return false;
  for (const role of RECONCILIATION_ROLES) {
    const row = policies.find((item) => item.role_name === role);
    if (!row) return false;
    for (const [key, expected] of Object.entries(EXPECTED_POLICY[role])) {
      if (row[key] !== expected) return false;
    }
  }
  return true;
}

async function roleFacts(engine: BrainEngine): Promise<Record<string, unknown>[]> {
  if (engine.kind !== 'postgres') return [];
  return await engine.executeRaw<Record<string, unknown>>(
    `SELECT r.rolname AS role_name,
            r.rolcanlogin AS can_login,
            r.rolsuper AS superuser,
            r.rolcreatedb AS createdb,
            r.rolcreaterole AS createrole,
            r.rolreplication AS replication,
            r.rolbypassrls AS bypassrls,
            pg_has_role(current_user, r.oid, 'USAGE') AS reachable_from_current_user
     FROM pg_roles r
     WHERE r.rolname = ANY($1)
     ORDER BY r.rolname`,
    [RECONCILIATION_CLUSTER_ROLES],
  );
}

async function postgresSafetyChecks(engine: BrainEngine): Promise<Record<string, unknown>> {
  if (engine.kind !== 'postgres') return { role_privileges_ok: false, guard_ok: false, owner_role_ok: false };
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `WITH oid AS (
       SELECT
         'public.sync_reconciliation_audit'::regclass AS audit_rel,
         'public.sync_reconciliation_role_policy'::regclass AS policy_rel,
         'public.sources'::regclass AS sources_rel,
         'public.pages'::regclass AS pages_rel,
         'public.content_chunks'::regclass AS chunks_rel,
         'public.ingest_log'::regclass AS ingest_rel,
         'public.gbrain_guard_sync_reconciliation_audit_update()'::regprocedure AS audit_fn,
         'public.gbrain_guard_sources_generation_update()'::regprocedure AS sources_fn
     ), role_names AS (
       SELECT unnest($2::text[]) AS role_name
     ), table_privileges(privilege_type) AS (
       VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
     ), intended_pages_update_cols(column_name) AS (
       SELECT unnest(ARRAY['slug','type','page_kind','title','compiled_truth','frontmatter','timeline','source_path','content_hash','embedding','embedding_voyage','embedding_model','embedding_dimensions','updated_at','effective_date','contextual_retrieval_mode','corpus_generation','generation'])
     ), expected_table_acl(role_name, relid, privilege_type) AS (
       SELECT 'gbrain_normal_sync', pages_rel, 'SELECT' FROM oid UNION ALL
       SELECT 'gbrain_normal_sync', pages_rel, 'INSERT' FROM oid UNION ALL
       SELECT 'gbrain_normal_sync', chunks_rel, 'SELECT' FROM oid UNION ALL
       SELECT 'gbrain_normal_sync', chunks_rel, 'INSERT' FROM oid UNION ALL
       SELECT 'gbrain_normal_sync', ingest_rel, 'SELECT' FROM oid UNION ALL
       SELECT 'gbrain_normal_sync', ingest_rel, 'INSERT' FROM oid UNION ALL
       SELECT 'gbrain_normal_sync', sources_rel, 'SELECT' FROM oid UNION ALL
       SELECT 'gbrain_normal_sync', audit_rel, 'SELECT' FROM oid UNION ALL
       SELECT 'gbrain_normal_sync', audit_rel, 'INSERT' FROM oid UNION ALL
       SELECT 'gbrain_normal_sync', policy_rel, 'SELECT' FROM oid UNION ALL
       SELECT 'gbrain_reconciliation_approve', audit_rel, 'SELECT' FROM oid UNION ALL
       SELECT 'gbrain_reconciliation_approve', policy_rel, 'SELECT' FROM oid UNION ALL
       SELECT 'gbrain_reconciliation_apply', pages_rel, 'SELECT' FROM oid UNION ALL
       SELECT 'gbrain_reconciliation_apply', sources_rel, 'SELECT' FROM oid UNION ALL
       SELECT 'gbrain_reconciliation_apply', audit_rel, 'SELECT' FROM oid UNION ALL
       SELECT 'gbrain_reconciliation_apply', policy_rel, 'SELECT' FROM oid UNION ALL
       SELECT 'gbrain_source_repair', sources_rel, 'SELECT' FROM oid UNION ALL
       SELECT 'gbrain_source_repair', policy_rel, 'SELECT' FROM oid UNION ALL
       SELECT 'gbrain_hard_purge', pages_rel, 'SELECT' FROM oid UNION ALL
       SELECT 'gbrain_hard_purge', pages_rel, 'DELETE' FROM oid UNION ALL
       SELECT 'gbrain_hard_purge', audit_rel, 'SELECT' FROM oid UNION ALL
       SELECT 'gbrain_hard_purge', policy_rel, 'SELECT' FROM oid
     ), public_relations AS (
      SELECT c.oid, c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    ), public_columns AS (
       SELECT c.oid, c.relname, a.attname
       FROM public_relations c
       JOIN pg_attribute a ON a.attrelid = c.oid
       WHERE a.attnum > 0 AND NOT a.attisdropped
     ), expected_column_acl(role_name, relid, column_name, privilege_type) AS (
       SELECT 'gbrain_normal_sync', pc.oid, pc.attname, 'UPDATE'
       FROM public_columns pc
       JOIN intended_pages_update_cols cols ON cols.column_name = pc.attname
       WHERE pc.relname = 'pages' UNION ALL
       SELECT 'gbrain_normal_sync', sources_rel, unnest(ARRAY['last_commit','last_sync_at','newest_content_at','chunker_version']), 'UPDATE' FROM oid UNION ALL
       SELECT 'gbrain_reconciliation_approve', audit_rel, unnest(ARRAY['authorized','after_state','result']), 'UPDATE' FROM oid UNION ALL
       SELECT 'gbrain_reconciliation_apply', pages_rel, unnest(ARRAY['deleted_at','updated_at']), 'UPDATE' FROM oid UNION ALL
       SELECT 'gbrain_reconciliation_apply', audit_rel, unnest(ARRAY['after_state','result','failure','completed_at','apply_attempt','applying_claimed_at']), 'UPDATE' FROM oid UNION ALL
       SELECT 'gbrain_source_repair', sources_rel, unnest(ARRAY['local_path','registration_generation']), 'UPDATE' FROM oid UNION ALL
       SELECT 'gbrain_hard_purge', audit_rel, unnest(ARRAY['after_state','result','completed_at']), 'UPDATE' FROM oid
     ), unexpected_table_acl AS (
       SELECT r.role_name, pr.relname, tp.privilege_type
       FROM role_names r CROSS JOIN public_relations pr CROSS JOIN table_privileges tp
       WHERE has_table_privilege(r.role_name, pr.oid, tp.privilege_type)
         AND NOT EXISTS (
           SELECT 1 FROM expected_table_acl e
           WHERE e.role_name = r.role_name AND e.relid = pr.oid AND e.privilege_type = tp.privilege_type
         )
     ), missing_table_acl AS (
       SELECT e.role_name, c.relname, e.privilege_type
       FROM expected_table_acl e JOIN pg_class c ON c.oid = e.relid
       WHERE NOT has_table_privilege(e.role_name, e.relid, e.privilege_type)
     ), column_privileges(privilege_type) AS (
       VALUES ('UPDATE')
     ), unexpected_column_acl AS (
       SELECT r.role_name, pc.relname, pc.attname, cp.privilege_type
       FROM role_names r CROSS JOIN public_columns pc CROSS JOIN column_privileges cp
       WHERE has_column_privilege(r.role_name, pc.oid, pc.attname, cp.privilege_type)
         AND NOT EXISTS (
           SELECT 1 FROM expected_column_acl e
           WHERE e.role_name = r.role_name AND e.relid = pc.oid AND e.column_name = pc.attname AND e.privilege_type = cp.privilege_type
         )
     ), missing_column_acl AS (
       SELECT e.role_name, c.relname, e.column_name, e.privilege_type
       FROM expected_column_acl e JOIN pg_class c ON c.oid = e.relid
       WHERE NOT has_column_privilege(e.role_name, e.relid, e.column_name, e.privilege_type)
     ), function_acl AS (
       SELECT NOT EXISTS (
         SELECT 1 FROM role_names r, oid
         WHERE has_function_privilege(r.role_name, oid.audit_fn, 'EXECUTE')
            OR has_function_privilege(r.role_name, oid.sources_fn, 'EXECUTE')
       ) AS guard_functions_not_executable
     ), guard AS (
       SELECT
         EXISTS (
           SELECT 1 FROM pg_trigger t, oid
           WHERE t.tgrelid = oid.audit_rel
             AND t.tgfoid = oid.audit_fn
             AND t.tgname = 'gbrain_guard_sync_reconciliation_audit_update'
             AND NOT t.tgisinternal
             AND t.tgenabled = 'O'
         ) AS audit_trigger_exists,
         EXISTS (
           SELECT 1 FROM pg_trigger t, oid
           WHERE t.tgrelid = oid.sources_rel
             AND t.tgfoid = oid.sources_fn
             AND t.tgname = 'gbrain_guard_sources_generation_update'
             AND NOT t.tgisinternal
             AND t.tgenabled = 'O'
         ) AS sources_trigger_exists,
         EXISTS (
           SELECT 1 FROM pg_proc p
           JOIN pg_roles owner ON owner.oid = p.proowner
           JOIN pg_language lang ON lang.oid = p.prolang
           JOIN oid ON p.oid = oid.audit_fn
           WHERE owner.rolname = 'gbrain_reconciliation_owner'
             AND lang.lanname = 'plpgsql'
             AND p.prosecdef IS FALSE
             AND p.proconfig @> ARRAY['search_path=pg_catalog, public']::text[]
         ) AS audit_function_posture_ok,
         EXISTS (
           SELECT 1 FROM pg_proc p
           JOIN pg_roles owner ON owner.oid = p.proowner
           JOIN pg_language lang ON lang.oid = p.prolang
           JOIN oid ON p.oid = oid.sources_fn
           WHERE owner.rolname = 'gbrain_reconciliation_owner'
             AND lang.lanname = 'plpgsql'
             AND p.prosecdef IS FALSE
             AND p.proconfig @> ARRAY['search_path=pg_catalog, public']::text[]
         ) AS sources_function_posture_ok,
         NOT EXISTS (
           SELECT 1
           FROM pg_class c, oid
           WHERE c.oid IN (oid.audit_rel, oid.policy_rel, oid.sources_rel)
             AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = 'gbrain_reconciliation_owner')
         ) AS guarded_tables_owned
     ), acl AS (
       SELECT
         NOT EXISTS (SELECT 1 FROM unexpected_table_acl) AS no_unexpected_table_acl,
         NOT EXISTS (SELECT 1 FROM missing_table_acl) AS no_missing_table_acl,
         NOT EXISTS (SELECT 1 FROM unexpected_column_acl) AS no_unexpected_column_acl,
         NOT EXISTS (SELECT 1 FROM missing_column_acl) AS no_missing_column_acl,
         COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM unexpected_table_acl x), '[]'::jsonb) AS unexpected_table_acl,
         COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM unexpected_column_acl x), '[]'::jsonb) AS unexpected_column_acl,
         COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM missing_table_acl x), '[]'::jsonb) AS missing_table_acl,
         COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM missing_column_acl x), '[]'::jsonb) AS missing_column_acl
     ), role_posture AS (
       SELECT
         bool_and(NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls) AS cluster_roles_normalized,
         EXISTS (
           SELECT 1 FROM pg_roles
           WHERE rolname = 'gbrain_reconciliation_owner'
             AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
         ) AS owner_flags_ok,
         NOT EXISTS (
           SELECT 1
           FROM pg_auth_members m
           WHERE m.roleid = 'gbrain_reconciliation_owner'::regrole
              OR m.member = 'gbrain_reconciliation_owner'::regrole
         ) AS owner_memberships_ok,
         NOT EXISTS (
           SELECT 1
           FROM pg_auth_members m
           JOIN pg_roles member_role ON member_role.oid = m.member
           WHERE member_role.rolname = ANY($1)
         ) AS operational_role_memberships_ok
       FROM pg_roles
       WHERE rolname = ANY($1)
     )
     SELECT *,
       (audit_trigger_exists AND sources_trigger_exists AND audit_function_posture_ok
        AND sources_function_posture_ok AND guarded_tables_owned AND guard_functions_not_executable) AS guard_ok,
       (no_unexpected_table_acl AND no_missing_table_acl AND no_unexpected_column_acl AND no_missing_column_acl) AS role_privileges_ok,
       (cluster_roles_normalized AND owner_flags_ok AND owner_memberships_ok AND operational_role_memberships_ok) AS owner_role_ok
     FROM guard, acl, function_acl, role_posture`,
    [RECONCILIATION_CLUSTER_ROLES, RECONCILIATION_ROLES],
  );
  return rows[0] ?? { role_privileges_ok: false, guard_ok: false, owner_role_ok: false };
}

export async function getCapabilities(engine: BrainEngine): Promise<Record<string, unknown>> {
  const diagnostics: string[] = [];
  const hasAudit = await checked(diagnostics, 'table.sync_reconciliation_audit', () => tableExists(engine, 'sync_reconciliation_audit'), false);
  const hasPolicy = await checked(diagnostics, 'table.sync_reconciliation_role_policy', () => tableExists(engine, 'sync_reconciliation_role_policy'), false);
  const hasGeneration = await checked(diagnostics, 'column.sources.registration_generation', () => columnExists(engine, 'sources', 'registration_generation'), false);
  const hasApplyAttempt = await checked(diagnostics, 'column.sync_reconciliation_audit.apply_attempt', () => columnExists(engine, 'sync_reconciliation_audit', 'apply_attempt'), false);
  const hasApplyLease = await checked(diagnostics, 'column.sync_reconciliation_audit.applying_claimed_at', () => columnExists(engine, 'sync_reconciliation_audit', 'applying_claimed_at'), false);
  const hasApproveColumn = await checked(diagnostics, 'column.sync_reconciliation_role_policy.can_approve_reconciliation', () => columnExists(engine, 'sync_reconciliation_role_policy', 'can_approve_reconciliation'), false);
  const policies = await checked(diagnostics, 'role_policy', () => rolePolicyRows(engine, hasApproveColumn), [] as Record<string, unknown>[]);
  const pgRoles = await checked(diagnostics, 'pg_roles', () => roleFacts(engine), [] as Record<string, unknown>[]);
  const postgresChecks = await checked(diagnostics, 'postgres_safety_checks', () => postgresSafetyChecks(engine), { role_privileges_ok: false, guard_ok: false } as Record<string, unknown>);
  const configVersionRaw = await checked(diagnostics, 'config.version', () => engine.getConfig('version'), null as string | null);
  const configVersion = Number(configVersionRaw ?? 0);

  const pgRoleNames = new Set(pgRoles.map((row) => String(row.role_name)));
  const hasPgRoles = engine.kind === 'postgres' && RECONCILIATION_ROLES.every((role) => pgRoleNames.has(role));
  const hasClusterRoles = engine.kind === 'postgres' && RECONCILIATION_CLUSTER_ROLES.every((role) => pgRoleNames.has(role));
  const hasExactPolicyRows = policyIsExact(policies);
  const hasExactSchema = hasAudit && hasPolicy && hasGeneration && hasApplyAttempt && hasApplyLease && hasApproveColumn && configVersion === REQUIRED_SCHEMA_VERSION;
  const guardsOk = postgresChecks.guard_ok === true;
  const rolePrivilegesOk = postgresChecks.role_privileges_ok === true;
  const ownerRoleOk = postgresChecks.owner_role_ok === true;
  const identity = await checked(
    diagnostics,
    'identity',
    async () => (await engine.executeRaw<{ current_user: string; session_user: string }>(
      `SELECT current_user::text AS current_user, session_user::text AS session_user`,
    ))[0] ?? { current_user: 'unknown', session_user: 'unknown' },
    { current_user: 'unknown', session_user: 'unknown' },
  );
  const supported = hasExactSchema && hasClusterRoles && hasExactPolicyRows && guardsOk && rolePrivilegesOk && ownerRoleOk && diagnostics.length === 0;

  return {
    schema_version: 1,
    gbrain_version: VERSION,
    backend: engine.kind,
    database: {
      current_user: identity.current_user,
      session_user: identity.session_user,
      schema_version: Number.isFinite(configVersion) ? configVersion : null,
      required_sync_safety_schema_version: Math.min(REQUIRED_SCHEMA_VERSION, LATEST_VERSION),
    },
    sync_safety: {
      supported,
      required_tokens: REQUIRED_SYNC_TOKENS,
      capabilities: {
        explicit_source: hasExactSchema,
        root_identity: hasExactSchema,
        reconciliation_manifest: hasAudit,
        db_roles: hasPgRoles,
        schema_v2: hasExactSchema,
      },
      role_policy: policies,
      roles: pgRoles,
      postgres_checks: postgresChecks,
      diagnostics,
    },
  };
}

export async function runCapabilities(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: gbrain capabilities --json\n\nPrint runtime capabilities required by downstream callers.`);
    return;
  }
  if (!args.includes('--json')) {
    throw new Error('gbrain capabilities currently requires --json');
  }
  console.log(JSON.stringify(await getCapabilities(engine), null, 2));
}
