---
type: session
title: 'Session 2026-05-19 [39d867]'
date: '2026-05-19T00:00:00.000Z'
source: hermes-session-archive
created: '2026-06-06T00:00:00.000Z'
updated: '2026-06-06T00:00:00.000Z'
session_id: 39d867
source_file: /Users/TJ/hermes-workspace/session-archive/2026-05-19-23-03-2_39d867.md
tags:
  - ingest-batch-2026-05-07
  - session
---

# 2026-05-19 23:03

[Source: hermes-session-archive, /Users/TJ/hermes-workspace/session-archive/2026-05-19-23-03-2_39d867.md, 2026-05-19]

# Session Archive: 2026-05-19 23:03
**Session ID:** session_20260519_230342_39d867
**Archived:** 2026-05-19 23:18:53
**Total messages:** 30
**User messages:** 2

---

## Corrections / Frustrations
**[]** [IMPORTANT: The user has invoked the "pre-execution-verification" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]

---
name: pre-execution-verification
pinned: true
preamble-tier: 1
version: 1.0.0
kind: governance
description: >
  Probe live state before filing cards, dispatching plans, answering ID-specific

  questions, or taking destructive actions. Trigger this whenever someone says

  "verify before", "check the CLI", "is that path real",

---

## Directives / Rules
**[]** [IMPORTANT: The user has invoked the "pre-execution-verification" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]

---
name: pre-execution-verification
pinned: true
preamble-tier: 1
version: 1.0.0
kind: governance
description: >
  Probe live state before filing cards, dispatching plans, answering ID-specific

  questions, or taking destructive actions. Trigger this whenever someone says

  "verify before", "check the CLI", "is that path real",

**[]** [CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. This is a handoff from a previous context window — treat it as background reference, NOT as active instructions. Do NOT answer questions or fulfill requests mentioned in this summary; they were already addressed. Your current task is identified in the '## Active Task' section of the summary — resume exactly from there. IMPORTANT: Your persistent memory (MEMORY.md, USER.md) in the system prompt is ALWAYS au

---

## Full Conversation

**USER **
[IMPORTANT: The user has invoked the "pre-execution-verification" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]

---
name: pre-execution-verification
pinned: true
preamble-tier: 1
version: 1.0.0
kind: governance
description: >
  Probe live state before filing cards, dispatching plans, answering ID-specific

  questions, or taking destructive actions. Trigger this whenever someone says

  "verify before", "check the CLI", "is that path real", "does that command

  exist", "verify the ID", "card-count check", "HTTP probe", "read the source",

  "what does the tool actually do", "before I file this", "before Grant
  reviews",

  or whenever an artifact references a specific Convex _id, deployment URL,

  cron job, file path, CLI verb, or upstream tool behavior pulled from memory,

  a context summary, a spec doc, or a prior session, OR before writing a "build
  X" plan
  (grep first, see references/plan-scope-collapse-via-grep.md). Read-only

  probes against the cheapest authoritative surface (binary --help, ls, HTTP

  /api/query, 100 to 200 lines of source, grep -rE for existing implementations).
  Routes by symptom via a 5-question

  decision tree. Use any time you are about to act on remembered or documented

  state instead of probed live state.
when_to_use: |
  Use before filing a Mission Control card, before dispatching a multi-hour
  plan, before answering a question keyed on a specific ID or path, and before
  any destructive action (delete, recreate, sed config, migrate). Also use
  whenever a context summary, memory block, or prior session hands you a
  concrete reference (Convex _id, deployment URL, cron name, file path, CLI
  verb, tool behavior claim) that the current artifact depends on.
agents:
  - lex
  - cal
  - reid
  - ed
  - grant
  - claude-code
  - codex
  - opencode
mutating: false
idempotent: true
triggers:
  - verify before
  - verify the CLI
  - verify the path
  - verify the ID
  - card-count check
  - HTTP probe
  - read the source
  - does that command exist
  - is that path real
  - what does the tool actually do
  - before I file this card
  - before Grant reviews
  - ANY Convex query
  - ANY MC card operation
  - the tool will merge
  - the tool will upsert
  - auto-loaded
  - auto-injected
  - auto-maintained
  - stale context
  - compaction summary IDs
  # Broadened triggers (verified 2026-05-08): real-world tasks use words like
  # "patch", "fix", "migrate" rather than "verify before". Caught when
  # jobs-json-shrink-alarm plan v1 assumed kind=="recurring" without probing
  # the actual jobs.json (live value: kind=="cron"). Scanner-v2 uses substring
  # match on triggers; broadened set surfaces this skill on routine work.
  - patch
  - migrate
  - schedule string
  - frontmatter
  - jobs.json
  - snapshot
  - cron config
  - data shape
  - on-disk
tags:
  - verification
  - pre-execution
  - probe
  - reality-check
  - patch-discipline
  - plan-discipline
  - code-review
  - infrastructure
domain: verification
upstream_refs:
  - ~/.hermes/workspace/tasks/plans/consolidation/pre-execution-verification-source-distillation.md
    (Cal Pass 1 distillation, source for this skill)
  - ~/.hermes/skills/skill-creator/SKILL.md (format gate for Wave 1 consolidated
    skills)
  - "retired: ~/.hermes/skills/verify-cli-surface-before-card/SKILL.md (lines
    cited inline)"
  - "retired: ~/.hermes/skills/verify-filesystem-state-before-planning/SKILL.md
    (lines cited inline)"
  - "retired: ~/.hermes/skills/verify-stale-context-ids/SKILL.md (lines cited
    inline)"
  - "retired: ~/.hermes/skills/verify-tool-semantics-before-planning/SKILL.md
    (lines cited inline)"
  - ~/.hermes/skills/hit-network/thin-harness-fat-skills/SKILL.md (architectural
    pattern)
