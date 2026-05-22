# Cron Registration (DEFERRED for TJ approval)

The auto-enrich pipeline is built, tested, and wired through a cron-ready
wrapper at `~/.hermes/scripts/auto-enrich-pipeline.sh`. Registration as a
recurring Hermes cron job is paused: persistent automation crosses Lex's
autonomy boundary and requires explicit TJ approval before activation.

## Why a doc, not a registered job

Per Lex operating rules, anything that runs on its own schedule without a
human-in-the-loop trigger needs TJ sign-off. The same applies to live brain
writes from autonomous research, which is why the dry-run smoke is the
default and `SMOKE_LIVE=1` is a separately gated path.

## Exact registration command (Lex runs this on approval)

```
cronjob register \
  --name auto-enrich-pipeline \
  --schedule "0 3 * * *" \
  --script ~/.hermes/scripts/auto-enrich-pipeline.sh \
  --no-agent \
  --deliver local \
  --prompt "auto-enrich nightly pipeline. Watchdog mode."
```

Parameters:
- name: auto-enrich-pipeline
- schedule: 0 3 * * * (03:00 local nightly)
- script: ~/.hermes/scripts/auto-enrich-pipeline.sh
- no_agent: true (executes the script directly, no LLM in the loop)
- deliver: local (results land in the local heartbeat + pipeline.log, no
  Telegram or email blast)
- prompt: "auto-enrich nightly pipeline. Watchdog mode."

## Pre-registration smoke (REQUIRED before activation)

Before flipping the cron on, run the smoke in dry-run mode:

```
bash recipes/auto-enrich/scripts/smoke.sh
```

This pulls one sensor candidate, runs research (or the mocked fixture if
`CAL_DISPATCH_MODE=mock`), the quality gate, and synthesize, then prints
the unified diff and the draft path. No brain writes.

After review of the dry-run output, the live smoke is gated by
`SMOKE_LIVE=1` and writes to the brain once:

```
SMOKE_LIVE=1 bash recipes/auto-enrich/scripts/smoke.sh
```

That single live run is also a TJ-approval gate, separate from the cron
registration itself.

## Logs and observability

- `~/.gbrain/integrations/auto-enrich/heartbeat.jsonl` (per-step events)
- `~/.gbrain/integrations/auto-enrich/escalations.jsonl` (gated candidates
  with full issue lists)
- `~/.gbrain/integrations/auto-enrich/pipeline.log` (stdout/stderr from
  every cron run, tee'd by the wrapper)
- `gbrain integrations show auto-enrich` surfaces the heartbeat counters.
