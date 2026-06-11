# Timeline Coverage Backfill Orchestration Plan

> **For Hermes:** This is an ops plan, not a feature implementation plan. Use `scheduler-fits-work` to select the execution vehicle and `gbrain-timeline-batch-preflight` only if falling back to manual batch `timeline-add` writes.

**Goal:** Move GBrain timeline coverage materially toward the 90% target using real extractable page metadata/content only, without synthetic spam or blocking TJ's current work.

**Architecture:** The canonical first path is GBrain's idempotent built-in DB extractor: `gbrain extract timeline --source db`. It reads existing pages and writes timeline entries derived from real content/metadata. Because the dry-run scanned ~70,652 pages and emitted real candidate entries, run the non-dry extraction as a tracked background process with log output, then verify with doctor + direct health metrics. Manual timeline-add batches are fallback only, and require slug pre-flight verification.

**Tech Stack:** GBrain CLI, Postgres/PGLite engine via existing `gbrain` config, Hermes terminal background process, doctor JSON verification.

---

## Current Verified State

- `conversation_format_coverage`: ok
- `content_sanity_audit_recent`: ok, oversize-only cluster
- `stale_locks`: ok after clearing stale rows
- `sync_freshness`: ok after no-op sync freshness patch
- `type_proliferation`: ok after `tj-v2` schema unification
- `timeline_coverage`: warn, `56% ± 1.0%`, target `90%`
- Dry-run of `gbrain extract timeline --source db --dry-run --json` showed real `add_timeline` candidates and progressed through a 70,652-page DB scan. That proves the extractor has non-synthetic work available.

## Dispatch Vehicle Decision

Per `scheduler-fits-work`:

- Work shape: long-running mechanical backfill over 70K pages, no active reasoning during the run.
- p95 duration: unknown but likely minutes to tens of minutes; foreground chat/tool loop is the wrong vehicle.
- Trigger: one-shot operational backfill, started now.
- Correct vehicle: `terminal(background=true, notify_on_complete=true)` from `/Users/TJ/gbrain`.
- Not `delegate_task`: there is nothing to reason about once the command starts.
- Not Hermes cron: this is not recurring and does not need Lex context.

---

## Phase 0: Pre-flight

**Objective:** Avoid running a mutating backfill into a bad state.

**Commands:**

```bash
cd /Users/TJ/gbrain
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

gbrain doctor --json > /tmp/gbrain-doctor-before-timeline.json
python3 - <<'PY'
import json
j=json.load(open('/tmp/gbrain-doctor-before-timeline.json'))
for name in ['stale_locks','sync_freshness','timeline_coverage']:
    c=next(x for x in j['checks'] if x['name']==name)
    print(c['status'], name, c['message'])
PY
```

**Gate:** Proceed only if:

- `stale_locks` is ok.
- `sync_freshness` is ok.
- `timeline_coverage` is still warn/low, confirming the work is needed.

---

## Phase 1: Start bounded tracked background extraction

**Objective:** Run canonical non-dry timeline extraction over DB pages while preserving logs.

**Command shape:**

```bash
cd /Users/TJ/gbrain
mkdir -p /tmp/gbrain-timeline-backfill
LOG="/tmp/gbrain-timeline-backfill/$(date -u +%Y%m%dT%H%M%SZ).log"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

gbrain extract timeline --source db 2>&1 | tee "$LOG"
```

**Hermes execution vehicle:**

Use `terminal(background=true, notify_on_complete=true, timeout=...)` rather than running this foreground.

**Success signal:** Process exits 0 and log ends with a `Done:` line showing pages processed and timeline entries created.

**Failure signal:** Non-zero exit, lock-busy error, or traceback. If lock-busy appears, stop and re-run doctor `stale_locks` before any manual lock clearing.

---

## Phase 2: Post-run verification

**Objective:** Confirm extraction had real effect and did not regress other health checks.

**Commands:**

```bash
cd /Users/TJ/gbrain
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

gbrain doctor --json > /tmp/gbrain-doctor-after-timeline.json
python3 - <<'PY'
import json
j=json.load(open('/tmp/gbrain-doctor-after-timeline.json'))
for name in ['timeline_coverage','stale_locks','sync_freshness','conversation_format_coverage','content_sanity_audit_recent','type_proliferation']:
    c=next((x for x in j['checks'] if x['name']==name),None)
    if c:
        print(c['status'], name, c['message'])
PY
```

Also capture raw engine health:

```bash
bun - <<'TS'
import { loadConfig } from './src/core/config.ts';
import { createEngine } from './src/core/engine-factory.ts';
const cfg = loadConfig();
const engine = await createEngine(cfg);
await engine.connect(cfg);
const h = await engine.getHealth();
console.log(JSON.stringify({
  timeline_coverage: h.timeline_coverage,
  link_coverage: h.link_coverage,
  pages: h.pages,
  timeline_entries: h.timeline_entries,
}, null, 2));
await engine.disconnect();
TS
```

**Gate:** Accept the run if:

- Timeline entries created > 0, or doctor/raw coverage moved upward.
- No target checks regress from ok to warn/fail except timeline if it remains below 90.
- `stale_locks` remains ok.

---

## Phase 3: Decide next iteration, do not rush to synthetic fill

**Objective:** Keep progressing toward 90% without junk timeline rows.

If coverage improves but remains below 90:

1. Run another dry-run targeted by high-yield type if CLI supports it, e.g. `--type person`, `--type company`, or source-specific extraction.
2. If built-in extractor reaches diminishing returns, switch to manual batches only for high-value entity pages with verified slugs.
3. Manual batch rule: max 8-10 entries per cycle and verify every slug with `gbrain get` before `timeline-add`.

If coverage does not improve:

1. Treat this as extractor/idempotency diagnosis, not as a reason to synthesize timeline spam.
2. Inspect how `timeline_coverage` is computed versus what `gbrain extract timeline` writes.
3. Identify top entity pages with zero timeline entries and determine whether they have real date-bearing content.

---

## Rollback / Safety

- `gbrain extract timeline --source db` is intended to be idempotent via existing dedup keys. Do not manually delete entries unless a concrete bad source marker is identified.
- If manual fallback is ever used, tag summaries/sources clearly and keep the batch small so rollback can target exact rows.
- Do not use synthetic generic entries like “entity exists” or “page created” unless derived from real metadata and accepted as `backfill:metadata` style rows.

## Acceptance Criteria

- A background extraction process is launched and tracked.
- The process completes or failure output is captured.
- Post-run doctor and direct health metrics are captured.
- Timeline coverage moves upward, or a concrete extractor-limit diagnosis is produced.
- No stale locks remain.
- No synthetic timeline spam is introduced.