---
<!-- AUTO-GENERATED FROM /Users/TJ/.hermes/skills/_pilot/pre-execution-verification/SKILL.md.tmpl - DO NOT EDIT BY HAND -->

# Pre-Execution Verification

Probe live state before acting on it. The four retired source skills shared
one root failure mode: acting on remembered or documented state instead of
probed live state. They differed only in WHICH surface the probe targeted
(CLI verbs, filesystem entries, context IDs, tool source code). This skill
unifies the procedure, preserves per-surface specificity in addenda, and
routes by symptom via a 5-question decision tree.

The whole protocol is read-only and idempotent. Re-running it is cheap. The
only mutating sub-step (a throwaway-slug CLI dry-run) is namespaced under
`test/` and called out explicitly.

## Triggers

Load this skill when any of these fire:

- About to file a Mission Control card with backtick-quoted CLI commands,
  named binary verbs, or spec-doc function names assumed to have CLI parity.
- About to dispatch a plan that references a file path, "auto-loaded" claim,
  named maintenance script, or named cron job without a source citation.
- A context summary, memory block, or prior session hands a specific Convex
  `_id`, deployment URL, cron job ID, file path, or card title that the
  current artifact depends on.
- ANY Mission Control card operation (read, list, search, update, delete).
- ANY Convex query whatsoever.
- About to take destructive action (delete, recreate, sed config, migrate)
  based on an ID, path, or behavior claim from prior context.
- Writing a multi-hour plan that depends on an upstream tool's BEHAVIOR
  (merge, upsert, dedupe, preserve, idempotent re-run, lock, resume).
- Any phrase in draft text like "the tool will MERGE / UPSERT / DEDUPE /
  preserves X automatically."
- Before Grant adversarial review on any planning card that calls upstream
  tools.

If two surfaces match (most non-trivial artifacts hit at least two), run
both probes. They compose; the decision tree below orders them.

## Procedure

The unified six-step spine. Run in order. Halt on the first failed probe.

1. **Enumerate the claims.** Grep your draft (plan, card, answer, dispatch)
   for every concrete reference: CLI invocations, file paths, IDs,
   "auto-loaded" claims, tool-behavior assertions ("merges", "upserts",
   "preserves"). Each is a hypothesis, not a fact. Sources:
   verify-cli-surface lines 70 to 72; verify-filesystem-state lines 58 to
   60; verify-stale-context-ids lines 28 to 32; verify-tool-semantics lines
   90 to 99.

2. **Probe each claim against live state with the cheapest authoritative
   tool.** Pick the surface by symptom (the decision tree below maps Q1 to
   Q5 onto these probes):
   - CLI verbs and flags: `<binary> --help` then `<binary> <verb> --help`,
     then the `gbrain call <op> '<json>'` MCP-via-CLI bridge before
     concluding "not callable from shell." Source: verify-cli-surface lines
     74 to 91, 130 to 138.
   - Filesystem entries: `ls -la <path>`, `find ~ -name <name>`, `hermes
     cron list | grep <name>`, then read the loader source if a file claims
     to be auto-loaded. Source: verify-filesystem-state lines 60 to 68, 73
     to 82, 86 to 104.
   - Context-summary IDs: HTTP probe against the canonical endpoint (Convex
     `/api/query` for MC cards), never trust the summary's `_id`. Search by
     title keyword first, get canonical ID, then operate. Source:
     verify-stale-context-ids lines 57 to 85, 295 to 303.
   - Tool semantics: read 100 to 200 lines of the entry function source.
     Scan for the six semantic decision points: empty-target handling,
     idempotency guards, lock acquisition, resume or manifest logic, schema
     assumptions, failure modes. Source: verify-tool-semantics lines 111 to
     122.

3. **Falsify, do not confirm.** State each assumption in writing first, then
   point at the line of code, the `ls` output, the HTTP response, or the
   `--help` banner that proves it. Unverified is unverified, not "probably
   fine." Source: verify-tool-semantics lines 124 to 127.

4. **Cite the verification in the artifact.** Every plan, card, or answer
   that depends on probed state gets a "Verified ___" section with
   timestamps and line numbers (Verified CLI Surface, State Verification,
   ID Verification, Source Verification). Pre-citing short-circuits Grant
   review and proves the work is grounded. Source: verify-cli-surface lines
   111 to 122; verify-filesystem-state lines 108 to 120; verify-tool-semantics
   lines 136 to 152.

5. **If a probe fails, halt. Do not paper over.** Either find the correct
   surface, file a blocker card, or restructure the plan around what
   actually exists. Sources: all four; explicit in verify-cli-surface line
   82, verify-filesystem-state lines 71 to 72, verify-stale-context-ids
   lines 405 to 415, verify-tool-semantics lines 128 to 134.

