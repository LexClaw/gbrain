# GBrain Upstream Pull — Safety Gate + Reconciliation Plan

**Task:** Kanban t_7b40e5c8 (MC kn7219b7) — Pull LexClaw/gbrain fork up to upstream garrytan/gbrain
**Owner:** Grant (infra + migration). Reid for code-level conflict resolution at cutover.
**Date:** 2026-06-10
**Scope of THIS run:** read-only safety gate + GO/NO-GO + reconciliation plan. **No live cutover** (out of scope per card: "before any risky cutover"; HR-4 irreversible-destructive = approval; 1h runtime cap).

---

## Version delta (card said v0.42.25; reality has moved)

| | Version | SHA |
|---|---|---|
| Our fork (LexClaw/gbrain master) | **0.42.1.0** | `15ab4972` |
| Upstream (garrytan/gbrain master) | **0.42.38.0** | `03ffc6eb` |

- **36 commits behind** upstream, **51 commits ahead** (substantial fork carry — auto-enrich pipeline + ingest verb + several LEX-FORK guards).
- Card referenced v0.42.25; upstream is now v0.42.38. The 3 target fixes are all present and below v0.42.25, so the card's premise holds.

## The 3 canonical fixes we want — ALL PRESENT in the delta

1. **DB-connection crash** ("connect() has not been called", job 5539): `f3ade6c0` **v0.42.21.0** — module-singleton ownership, closes #1404/#1471/#1619. ✅
2. **RSS drain (12–14GB):** `766604de` **v0.42.5.0** (RSS watchdog + pooler-reap self-heal + cycle-lint DB-disconnect) and `ec5fed29` **v0.42.20.0** (Postgres reconnect race). ✅ Live confirmation: `jobs work` daemon (pid 8887) observed at **7.2–8.2 GB RSS** right now — the drain is real and active.
3. Bonus reliability that rides along: `3fe44936` v0.42.16.0 (cause-ranked doctor + OOM-loop line + auto-drain), `f7f8512b` v0.42.28.0 (batch-insert jsonb fix), `03ffc6eb` v0.42.37.0 (reap stale locks + cooperative-abort).

---

## Gate Checks

### Check A — Schema migration risk: **LOW** ✅
Backend is **local Postgres** (`postgres://localhost:5432/gbrain`), schema **v111 live**. Delta adds migrations **v112–v115** (read in full):

| v | name | operation | risk at our scale |
|---|---|---|---|
| 112 | pages_links_extracted_at | `ADD COLUMN ... TIMESTAMPTZ` (no default) + `CREATE INDEX CONCURRENTLY` | instant metadata change; CONCURRENTLY = non-blocking. LOW |
| 113 | links_link_source widen | `DROP/ADD CONSTRAINT` (check) | metadata-only on `links`. LOW |
| 114 | links_link_source kebab regex | two-phase `ADD CONSTRAINT ... NOT VALID` then `VALIDATE CONSTRAINT` | **explicitly non-blocking** (SHARE UPDATE EXCLUSIVE). LOW |
| 115 | op_checkpoint_paths | `CREATE TABLE IF NOT EXISTS` (empty) | new empty table. LOW |

**No v28-class wedge pattern** — zero bulk `UPDATE`/`DELETE` without `LIMIT`. All Postgres paths use the non-locking primitives (CONCURRENTLY / NOT VALID→VALIDATE). Scale: 70,669 pages / 232,778 chunks / 394,435 links — none of the migrations scan these tables destructively. **No wedge risk.**

### Check B — Wrapper timeout outliers: **NONE** ✅
No migration timeout below the 600_000 norm in the delta.

