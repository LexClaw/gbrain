# GBrain Conversation→Facts Extraction — No-Spend Preflight & Recommendation

**Card:** t_d6191333 (parent MC: kn7e69hxjfn2gre694hzeptf7h88465z)
**Author:** Grant
**Date:** 2026-06-10
**Spend incurred by this task:** $0.0000 (all dry-run / read-only)

---

## TL;DR

The pipeline is **already proven working** on session pages. AC3 ("native
conversation→facts extraction yields facts from session archives") does **not
require a new paid run to demonstrate** — it was proven at $0.08 on the exact
binary now installed, and I re-confirmed segmentation live at $0.00 via dry-run.

**Recommendation: approve a small bounded LIVE sample (~$0.50 cap, ~15 session
pages) to confirm fresh end-to-end yield on the current brain, then let the
existing nightly `conversation_facts_backfill` phase grind the backlog at its
$5/night cap.** Do NOT block on Docker E2E (daemon down + logic-only change).
Do NOT run the ~$3 Phase C yield run — it's oversized for what's left to prove.

---

## 1. Pipeline config & eligibility — verified (no spend)

Environment note: the worker shell sandboxes `$HOME` to the profile dir, so
`gbrain` reported "No brain configured" until pointed at the real home with
`GBRAIN_HOME=/Users/TJ`. All commands below use that prefix.

| Check | Value | Source |
|---|---|---|
| Brain engine | postgres @ `localhost:5432/gbrain` (accepting connections) | `~/.gbrain/config.json` |
| `chat_model` | `anthropic:claude-sonnet-4-6` (set — preflight passes) | `gbrain config get chat_model` |
| `cycle.conversation_facts_backfill.enabled` | `true` | config |
| `cycle.conversation_facts_backfill.types` | `["conversation","meeting","slack","email","session"]` — **session present** | config |
| Installed binary | gbrain 0.42.1.0 | `gbrain --version` |
| Fork HEAD | `15ab4972` (parser fix) on top of `2c9679f8` (session allowlist) | `git log` |

`doctor` health (relevant lines):
- `[WARN] conversation_facts_backlog: 7639 eligible pages without extraction.`
- `[OK] conversation_format_coverage: 64 transcript-like pages; _no_match=1` (parser coverage healthy).
- `[OK] facts_extraction_health: No facts:absorb failures in last 24h.`
- `[OK] facts_health: 2 active facts.`
- `[OK] facts_embedding_width_consistency: halfvec(1536) matches gateway.`

Live `facts` table baseline (read-only psql):
- **2 total facts**, both `source LIKE 'cli:extract-conversation-facts%'`.
- **2 pages** carry the terminal audit row (the REID proof pages only).
- Confirms: facts_backup_20260606 was NOT restored; backlog is a fresh re-mine.

## 2. Zero-cost proof that AC3 holds (dry-run)

`--dry-run` runs the full path — enumerate → read body → parse → segment — and
stops before the paid extractor call. It is the no-spend AC3 oracle.

```
gbrain extract-conversation-facts --types session --limit 20 --force --dry-run
→ 38 segments across 18/20 pages, $0.0000
```

Per-page segment yield from the sample (proves allowlist + parser + segmenter
all fire on `type=session` Hermes archives):
- 066c3bba → 2 seg, 0674c0d1 → 1, 06ee4e8f → 8, 0b216be5 → 4, 11c21f70 → 4, …
- Mean ≈ **2.1 segments/page**; non-zero on every non-empty page.

Combined with REID's already-landed live proof (rich session `2026-05-14-0946`:
**30 facts / 7 segments for $0.08** on commit `15ab4972` = the installed binary),
the extraction logic is demonstrably correct. The only thing a new paid run adds
is a *fresh* confirmation against today's brain state.

## 3. Docker E2E — BLOCKED, and not on the critical path

`docker info` → `failed to connect to the docker API at unix:///var/run/docker.sock`.
The daemon is not running, so `bun run ci:local` (the Dockerized 29-file E2E
gate) cannot run in this environment. **This is a reported blocker, not a
stopper:** the fix is parser/allowlist logic fully covered by unit tests
(`bun test parse.test.ts extract-conversation-facts.test.ts` = 96 pass per REID).
E2E should run on the next Docker-available CI pass *before merge to master*, but
it is not required to validate the runtime behavior we already observe live.

## 4. Cost sizing for the backlog (informational)

- Per-segment cost ≈ $0.08 / 7 ≈ **$0.011/segment** (REID's rich run).
- Backlog 7,639 pages × ~2.1 seg/page ≈ ~16k segments × $0.011 ≈ **~$175 worst-case
  full grind** — but thin pages (many are 1 segment) pull the real number down,
  and the nightly phase self-throttles at `$5/night`, self-completing over ~2–4 weeks.
- The nightly cap means there is **no large lump-sum decision** to make: the spend
  is paced and capped by config already.

---

## Recommendation (ranked)

1. **Approve a bounded live sample now** (needs TJ sign-off — it spends money):
   ~15 session pages, hard $0.50 cap. Confirms fresh end-to-end yield (real rows
   written to the live `facts` table) on today's brain, then hands off to the
   nightly phase. Exact command + verification below.
2. **Let the existing nightly `conversation_facts_backfill` phase do the bulk
   grind** — it is already enabled with `session` in scope and capped at $5/night.
   No new orchestration needed.
3. **Defer Docker E2E** to the next Docker-available CI run, pre-merge. Not a
   gate for runtime validation.
4. **Do NOT run the ~$3 Phase C yield run** — oversized; the bounded $0.50 sample
   + already-landed REID proof cover AC3 with margin.

### Exact paid command (pending approval)

```bash
GBRAIN_HOME=/Users/TJ gbrain extract-conversation-facts \
  --types session --limit 15 --max-cost-usd 0.50 --workers 1 --yes
```

- **Scope:** up to 15 unprocessed session pages (~30 segments at sample mean).
- **Est. cost:** ~$0.30–0.50 (hard-capped at $0.50; workers=1 → exact ceiling).
- **Verification (read-only, post-run):**
  ```sql
  SELECT count(*) FILTER (WHERE source LIKE 'cli:extract-conversation-facts%')
  FROM facts;                                  -- expect >> 2 (baseline)
  SELECT count(DISTINCT source_markdown_slug)
  FROM facts WHERE source='cli:extract-conversation-facts:terminal';  -- expect ~17 (2 + ~15)
  ```
  Plus `gbrain doctor` → `conversation_facts_backlog` count should drop by ~15.
```
