# Research Artifact Schema

The research artifact is the structured JSON object Cal returns after researching one
candidate page. It is the contract between Phase 2 (research dispatch) and Phase 3
(quality gate + merge). Cal does NOT write directly to the brain; it emits one of these
artifacts, which a downstream quality gate validates and then synthesizes into the page.

## Iron Law

Every claim must cite. `claims[].citation.url` and `claims[].citation.quote` are both
required. A claim with an empty, missing, or whitespace-only citation field is a
fabricated claim and the artifact MUST fail downstream validation.

This rule is enforced at two layers:

1. `scripts/run_research.py` validates the artifact shape post-dispatch and exits 2 on
   any missing top-level key or any claim with an empty `citation.url` or
   `citation.quote`. Heartbeat records `schema_validation_failed`.
2. The Phase 3 quality gate re-checks the Iron Law plus a non-destructive-edit rule
   before any synthesize merge touches the page.

## Top-level shape

```json
{
  "target_slug": "people/tom-blomfield",
  "researched_at": "2026-05-22T03:14:00Z",
  "researcher": "cal-subagent",
  "queries_run": [
    {"query": "Tom Blomfield Y Combinator partner", "source": "web", "result_count": 8}
  ],
  "claims": [
    {
      "text": "Tom Blomfield is a YC General Partner since 2021.",
      "citation": {
        "url": "https://www.ycombinator.com/people/tom-blomfield",
        "fetched_at": "2026-05-22T03:14:05Z",
        "quote": "Tom joined YC as a Group Partner in 2021."
      },
      "section_hint": "## Role"
    }
  ],
  "structured_facts": [
    {"key": "role", "value": "General Partner", "org": "y-combinator", "since": "2021"}
  ],
  "suggested_links": [
    {"type": "partner_at", "target": "companies/y-combinator"}
  ],
  "narrative_additions": [
    {
      "section": "## Public Thesis",
      "text": "Believes consumer fintech wins via radical product polish, not feature breadth.",
      "citation_indexes": [0]
    }
  ]
}
```

## Field reference

- `target_slug` (required, string): the slug of the candidate page being enriched.
  Format `<type>/<slug>` e.g. `people/tom-blomfield`.
- `researched_at` (required, ISO8601 UTC string): when Cal finished the research run.
- `researcher` (required, string): identity tag. For this recipe always
  `"cal-subagent"`. Future researchers (multi-agent ensembles) get distinct tags.
- `queries_run` (required, array): every query Cal executed, in order.
  - `query` (string): the literal search string sent.
  - `source` (enum): `x | web | news | crunchbase | academic | linkedin | page_grep`.
  - `result_count` (int): number of results returned by that source for that query.
- `claims` (required, array): atomic factual claims Cal extracted. Each MUST cite.
  - `text` (string): one-sentence factual claim suitable for inline insertion.
  - `citation.url` (required, string): primary source URL.
  - `citation.fetched_at` (required, ISO8601 UTC string).
  - `citation.quote` (required, string): verbatim substring from the source that
    supports `text`. No paraphrase.
  - `section_hint` (optional, string): which markdown section the claim belongs in
    (`"## Role"`, `"## Background"`, etc.).
- `structured_facts` (optional, array): typed key/value pairs for the page's `## Facts`
  fence. Free-form schema per fact type; consumer in Phase 3 maps to gbrain's typed
  metric claim shape where applicable.
- `suggested_links` (optional, array): cross-links Cal proposes adding to the page.
  - `type` (string): edge type (`partner_at`, `founded`, `mentions`, etc.).
  - `target` (string): target slug.
- `narrative_additions` (optional, array): prose blocks to insert into existing sections.
  - `section` (string): markdown heading where the prose goes.
  - `text` (string): the prose itself.
  - `citation_indexes` (int array): indexes into `claims[]` that back the prose.

## Test fixtures

Three fixture files under `tests/fixtures/` exercise the schema and downstream gates:

- `research_artifact_good.json`: every claim cited, narrative additions target a thin
  (<30 words human prose) section, all structural keys present. This is the happy path
  the run_research.py validator must accept.
- `research_artifact_fabricated.json`: one claim has `citation.url = ""`. The Iron Law
  rejects this; run_research.py exits 2 and the quality gate refuses the artifact.
- `research_artifact_destructive.json`: a `narrative_additions` entry targets a section
  that already contains >30 words of existing human prose. Schema-wise valid; the
  Phase 3 non-destructive-edit gate rejects it (Phase 2 ships the fixture; Phase 3
  ships the gate).
