# GBrain Fact Mining Fix — Deliverable

**Card:** kn7b2nt3y66wp59ppgs4xd92k588ags8
**Branch:** `reid-facts-fix` (worktree `/tmp/gbrain-reid-facts-fix`, fork `~/gbrain` LexClaw/master)
**Date:** 2026-06-09

## Root cause (TWO stacked bugs, not the sourceId theory)

Fact mining produced 0 output for two independent reasons:

1. **Allowlist drop.** `session` was missing from `ALLOWED_TYPES` in the extract command AND the Minion job handler autopilot runs nightly. Sessions are 7,561 of 7,636 eligible pages — the entire backlog was filtered out before extraction. Runtime config already had `session`; the code allowlist overrode it.

2. **Parser blind to session format.** Even with `session` allowed, the conversation parser returned `no_match` on Hermes session-archive bodies (`**USER **` / `**ASSISTANT **` role headings), yielding 0 segments → 0 facts.

A third, environmental issue surfaced during proof: the brain's `config.json` had **no `chat_model`** set, so `extract-conversation-facts` failed its `isAvailable('chat')` preflight. Fixed by `gbrain config set chat_model anthropic:claude-sonnet-4-6`.

## Fixes

**Commit 5be08559** — `fix(facts): add 'session' to extract-conversation-facts allowlist (5 files)`
- `src/commands/extract-conversation-facts.ts`, `src/commands/jobs.ts`, `src/commands/sources.ts`, `src/commands/doctor.ts`, `src/core/cycle/conversation-facts-backfill.ts`
- Test proving `--types session` accepted.

**Commit 0b4d6b71** — `fix(parser): recognize Hermes session-archive format`
- New builtin pattern `hermes-session-role-heading` matching `**USER **`, `**ASSISTANT**`, `**USER [timestamp]**`, and USER/ASSISTANT/SYSTEM/TOOL/DEVELOPER labels.
- Added optional per-pattern `min_acceptance_score` (0.01) so sparse role-delimiters in long bodies clear the density floor; skips `---` separators.
- Parser probe `sessions/2026-05-17-1803-45cd97`: `no_match` → `message_count=22`.

**Config (live brain):** `chat_model = anthropic:claude-sonnet-4-6` set in `~/.gbrain/config.json`.

## Proof (live DB, postgres://localhost:5432/gbrain)

| Run | Slug | Result | facts table |
|---|---|---|---|
| Thin session | 2026-05-17-1803 | 1 fact / 1 segment | 9 → 10 |
| Rich session | 2026-05-14-0946 | **30 facts / 7 segments** | 10 → **41** |

Full pipeline verified end-to-end: allowlist → parser (7 segments) → chat extraction ($0.08) → 30 facts in live table.

## CI

- `tsc --noEmit`: clean (exit 0)
- `bun test parse.test.ts extract-conversation-facts.test.ts` (DATABASE_URL unset, CI-style): **96 pass, 0 fail**
- Docker E2E phase NOT run (Docker daemon not running locally). Changes are parser/allowlist logic, fully covered by unit tests. Recommend E2E on next Docker-available CI run before merge to master.

## Next step (re-mining, per TJ decision)

The corrected nightly `conversation_facts_backfill` phase (enabled, `types` includes `session`) will now grind the 7,561-session backlog at ~$5/night and self-complete over ~2 weeks. **No manual restore of `facts_backup_20260606`** — re-mine fresh, as directed.

## Outstanding

- Merge `reid-facts-fix` → master after a Docker-available E2E pass.
- The duplicate in-review card "Conversation format coverage improvement (82% no-match)" is the SAME root cause as bug 2 — fold/close it against this card once Convex `tasks:getAll` recovers (it was hard-erroring during this session).