6. **Disclose stale context plainly.** When probed reality differs from
   prior context, tell the user: "The IDs in my context summary were stale,
   so my earlier answer was based on what the summary claimed, not live
   truth." Do not silently revise. Source: verify-stale-context-ids lines
   405 to 415 (rule 5 of SOUL: never lie to TJ, including lies of
   confidence).

### Decision Tree (entry routing, Q1 to Q5)

Run top-down. First match dictates the next probe. Multi-domain artifacts
run multiple probes; they compose.

```
START: I am about to file a card, dispatch a plan, answer a question, or
       take an action.

Q1: Does my artifact reference a SPECIFIC ID, deployment URL, file path, or
    cron job ID that came from a context summary, memory block, or prior
    session?
    YES: run the IDs probe (step 2, IDs branch). HTTP probe FIRST.
         Card-count check before ANY MC operation. Then re-evaluate Q2 to Q4.
    NO:  continue.

Q2: Does my artifact contain backtick-quoted CLI commands, named binary
    verbs, or spec-doc function names I assume have CLI parity?
    YES: run the CLI probe (step 2, CLI branch). Try `gbrain call <fn>`
         bridge BEFORE concluding "not reachable." Then continue.
    NO:  continue.

Q3: Does my artifact reference a file path, "auto-loaded" claim, named
    script, or named cron without a source citation?
    YES: run the FS probe (step 2, FS branch). `ls -la`, `find`, `cron
         list`, read the loader. Then continue.
    NO:  continue.

Q4: Does my artifact span 2+ hours of work and depend on an upstream tool's
    BEHAVIOR (merge, upsert, dedupe, preserve, idempotent re-run, etc.)?
    YES: run the semantics probe (step 2, semantics branch). Read 100 to
         200 lines of source. Falsify each behavior assumption with a line
         citation.
    NO:  continue.

Q5: All triggered probes complete? Cite verifications in the artifact
    (Verified CLI Surface, State Verification, ID Verification, Source
    Verification) with timestamps and line numbers. Then proceed.
```

A migration plan that calls `gbrain migrate` against a Convex-tracked card
with paths to scripts hits Q1, Q2, Q3, AND Q4. Run all four; they compose.

### Per-Surface Addenda (preserved specificity)

**CLI surface (Q2).** Three surfaces exist, not two: top-level CLI verbs,
MCP-only operations, and the `gbrain call <op> '<json>'` MCP-via-CLI bridge.
Try the bridge BEFORE concluding "not callable from shell." Per-command
help can contradict top-level help (the `gbrain put` example, only resolvable
by dry-running). Source: verify-cli-surface lines 36 to 37, 41 to 42, 89 to
93, 130 to 138.

**Filesystem state (Q3).** Footers are often aspirational from when a script
was *planned* but never built; `cron list | grep <name>` returning zero hits
is authoritative. "Auto-loaded" without a loader source line is unverified.
There are usually multiple identity or config files scoped to different
anchors; identify the one the loader actually reads. *Canonical incident,
April 28 WS-2B:* a fresh raw-data export shipped with uncovered windows
because the card footer asserted "auto-maintained by cron" and the cron
did not exist; the footer-aspirationality trap fired and the gap stayed
hidden until a downstream consumer hit empty ranges. Pair this with the
Lex Self-Maintenance Rebuild later the same day, two near-identical
footer-trust failures in one session: that is a pattern, not a one-off.
Source: verify-filesystem-state lines 42, 73 to 82, 127 to 128, 133 to 134;
distillation lines 173, 182.

**Stale context IDs (Q1).** Compaction summaries hallucinate IDs at high
rates; Convex `_id` (high-entropy hex) is invented, while titles are
LLM-summarized from real text and are approximately true. Two namespaces
exist under one deployment name (`prod:` and `dev:`); a card-count
discrepancy (for example 408 vs 61) means wrong namespace, and HTTP probe
is ground truth. Memory blocks lie about deployment names: entries shaped
"MC Convex LIVE is X (NOT Y)" have been backwards in production. The FIRST
tool call when working with MC cards is the prod card-count probe; no
exceptions. *Canonical incident, April 30 namespace third-repeat:* the
same `prod:` vs `dev:` Convex deployment split that bit on April 28
morning and April 28 evening surfaced a THIRD time on April 30, even
though the dedicated skill existed and its triggers matched. The skill
got skipped because nothing forced it to load on the trigger phrase. This
is the strongest argument on file for a load-on-trigger forcing function
(autoloader rule) as future work; the decision tree alone is not enough
when the agent forgets to consult it. Source: verify-stale-context-ids
lines 36 to 43, 90 to 122, 137, 293 to 330, 315 to 330; distillation lines
193, 196, 255, 257, 269.

