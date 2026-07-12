import type { BrainEngine } from '../core/engine.ts';
import { VERSION } from '../version.ts';

const REQUIRED_SYNC_TOKENS = [
  'explicit-source',
  'root-identity',
  'reconciliation-manifest',
  'db-roles',
  'schema-v2',
] as const;

async function tableExists(engine: BrainEngine, table: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_name = $1`,
    [table],
  );
  return Number(rows[0]?.n ?? 0) === 1;
}

async function rolePolicyRows(engine: BrainEngine): Promise<Record<string, unknown>[]> {
  if (!(await tableExists(engine, 'sync_reconciliation_role_policy'))) return [];
  return await engine.executeRaw<Record<string, unknown>>(
    `SELECT role_name, can_normal_sync, can_apply_reconciliation, can_repair_source_root, can_hard_purge
     FROM sync_reconciliation_role_policy ORDER BY role_name`,
  );
}

export async function getCapabilities(engine: BrainEngine): Promise<Record<string, unknown>> {
  const hasAudit = await tableExists(engine, 'sync_reconciliation_audit');
  const hasPolicy = await tableExists(engine, 'sync_reconciliation_role_policy');
  const policies = await rolePolicyRows(engine);
  const roleNames = new Set(policies.map((row) => String(row.role_name)));
  const hasRoles = ['gbrain_normal_sync', 'gbrain_reconciliation_apply', 'gbrain_source_repair', 'gbrain_hard_purge']
    .every((role) => roleNames.has(role));
  const syncSafetyReady = hasAudit && hasPolicy && hasRoles;
  return {
    schema_version: 1,
    gbrain_version: VERSION,
    sync_safety: {
      supported: syncSafetyReady,
      required_tokens: REQUIRED_SYNC_TOKENS,
      capabilities: {
        explicit_source: true,
        root_identity: true,
        reconciliation_manifest: hasAudit,
        db_roles: hasPolicy && hasRoles,
        schema_v2: hasAudit && hasPolicy,
      },
      role_policy: policies,
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
