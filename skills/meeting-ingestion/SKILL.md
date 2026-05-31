---
name: meeting-ingestion
version: 1.0.0
description: |
  Ingest meeting transcripts into brain pages with attendee enrichment, entity
  propagation, and timeline merge. Iron Law: a meeting is not fully ingested
  until the enrich skill has processed every entity mentioned. Use when asked to
  "meeting transcript", "process this meeting", or "meeting notes". Proactively
  invoke whenever a meeting transcript is received to ensure all entities are
  propagated.
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

### Don't trust the injected "Brain context" / WS-1D header — verify every attendee yourself

The session prompt sometimes carries a `[Brain context: WS-1D forcing function]` block that pre-classifies attendees as `NOT_IN_BRAIN (external fallback advisable)`. **This header gives false negatives.** Confirmed 2026-05-29: a Senturai-call header flagged TJ, Kelly Kellam, and Jay Bailey all as NOT_IN_BRAIN, but all three had canonical pages (`people/tj-shedd`, `people/kelly-kellam`, `people/jay-bailey`). Had the header been trusted, the ingestion would have created duplicate stub pages and split three entities.

Rule: the injected header is a hint, never an authority. Run `gbrain search "<name>"` and `gbrain get people/<slug>` (or `gbrain list | grep -i <lastname>`) on EVERY attendee before deciding create-vs-update, exactly as the slug-pitfall above requires. The verify-first discipline already in this skill is what catches the header's errors — do not skip it because the header "already told you."

If the header is wrong on people who are clearly in the brain repeatedly, that's worth a card against the WS-1D forcing-function lookup, not a reason to distrust the brain.

### Multi-part transcript arriving across several messages — grow ONE page idempotently, never create part-2/part-3 pages

A long call transcript often arrives split across multiple chat messages (and sometimes the first paste is the wrong/partial transcript that gets superseded by the full one). Confirmed 2026-05-29 (Clavis × Sentur.ai call): the transcript came in three messages, and an early paste was a truncated cold-open later replaced by the complete call.

Rules:
1. **One meeting = one slug, always.** Pick the canonical slug on the first paste (`meetings/<date>-<slug>`) and keep writing to it. Do NOT create `...-part2`, `...-continued`, or a second dated page. `gbrain put` to the same slug is idempotent — it overwrites/grows the page, and the auto-link pass reports `created: 0` on links that already exist (not an error, just "already wired").
2. **Stage the page body in a local file** (e.g. `/tmp/meeting.md`), then `gbrain put <slug> --content "$(cat /tmp/meeting.md)"`. When the next transcript chunk arrives, `patch` the staged file (grow Summary / Key Decisions / Action Items / Discussion Notes in place) and re-`put`. This keeps one coherent page instead of append-only fragments.
3. **If an early paste was wrong/partial**, just rewrite the body wholesale and re-put — the idempotent put replaces it cleanly. Re-run the Phase-5 timeline-add for any NEW entity introduced by the later chunk; entities already on the timeline don't need a second identical entry.
4. **Key Decisions / Action Items frequently live in the back half of a call.** A cold-open paste may legitimately have zero decisions; don't stamp "no decisions" as final until you've seen the whole transcript. Flag in the page that content is partial if you're mid-stream.
5. **Attendee-set test for "is this a new meeting or the same one?"** A paste labeled "follow-up" or "internal debrief with just us" that STILL has the external participants speaking is NOT a separate meeting — it's the tail of the main call, and belongs on the same page. A genuine internal debrief has ONLY the internal people as speakers. Confirmed 2026-05-29: a paste labeled "follow-up call with myself, Jay and Kelly" was actually the closing 5 min of the group call (Jan/Seth/Rasmus all still talking); the REAL debrief arrived in a later paste with only the three internal voices. The genuine internal debrief is the HIGH-VALUE artifact (the team's candid read, the real go/no-go) — file it as its own `meetings/<date>-<slug>-debrief` page and `gbrain link <debrief> <call> --type related_to`. Before creating any "new" same-day meeting page, grep the paste for distinctive phrases already on an existing same-day page (a quote, the goodbye sequence); if they match, it's the same call — update, don't duplicate. Always tell TJ when a paste is a duplicate/continuation; he may not realize the note-taker mis-stitched the clip.
6. **Do NOT force-link ambiguous first-name-only references.** A debrief naming "Justin", "Jason", or "Matt" with no surname may or may not map to an existing page (a `people/justin-williams` existed but with no confirmation it was the same Justin). Mention them in prose, leave them UNLINKED, and ask TJ who they map to. A wrong link poisons the graph; a missing one is recoverable.

## Pitfalls (discovered in real ingestions)

### Verify the transcript is what it's labeled before ingesting (dedup + attendee-set check)

TJ (and AI note-takers) frequently mislabel or duplicate transcripts. Seen
2026-05-29: TJ pasted "the full transcript," then "the follow-up call," then
"the recap with myself, Jay and Kelly" — and TWO of the three were the wrong
clip (a duplicate of the call's cold-open, and the group call's ending
mislabeled as a 3-person debrief). Before writing a new meeting page:

1. **Dedup check.** If the pasted content matches a meeting page you already
   wrote this session/day, do NOT create a second page. `gbrain get
   <suspected-slug>` and grep for distinctive phrases from the paste. If they're
   already there, say so and skip — re-ingesting duplicates the page and splits
   the entity graph.
2. **Attendee-set sanity check.** The speakers IN the transcript must match the
   meeting it claims to be. A "debrief between just A, B, C" transcript that has
   D, E, F speaking is mislabeled (it's the group call, not the debrief). Flag
   the mismatch to TJ rather than filing it under the wrong title.
3. **Flag thin transcripts.** A "cold open" (audio troubleshooting + intros,
   cut off mid-sentence) has zero decisions/action items. Ingest it faithfully
   but say so explicitly in the page and in your recap — don't pad the
   Discussion section with substance that isn't there.

When the transcript IS correct and substantive, the recap should lead with the
real outcome (decisions, action items, the partnership/diligence read), not a
restatement of who said hello.

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

### The inbound "Brain context / NOT_IN_BRAIN" header is advisory and frequently WRONG — never trust it as ground truth

A meeting-ingest prompt may arrive with an injected header like:

```
[Brain context: WS-1D forcing function]
- Kelly Kellam -> NOT_IN_BRAIN (external fallback advisable)
- TJ -> NOT_IN_BRAIN (external fallback advisable)
[/Brain context]
```

This forcing-function lookup produces FALSE NEGATIVES. Confirmed repeatedly 2026-05-29: a single Senturai-call ingest had TJ, Kelly Kellam, AND Jay Bailey all flagged `NOT_IN_BRAIN` across two consecutive messages — yet all three have canonical pages (`people/tj-shedd`, `people/kelly-kellam`, `people/jay-bailey`). If you had trusted the header and created new pages, you'd have split three core entities into duplicates and corrupted the graph.

**Rule:** the inbound header is a HINT, not authority. For EVERY attendee — including ones the header marks NOT_IN_BRAIN — run your own `gbrain search "<name>"` + slug verification (the Phase 3 step) BEFORE deciding to create vs update. The header's false negatives are exactly the entities most likely to already exist (your own principals/recurring contacts). When the header and your live `gbrain search` disagree, your live search wins; surface the discrepancy to TJ as a possible forcing-function bug (it is worth a card if it recurs), but do NOT let it drive a duplicate-create.

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