**Convex MC card lookup three surfaces + archive trap (Q1, extends stale-IDs).**
`tasks:getById` is an `internalQuery` and is NOT callable from `curl
/api/query`, `npx convex run`, or the JS SDK (`ConvexHttpClient`). Use
the public siblings: `tasks:getAll`
(~548 active), then `tasks:getIceboxed` (~17), then `tasks:getArchived`
(~53). "Card not found in getAll" is not the same as "card doesn't exist"
— always check iceboxed and archived before declaring the ID stale or the
namespace wrong. Mutations `tasks:updateNotes` / `tasks:updateStatus` ARE
public and work on archived cards (verified 2026-05-19 on Grant verdict
flow). Four shell-callable surfaces exist: `curl /api/query`, `npx convex
run`, JS SDK via `ConvexHttpClient`, and the `gbrain call` bridge for
GBrain-side mutations. See `references/convex-mc-card-lookup-surfaces.md`
See `references/convex-mc-card-lookup-surfaces.md` for the recipe, the JS-SDK pattern for one-shot read-write-flip scripts
(common Grant auto-review use case), the env-var-export-via-xargs gotcha,
the lost-plan inferred-completion verdict pattern (when the plan file is
missing from disk), the **upstream-supersession sub-pattern** (deliverables
absent on disk but functional intent met by upstream code that didn't exist
when the plan was written, with a probe-order decision table and
PASS-as-CHANGED verdict template — 2026-05-19 GBrain wikilink extraction
incident), the **pipeline-orchestration sub-pattern** (`tasks:updateStatus`
to `in_review` schedules a 60s-delayed Grant auto-review request, so
scripted-verdict flows should post notes first then flip straight to
`done`), the BLOCKED-pipeline gotcha (capture-then-parse, never pipe
`convex run` stdout straight into `python3 -c`), and the
public-vs-internalQuery probe (`grep "export const" convex/tasks.ts`).

**Tool semantics (Q4).** Docs describe intent; source describes behavior.
`gbrain migrate` sounds like a merger, is replace-only with `--force-wipe`.
Bookmarked highest-ROI gbrain source files: `migrate-engine.ts`,
`core/migrate.ts`, `apply-migrations.ts`, `dream.ts`, `core/cycle.ts`,
`extract.ts`, `sync.ts`. Source: verify-tool-semantics lines 30 to 61, 158
to 165, 180 to 186.

**Cron timeout diagnostic pattern.** When a cron script consistently hangs 
or times out, check the target database directly for recent activity before 
declaring failure. Script execution problems ≠ system health problems when 
other processes maintain the same data successfully. Database timestamps are 
ground truth for sync status. Large file volumes (6K+ files) can cause 
legitimate script timeouts even with small time ranges due to startup 
overhead. Integer-only hour parameters (like ALE session sync) limit granularity 
for timeout recovery. **Infrastructure-level hangs** (script starts but never 
progresses past initialization) indicate dependency or database initialization 
failures rather than data volume issues - probe database state directly and 
check for missing libraries before retrying. **Silent execution pattern**: when 
scripts run with zero stdout and exit_code 0, distinguish genuine success (no work 
needed) from silent failures (dependency/config errors) by probing the target 
data store directly. **macOS timeout command limitation**: macOS lacks the `timeout` 
command by default; use `gtimeout` (GNU coreutils) or background process with kill 
for timeout functionality in cron scripts. **Timezone parsing issues**: cron scripts 
that process timestamped data can fail silently when they parse local timestamps 
as UTC or vice versa. When a script reports "0 items processed" but recent 
timestamped files exist, check the cutoff calculation. Session timestamps from 
EDT (local time) compared against UTC cutoffs create a systematic ~4-5 hour blind 
spot. Use `--verbose` mode and compare the calculated cutoff against actual file 
timestamps to detect timezone mismatches. **Diagnostic protocol**: verify database 
health via direct SQLite queries, check pending work counts, distinguish initialization 
hangs from volume-related slowdowns, report status honestly rather than masking 
timeouts as "no work to do." See `references/cron-database-hang-patterns.md` for diagnostic 
protocol, `references/ale-session-sync-timezone-mismatch.md` for timezone 
parsing diagnostic pattern, fix, and verification recipe, and other reference files for specific patterns.

**Plan-scope collapse via grep (Q3 + Q4 combined).** Before writing a "build X"
or "wire up Y" plan, grep the codebase for the technology by name first. The
2026-05-14 Cartesia incident: a planned 2-3 hour "build Cartesia output
bridge" collapsed to 45 minutes of "wire existing Cartesia into the browser
transport" after a 30-second grep revealed the work was already in
`transports/twilio.mjs`. Build-class plans should open with a "What already
exists (probed YYYY-MM-DD HH:MM)" section listing grep hits. See
`references/plan-scope-collapse-via-grep.md` for the rule, grep target list,
and plan template section.

**Hardcoded tool path + route-name-is-not-semantics (Q2 + Q4 combined).**
Before shipping a plan that bakes in a tool path (`/opt/homebrew/bin/npm`,
`/usr/local/bin/node`) or references a named endpoint (`/api/health`,
`/healthz`) by its name alone, probe the live path with `command -v <tool>`
and READ the route file. 2026-05-19 MC infra incident: a Grant-approved
plan hardcoded `/opt/homebrew/bin/npm` (npm is in nvm on this Mac, not
homebrew) AND probed `/api/health` (which is actually an Oura Ring data
proxy, not an MC liveness signal). MC crash-looped 161 times before
recovery, and the watchdog would have alerted on Oura outages instead of
MC outages. Prefer runtime `command -v` resolution over hardcoded paths;
read the route file before referencing it. See
`references/tool-path-and-route-name-falsification.md` for the full pattern,
plan-review checklist additions, and Next.js App Router underscore-folder
gotcha (`/api/_internal/...` is private and excluded from routing; use
`/api/internal/...` instead).

