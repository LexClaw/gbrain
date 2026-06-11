# Cycle-lock break-lock fix — 2026-06-10 (Grant, Kanban t_7f9b21cd)

Follow-up to t_48555205 / MC kn7dcpye. Fixes the wrong `stale_locks` doctor
recovery hint for `gbrain-cycle:<source>` locks.

## Root cause

`gbrain_cycle_locks` is a SHARED table holding many lock-id shapes:
- `gbrain-sync:<source>`      performSync writer window
- `gbrain-cycle`              legacy global cycle lock
- `gbrain-cycle:<source>`     per-source cycle lock (autopilot / `gbrain jobs work`)
- `gbrain-migrate:<db>`       migration lock
- `gbrain-reindex-multimodal` reindex lock
- `embed-backfill:<source>`   embed-backfill job lock

Two surfaces hard-coded the `gbrain-sync:<source>` shape and fell back to a
bare `gbrain sync --break-lock` for every other id:
- `doctor.ts checkStaleLocks` (the warning the operator sees)
- `sync.ts formatLockBusyMessage` ("another sync is in progress")

`gbrain sync --break-lock` with no scope resolves to `gbrain-sync:default`.
For the live stale `gbrain-cycle:default` row (pid 32719, a live `gbrain jobs
work` whose 5-min TTL expired between refreshes), the hint pointed at a
DIFFERENT lock. Following it returned "nothing to break" while the real row
persisted. No supported recovery path existed for cycle/migrate/reindex locks.

## Lock-ownership audit (acceptance item 1)

The stale `gbrain-cycle:default` row is held by a LIVE holder. Cycle locks use
a 5-min TTL (`LOCK_TTL_MINUTES=5`, dropped from 30 in v0.41.19.0) refreshed
every 30s by `yieldDuringPhase`. Between phase boundaries the TTL can lapse
while the holder is still alive and healthy — so `ttl_expires_at < NOW()` is
NOT proof of a dead holder for cycle locks. Force-deleting the row mid-run
would let a second cycle enter against a live writer. Per acceptance, the live
row was NOT touched. The correct recovery is the SAME safe break worker used
for sync locks: it refuses a live local holder (`pid_alive`) and only clears
TTL-expired-AND-pid-dead (or `--max-age` wedged-but-alive) rows. `--force` is
the documented escape hatch.

## Fix (acceptance items 2-4)

1. `src/core/db-lock.ts` — new `breakLockHintFor(lockId)` helper. Single source
   of truth: sync locks keep `--source <s>`; everything else routes through a
   new generic `--lock <id>` flag.
2. `src/commands/doctor.ts checkStaleLocks` — uses `breakLockHintFor`.
3. `src/commands/sync.ts formatLockBusyMessage` — uses `breakLockHintFor`.
4. `src/commands/sync.ts` break-lock dispatch — new `--lock <id>` flag breaks
   ANY lock id through the EXISTING `runBreakLock` safe worker (cross-host
   refusal, ttl-expired/pid-dead guard, `--max-age`, `--force`). Mutually
   exclusive with `--source` and `--all`; absent rows exit 0.
5. `gbrain sync --help` documents `--break-lock` and `--lock`.

No unsafe force-delete of live holders: the safe path is unchanged; `--lock`
reuses it verbatim. Live holder is only cleared via explicit `--force-break-lock`.

## Verification

- `bun test test/break-lock-hint.test.ts test/doctor-stale-locks-hint.test.ts
  test/db-lock-inspect.test.ts test/sync-break-lock-all.test.ts` → 32 pass / 0 fail.
- `bunx tsc --noEmit` clean on all touched files.
- Live `gbrain doctor --json` now emits:
  `gbrain-cycle:default (pid 32719 ...) → gbrain sync --break-lock --lock gbrain-cycle:default`
  (was the wrong bare `gbrain sync --break-lock` before).
- E2E (`test/e2e/sync-lock-recovery.test.ts`, +6 cases) self-skips without
  DATABASE_URL; needs a pgvector container in CI to execute.

## Tests added

- `test/break-lock-hint.test.ts` — hint helper, all 6 lock-id shapes incl. the incident case.
- `test/doctor-stale-locks-hint.test.ts` — PGLite end-to-end checkStaleLocks hint per shape.
- `test/e2e/sync-lock-recovery.test.ts` — 6 new E2E cases for `--lock` break/refuse/force/guards.

## Reviewer note on the shared workspace