### Check C — CLI surface changes: **MEDIUM (merge-only, not live-breakage)** ⚠️
- Upstream **ADDED:** `enrich`, `connect`, `quarantine`, `self-upgrade`.
- Upstream **REMOVED:** `ingest` (this is OUR fork's web-to-brain verb — must survive the merge).
- **Cross-ref against crons/scripts:** NO cron or script calls `gbrain ingest`/`enrich`/`connect`/`quarantine`. → CLI delta is a **merge-resolution concern only**, with **zero live consumer breakage**. Our `ingest` carry must be re-inserted into upstream's `CLI_ONLY` superset during conflict resolution.

### Check D — Dependency major bumps: **NONE** ✅
`package.json` diff = version field + two `scripts` entries (`eval:autocut`, `check:doc-history`/`check-key-files-current-state.sh`). No drizzle/pglite/bun-types major bumps.

### Check E — Skill changes: not gating. Upstream skill churn does not collide with our cron skill paths (no cron loads a `~/gbrain/skills/...` path affected by removals).

### Check F — Breaking keywords: present in subjects (`fix(security...)` source-isolation grant enforcement, frontmatter guard) but read as **additive hardening**, not API breaks. Trust-boundary marker-strip in `import-file.ts` is a fail-closed guard — compatible with our truncation guard (both run, ours first).

---

## Merge conflict surface (measured, not guessed)

Test-merge run in a **detached throwaway worktree** (`/tmp/gb-testmerge`, removed; live daemon at `/Users/TJ/gbrain/src/cli.ts` never saw it):

**5 conflicted files, 7 hunks total — all additive seams (keep-both):**

| file | hunks | nature |
|---|---|---|
| `src/cli.ts` | 1 | our `ingest`/auto-enrich registration vs upstream `enrich`/`connect`/`quarantine`/`self-upgrade`. Resolution: take upstream `CLI_ONLY` superset, re-insert our `ingest`. |
| `src/commands/autopilot.ts` | 2 | our autopilot wiring vs upstream supervisor singleton. |
| `src/core/conversation-parser/llm-base.ts` | 1 | our `LEX-FORK (card kn7e69h)` chatTransport test seam vs upstream T4 fallback. |
| `src/core/import-file.ts` | 1 | our truncation guard (kn7f8tg0) vs upstream v0.42 trust-boundary marker-strip. Keep BOTH: guard runs, then strip. |
| `test/autopilot-supervisor-wiring.test.ts` | 2 | test counterpart to autopilot.ts. |

No file involves data migration logic. All resolvable by a code agent in ~30–60 min. Manifest present (`lex-customizations-manifest.json`, 87 entries, hardened pre-v0.42.1).

---

## ⚠️ Pitfall #9 — CONFIRMED LIVE HAZARD

`/Users/TJ/.bun/bin/gbrain` → `…/install/global/node_modules/gbrain` → **symlink to `/Users/TJ/gbrain`**. Two LIVE daemons resolve through it:
- `com.gbrain.autopilot` (pid 15118, launchd)
- `gbrain jobs work --max-rss 10240` (pid 8887, 7.2 GB RSS)

`runMigrations()` fires inside `connectEngine()` on every daemon tick with **no operator gate**. **The instant a merge carrying v112–v115 is committed into `/Users/TJ/gbrain`, the next daemon tick auto-migrates the LIVE brain 111→115 unsupervised.** Therefore the cutover MUST do the merge in an out-of-tree worktree (or stop both daemons) and MUST rehearse on a clone BEFORE the commit.

---

## VERDICT: **GO (conditional)** — proceed to a controlled cutover in a SEPARATE, operator-approved run

Risk profile: migration risk **LOW**, dep risk **LOW**, merge surface **SMALL (7 additive hunks)**, the 3 target fixes **all present**, live drain **reproduced**. This is a clean, high-value pull. The only HIGH-consequence element is operational sequencing (Pitfall #9), which the procedure below fully contains.

**This run does NOT execute the cutover** — irreversible live-brain migration requires explicit approval (HR-4) and exceeds the 1h cap. Blocking for that approval.

---

## Reconciliation / Cutover Plan (for the approved run — owner Grant, Reid for conflicts)

**Pre-flight**
1. Snapshot the live Postgres brain with the **version-matched** dumper:
   `/opt/homebrew/opt/postgresql@17/bin/pg_dump "postgres://localhost:5432/gbrain" -Fc -f /Users/TJ/.gbrain/brain.dump.$(date +%Y%m%d-%H%M)` — verify non-zero bytes (pg_dump version-mismatch writes a 0-byte file on exit-1).
2. `scripts/reapply-customizations.sh --check` BEFORE merge — a failure on an entry NOT touched this session means the manifest was already lying about a previously dropped file; surface as its own finding, decide restore-vs-prune with TJ before merge bakes loss in.

**Rehearsal (proof before live)**
3. Restore the dump into a throwaway scratch DB; override via `DATABASE_URL` env-var (beats config.json so every command provably hits the clone). Run the REAL migration path (`init --migrate-only`, NOT the `apply-migrations` no-op stub) on the clone. Prove: no wedge, identical row counts (70,669 pages / 394,435 links), new tables present, a real `gbrain get` works, `gbrain doctor --fast` green. This converts "recon says LOW" into measured evidence.

**Isolation (defeat Pitfall #9)**
4. EITHER stop both daemons (`launchctl bootout` autopilot + kill pid 8887) OR do the merge in a `git worktree` whose path the running shim does NOT resolve to. Do the rehearsal in step 3 BEFORE any commit.

**Merge (additive)**
5. `git merge --no-commit --no-ff upstream/master`; resolve the 7 hunks keep-both: cli.ts (upstream superset + re-add `ingest`), import-file.ts (truncation guard then trust-boundary strip), llm-base.ts (preserve LEX-FORK seam), autopilot.ts + test (preserve our wiring inside upstream supervisor singleton). Grep for stray trailing `>>>>>>>` markers after large-block patches.

**Survival gate**
6. Zero conflict markers → `bun install` → typecheck → `bun test` on the 5 touched files → `scripts/reapply-customizations.sh --check` (0 FAILED) → grep merged files to confirm our customizations literally survive (truncation guard, LEX-FORK seam, ingest registration).

**Live apply + verify**
7. Restart daemons (or commit, letting the gated next tick migrate). Confirm `config.version` → 115.
8. **Original card verification target:** tail `/Users/TJ/.gbrain/autopilot.err` — No-DB-connection errors gone — AND watchdog drain events trending toward zero (jobs-work RSS should stop climbing past max-rss without the wedge).

**Rollback:** restore the step-1 dump into `gbrain` if doctor red or row counts drift.