**Multi-hop pipeline verification (Q4 at the protocol layer).** When
activating a pipeline that crosses N systems (producer → transport →
handler → side-effect), HTTP 200 from the entry-point proves nothing about
hops 2..N. Verify the terminal side-effect, not the entry status code.
2026-05-19 HR-16 incident: Convex-native Grant Auto-Review pipeline was
"smoke tested" by flipping a card and observing HTTP 200 at the Hermes
webhook. The agent never spawned because Convex sent no `event_type` field
and Hermes's event-filter returned `{"status":"ignored"}` with 200 status,
identical byte-shape to "accepted" without reading the body. Pipeline was
broken from activation and went undetected until TJ asked why no Grant
verdicts were landing. See `references/multi-hop-pipeline-verification.md`
for the per-hop verification checklist, the side-effect probe table by
pipeline class, and the diagnostic protocol when a pipeline is
"instrumented but not working."

**Adjacent-artifact conflation (Q4 sibling, shared destinations).** When
verifying that action X produced effect Y in a shared destination (brain
export folder, log file, output cache), "fresh artifact in the right
directory" is NOT proof X produced it. Multiple producers write to shared
destinations; filename patterns encode transport not producer; mtime can
collide within seconds. Run the artifact-producer match probe (timestamp
match, content sanity, payload signature, other-producer enumeration,
negative probe) BEFORE citing the artifact as evidence. 2026-05-19 PTT
helper incident: agent cited a 15.9KB voice-call brain page as proof the
PTT helper worked. The page was actually produced by a parallel `/talk`
web UI session TJ ran the same minute; the helper's smoke output was a
separate 385-byte stub in the same directory. TJ caught it: "Well I
didn't have a conversation." Both files matched
`YYYY-MM-DD-HHMM-browser-*.md`, both timestamped 10:51:13, both used the
`/browser` transport. Pattern match without producer match is pattern
match, not verification. See
`references/adjacent-artifact-conflation.md` for the probe procedure,
shared-destination hotspot list, and the
"causal/signature/negative" verification taxonomy.

**Dispatch target already shipped (Q3 across session boundary).** Before
dispatching an agent to fix a script, patch a skill, or build a small
follow-up logged in a prior session, run `git log --oneline -10 <file>` on
the target file(s) and smoke-run the script if it's idempotent. The fix
often landed already. 2026-05-19 incident: TJ asked for Reid to be
dispatched to fix non-idempotent `register-*.sh` scripts in
`mission-control/scripts/`. 10-second probe revealed commit `18bf72c`
("register-*.sh: implement actual idempotency...") had already shipped,
and `bash register-overnight-collector.sh` returned "Already registered:
... No-op." Dispatch averted entirely. Trigger phrases: "Just dispatch
Reid for X", "did we fix Y?", "Reid was going to patch the script", or
any session-summary "open follow-up: ..." item. The probe cost is
identical whether the fix landed or not, so the policy is unconditional:
probe first, dispatch second. See `references/dispatch-target-already-shipped.md`
for the probe procedure, canonical incident transcript, and trigger-phrase
list. Pair with `references/audit-said-todo-but-code-already-shipped.md`
(env-flag-gated code) for the sibling pattern when work was completed but
defaulted off.

**Small fix masks a larger gap (Q3 + Q4 combined).** Before committing
the "1-line fix" the card describes, actually run the card's smoke-test
step end-to-end. If the smoke-test fails for a reason unrelated to your
fix, STOP and surface the gap. The 1-line fix in isolation will close a
card whose underlying problem is not solved, and the misleading green
check will compound silently. 2026-05-19 incident: card kn7d7e44 said
"add `cli` alias to gbrain/package.json + smoke-test." Alias re-added in
3 seconds. Smoke-test `bun run cli ingest --help` failed with
`Unknown command: ingest` — the `ingest` verb itself was dropped in the
v0.36 upgrade. Broader probe: `git diff --name-only master pre-v036-rollback`
returned 1,101 files; the entire web-to-brain recipe (20 files) was
absent from master. Shipping the 1-line fix would have closed the card
on a non-functional surface. See `references/small-fix-masks-larger-gap.md`
for the procedure, the recovery decision points (keep/revert/amend the
small fix), and the canonical incident transcript. Sibling to
`dispatch-target-already-shipped.md`: same probe discipline, opposite
finding (work is bigger than the card claims, vs. work is already done).

**Plan-embedded git working-directory assumption (Q3).** Before approving any
plan that contains `cd <path> && git <verb>` lines, probe whether `<path>`
is actually a git repo (`ls -la <path>/.git`, `git rev-parse --show-toplevel`).
2026-05-18 brain-first-hook-fixes incident: both v1 and v2 of a 77K-byte
plan opened with `cd ~/.hermes && git status` and had 18 per-task commit
calls targeting `~/.hermes`. `~/.hermes` is not a repo; the hook directory
under it was untracked. Both adversarial reviews missed it because git
working directories felt too trivial to probe. Plans that produce commits
should add a P0.0 git-repo verification step before P0.1. See
`references/plan-git-working-dir-assumption.md` for the failure mode, the
P0.0 template, and the trigger-word list for plan review.

