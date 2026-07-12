import type { BrainEngine } from '../core/engine.ts';
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
  'gbrain_reconciliation_apply',
  'gbrain_source_repair',
  'gbrain_hard_purge',
] as const;

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

async function scalar<T>(engine: BrainEngine, sql: string, params: unknown[] = [], fallback: T): Promise<T> {
  try {
    const rows = await engine.executeRaw<Record<string, T>>(sql, params);
    const first = rows[0];
    if (!first) return fallback;
    return Object.values(first)[0] as T ?? fallback;
  } catch {
    return fallback;
  }
}

async function rolePolicyRows(engine: BrainEngine): Promise<Record<string, unknown>[]> {
  if (!(await tableExists(engine, 'sync_reconciliation_role_policy'))) return [];
  return await engine.executeRaw<Record<string, unknown>>(
    `SELECT role_name, can_normal_sync, can_apply_reconciliation, can_repair_source_root, can_hard_purge
     FROM sync_reconciliation_role_policy ORDER BY role_name`,
  );
}

async function objectPrivileges(engine: BrainEngine): Promise<Record<string, unknown>> {
  const checks = [
    ['pages_select', 'pages', 'SELECT'],
    ['pages_insert', 'pages', 'INSERT'],
    ['pages_update', 'pages', 'UPDATE'],
    ['pages_delete', 'pages', 'DELETE'],
    ['audit_select', 'sync_reconciliation_audit', 'SELECT'],
    ['audit_insert', 'sync_reconciliation_audit', 'INSERT'],
    ['audit_update', 'sync_reconciliation_audit', 'UPDATE'],
    ['audit_delete', 'sync_reconciliation_audit', 'DELETE'],
    ['policy_select', 'sync_reconciliation_role_policy', 'SELECT'],
    ['policy_update', 'sync_reconciliation_role_policy', 'UPDATE'],
  ] as const;
  const out: Record<string, unknown> = {};
  for (const [key, table, privilege] of checks) {
    out[key] = await scalar<boolean>(engine, `SELECT has_table_privilege(current_user, $1, $2) AS ok`, [table, privilege], false);
  }
  return out;
}

async function roleFacts(engine: BrainEngine): Promise<Record<string, unknown>[]> {
  if (engine.kind !== 'postgres') return [];
  return await engine.executeRaw<Record<string, unknown>>(
    `SELECT r.rolname AS role_name,
            pg_has_role(current_user, r.oid, 'USAGE') AS can_set_role
     FROM pg_roles r
     WHERE r.rolname = ANY($1)
     ORDER BY r.rolname`,
    [RECONCILIATION_ROLES],
  );
}

export async function getCapabilities(engine: BrainEngine): Promise<Record<string, unknown>> {
  const hasAudit = await tableExists(engine, 'sync_reconciliation_audit');
  const hasPolicy = await tableExists(engine, 'sync_reconciliation_role_policy');
  const hasGeneration = await columnExists(engine, 'sources', 'registration_generation');
  const hasSchemaV2Shape = hasAudit && hasPolicy && hasGeneration;
  const policies = await rolePolicyRows(engine);
  const pgRoles = await roleFacts(engine);
  const pgRoleNames = new Set(pgRoles.map((row) => String(row.role_name)));
  const policyRoleNames = new Set(policies.map((row) => String(row.role_name)));
  const hasPgRoles = engine.kind === 'postgres' && RECONCILIATION_ROLES.every((role) => pgRoleNames.has(role));
  const hasPolicyRows = RECONCILIATION_ROLES.every((role) => policyRoleNames.has(role));
  const identity = {
    current_user: await scalar<string>(engine, `SELECT current_user::text AS value`, [], 'unknown'),
    session_user: await scalar<string>(engine, `SELECT session_user::text AS value`, [], 'unknown'),
  };
  const privileges = await objectPrivileges(engine);
  const schemaMigrationVersion = await scalar<number | null>(
    engine,
    `SELECT MAX(version)::int AS value FROM schema_migrations`,
    [],
    null,
  );
  return {
    schema_version: 1,
    gbrain_version: VERSION,
    backend: engine.kind,
    database: {
      current_user: identity.current_user,
      session_user: identity.session_user,
      schema_migration_version: schemaMigrationVersion,
    },
    sync_safety: {
      supported: hasSchemaV2Shape && hasPgRoles && hasPolicyRows,
      required_tokens: REQUIRED_SYNC_TOKENS,
      capabilities: {
        explicit_source: hasGeneration,
        root_identity: hasGeneration,
        reconciliation_manifest: hasAudit,
        db_roles: hasPgRoles,
        schema_v2: hasSchemaV2Shape,
      },
      role_policy: policies,
      roles: pgRoles,
      object_privileges: privileges,
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
