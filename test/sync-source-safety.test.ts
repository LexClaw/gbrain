import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { assertSyncSourceRootGuard, performSync } from '../src/commands/sync.ts';

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

function makeRepo(): string {
  const repo = tempDir('gbrain-sync-source-safety');
  git(repo, 'git init -q');
  git(repo, 'git config user.email test@example.com');
  git(repo, 'git config user.name Test');
  mkdirSync(join(repo, 'notes'), { recursive: true });
  writeFileSync(join(repo, 'notes', 'alpha.md'), '# Alpha\n');
  git(repo, 'git add notes/alpha.md');
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

describe('sync source safety guard', () => {
  test('rejects unqualified repo override in a multi-source brain', async () => {
    const repoA = tempDir('gbrain-source-a');
    const repoB = tempDir('gbrain-source-b');
    await setSourcePath('default', repoA);
    await addSource('source-b', repoB);

    await expect(assertSyncSourceRootGuard(engine, { repoPath: repoB }, repoB))
      .rejects.toThrow(/--source is required/);
  });

  test('rejects explicit source when repo root does not match registered local_path', async () => {
    const repoA = tempDir('gbrain-source-a');
    const repoB = tempDir('gbrain-source-b');
    await setSourcePath('default', repoA);

    await expect(assertSyncSourceRootGuard(engine, {
      repoPath: repoB,
      sourceId: 'default',
      explicitSourceArg: true,
      sourceResolutionTier: 'flag',
    }, repoB)).rejects.toThrow(/root mismatch/);
  });

  test('allows explicit compatible source root', async () => {
    const repoA = tempDir('gbrain-source-a');
    await setSourcePath('default', repoA);

    await expect(assertSyncSourceRootGuard(engine, {
      repoPath: repoA,
      sourceId: 'default',
      explicitSourceArg: true,
      sourceResolutionTier: 'flag',
    }, repoA)).resolves.toBeUndefined();
  });

  test('incremental sync tombstones deleted files instead of hard-deleting page rows', async () => {
    const repo = makeRepo();
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

      rmSync(join(repo, 'notes', 'alpha.md'));
      git(repo, 'git add -A');
      git(repo, 'git commit -q -m remove-alpha');

      const second = await performSync(engine, {
        repoPath: repo,
        sourceId: 'default',
        explicitSourceArg: true,
        sourceResolutionTier: 'flag',
        noPull: true,
        noEmbed: true,
        noExtract: true,
      });
      expect(second.deleted).toBe(1);

      const rows = await engine.executeRaw<{ slug: string; deleted_at: string | null }>(
        `SELECT slug, deleted_at FROM pages WHERE source_id = 'default' AND slug = 'notes/alpha'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].deleted_at).not.toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
