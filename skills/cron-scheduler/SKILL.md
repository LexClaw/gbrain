---
name: cron-scheduler
version: 1.0.0
description: |
  Schedule management with staggering, quiet hours, and wake-up override.
  Validates schedules, prevents collisions, and gates delivery during quiet hours.
triggers:
  - "schedule a job"
  - "cron"
  - "quiet hours"
  - "what jobs are running"
tools:
  - search
  - get_page
  - put_page
mutating: true
---

# Cron Scheduler

> **Convention:** See `skills/conventions/test-before-bulk.md` — test every cron job on 3-5 items first.

## Contract

This skill guarantees:
- Schedule staggering: max 1 job per 5-minute slot, no collisions
- Quiet hours gating: timezone-aware, with user-awake override
- Thin job prompts: jobs say "Read skills/X/SKILL.md and run it" (no inline 3000-word prompts)
- Idempotency: jobs can run twice without duplicate side effects
- Results saved as reports: `reports/{job-name}/{YYYY-MM-DD-HHMM}.md`

## Phases

1. **Define job.** Name, schedule (cron expression), skill to run, timeout.
2. **Validate schedule.** Check no collision with existing jobs (5-minute offset rule).
   - Slots: :05, :10, :15, :20, :25, :30, :35, :40, :45, :50
   - If collision detected, suggest the next available slot
3. **Check quiet hours.** Default: 11 PM - 8 AM local time.
   - Override: user-awake flag (if user is active, quiet hours suspended)
   - During quiet hours: save output to held queue
   - Morning contact releases the backlog
4. **Register with host scheduler.** OpenClaw cron, Railway cron, crontab, or process manager. **Each registered entry should execute via Minions, not `agentTurn`.** See `skills/conventions/cron-via-minions.md` for the rewrite pattern (PGLite uses `--follow`, Postgres uses fire-and-forget + `--idempotency-key` on the cycle slot). GBrain's v0.11.0 migration auto-rewrites entries for built-in handlers; host-specific handlers need a code-level registration per `docs/guides/plugin-handlers.md`.
5. **Write thin prompt.** Job prompt is one line: "Read skills/{name}/SKILL.md and run it."

## Idempotency Requirement

Every cron job MUST be idempotent:
- Running the same job twice produces the same result (no duplicate pages, no duplicate timeline entries)
- Use checkpoint state files to track progress and resume interrupted runs
- Check for existing output before creating new output

## Output Format

Job configuration saved. Report: "Job '{name}' scheduled at {cron expression}. Next run: {time}."

## Multi-source brains: use `sync --all`, not per-source entries

