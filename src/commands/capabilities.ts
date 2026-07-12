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
    `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_name = $1`,
    [table],
  );
  return Number(rows[0]?.n ?? 0) === 1;
}

async function columnExists(engine: BrainEngine, table: string, column: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n
     FROM information_schema.columns
     WHERE table_name = $1 AND column_name = $2`,
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
            pg_has_role(current_user, r.oid, 'USAGE') AS reachable_from_current_user
     FROM pg_roles r
     WHERE r.rolname = ANY($1)
     ORDER BY r.rolname`,
    [RECONCILIATION_ROLES],
  );
}

async function postgresSafetyChecks(engine: BrainEngine): Promise<Record<string, unknown>> {
  if (engine.kind !== 'postgres') return { role_privileges_ok: false, guard_ok: false };
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `WITH guard AS (
       SELECT
         EXISTS (
           SELECT 1 FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           WHERE c.relname = 'sync_reconciliation_audit'
             AND t.tgname = 'gbrain_guard_sync_reconciliation_audit_update'
             AND NOT t.tgisinternal
             AND t.tgenabled = 'O'
         ) AS audit_trigger_exists,
         EXISTS (
           SELECT 1 FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           JOIN pg_roles owner ON owner.oid = p.proowner
           WHERE n.nspname = 'public'
             AND p.proname = 'gbrain_guard_sync_reconciliation_audit_update'
             AND owner.rolname = 'gbrain_reconciliation_owner'
         ) AS audit_function_owned,
         EXISTS (
           SELECT 1 FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           WHERE c.relname = 'sources'
             AND t.tgname = 'gbrain_guard_sources_generation_update'
             AND NOT t.tgisinternal
             AND t.tgenabled = 'O'
         ) AS sources_trigger_exists,
         EXISTS (
           SELECT 1 FROM pg_class c
           JOIN pg_roles owner ON owner.oid = c.relowner
           WHERE c.relname IN ('sync_reconciliation_audit', 'sources')
           GROUP BY owner.rolname
           HAVING owner.rolname = 'gbrain_reconciliation_owner' AND COUNT(*) = 2
         ) AS guarded_tables_owned
     ), privs AS (
       SELECT
         has_table_privilege('gbrain_normal_sync', 'pages', 'SELECT') AS normal_pages_select,
         has_table_privilege('gbrain_normal_sync', 'pages', 'INSERT') AS normal_pages_insert,
         has_column_privilege('gbrain_normal_sync', 'sources', 'local_path', 'UPDATE') = false AS normal_sources_local_path_forbidden,
         has_column_privilege('gbrain_reconciliation_approve', 'sync_reconciliation_audit', 'authorized', 'UPDATE') AS approve_authorized_update,
         has_column_privilege('gbrain_reconciliation_approve', 'sync_reconciliation_audit', 'result', 'UPDATE') AS approve_result_update,
         has_table_privilege('gbrain_reconciliation_approve', 'pages', 'UPDATE') = false AS approve_pages_update_forbidden,
         has_column_privilege('gbrain_reconciliation_apply', 'pages', 'deleted_at', 'UPDATE') AS apply_pages_deleted_update,
         has_column_privilege('gbrain_reconciliation_apply', 'sync_reconciliation_audit', 'authorized', 'UPDATE') = false AS apply_authorized_forbidden,
         has_column_privilege('gbrain_reconciliation_apply', 'sync_reconciliation_audit', 'manifest_hash', 'UPDATE') = false AS apply_manifest_hash_forbidden,
         has_column_privilege('gbrain_source_repair', 'sources', 'local_path', 'UPDATE') AS repair_sources_local_path_update,
         has_column_privilege('gbrain_source_repair', 'sources', 'registration_generation', 'UPDATE') AS repair_sources_generation_update,
         has_table_privilege('gbrain_source_repair', 'pages', 'UPDATE') = false AS repair_pages_update_forbidden,
         has_table_privilege('gbrain_hard_purge', 'pages', 'DELETE') AS purge_pages_delete,
         has_column_privilege('gbrain_hard_purge', 'sync_reconciliation_audit', 'manifest_hash', 'UPDATE') = false AS purge_manifest_hash_forbidden
     )
     SELECT *,
       (audit_trigger_exists AND audit_function_owned AND sources_trigger_exists AND guarded_tables_owned) AS guard_ok,
       (normal_pages_select AND normal_pages_insert AND normal_sources_local_path_forbidden
        AND approve_authorized_update AND approve_result_update AND approve_pages_update_forbidden
        AND apply_pages_deleted_update AND apply_authorized_forbidden AND apply_manifest_hash_forbidden
        AND repair_sources_local_path_update AND repair_sources_generation_update AND repair_pages_update_forbidden
        AND purge_pages_delete AND purge_manifest_hash_forbidden) AS role_privileges_ok
     FROM guard, privs`,
  );
  return rows[0] ?? { role_privileges_ok: false, guard_ok: false };
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
  const hasExactPolicyRows = policyIsExact(policies);
  const hasExactSchema = hasAudit && hasPolicy && hasGeneration && hasApplyAttempt && hasApplyLease && hasApproveColumn && configVersion === REQUIRED_SCHEMA_VERSION;
  const guardsOk = postgresChecks.guard_ok === true;
  const rolePrivilegesOk = postgresChecks.role_privileges_ok === true;
  const identity = await checked(
    diagnostics,
    'identity',
    async () => (await engine.executeRaw<{ current_user: string; session_user: string }>(
      `SELECT current_user::text AS current_user, session_user::text AS session_user`,
    ))[0] ?? { current_user: 'unknown', session_user: 'unknown' },
    { current_user: 'unknown', session_user: 'unknown' },
  );
  const supported = hasExactSchema && hasPgRoles && hasExactPolicyRows && guardsOk && rolePrivilegesOk && diagnostics.length === 0;

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
