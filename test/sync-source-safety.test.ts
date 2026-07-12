import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { assertSyncSourceRootGuard, performSync, syncOneSource, proposeSyncReconciliation, applySyncReconciliation } from '../src/commands/sync.ts';
import { getCapabilities } from '../src/commands/capabilities.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `${name}-`));
}

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: 'utf8' }).trim();
}

function makeRepo(fileCount = 1): string {
  const repo = tempDir('gbrain-sync-source-safety');
  git(repo, 'git init -q');
  git(repo, 'git config user.email test@example.com');
  git(repo, 'git config user.name Test');
  mkdirSync(join(repo, 'notes'), { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    const name = i === 0 ? 'alpha' : `extra-${i}`;
    writeFileSync(join(repo, 'notes', `${name}.md`), `# ${name}\n`);
  }
  git(repo, 'git add notes');
  git(repo, 'git commit -q -m init');
  return repo;
}

async function setSourcePath(sourceId: string, localPath: string): Promise<void> {
  await engine.executeRaw(
    `UPDATE sources SET local_path = $1 WHERE id = $2`,
    [localPath, sourceId],
  );
}

async function addSource(sourceId: string, localPath: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, '{}'::jsonb)`,
    [sourceId, localPath],
  );
}

async function grantCurrentUser(capability: 'can_normal_sync' | 'can_apply_reconciliation' | 'can_repair_source_root' | 'can_hard_purge'): Promise<void> {
  const identity = await engine.executeRaw<{ current_user: string }>(`SELECT current_user::text AS current_user`);
  await engine.executeRaw(
    `INSERT INTO sync_reconciliation_role_policy
       (role_name, can_normal_sync, can_apply_reconciliation, can_repair_source_root, can_hard_purge)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (role_name) DO UPDATE SET
       can_normal_sync = EXCLUDED.can_normal_sync,
       can_apply_reconciliation = EXCLUDED.can_apply_reconciliation,
       can_repair_source_root = EXCLUDED.can_repair_source_root,
       can_hard_purge = EXCLUDED.can_hard_purge`,
    [
      identity[0].current_user,
      capability === 'can_normal_sync',
      capability === 'can_apply_reconciliation',
      capability === 'can_repair_source_root',
      capability === 'can_hard_purge',
    ],
  );
}

describe('sync source safety guard', () => {
  test('rejects unqualified repo override in a multi-source brain', async () => {
    const repoA = makeRepo();
    const repoB = makeRepo();
    try {
      await setSourcePath('default', repoA);
      await addSource('source-b', repoB);

      await expect(assertSyncSourceRootGuard(engine, { repoPath: repoB }, repoB))
        .rejects.toThrow(/explicit --source provenance/);
    } finally {
      rmSync(repoA, { recursive: true, force: true });
      rmSync(repoB, { recursive: true, force: true });
    }
  });

  test('rejects explicit source when repo root does not match registered local_path', async () => {
    const repoA = makeRepo();
    const repoB = makeRepo();
    try {
      await setSourcePath('default', repoA);

      await expect(assertSyncSourceRootGuard(engine, {
        repoPath: repoB,
        sourceId: 'default',
        explicitSourceArg: true,
        sourceResolutionTier: 'flag',
      }, repoB)).rejects.toThrow(/root mismatch/);
    } finally {
      rmSync(repoA, { recursive: true, force: true });
      rmSync(repoB, { recursive: true, force: true });
    }
  });

  test('allows explicit compatible source root', async () => {
    const repoA = makeRepo();
    try {
      await setSourcePath('default', repoA);

      await expect(assertSyncSourceRootGuard(engine, {
        repoPath: repoA,
        sourceId: 'default',
        explicitSourceArg: true,
        sourceResolutionTier: 'flag',
      }, repoA)).resolves.toBeUndefined();
    } finally {
      rmSync(repoA, { recursive: true, force: true });
    }
  });

  test('rejects forged or implicit default resolver provenance', async () => {
    const repo = makeRepo();
    try {
      await setSourcePath('default', repo);

      await expect(assertSyncSourceRootGuard(engine, {
        repoPath: repo,
        sourceId: 'default',
        explicitSourceArg: false,
        sourceResolutionTier: 'brain_default',
      }, repo)).rejects.toThrow(/explicit --source provenance/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('rejects missing local_path for the default source even with explicit provenance', async () => {
    const repo = makeRepo();
    try {
      await expect(assertSyncSourceRootGuard(engine, {
        repoPath: repo,
        sourceId: 'default',
        explicitSourceArg: true,
        sourceResolutionTier: 'flag',
      }, repo)).rejects.toThrow(/has no local_path/);

      const rows = await engine.executeRaw<{ local_path: string | null }>(
        `SELECT local_path FROM sources WHERE id = 'default'`,
      );
      expect(rows[0].local_path).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('incremental sync proposes deleted files without tombstoning under normal sync role', async () => {
    const repo = makeRepo(5);
    try {
      await setSourcePath('default', repo);
      const first = await performSync(engine, {
        repoPath: repo,
        sourceId: 'default',
        explicitSourceArg: true,
        sourceResolutionTier: 'flag',
        noPull: true,
        noEmbed: true,
        noExtract: true,
      });
      expect(first.status).toBe('first_sync');

      await grantCurrentUser('can_normal_sync');
      rmSync(join(repo, 'notes', 'alpha.md'));
      git(repo, 'git add -A');
      git(repo, 'git commit -q -m remove-alpha');

      await expect(performSync(engine, {
        repoPath: repo,
        sourceId: 'default',
        explicitSourceArg: true,
        sourceResolutionTier: 'flag',
        noPull: true,
        noEmbed: true,
        noExtract: true,
      })).rejects.toThrow(/proposed as sync-reconcile-/);

      const rows = await engine.executeRaw<{ slug: string; deleted_at: string | null }>(
        `SELECT slug, deleted_at FROM pages WHERE source_id = 'default' AND slug = 'notes/alpha'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].deleted_at).toBeNull();

      const audits = await engine.executeRaw<{ reason: string; candidate_count: number; result: string; manifest_hash: string }>(
        `SELECT reason, candidate_count, result, manifest_hash FROM sync_reconciliation_audit`,
      );
      expect(audits.some((r) => r.reason === 'incremental_deleted' && r.candidate_count === 1 && r.result === 'proposed' && r.manifest_hash.length === 64)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('direct syncOneSource boundary carries parser-proven source provenance', async () => {
    const repo = makeRepo();
    try {
      await setSourcePath('default', repo);
      const { result } = await syncOneSource(engine, {
        id: 'default',
        name: 'default',
        local_path: repo,
        config: {},
      }, {
        dryRun: false,
        full: false,
        noPull: true,
        noEmbed: true,
        noExtract: true,
        skipFailed: false,
        retryFailed: false,
        concurrency: undefined,
      });
      expect(result.status).toBe('first_sync');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('migration-backed reconciliation role policy is present on fresh schema', async () => {
    const fresh = new PGLiteEngine();
    await fresh.connect({});
    try {
      await fresh.initSchema();
      const rows = await fresh.executeRaw<{
        role_name: string;
        can_normal_sync: boolean;
        can_apply_reconciliation: boolean;
        can_repair_source_root: boolean;
        can_hard_purge: boolean;
      }>(
        `SELECT role_name, can_normal_sync, can_apply_reconciliation, can_repair_source_root, can_hard_purge
         FROM sync_reconciliation_role_policy ORDER BY role_name`,
      );
      expect(rows).toEqual([
        { role_name: 'gbrain_hard_purge', can_normal_sync: false, can_apply_reconciliation: false, can_repair_source_root: false, can_hard_purge: true },
        { role_name: 'gbrain_normal_sync', can_normal_sync: true, can_apply_reconciliation: false, can_repair_source_root: false, can_hard_purge: false },
        { role_name: 'gbrain_reconciliation_apply', can_normal_sync: false, can_apply_reconciliation: true, can_repair_source_root: false, can_hard_purge: false },
        { role_name: 'gbrain_source_repair', can_normal_sync: false, can_apply_reconciliation: false, can_repair_source_root: true, can_hard_purge: false },
      ]);
    } finally {
      await fresh.disconnect();
    }
  });

  test('proposal/apply split denies tombstone to normal sync and applies under apply capability', async () => {
    const repo = makeRepo(5);
    try {
      await setSourcePath('default', repo);
      await performSync(engine, {
        repoPath: repo,
        sourceId: 'default',
        explicitSourceArg: true,
        sourceResolutionTier: 'flag',
        noPull: true,
        noEmbed: true,
        noExtract: true,
      });
      await grantCurrentUser('can_normal_sync');
      const proposal = await proposeSyncReconciliation(engine, ['notes/alpha'], {
        sourceId: 'default',
        repoPath: repo,
        reason: 'incremental_deleted',
      });
      expect(proposal.operationId).toStartWith('sync-reconcile-');
      await expect(applySyncReconciliation(engine, proposal.operationId, { repoPath: repo })).rejects.toThrow(/lacks can_apply_reconciliation/);

      const preApply = await engine.executeRaw<{ deleted_at: string | null }>(
        `SELECT deleted_at FROM pages WHERE source_id = 'default' AND slug = 'notes/alpha'`,
      );
      expect(preApply[0].deleted_at).toBeNull();

      await grantCurrentUser('can_apply_reconciliation');
      await engine.executeRaw(
        `UPDATE sync_reconciliation_audit SET result = 'approved', authorized = true WHERE operation_id = $1`,
        [proposal.operationId],
      );
      const applied = await applySyncReconciliation(engine, proposal.operationId, { repoPath: repo });
      expect(applied).toEqual(['notes/alpha']);
      const postApply = await engine.executeRaw<{ deleted_at: string | null }>(
        `SELECT deleted_at FROM pages WHERE source_id = 'default' AND slug = 'notes/alpha'`,
      );
      expect(postApply[0].deleted_at).not.toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('gbrain capabilities exposes exact sync-safety tokens from schema support', async () => {
    const fresh = new PGLiteEngine();
    await fresh.connect({});
    try {
      await fresh.initSchema();
      const caps = await getCapabilities(fresh) as any;
      expect(caps.sync_safety.required_tokens).toEqual([
        'explicit-source',
        'root-identity',
        'reconciliation-manifest',
        'db-roles',
        'schema-v2',
      ]);
      expect(caps.sync_safety.capabilities.reconciliation_manifest).toBe(true);
      expect(caps.sync_safety.capabilities.db_roles).toBe(false);
      expect(caps.sync_safety.supported).toBe(false);
    } finally {
      await fresh.disconnect();
    }
  });

  test('reconciliation threshold rejection aborts without checkpointing or tombstoning', async () => {
    const repo = makeRepo(3);
    try {
      await setSourcePath('default', repo);
      const first = await performSync(engine, {
        repoPath: repo,
        sourceId: 'default',
        explicitSourceArg: true,
        sourceResolutionTier: 'flag',
        noPull: true,
        noEmbed: true,
        noExtract: true,
      });
      expect(first.status).toBe('first_sync');

      await grantCurrentUser('can_normal_sync');
      for (const name of ['alpha', 'extra-1']) rmSync(join(repo, 'notes', `${name}.md`));
      git(repo, 'git add -A');
      git(repo, 'git commit -q -m remove-too-many');

      await expect(performSync(engine, {
        repoPath: repo,
        sourceId: 'default',
        explicitSourceArg: true,
        sourceResolutionTier: 'flag',
        noPull: true,
        noEmbed: true,
        noExtract: true,
      })).rejects.toThrow(/exceeds aggregate thresholds/);

      const rows = await engine.executeRaw<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = 'default' AND deleted_at IS NOT NULL`,
      );
      expect(Number(rows[0].n)).toBe(0);

      const audits = await engine.executeRaw<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM sync_reconciliation_audit WHERE result = 'applied'`,
      );
      expect(Number(audits[0].n)).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
