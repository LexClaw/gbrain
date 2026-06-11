/**
 * doctor `stale_locks` check — emits the CORRECT recovery hint per lock id.
 *
 * Regression guard for the 2026-06-10 cycle-lock incident. Before the fix,
 * checkStaleLocks hard-coded the `gbrain-sync:<source>` shape and fell back
 * to a bare `gbrain sync --break-lock` for every other id — which targets
 * `gbrain-sync:default`, the WRONG lock for a stale `gbrain-cycle:default`
 * row. This test inserts each lock-id shape directly and asserts the hint
 * line names a recovery command that actually targets THAT lock.
 *
 * Runs hermetically against PGLite (no Postgres container / DATABASE_URL).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { checkStaleLocks } from '../src/commands/doctor.ts';

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
  await (engine as any).db.query('DELETE FROM gbrain_cycle_locks', []);
});

async function insertStaleLock(id: string, pid: number): Promise<void> {
  await (engine as any).db.query(
    `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
     VALUES ($1, $2, $3, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '30 minutes')`,
    [id, pid, 'test-host'],
  );
}

describe('checkStaleLocks recovery hints', () => {
  test('ok when no stale rows', async () => {
    const check = await checkStaleLocks(engine);
    expect(check.status).toBe('ok');
  });

  test('cycle lock → --lock hint (the incident: NOT a bare --break-lock)', async () => {
    await insertStaleLock('gbrain-cycle:default', 32719);
    const check = await checkStaleLocks(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('gbrain-cycle:default');
    // The fix: hint must name the literal lock id via --lock.
    expect(check.message).toContain('gbrain sync --break-lock --lock gbrain-cycle:default');
    // Regression: the OLD buggy hint (bare --break-lock with no scope, or a
    // --source pointing at the wrong sync lock) must NOT appear for a cycle row.
    expect(check.message).not.toMatch(/gbrain-cycle:default.*--source/);
  });

  test('sync lock → --source hint (back-compat preserved)', async () => {
    await insertStaleLock('gbrain-sync:studiovault', 12345);
    const check = await checkStaleLocks(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('gbrain sync --break-lock --source studiovault');
  });

  test('legacy + migrate lock ids both get --lock hints', async () => {
    await insertStaleLock('gbrain-cycle', 111);
    await insertStaleLock('gbrain-migrate:postgres', 222);
    const check = await checkStaleLocks(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('gbrain sync --break-lock --lock gbrain-cycle');
    expect(check.message).toContain('gbrain sync --break-lock --lock gbrain-migrate:postgres');
  });
});
