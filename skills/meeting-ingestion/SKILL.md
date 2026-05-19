---
name: meeting-ingestion
version: 1.0.0
description: |
  Ingest meeting transcripts into brain pages with attendee enrichment, entity
  propagation, and timeline merge. A meeting is NOT fully ingested until the
  enrich skill has processed every entity.
triggers:
  - "meeting transcript"
  - "process this meeting"
  - "meeting notes"
  - meeting transcript received
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
mutating: true
writes_pages: true
writes_to:
  - meetings/
  - people/
  - companies/
---

# Meeting Ingestion Skill

> **Filing rule:** Read `skills/_brain-filing-rules.md` before creating any new page.

## Contract

This skill guarantees:
- Meeting page created with attendees, summary, key decisions, action items
- EVERY attendee gets a people page (created or updated)
- EVERY company discussed gets entity propagation
- Timeline entries on ALL mentioned entities (timeline merge)
- Meeting is NOT fully ingested until enrich runs for every entity
- Back-links created bidirectionally

> **Convention:** See `skills/conventions/quality.md` for Iron Law back-linking.

Every attendee and company mentioned MUST get a back-link from their page to
the meeting page. An unlinked mention is a broken brain.

## Phases

### Phase 1: Parse the transcript

Extract from the transcript:
- Attendees (names, roles if available)
- Date, time, duration
- Key topics discussed
- Decisions made
- Action items with owners
- Companies and projects mentioned

### Phase 2: Create meeting page

```markdown
# {Meeting Title} — {Date}

**Attendees:** {list with links to people pages}
**Date:** {YYYY-MM-DD}
**Duration:** {if available}

## Summary
{3-5 bullet key outcomes}

## Key Decisions
{Decisions with context}

## Action Items
{Tasks with owners and deadlines}

## Discussion Notes
{Structured notes by topic}
```

### Phase 3: Attendee enrichment (MANDATORY)

For EACH attendee:
1. `gbrain search "{name}"` — does a people page exist?
2. If NO → create via enrich skill (this is mandatory, not optional)
3. If YES → update compiled truth with meeting context
4. Add timeline entry on the person's page:
   `gbrain timeline-add <person-slug> <date> "Attended <meeting-title>"`

**Note (v0.10.1):** Once the meeting page is written via `gbrain put`, the
auto-link post-hook automatically creates `attended` links from the meeting
to each attendee whose page is referenced as `[Name](people/slug)`. You don't
need to call `gbrain link` for attendees. You DO still need `gbrain timeline-add`
for dated events (auto-link only handles links, not timeline entries).

### Phase 4: Entity propagation (MANDATORY)

For each company, project, or concept discussed:
1. Check brain for existing page
2. Create/update as needed
3. Add timeline entry referencing the meeting
4. Back-link from entity page to meeting page

### Phase 5: Timeline merge

The same event appears on ALL mentioned entities' timelines. If Alice met Bob at
Acme Corp, the event goes on Alice's page, Bob's page, AND Acme Corp's page.

### Phase 6: Sync

`gbrain sync` to update the index.

## Output Format

Meeting page created. Report: "Meeting ingested: {N} attendees enriched, {N} entities
updated, {N} action items captured."

## Anti-Patterns

- Creating the meeting page without enriching attendees
- Skipping entity propagation ("I'll do that later")
- Not merging timelines across all mentioned entities
- Creating attendee stubs without meaningful content
- Filing meeting pages without cross-linking to all participants

## Pitfalls (discovered in real ingestions)

### Attendee slug is not always `people/<firstname-lastname>`

Some people pages live under `people/wiki/<slug>` (legacy migration path) rather
than `people/<slug>`. Notable examples:
- TJ Shedd → `people/wiki/tj-shedd` (NOT `people/tj-shedd`)

**Before** running `gbrain timeline-add <person-slug>` or `gbrain link <meeting> <person-slug>`,
verify the slug exists:

```bash
gbrain list | grep -iE "people/.*<lastname>"
```