This is a `dir` workspace = the real `/Users/TJ/gbrain` repo on `master`, which
already carried UNRELATED uncommitted changes (resolver_health rework, skills
edits, a sync-anchor freshness hunk in performSyncInner). I did NOT commit. My
edits live in the working tree. A scoped, foreign-hunk-free patch of ONLY my 7
hunks is at:
`reports/maintenance/gbrain-score-to-green/cycle-lock-breaklock-fix-2026-06-10.patch`
Review that patch, not `git diff`, to see my changes in isolation.

## Revision 2 — 2026-06-10 (addressing Leigh CHANGES_REQUIRED)

Leigh's review caught a real CLI parsing bug in the `--lock` handling. The
original inline parse was:

```ts
const lockArg = args.find((a, i) => args[i - 1] === '--lock');
if (lockArg !== undefined) { ... }
```

`find` returns the token *after* `--lock`, which silently accepted three
dangerous shapes for an operator-facing destructive recovery command:

1. `gbrain sync --break-lock --lock` (flag is the last token): `find` returns
   `undefined`, indistinguishable from "no --lock at all" → the CLI fell
   through to the DEFAULT `gbrain-sync:default` lock. The operator typed
   `--lock` and broke a DIFFERENT lock than they named.
2. `gbrain sync --break-lock --lock --force`: `find` returns `'--force'` → it
   would attempt to break a lock literally named "--force".
3. `gbrain sync --break-lock --lock ''`: `find` returns `''` →
   `runBreakLock(engine, '', ...)` targets an empty lock id.

### Fix

Extracted a pure, unit-tested resolver `parseLockArg(args)` into
`src/core/db-lock.ts` (sibling to `breakLockHintFor`). It returns
`{ present, value?, error? }`:

- `present:false` → no `--lock` flag; CLI falls through to `--source`/`--all`.
- `present:true` + `error` → `--lock` given but value missing / empty /
  whitespace-only / flag-shaped (`startsWith('-')`). CLI prints `error` and
  `process.exit(1)`.
- `present:true` + `value` → validated non-empty lock id.

`sync.ts` now branches on `parseLockArg` instead of the raw `find`. The
error-exit happens BEFORE the valid path, so the previous silent fall-through
to the default sync lock is impossible. `--source`/`--all` mutual exclusion is
unchanged (still enforced in the `present:true` branch). Note: a `--lock`
immediately followed by `--source` is now rejected at the value-validation step
(value is flag-shaped) rather than reaching the mutual-exclusion check — either
way it errors, never silently breaks the wrong lock.

### Tests added (rev 2)

- `test/parse-lock-arg.test.ts` (NEW, 10 cases): absent / empty-argv / valid
  (concrete id, bare id, id-then-more-flags) plus the four invalid shapes
  (missing value, flag-shaped value, empty value, whitespace-only value, and
  `--lock --source`). Each invalid case asserts `present:true` (so the CLI
  errors rather than falling through) and `value` undefined.

### Verification status (rev 2) — IMPORTANT

The terminal/shell was hard-blocked for this entire retry session (every shell
command, including a bare `echo`, returned `BLOCKED: Webhook curl POST is not
allowlisted` — an environment fault, not a code fault). Therefore I could NOT
run `bun test` or `bunx tsc --noEmit` live this run.

What I *could* verify:
- LSP diagnostics on both edited files (`db-lock.ts`, `sync.ts`) and the new
  test are CLEAN after the final edits (the flat `LockArgResult` interface
  removed the only narrowing-related TS errors).
- Read-back of the wired `sync.ts` block (lines 2204-2247) confirms the
  error-exit precedes the valid path and `lockArgResult.value!` is only reached
  after the `present && error` guard.

A reviewer with a working shell should run, to close this out:
```
cd /Users/TJ/gbrain
bunx tsc --noEmit            # expect clean on db-lock.ts / sync.ts / parse-lock-arg.test.ts
bun test test/parse-lock-arg.test.ts test/break-lock-hint.test.ts test/doctor-stale-locks-hint.test.ts
```
The pgvector E2E (`test/e2e/sync-lock-recovery.test.ts`) remains
blocked-until-CI as before.

### Changed files (rev 2, cumulative)

- `src/core/db-lock.ts` — added `LockArgResult` + `parseLockArg` (rev 2).
- `src/commands/sync.ts` — `--lock` branch now uses `parseLockArg` (rev 2).
- `test/parse-lock-arg.test.ts` — NEW (rev 2).
- (rev 1 unchanged: `breakLockHintFor`, doctor/sync hint wiring,
  `break-lock-hint.test.ts`, `doctor-stale-locks-hint.test.ts`,
  `test/e2e/sync-lock-recovery.test.ts`.)
