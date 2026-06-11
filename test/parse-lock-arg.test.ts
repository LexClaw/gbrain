/**
 * parseLockArg — validation for `gbrain sync --break-lock --lock <id>`.
 *
 * Regression guard for the 2026-06-10 Leigh-review bug. The original inline
 * parse `args.find((a, i) => args[i - 1] === '--lock')` silently accepted three
 * dangerous shapes for an operator-facing destructive recovery command:
 *
 *   1. `--lock` as the LAST token  → find() returns undefined, which is
 *      indistinguishable from "no --lock flag", so the CLI fell through to the
 *      DEFAULT gbrain-sync:default lock. The operator named one lock and broke
 *      another.
 *   2. `--lock --force`            → find() returns '--force', so it would try
 *      to break a lock literally named "--force".
 *   3. `--lock ''` (empty value)   → find() returns '', so runBreakLock targets
 *      an empty lock id.
 *
 * parseLockArg distinguishes "absent" from "present-but-invalid" so the CLI can
 * (a) fall through to --source/--all when absent, and (b) hard-error with a
 * clear message when present-but-invalid — never silently break a different
 * lock than the one named.
 */
import { describe, test, expect } from 'bun:test';
import { parseLockArg } from '../src/core/db-lock.ts';

describe('parseLockArg', () => {
  test('absent: no --lock flag at all returns present:false', () => {
    const r = parseLockArg(['--break-lock', '--source', 'default']);
    expect(r.present).toBe(false);
    expect(r.value).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  test('absent on an empty argv', () => {
    expect(parseLockArg([]).present).toBe(false);
  });

  test('valid: --lock with a concrete lock id returns the literal value', () => {
    const r = parseLockArg(['--break-lock', '--lock', 'gbrain-cycle:default']);
    expect(r.present).toBe(true);
    expect(r.value).toBe('gbrain-cycle:default');
    expect(r.error).toBeUndefined();
  });

  test('valid: bare (sourceless) lock id', () => {
    const r = parseLockArg(['--break-lock', '--lock', 'gbrain-cycle']);
    expect(r.present).toBe(true);
    expect(r.value).toBe('gbrain-cycle');
    expect(r.error).toBeUndefined();
  });

  test('valid: --lock id followed by more flags still resolves the id', () => {
    const r = parseLockArg(['--break-lock', '--lock', 'gbrain-migrate:postgres', '--json']);
    expect(r.present).toBe(true);
    expect(r.value).toBe('gbrain-migrate:postgres');
  });

  // ---- the three bug cases Leigh flagged ----

  test('INVALID: --lock as the last token (no value) errors, does NOT fall through', () => {
    const r = parseLockArg(['--break-lock', '--lock']);
    // Critical: present:true so the CLI errors instead of treating it as
    // "no --lock" and silently breaking the default sync lock.
    expect(r.present).toBe(true);
    expect(r.value).toBeUndefined();
    expect(r.error).toBeDefined();
  });

  test('INVALID: --lock followed by another flag is rejected (no "--force" lock id)', () => {
    const r = parseLockArg(['--break-lock', '--lock', '--force']);
    expect(r.present).toBe(true);
    expect(r.value).toBeUndefined();
    expect(r.error).toContain('--force');
  });

  test('INVALID: --lock with an explicit empty value is rejected', () => {
    const r = parseLockArg(['--break-lock', '--lock', '']);
    expect(r.present).toBe(true);
    expect(r.value).toBeUndefined();
    expect(r.error).toBeDefined();
  });

  test('INVALID: --lock with a whitespace-only value is rejected', () => {
    const r = parseLockArg(['--break-lock', '--lock', '   ']);
    expect(r.present).toBe(true);
    expect(r.value).toBeUndefined();
    expect(r.error).toBeDefined();
  });

  test('INVALID: --lock followed by --source is treated as a missing value (flag, not id)', () => {
    // --source is a flag; it must not become the lock id. The mutual-exclusion
    // check happens downstream, but the value itself is invalid first.
    const r = parseLockArg(['--break-lock', '--lock', '--source', 'default']);
    expect(r.present).toBe(true);
    expect(r.value).toBeUndefined();
    expect(r.error).toContain('--source');
  });
});