`gbrain timeline-add` fails with `page "<slug>" not found` if you guess wrong.
`gbrain put` will happily CREATE a new page at the wrong slug, splitting the entity
into two pages. Verify first, then write.

### Name-spelling drift between TJ's prompt and brain canonical

TJ frequently types names from memory and the spelling may not match the brain's
canonical record. Examples seen:
- "Matthew Snyder" in prompt → `Matthew Snider` in brain (and reality)
- "Kevin Kott" in prompt and even in older meeting page titles → `Kevin Cott` in reality (cottlawgroup.com). The older meeting page `meetings/2026-04-13-fund-call-...` actually contains both spellings, because the AI Companion misheard the name and the original ingestion preserved the typo. Don't propagate it forward.

When `gbrain search "<name>"` returns no results on a person you have reason to
believe is in the brain (because TJ references a prior meeting, ongoing project,
or recurring relationship), try common variants before concluding it doesn't exist:
- y ↔ i (Snyder ↔ Snider, Tyler ↔ Tiler)
- K ↔ C (Kott ↔ Cott, Karen ↔ Caren)
- last name only
- first name only with role/company keyword (e.g. `gbrain search "Matthew Block 3"`)

Only after exhausting variants should you create a new people page.

### Frontmatter `company:` field can auto-link unresolved if the company page doesn't exist yet

`gbrain put` runs an auto-link pass on the way in. If you write a person page with a frontmatter field like `company: Cott Law Group` and the `companies/cott-law-group` page does NOT yet exist, the response includes:

```json
"auto_links": {
  "unresolved": [
    { "field": "company", "name": "Cott Law Group" }
  ]
}
```

This is informative, not fatal — the page still writes. But the back-link from the company won't materialize until the company page exists. Two fixes, pick one:

1. **Write the company page FIRST, then the people page.** Auto-link resolves cleanly on the people write. This is the preferred order whenever you're creating a person + their employer in the same flow.
2. **Write people first** (e.g. you don't have firm details yet), then write the company page after. The auto-link pass on the company write will pick up the back-reference, OR you can explicitly run `gbrain link people/<slug> companies/<slug> --type partner_of` (or `employed_by`, `founded`, etc.) once both exist.

This matters more than it looks: an unresolved auto-link is a silent broken pointer. The pre-flight rule is the same as the slug-pitfall rule above — check what exists before you write.

### Source-of-truth fallback when email is the missing artifact

For multi-vendor, multi-month workstreams (SDW fund formation is the canonical example), the Zoom AI Companion meeting summary + transcript may be the ONLY thing reaching the brain. The corresponding email thread (Matthew Snider, Kevin Cott, Akram, Axos, NAV) returns zero hits when you Gmail-search either TJ's or Lex's accounts. Confirmed 2026-05-18: searched `from:matthew`, `Kevin Cott`, `Sovereign Digital PPM`, `State Harbor`, `Akram`, `Axos`, `NAV Consulting` against both `tj@hitnetwork.com` and `lex@hitnetwork.io` — all returned `No messages found`.

This means the email is somewhere we don't have a token for (personal Gmail, a Block 3 channel, Matthew's outbound only) and the brain cannot compound from primary source until we get it.

**Handling:**
1. Ingest the meeting transcript as canonical-for-now. Mark which decisions / dollar figures are transcript-sourced.
2. In the meeting page's `## Sources` or `## Open Threads` section, flag that the corresponding email correspondence is NOT in the brain and explain why (account where it lives is not indexed).
3. When TJ flags that the workstream produces real artifacts (zip files, PDFs, contracts), ask him to forward / drop them in a workspace folder explicitly. Don't assume Gmail-indexed-by-default.
4. For person pages tied to this workstream, cite the transcript meeting pages + any prior brain enrichment (`sdw-intelligence-brief-...`), and note that future enrichment is gated on receiving the primary documents.

This is a Hit-Network-specific pattern: SDW correspondence lives outside the Gmail accounts Lex can search. Same probably applies to TJSJ, family-office, and any personal-banking workstream. **Never assume "I have Gmail access" means "I have all of TJ's email."**
