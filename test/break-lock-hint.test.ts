/**
 * breakLockHintFor — recovery-command hint for stale/busy locks.
 *
 * Regression guard for the 2026-06-10 cycle-lock incident: doctor's
 * `stale_locks` check and performSync's "another sync is in progress"
 * message both used to hard-code the `gbrain-sync:<source>` shape and fall
 * back to a bare `gbrain sync --break-lock` for every other lock id. That
 * bare hint resolves to `gbrain-sync:default` — the WRONG lock for a stale
 * `gbrain-cycle:default` row. The helper now emits a correct, copy-pasteable
 * recovery command for every lock id shape in `gbrain_cycle_locks`.
 */
import { describe, test, expect } from 'bun:test';
import { breakLockHintFor } from '../src/core/db-lock.ts';

describe('breakLockHintFor', () => {
  test('sync locks keep the familiar --source spelling (back-compat)', () => {
    expect(breakLockHintFor('gbrain-sync:default')).toBe(
      'gbrain sync --break-lock --source default',
    );
    expect(breakLockHintFor('gbrain-sync:studiovault')).toBe(
      'gbrain sync --break-lock --source studiovault',
    );
  });

  test('per-source cycle locks route through generic --lock (the incident case)', () => {
    // This is the exact lock id from the 2026-06-10 forensics. The OLD hint
    // would have produced `gbrain sync --break-lock` → gbrain-sync:default,
    // which is NOT this lock. The new hint targets the literal id.
    expect(breakLockHintFor('gbrain-cycle:default')).toBe(
      'gbrain sync --break-lock --lock gbrain-cycle:default',
    );
  });

  test('legacy global cycle lock routes through --lock', () => {
    expect(breakLockHintFor('gbrain-cycle')).toBe(
      'gbrain sync --break-lock --lock gbrain-cycle',
    );
  });

  test('migrate / reindex / embed-backfill locks route through --lock', () => {
    expect(breakLockHintFor('gbrain-migrate:postgres')).toBe(
      'gbrain sync --break-lock --lock gbrain-migrate:postgres',
    );
    expect(breakLockHintFor('gbrain-reindex-multimodal')).toBe(
      'gbrain sync --break-lock --lock gbrain-reindex-multimodal',
    );
    expect(breakLockHintFor('embed-backfill:default')).toBe(
      'gbrain sync --break-lock --lock embed-backfill:default',
    );
  });

  test('the emitted --lock hint round-trips: the argument is the literal lock id', () => {
    // Whatever lock id goes in, the `--lock <id>` token must carry it
    // verbatim so `gbrain sync --break-lock --lock <id>` targets the same row.
    for (const id of ['gbrain-cycle:default', 'gbrain-cycle', 'gbrain-migrate:postgres']) {
      const hint = breakLockHintFor(id);
      const m = hint.match(/--lock (\S+)$/);
      expect(m).not.toBeNull();
      expect(m![1]).toBe(id);
    }
  });
});