**Subagent-fabricated CLI flags in adversarial review (Q2 + verification-of-verification).**
When Lex dispatches Grant (or any reviewer subagent) for adversarial plan
review of a CLI-heavy plan, Grant has the SAME training-data drift on CLI
surfaces that Lex does. Grant rejects fabrications it recognizes but
accepts fabrications it doesn't, AND recommends alternatives that also
don't exist. 2026-05-19 DC Knowledge Base ingestion: v1 plan REJECTED for
fabricated `gbrain rm`; v2 plan REJECTED for THREE new fabrications
introduced during the v1→v2 rework (`gbrain undelete`, `gbrain
inspect-links`, `gbrain put --chunk-size`). Net cost: 2 full Grant review
cycles before execution. **Fix:** before dispatching ANY CLI-heavy plan
for review, run `<binary> --help` and embed a `## Real <binary> commands
only (verified <date>)` section enumerating the real verb list. Grant
then either confirms the enumeration or finds an actually-missing verb;
the fabrication-spotting exercise is short-circuited. See
`references/subagent-fabricated-cli-flags-in-review.md` for the canonical
incident, the workflow change for the Planning Gate, and the pre-review
mini-checklist. Sibling of self-fabrication pattern in
`plan-draft-rejection-from-fictional-cli-verbs.md`.

**HR-Number literal ref drift (Q2 + Q3).** Plans that reference HR-N rules
by number (e.g., `prompt-builder.py:922` contains `"Operationalizes HR-15"`)
leave hard-coded strings in compiled prompts. When rules are renumbered or
retired, those strings become dangling references visible to every dispatched
subagent. 2026-05-19 HR consolidation v2: `prompt-builder.py` MC_LIBRARY_FILING_BLOCK
injected HR-15 into every deliverable prompt; plus 9 other script/docstring
refs across lex-workspace-collector, write-daily-curated, refresh-quickref,
test_brain_or_fs, migrate-synthesis-to-brain, brain_or_fs, dispatch.py.
Re-verify: grep -rn 'HR-[0-9]\+' scripts/ lib/ tests/ after any plan that
references hard-rule numbers. Must replace with skill names or SOUL.md
cross-references, not leave stale HR-N strings. See
`references/hr-number-literal-drift.md`.

### Verification of the Verification

Probing the wrong thing is itself a failure mode. Three checks:

1. **Count-match check (state probes).** If your filesystem probe or HTTP
   query returns a count that disagrees with what TJ or the UI sees, your
   probe is wrong, not reality. Re-run against the canonical endpoint.
   Source: verify-stale-context-ids lines 266 to 275, 311 to 313.

2. **Cross-surface check (CLI probes).** If `<binary> --help` does not list
   the verb you expected but the spec doc names the function, try the next
   surface (`gbrain call <function>`) before concluding the function is
   unreachable. Source: verify-cli-surface lines 134 to 138.

3. **Lazy-compile / cache check.** Empty grep results from `.next/`
   bundles, build artifacts, or other lazily-populated stores can mean "not
   yet built," not "not present." Force materialization (curl the route,
   run the build) before trusting an empty result. Source:
   verify-stale-context-ids lines 344 to 358.

If verification produces a "nothing found" result, ask: did I probe the
right surface, the right namespace, and a fully-materialized state? Only
after all three pass is "nothing" trustworthy.

## Pitfalls

All 21 pitfalls from Cal's Pass 1 distillation, preserved verbatim in
substance with source citations.

