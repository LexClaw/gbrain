# GBrain search JSONL telemetry

GBrain writes one JSON object per completed search call to `~/.local/state/gbrain/search-telemetry.jsonl`. The sink is local-only, append-only for normal operation, and capped at 10MB so long-running agents can collect decision data without unbounded disk growth.

This stream is separate from the existing database rollup table `search_telemetry`. The rollup table aggregates search-mode counters for `gbrain search stats`. The JSONL stream preserves per-call shape for the cache architecture decision matrix.

## Why this exists

The cache decision needs observed traffic, not guesses. The 48 hour collection window should answer five questions:

1. How often different raw searches collapse to the same normalized query.
2. How many unique normalized queries appear per caller.
3. What result-count distribution each caller sees.
4. How much wall-clock time each search path takes.
5. Whether humans, crons, and hooks issue meaningfully different query shapes.

The file captures enough to compute those numbers while staying simple enough to inspect with `jq`, Python, or a spreadsheet.

## Normalization

Every `hybridSearch` call normalizes the query before downstream search logic runs:

1. Convert to lowercase.
2. Normalize Unicode to NFC.
3. Replace non-alphanumeric characters with spaces.
4. Collapse repeated whitespace.
5. Trim leading and trailing whitespace.

The normalized text is used for query classification, keyword search, expansion input, embedding input, reranker input, and cache lookup. Raw text is only retained in the JSONL row so the collection window can measure how much normalization changes caller behavior.

Examples:

- `"Cache: Architecture?!"` becomes `"cache architecture"`.
- `"  Founder   ARR\tupdates "` becomes `"founder arr updates"`.
- `"Café / cafe"` becomes `"café cafe"` because NFC keeps accented letters as letters.

## JSONL schema

Each line is a standalone JSON object. The required fields are:

- `ts`: ISO 8601 timestamp generated after the search result is known.
- `raw_query`: query string received by `hybridSearch` before normalization.
- `normalized_query`: normalized query used by the search path.
- `result_count`: number of results returned after slicing, deduping, reranking, and token-budget enforcement.
- `wall_ms`: elapsed wall-clock milliseconds for the completed search call.
- `caller_hint`: consumer label from `GBRAIN_CALLER`, or `unknown` when unset.

Example row:

```json
{"ts":"2026-05-26T08:02:01.234Z","raw_query":"Cache: Architecture?!","normalized_query":"cache architecture","result_count":7,"wall_ms":42,"caller_hint":"Reid"}
```

`caller_hint` is intentionally caller-supplied, not authenticated identity. It is for traffic segmentation only.

## Caller tagging

Set `GBRAIN_CALLER` before invoking GBrain:

```bash
GBRAIN_CALLER=Lex gbrain query "cache architecture"
GBRAIN_CALLER=Reid gbrain query "search telemetry"
GBRAIN_CALLER=cron:daily-health gbrain query "daily health"
GBRAIN_CALLER=hook:telegram gbrain query "recent telegram context"
```

Recommended labels:

- `Lex` for direct Lex calls.
- `Reid` for direct Reid calls.
- `cron:<job-name>` for scheduled jobs.
- `hook:<hook-name>` for hooks.
- `unknown` is reserved for unset environments.

The logger strips control characters from `GBRAIN_CALLER`, trims whitespace, and caps the stored label length. Empty labels are stored as `unknown`.

## Rolling cap

The sink enforces a 10MB cap at write time. Before appending a row, the writer checks the current file size plus the pending row. If the append would exceed 10MB, it keeps the newest existing bytes that fit under the cap, aligns to the next newline so every retained line is complete, then appends the new row.

Operational notes:

- The cap is byte-based, not line-count-based.
- A single oversize row is truncated from the front only through normal JSON string size limits, which should not happen for search queries.
- Rotation is in-place to the same path, not timestamped archival rotation. The collection window should copy the file elsewhere before clearing it if a permanent artifact is needed.

## Collection methodology

The Wave 4 collection starts when the first verified row lands in `~/.local/state/gbrain/search-telemetry.jsonl`. Keep collection running for 48 hours with normal consumers using their expected caller labels.

Minimum coverage checks:

1. Lex direct call writes a row with `caller_hint: "Lex"`.
2. Reid direct call writes a row with `caller_hint: "Reid"`.
3. Cron call writes a row with a `cron:` prefix.
4. Hook call writes a row with a `hook:` prefix.
5. Unset caller path writes `caller_hint: "unknown"` only when no label is provided.

Quick inspection:

```bash
tail -n 20 ~/.local/state/gbrain/search-telemetry.jsonl | jq .
```

Caller coverage:

```bash
jq -r '.caller_hint' ~/.local/state/gbrain/search-telemetry.jsonl | sort | uniq -c
```

Normalization collision candidates:

```bash
jq -r '[.normalized_query, .raw_query] | @tsv' ~/.local/state/gbrain/search-telemetry.jsonl \
  | sort \
  | awk -F '\t' '{ raw[$1][$2]=1 } END { for (n in raw) { c=0; for (r in raw[n]) c++; if (c > 1) print n, c } }'
```

If the shell does not support nested arrays in `awk`, use Python:

```bash
python3 - <<'PY'
import json
from collections import defaultdict
rows = defaultdict(set)
with open('/Users/TJ/.local/state/gbrain/search-telemetry.jsonl', encoding='utf-8') as f:
    for line in f:
        if line.strip():
            row = json.loads(line)
            rows[row['normalized_query']].add(row['raw_query'])
for normalized, raws in sorted(rows.items()):
    if len(raws) > 1:
        print(len(raws), normalized)
PY
```

Latency and result count summary:

```bash
python3 - <<'PY'
import json, statistics
from collections import defaultdict
by_caller = defaultdict(list)
with open('/Users/TJ/.local/state/gbrain/search-telemetry.jsonl', encoding='utf-8') as f:
    for line in f:
        if line.strip():
            row = json.loads(line)
            by_caller[row['caller_hint']].append(row)
for caller, rows in sorted(by_caller.items()):
    wall = [r['wall_ms'] for r in rows]
    counts = [r['result_count'] for r in rows]
    print(caller, 'n=', len(rows), 'avg_wall_ms=', round(statistics.mean(wall), 1), 'avg_results=', round(statistics.mean(counts), 1))
PY
```

## Decision-matrix handoff

After 48 hours, copy the JSONL file into the follow-on analysis card artifact directory before pruning or restarting collection. Compute these values from the copied file:

- Total searches.
- Unique raw queries.
- Unique normalized queries.
- Normalization collision count, meaning normalized queries with more than one raw spelling.
- Caller mix and per-caller latency/result distributions.

Those five outputs are sufficient to decide whether the cache key should be raw query, normalized query, caller-scoped normalized query, or a hybrid with caller-specific bypass rules.

## Failure posture

Telemetry is best effort. Logging failures are swallowed so search never fails because the local state directory is missing, temporarily unwritable, or being rotated by another process. The absence of a row means the collection sample is incomplete, not that the search failed.

For collection windows, verify periodically with:

```bash
stat -f '%z bytes %Sm' ~/.local/state/gbrain/search-telemetry.jsonl
wc -l ~/.local/state/gbrain/search-telemetry.jsonl
```

If either command stops changing while searches are known to be happening, check that the running process includes the patched GBrain checkout and that `hybridSearch` is the path being exercised.