When the brain has 2+ active sources (anything `gbrain sources list` shows
with a non-null `local_path` that isn't archived), use one consolidated
cron line instead of N per-source entries.

**Preferred (multi-source)**:

```cron
*/5 * * * * gbrain sync --all --parallel 4 --workers 4 --skip-failed
```

This replaces N per-source lines AND auto-picks-up future sources without
a crontab edit. Concurrency budget: `parallel × workers × 2 ≈ 32`
connections during the wave (each per-file worker opens its own
2-connection pool). Stay under your Postgres `max_connections` setting.

**Avoid (legacy)**: separate `gbrain sync --source default` and
`gbrain sync --source zion-brain` entries staggered by 5 minutes. They
require manual deconfliction every time a new source is added, and a
slow source can race a fast source on the legacy global `gbrain-sync`
lock (v0.40.3.0+ uses per-source `gbrain-sync:<sourceId>` locks but the
per-source cron pattern doesn't benefit from the parallelism that
`--all --parallel` actually delivers).

`gbrain doctor` surfaces the recommended line as a `sync_consolidation`
check whenever it detects 2+ active sources. Paste-ready from there.

## Cost/model-routing audit pattern

When auditing scheduled jobs for cost, inventory **all scheduler surfaces**, not only Hermes `jobs.json`: Hermes cron jobs, user `crontab`, `~/Library/LaunchAgents`, Convex crons, GBrain autopilot, PM2/daemon loops, and the skill corpus that creates/feeds scheduled work. Classify each job by execution shape before changing models:

- `no_agent` / deterministic script-only: already LLM-free; preserve or convert similar mechanical jobs to `--no-agent` after one manual run.
- Mechanical internal reports, health checks, shrink alarms, backups: candidates for cheap models or no-agent wrappers.
- TJ-facing briefs, strategic reviews, identity/memory synthesis, security reviews, coding/review dispatch: keep on stronger models or shadow-test before downgrading.
- SIE/ALE/MC/routing/board-dependent jobs: hold model/no-agent conversion while the board/source-of-truth flow is actively migrating. They may look mechanically cheap, but their output contract and owner semantics are moving targets.

Prefer strong planning/review models and cheap execution models: write a high-quality plan/review first, then route routine execution and background crons to cheaper models or no-agent scripts. Do not use raw job count as the goal. First build liveness/owner/output metadata, then retire only after soak/dead-man proof and explicit approval for deletes/disablements.

### Ghost crontab classification pattern

When `crontab -l` points at missing scripts, do not immediately delete the line or blindly recreate the script. Classify first:

1. Confirm it is an active failure, not a stale hypothetical: inspect the redirected log and look for repeated `can't open file` / missing-path errors at the scheduled cadence.
2. Search only the canonical roots first (`~/hermes-workspace/Lex-Workspace/scripts`, `~/.hermes/scripts`, relevant repo roots). Avoid broad whole-home recursive searches unless necessary.
3. If the same script exists under the canonical workspace, classify as **path-drift candidate**. Stage a narrow path rewrite or migration proposal, but verify the script still runs against current data before editing crontab.
4. If the script is absent, classify as **rebuild-or-retire candidate**. Check prior cron audits/plans and current engine schema before recreating it; missing scripts are often migration-loss artifacts whose old behavior overlaps newer SIE/GBrain/board-native flows.
5. For jobs tied to SIE/ALE/MC ownership or card state, hold any rebuild/retirement mutation behind the active board/source-of-truth migration unless TJ approves a narrow exception.
6. Record rollback as restore-from-crontab-backup / uncomment-line, but remember that a rollback path is not permission to mutate without the approval gate.

## Anti-Patterns

- Scheduling jobs at the same minute (:00 for everything)
- Inline 3000-word prompts in cron jobs (use skill file references)
- Running cron jobs without testing on 3-5 items first
- Jobs that produce different output on re-run (not idempotent)
- Sending notifications during quiet hours (save to held queue instead)
- **Scheduling a cron interval shorter than the job's wall-clock runtime, with no lockfile.** Classic shape: a queue-drainer cron at `*/15 * * * *` where each queue item takes 5-10 minutes of subagent or subprocess work, and the job loops over N items per tick. The next cron tick fires while the previous instance is still running. Without a lockfile, you get N parallel instances racing on the same queue, each one consuming items the other expected to find. Symptom: queue depth drops in chunks, some items processed multiple times, some skipped, log timestamps interleave from parallel processes. Lex hit this 2026-05-15 on the youtube-channel-to-brain enrichment cron (15-min interval, 5-10 min per video, 30 items in queue). Fix: every long-running drainer cron MUST acquire a lock at the top of its wrapper script and exit 0 if the lock is held. On Linux, `flock` is fine: `exec 200>/tmp/job.lock; flock -n 200 || exit 0`. On macOS, do not assume `flock` exists; use an atomic lock directory fallback:
  ```bash
  LOCKDIR="/tmp/job-name.lockdir"
  if ! mkdir "$LOCKDIR" 2>/dev/null; then exit 0; fi
  trap 'rmdir "$LOCKDIR" 2>/dev/null || true' EXIT
  ```
  Verify the lock is respected by running two ticks back-to-back manually and confirming the second exits immediately. See also: the wrapper script pattern in `~/.hermes/scripts/` should always do this for any job that loops over N items.
- Separate per-source `gbrain sync --source <id>` cron entries when
  `gbrain sync --all --parallel N --workers N` would replace them with
  one line that auto-picks-up future sources.