| # | Pitfall | Surface(s) | Source |
|---|---|---|---|
| P1 | "I just used this command, path, or board last week." Versions, paths, namespaces drift between sessions. | CLI, FS, IDs | cli-surface 126 to 127; filesystem-state 124 to 125; stale-ids 137 |
| P2 | "Reading the spec doc and assuming CLI parity." Spec docs describe the operations layer; CLI is a subset; `gbrain call` is a third surface. | CLI | cli-surface 129 to 138 |
| P3 | "Reid will figure it out." Broken commands burn the executing agent's iteration budget on syntax discovery; that cost is yours, not theirs. | CLI | cli-surface 140 to 141 |
| P4 | "The card is small." Small cards are exactly where verification gets skipped and bugs land. | CLI | cli-surface 143 to 144 |
| P5 | "The footer says it's automated." Footers are documentation, often aspirational from the planning phase, never built. Run `cron list \| grep` before believing them. | FS | filesystem-state 127 to 128 |
| P6 | "It must auto-load, otherwise nothing would work." Things sometimes work despite missing automation via unrelated mechanisms. Read the loader. | FS | filesystem-state 130 to 131 |
| P7 | "There's only one identity or config file." There are usually multiple, scoped to different anchors. Identify the one the loader actually reads. | FS | filesystem-state 133 to 134 |
| P8 | Trusting your own previous plan. Yesterday's claim is not today's truth. Re-verify every session. | All | filesystem-state 136 to 137 |
| P9 | Don't double-check only when challenged. Verify proactively when answering ID-specific questions. | IDs | stale-ids 419 |
| P10 | The summary's "title" field is more reliable than the "_id" field. Search by title keyword first, get canonical ID, then operate. | IDs | stale-ids 421 |
| P11 | Two namespaces exist under one deployment name (`prod:` and `dev:`). Card-count discrepancy means wrong namespace; HTTP probe is ground truth. | IDs | stale-ids 423 |
| P12 | When TJ says "I see X" and your CLI says "no X," HE IS RIGHT. HTTP probe first, theories second, edits last. | IDs | stale-ids 425, 397 to 403 |
| P13 | "In_review since April 24." Suspiciously specific timestamps from summaries are usually invented. Verify against `_creationTime`. | IDs | stale-ids 427 |
| P14 | "I read the docs, that's enough." Docs describe intent; source describes behavior. | semantics | tool-semantics 158 to 159 |
| P15 | "I'll just test it on a throwaway DB." Testing tells you what the current build does; source tells you what the design intends. Combine for high-stakes work. | semantics | tool-semantics 161 to 162 |
| P16 | "The tool name suggests what it does." `gbrain migrate` sounds like merge, is replace-only. Names are marketing; source is contract. | semantics | tool-semantics 164 to 165 |
| P17 | "Source-reading isn't real engineering." 100 lines is the highest-ROI engineering action available when planning multi-hour migrations. | semantics | tool-semantics 170 to 171 |
| P18 | Reading the schema but not the runner (or vice versa). Both define the contract. Migrations especially. | semantics | tool-semantics 173 to 174 |
| P19 | Turbopack lazy-compile gotcha. Routes not yet visited aren't compiled, so grepping `.next` returns nothing. Force compile with curl first. | IDs | stale-ids 344 to 358 |
| P20 | `npx convex run` ignores `.env.local` namespace changes (auth cache or `--url` flag wins). Use HTTP API directly when CLI is misconfigured. | IDs | stale-ids 360 to 375 |
| P22 | Cron scripts with `datetime.fromisoformat()` on naive timestamps. Hermes session JSON stores `last_updated` in local time (EDT) without timezone suffix. Treating naive as UTC creates a ~4-5 hour blind spot. Always attach local tzinfo before comparing against UTC cutoffs. | FS, semantics | `ale-session-sync.py` `parse_iso_dt` function, 2026-05-19 fix |

## Verification

This skill ran correctly when:

- Every concrete reference in the artifact is enumerated (step 1).
- Every triggered branch of the decision tree (Q1 to Q4) executed its probe.
- Each assumption was stated, then falsified or confirmed against a probe
  output, with a citation (line number, timestamp, HTTP response, or
  `--help` banner excerpt).
- The artifact contains the appropriate "Verified ___" section(s):
  Verified CLI Surface, State Verification, ID Verification, or Source
  Verification.
- Verification-of-verification ran where applicable (count-match,
  cross-surface, lazy-compile).
- If any probe failed, the artifact is halted, blocked, or restructured;
  it was not silently shipped with unverified claims.
- For ID-keyed work, the FIRST tool call was the prod card-count probe.

Idempotency contract:

| Probe | Idempotent | Mutates | Re-run cost |
|---|---|---|---|
| `<binary> --help` | yes | no | seconds |
| `ls -la <path>` | yes | no | seconds |
| `find` / `cron list` | yes | no | seconds |
| HTTP `/api/query` | yes | no | seconds |
| Source code read | yes | no | minutes |
| Loader source read | yes | no | minutes |
| Dry-run on throwaway slug | NO | yes (creates `test/cli-surface-verify-<ts>`) | small storage; namespaced under `test/`; safe to leave or delete |

Re-running pre-execution verification is always cheap. Skipping it because
"I verified yesterday" is the highest-frequency failure across all four
sources (P1, P8). Re-verify per session. The only mutating probe is the
throwaway-slug CLI dry-run; use a timestamped `test/` namespace and
document it as disposable. Source: cli-surface lines 95 to 109.

## Reversal/Recovery

Pre-execution verification fails in two senses; recovery differs.

**A. The probe itself fails (probe error, network down, source missing).**
Fall back to the next-cheapest surface (CLI help, then source grep, then
throwaway test). Document the unverified claim explicitly in the plan with
`# UNVERIFIED, probe failed because <reason>` so Grant or TJ can decide
whether to proceed or block. Never silently downgrade "unverified" to
"probably fine."

**B. The probe succeeds and reveals the artifact is wrong.**
- *Wrong CLI verb:* find the correct verb OR file an upstream blocker card
  (add the verb) and block the dependent card on it. Source: cli-surface
  line 82.
- *Wrong path:* find the real path before continuing. Do not proceed on a
  path you have not `ls`-confirmed. Source: filesystem-state lines 71 to 72.
- *Stale ID:* state plainly to the user that prior context was
  hallucinated; restart from live state. Source: stale-ids lines 405 to 415.
- *Wrong tool semantics:* restructure the plan around what the tool
  actually does. (April 29 GBrain Engine Recovery: 10-hour plan collapsed
  to 4 to 5 hours after reading 100 lines of `migrate-engine.ts`.) Source:
  tool-semantics lines 128 to 134, 210 to 214.

