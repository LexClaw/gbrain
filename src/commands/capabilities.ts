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

async function objectPrivileges(engine: BrainEngine): Promise<Record<string, unknown>> {
  if (engine.kind !== 'postgres') return {};
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT
       has_table_privilege(current_user, 'pages', 'SELECT') AS pages_select,
       has_table_privilege(current_user, 'pages', 'INSERT') AS pages_insert,
       has_table_privilege(current_user, 'pages', 'DELETE') AS pages_delete,
       has_column_privilege(current_user, 'pages', 'deleted_at', 'UPDATE') AS pages_deleted_at_update,
       has_column_privilege(current_user, 'sync_reconciliation_audit', 'authorized', 'UPDATE') AS audit_authorized_update,
       has_column_privilege(current_user, 'sync_reconciliation_audit', 'result', 'UPDATE') AS audit_result_update,
       has_column_privilege(current_user, 'sync_reconciliation_audit', 'manifest_hash', 'UPDATE') AS audit_manifest_hash_update,
       has_table_privilege(current_user, 'sync_reconciliation_role_policy', 'SELECT') AS policy_select,
       has_table_privilege(current_user, 'sync_reconciliation_role_policy', 'UPDATE') AS policy_update`,
  );
  return rows[0] ?? {};
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

export async function getCapabilities(engine: BrainEngine): Promise<Record<string, unknown>> {
  const diagnostics: string[] = [];
  const hasAudit = await checked(diagnostics, 'table.sync_reconciliation_audit', () => tableExists(engine, 'sync_reconciliation_audit'), false);
  const hasPolicy = await checked(diagnostics, 'table.sync_reconciliation_role_policy', () => tableExists(engine, 'sync_reconciliation_role_policy'), false);
  const hasGeneration = await checked(diagnostics, 'column.sources.registration_generation', () => columnExists(engine, 'sources', 'registration_generation'), false);
  const hasApproveColumn = await checked(diagnostics, 'column.sync_reconciliation_role_policy.can_approve_reconciliation', () => columnExists(engine, 'sync_reconciliation_role_policy', 'can_approve_reconciliation'), false);
  const policies = await checked(diagnostics, 'role_policy', () => rolePolicyRows(engine, hasApproveColumn), [] as Record<string, unknown>[]);
  const pgRoles = await checked(diagnostics, 'pg_roles', () => roleFacts(engine), [] as Record<string, unknown>[]);
  const privileges = await checked(diagnostics, 'object_privileges', () => objectPrivileges(engine), {} as Record<string, unknown>);
  const configVersionRaw = await checked(diagnostics, 'config.version', () => engine.getConfig('version'), null as string | null);
  const configVersion = Number(configVersionRaw ?? 0);

  const pgRoleNames = new Set(pgRoles.map((row) => String(row.role_name)));
  const policyRoleNames = new Set(policies.map((row) => String(row.role_name)));
  const hasPgRoles = engine.kind === 'postgres' && RECONCILIATION_ROLES.every((role) => pgRoleNames.has(role));
  const hasPolicyRows = RECONCILIATION_ROLES.every((role) => policyRoleNames.has(role));
  const hasExactSchema = hasAudit && hasPolicy && hasGeneration && hasApproveColumn && configVersion >= REQUIRED_SCHEMA_VERSION;
  const identity = await checked(
    diagnostics,
    'identity',
    async () => (await engine.executeRaw<{ current_user: string; session_user: string }>(
      `SELECT current_user::text AS current_user, session_user::text AS session_user`,
    ))[0] ?? { current_user: 'unknown', session_user: 'unknown' },
    { current_user: 'unknown', session_user: 'unknown' },
  );

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
      supported: hasExactSchema && hasPgRoles && hasPolicyRows && diagnostics.length === 0,
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
      object_privileges: privileges,
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