**C. Recovery from action already taken on unverified state.**
If you already filed a card with fictional CLI, deleted the wrong board's
cards, or sed-replaced based on a wrong mental model:
1. Stop further action immediately.
2. Tell the user what the cascade was, in plain language.
3. Run the HTTP probe, `ls`, or source read that should have been step 1.
4. Reverse what you can (`.preremove` files for sed, `git stash` for code
   edits, recreate deleted records from `_creationTime` history).
5. Update memory with the failure pattern so future-self does not
   re-trigger it.

Canonical incident: April 28 evening, "Sed-replaced 18 config files based
on wrong root cause, killed and restarted MC dev server unnecessarily,
only THEN ran the HTTP probe." Source: stale-ids lines 332 to 342.

## Source Citations

Four retired Hit Network skills, consolidated here. All line numbers refer
to the source file as captured in Cal's Pass 1 distillation
(`~/.hermes/workspace/tasks/plans/consolidation/pre-execution-verification-source-distillation.md`).

- **verify-cli-surface-before-card** (172 lines). Three surfaces (CLI,
  MCP-only, `gbrain call` bridge); per-command help contradicts top-level
  help; April 28 WS-2B and Lex Self-Maintenance double-failure; Verified
  CLI Surface forcing function. Lines 27 to 46, 36 to 37, 41 to 42, 70 to
  72, 74 to 91, 89 to 93, 95 to 109, 111 to 122, 126 to 127, 130 to 138,
  140 to 141, 143 to 144.
- **verify-filesystem-state-before-planning** (169 lines). Three failure
  classes (wrong path, wrong loader claim, fictional cron); footers are
  aspirational; loader source must be read; distinct-from-CLI table.
  Lines 28 to 32, 42, 58 to 60, 60 to 68, 71 to 72, 73 to 82, 86 to 104,
  108 to 120, 124 to 125, 127 to 128, 130 to 131, 133 to 134, 136 to 137,
  141 to 145.
- **verify-stale-context-ids** (429 lines, the largest source). Compaction
  summaries hallucinate `_id`s; HTTP probe FIRST; `prod:` vs `dev:`
  namespace trap (408 vs 61); memory blocks lie about deployment names;
  April 30 pre-flight forcing function. Lines 28 to 32, 36 to 43, 57 to 85,
  90 to 122, 137, 266 to 275, 293 to 330, 311 to 313, 315 to 330, 332 to
  342, 344 to 358, 360 to 375, 397 to 403, 405 to 415, 419, 421, 423, 425,
  427.
- **verify-tool-semantics-before-planning** (214 lines). Source over docs
  (April 29 case, `gbrain migrate` is replace-only); six semantic decision
  points; bookmarked source files; distinct-from-CLI-surface table. Lines
  30 to 61, 65 to 71, 90 to 99, 111 to 122, 124 to 127, 128 to 134, 136 to
  152, 158 to 159, 161 to 162, 164 to 165, 170 to 171, 173 to 174, 180 to
  186, 210 to 214.

Format gate and architectural pattern:

- `~/.hermes/skills/skill-creator/SKILL.md` (Wave 1 format gate).
- `~/.hermes/skills/hit-network/thin-harness-fat-skills/SKILL.md` (fat
  skill philosophy).

See references/ for conformance checklist and paired-benchmark instructions.

The user has provided the following instruction alongside the skill invocation: [IMPORTANT: You are running as a scheduled cron job. DELIVERY: Your final response will be automatically delivered to the user — do NOT use send_message or try to deliver the output yourself. Just produce your report/output as your final response and the system handles the rest. SILENT: If there is genuinely nothing new to report, respond with exactly "[SILENT]" (nothing else) to suppress delivery. Never combine [SILENT] with content — either report your findings normally, or say [SILENT] and nothing more.]

ENV BOOTSTRAP (cron strips PATH; this MUST be the first thing your shell does):
  export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
Run that line before any `gbrain`, `bun`, `git`, or workspace CLI invocation. The
`.local/bin/gbrain` shim is the actual executable; `~/.bun/bin/gbrain` is a .ts
symlink that needs bun shebang resolution and fails under stripped PATH.

Daily backup for both repos. Run these commands silently:

## REPO 1: Lex Workspace
1. cd ~/hermes-workspace/Lex-Workspace
2. git add -A
3. git commit -m "daily backup $(date +%Y-%m-%d)" || true
4. GIT_TERMINAL_PROMPT=0 timeout 90 git push origin main 2>&1 || echo "Push failed or timed out"
5. GIT_TERMINAL_PROMPT=0 timeout 90 git push backup main 2>&1 || echo "Backup push failed (ok if no backup remote)"

## REPO 2: Hermes Skills
1. cd ~/.hermes/skills
2. git add -A
3. git commit -m "skills backup $(date +%Y-%m-%d)" || true
4. GIT_TERMINAL_PROMPT=0 timeout 90 git push origin main 2>&1 || echo "Push failed or timed out"

No Telegram message unless a push fails with a non-timeout error. Log results only.

---

**ASSISTANT **
I need to follow the pre-execution verification skill protocol before running the daily backup. Let me probe the live state first.

---

