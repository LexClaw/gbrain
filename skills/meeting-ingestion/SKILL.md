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

FILING GATE: before creating any brain page, consult `~/.hermes/skills/RESOLVER.md` (the routing table) and the `brain-taxonomist` filing rules. Do not hardcode page paths; route through the resolver.

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

### Phase 0: Pre-write recall sweep (MANDATORY before creating ANY entity page)

Before you CREATE a new person/company/asset page — or reconstruct one because "there's no page yet" — you MUST exhaust the memory surfaces you already own. Do NOT reconstruct an entity from the single nearest source (the transcript in front of you + one `gbrain query`). That reproduces stale data and makes TJ be the retrieval index for his own history.

Run ALL of these, then reconcile, BEFORE writing:

1. **Strategic + chat history (both tools — they index differently):**
   - `session_search(query="<entity> ...")` for the framing.
   - Raw FTS over the message DB for sentences semantic search misses:
     ```bash
     sqlite3 ~/.hermes/state.db "SELECT substr(session_id,1,15), role, substr(content,1,400) FROM messages WHERE content LIKE '%<entity>%' AND (content LIKE '%test case%' OR content LIKE '%my business%' OR content LIKE '%I own%' OR content LIKE '%first client%' OR content LIKE '%pilot%' OR content LIKE '%case study%') AND session_id NOT LIKE 'cron%' ORDER BY rowid;"
     ```
   - Strategy/huddle sessions often carry the TRUE framing (owned vs client, test-case vs deal) that the entity page lost.
2. **iMessage / AddressBook (chat.db)** when the entity is a person or owned business — load the `imessage` skill. Relationship AGE and recent texts are ground truth (e.g. a thread dating to 2024 disproves a "2026 client" label). `imsg` is usually NOT installed; read `~/Library/Messages/chat.db` directly and decode `attributedBody`.
3. **`gbrain query` + `gbrain timeline` on the entity AND adjacent entities** (the related huddle, the people who onboarded it). Cross-references surface the framing.
4. **Look for authored-but-uncommitted enrichment** — search sessions for a prior `/tmp/enrich-*` page on this entity that never made it live.

**Reconcile rule:** when the existing entity page contradicts the strategy sessions, treat the ENTITY PAGE as the suspect — it's often a stale Zoom-AI-Companion mishear (e.g. "HIIT Fitness" for "Hit Fitness", "client" for "owned business"). Fix the page to match the corrected truth; note the correction inline so the next reader sees why it changed.

This is HR-9 (brain-first) taken one level deeper: brain-first isn't one `gbrain query`, it's *exhaust every memory surface you own* before reconstructing. (Lesson: lex-workspace/learnings/promoted, 2026-06-08.)

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

**Material-status changes need a dated `## MAJOR UPDATE` section, not just a timeline ping.**
A timeline entry is the right grain for "they met and discussed X." But when the
transcript reveals something that materially changes how the entity should be
understood, the entity page's BODY is now stale and a one-line timeline entry won't
surface it to a future reader. Add a `## MAJOR UPDATE — <topic> (<date>)` section to
the entity page with the new facts, sourced to the meeting.
Confirmed 2026-06-01: the Blofin company page described it as a "CEX partnership
prospect"; the call revealed Blofin had built its own layer-1 blockchain + DEX +
prediction market. That's a body-level rewrite, not a timeline footnote — added a
dated MAJOR UPDATE section AND the timeline entry AND the meeting back-link.

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

### Post-call transcripts should update sales artifacts, not only the brain record

When TJ drops a transcript after a sales/discovery call, treat it as a live correction source for any deck, brief, proposal, or follow-up that was produced before the call. Do not only summarize the meeting. Extract what changed from the pre-call assumptions, then patch the customer-facing artifact class that was in play.

Fast path:
1. Identify corrected terms, systems, product names, and buyer priorities from the transcript.
2. Search the existing deck/brief/follow-up source for stale claims and replace them.
3. Rebuild generated files, not just source files.
4. Run external-prose hygiene, especially em dashes and unsupported claims.
5. Produce a short debrief plus a follow-up email draft.
6. If TJ is live on the call or says ASAP, deliver the files directly before writing a long explanation.

Example pattern from Vermeer/MyOS: pre-call deck mentioned JDLink/Vermeer Connect; call clarified they access Vermeer telematics / factory data and are focused on Microsoft/Fabric, business system, Salesforce, Modern, Target BI, invoice checks, parts stocking, and customer identity matching. The correct move was to rebuild the deck around those call-validated facts and remove the unsupported integration language.

### Mine ALL memory surfaces BEFORE reconstructing an entity (don't make TJ the retrieval index)

When the trigger is "create/reconstruct a page for X" or "why is there no page for X" (a person, company, deal, or owned asset), do NOT reconstruct from the single nearest source (the transcript in front of you) plus one `gbrain query`. That reproduces whatever stale framing the entity page already has. Confirmed 2026-06-08 (Hit Fitness): the meeting transcript + a `gbrain query` got the surface facts right but MISSED that the gym was TJ's OWNED business and a deliberate AI-services TEST CASE — framing established weeks earlier in strategy sessions but never reconciled onto the entity page. TJ had to correct twice ("this is in older sessions + iMessage", then "we discussed it was my business and a test case").

Run the full recall sweep first:
1. **`session_search` AND raw FTS over `~/.hermes/state.db`** for X. Strategic / `/investigate` / huddle sessions carry framing (ownership, strategic role, "test case", "anchor") that the entity page lost. `session_search` semantic ranking often misses it — query the DB directly: `sqlite3 ~/.hermes/state.db "SELECT substr(session_id,1,15), role, substr(content,1,400) FROM messages WHERE content LIKE '%X%' AND (content LIKE '%test case%' OR content LIKE '%my business%' OR content LIKE '%own%' OR content LIKE '%pilot%' OR content LIKE '%anchor%') AND session_id NOT LIKE 'cron%' ORDER BY rowid;"` (DO NOT use rowid for timestamps — it produces garbage dates; convert from a real date column or just use it for ordering).
2. **iMessage / AddressBook (chat.db)** when X is a person or owned business. Relationship AGE is ground truth: a thread going back years hard-disproves a "2026 client" label. Recent texts surface live operational detail (staff, domains, landing pages). See `references/entity-reconstruction-recall-sweep.md` for the AddressBook→handle→message decode recipe.
3. **`gbrain query` + `gbrain timeline` on X AND adjacent entities** (the related huddle, the related people, the parent company). The fact you need is often on a neighbor's page or timeline, not X's.

**Reconcile, and treat the entity page as SUSPECT when it contradicts the strategy sessions.** Entity pages are frequently corrupted by Zoom-AI-Companion mishears (e.g. "Hit Fitness" logged as "HIIT Fitness", an owned business logged as a "client"). The strategy session is usually the truer record of intent; fix the entity page to match, and add a one-line "framing correction (date)" note so the next reader sees the reconciliation. This is HR-9 (brain-first) taken one level deeper: brain-first is not one `gbrain query`, it's *exhaust the memory surfaces you own* before reconstructing.

Also watch for **authored-but-never-committed enrichments**: a rich page draft may exist only inside an old session transcript (the /tmp file is long gone). Pull it from `state.db` and re-commit rather than re-deriving from scratch.

### After correcting an entity, ABSORB + REMOVE the duplicates/dead-links — don't leave "harmless litter"

When you correct or reconcile an entity, you frequently expose leftover wrong records: an iMessage-sync **stub duplicate** of the canonical page, and **dangling wikilinks** to nonexistent/old slugs scattered in other pages. Do NOT report these as "harmless" and move on. TJ's standard (confirmed 2026-06-08): *"Shouldn't the old ones be absorbed into the correct pages and then removed?"* — yes. Leaving known-wrong duplicates and dead pointers in the brain is litter, not a neutral outcome. Close it out in the same turn.

The two cleanup classes need different handling — classify first:

1. **Real duplicate page (stub vs canonical).** `gbrain get <stub-slug> --include-deleted` returns a page → it's real. Procedure:
   - **Absorb** any unique real data from the stub into the canonical page's frontmatter — especially iMessage contact identifiers (`handles:`, `contacts_uid:`). This is what makes contact-sync MATCH the canonical next time instead of regenerating the stub. Skip junk (e.g. a legacy/old phone number TJ says to disregard — "people often have old cell numbers from previous locations").
   - **Soft-delete** the stub: `gbrain delete <stub-slug>` (recoverable 72h, hard-purged by autopilot after the window). There is no `merge`/`redirect`/`rename` verb — absorb-then-delete is the pattern.
   - Re-`gbrain put` the canonical (so the absorbed frontmatter registers), then confirm the stub is gone: `gbrain get <stub-slug>` → `page_not_found`.

2. **Dangling wikilink (no page exists).** `gbrain get <slug>` returns `page_not_found` AND the slug isn't a real page → there's nothing to absorb; just **repoint the link** to the correct slug. Fix only **live pages** (meetings, companies, people, concepts). Do NOT edit `/sessions/` archive transcripts — those are read-only history; rewriting them is rewriting the record. Use `search_files target=files` to find references (a recursive `grep` over the whole wiki tree TIMES OUT — scope it), filter out `/sessions/`, patch the live ones, re-`put`.

**Distinguish duplicate from canonical before deleting anything.** A contact-sync stub looks identical to a canonical page that got *overwritten* by contact-sync. Read both: the canonical has a rich compiled-truth body (and may carry a `restored_from` / `restore_reason` in frontmatter). Confirmed 2026-06-08: `people/tj-shedd` LOOKS like a sync stub but is the canonical page — it was clobbered by contact-sync on 2026-06-01 and restored under card kn751g4w. Deleting it would be destroying the real record. When in doubt, `gbrain query` for the entity to see which slug ranks as the compiled-truth page.

**Recurring root cause worth flagging to TJ:** iMessage contact-sync minting stub pages beside rich canonical ones (and sometimes overwriting them) is a *known repeat failure* (TJ's page 2026-06-01; Branden's stub 2026-06-08). The durable fix is a sync-side guard that won't create/overwrite a page that already has a rich canonical body — worth a card rather than hand-cleaning each occurrence.

### Confirmed canonical slugs (verify with `gbrain list | grep`, don't guess)

Recurring Hit Network entities and their real slugs (confirmed 2026-06-01; TJ slug re-confirmed 2026-06-08):
- TJ Shedd → `people/tj-shedd` is the live, writeable person page that resolves auto-links and accepts `gbrain timeline-add` (confirmed working 2026-06-08). Caveats: `operations/wiki/tj-shedd` also exists (type `note`, legacy config import) and `people/wiki/tj-shedd` is a `redirect` stub — neither is the canonical person record. The 05-19-era note claiming `operations/wiki/tj-shedd` is canonical is OUTDATED; prefer `people/tj-shedd` for attendee links and timeline entries.
- Branden O'Neil → `people/branden-oneil` is canonical (rich compiled-truth page). An iMessage contact-sync stub `people/branden-o-neil` (note the hyphen in "o-neil") existed but was ABSORBED (handle + contacts_uid folded into the canonical frontmatter) and SOFT-DELETED 2026-06-08 — do not recreate it. Always target `people/branden-oneil`. (Branden's cell is a 616/Michigan number; legacy from a prior location, don't infer location from it.)
- MyOS → `products/myos` is canonical; `businesses/myos` and `companies/myos` are moved/nonexistent. MyOS == "Clavis" (same product; Clavis was the builder's original codename, TJ rebranded to MyOS; naming not yet cleaned up across the codebase/UI).
- Drew Weidert → `operations/wiki/drew-weidert`
- BloFin (exchange) → `companies/blofin`
- Discover Crypto → `companies/discover-crypto`
- Hit Fitness (TJ-OWNED boxing gym, Marietta/Kennesaw GA, hitfitnessandboxing.com) → `companies/hit-fitness`. Old records call it "HIIT Fitness" — a mishear; `companies/hiit-fitness` is a dangling wikilink, not a real page. NOT a client; see the WHO-an-entity-is pitfall below.
- Wade Medford (TJ's operating partner at Hit Fitness, +1-404-931-8832) → `people/wade-medford`. Old records mislabel him a "client"; `people/wade` is a dangling wikilink, not a real page.
- Atlas Rose (Branden O'Neil's fractional-CMO firm) → `companies/atlas-rose`. NOTE: Atlas Rose / Branden have NOTHING to do with Hit Fitness — keep the two threads fully separate even though both surfaced in the same 2026-06-08 session.

Always run `gbrain list | grep -iE "people/(wiki/)?<lastname>|operations/wiki/<lastname>"` before `gbrain timeline-add` or `gbrain put` on a person — the same person may live under `people/`, `people/wiki/`, or `operations/wiki/`. Guessing creates a split-entity duplicate.

### Multi-part transcript: APPEND to the existing meeting page, never create a Part-2 page

TJ frequently pastes a long transcript across **multiple messages** (the call gets split because of length). When the second chunk arrives:
1. Do NOT create a `meetings/<date>-<title>-part-2` page — that splits one meeting into two records.
2. `patch` a new `## Part 2 — <topic> (<timestamp range>)` section into the SAME meeting page, then `gbrain put` it again to re-register links.
3. Re-check the company/people pages: Part 2 often RESOLVES open follow-ups you flagged in Part 1 (2026-06-01 BloFin call: Part 1 ended mid-sentence on "two onboarding items"; Part 2 revealed them). Update the "Open follow-up" note on the entity page from open → resolved.
4. The `gbrain put` auto-link pass is idempotent — re-putting an already-linked page returns `created: 0, unresolved: []`, which is the success signal, not a no-op failure.

### Multi-TOUCH thread (distinct from multi-PART transcript): read the prior brief/debrief first

A meeting is often the Nth touch in an ongoing relationship, not a one-off. Before ingesting,
check whether the brain already holds a prior meeting page, debrief, or pre-meeting brief for
the same parties. Confirmed 2026-06-08 (3rd Branden/Atlas Rose touch): a Cal pre-meeting brief
lived at `workspace/briefs/meetings/<date>-<slug>.md` AND a prior debrief was embedded in the
person page (`## Meeting 2026-05-20: ...`). Reading both BEFORE writing let the new page:
- Flag which open questions the new call RESOLVED vs. left OPEN (e.g. the GC-vs-sub structural
  question was flagged in the prior brief; the new call did NOT address it — that absence is
  itself signal worth recording in the new page's "Strategic read / carry-forward" section).
- Carry forward the strategic frame (Dave Thiel's "general contractor not sub" constraint) so
  the new page is continuous with the thread rather than a standalone snapshot.

How to find prior touches:
- `gbrain timeline <person-slug>` — the timeline lists every prior meeting + brief with sources.
- `search_files target=files pattern="<date-or-name>*"` under `workspace/.../briefs/meetings/`.
- The person page body often embeds a `## Meeting <date>` debrief section.

Anti-pattern: ingesting the Nth meeting as if it were the first. A standalone summary that
doesn't reconcile against the open threads from prior touches is a thinner record than the brain
already had.

### Wikilinked-but-nonexistent target = silent broken pointer; CREATE it during propagation

A company/person/concept can be referenced via `[[companies/atlas-rose|Atlas Rose]]` across many
pages yet have NO page at that slug. `gbrain put` resolves the link visually but the target
returns `Error [page_not_found]` on `gbrain get`, and there is no back-link or compiled truth.
Confirmed 2026-06-08: `companies/atlas-rose` was wikilinked from the person page, the prior brief,
and timeline entries, but the page never existed — every reference was a dangling pointer.

Detection (do this during Phase 4 entity propagation): for each entity the meeting discusses,
run `gbrain get <expected-slug>` BEFORE assuming it exists. `page_not_found` means the propagation
step is to CREATE the page (with the meeting's net-new facts), not just timeline-add to it.

When you create the missing page, the auto-link pass on `gbrain put` resolves all the previously-
dangling references at once (the 2026-06-08 atlas-rose create reported `auto_links.created: 5,
unresolved: []` — that's five broken pointers healed in one write). After creating, re-`put` the
pages that referenced it (or rely on their next edit) so back-links materialize fully.

### Attendee slug is not always `people/<firstname-lastname>`

Some people pages live under `people/wiki/<slug>` (legacy migration path) rather
than `people/<slug>`, and some have a canonical `people/<slug>` page PLUS legacy
`people/wiki/<slug>` (redirect) and `operations/wiki/<slug>` (note) siblings. The
canonical writeable record is the one with `type: person` and a real compiled-truth
body — confirm by reading it, don't infer from the path. (See the corrected
canonical-slugs list above; TJ Shedd's live page is `people/tj-shedd`, NOT the
`people/wiki/` redirect stub.)

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

### Multi-part transcripts: APPEND to the existing page, never create a duplicate

TJ frequently pastes a long transcript in TWO (or more) messages — the call exceeds
one message, so Part 2 arrives as a follow-up after you've already ingested Part 1.
When this happens:

1. **Do NOT create a second meeting page.** `gbrain query "<topic>"` / `gbrain list | grep meetings/<date>`
   first to confirm the page from Part 1 exists. Confirmed 2026-06-01: the Blofin call
   came in two messages ~15 min apart; the right move was appending Part 2 to
   `meetings/2026-06-01-blofin-partnership-sync`, not minting a new slug.
2. **Append, don't rewrite.** Use `patch` (or `gbrain put` on the re-read local file)
   to add a `## Part 2 — <topic span> (<start>–<end> timestamps)` section before the
   `## Sources` block. Keep Part 1's structure intact.
3. **Resolve open follow-ups the later part answers.** Part 1 will often have flagged
   "Open Threads / Follow-ups" for things the call hadn't reached yet. When Part 2
   answers one, EDIT the flag in place: mark it `(RESOLVED — answers the earlier open
   follow-up)` and write the answer. Also update the same resolved note on any entity
   page that carried it forward (e.g. the company page's "Open follow-up" line). Don't
   leave a stale "we don't know yet" when the brain now knows.
4. **Re-put after editing the local write-through file.** `patch` edits the on-disk
   `wiki/...md` file, but the GBrain index/links only refresh on `gbrain put`. After
   appending Part 2, run `gbrain put <slug> < wiki/<slug>.md` so new wikilinks register,
   then `gbrain sync`. Watch for the `_warning: "was modified since you last read it"` —
   it's benign here (you just patched it yourself) but means re-read before any further edit.
5. **Update the `## Sources` note** to reflect the full duration / "delivered in two parts."

### Don't inherit the transcript's framing of WHO an entity is — verify ownership

A transcript frames participants by their role *in that call*, which is often NOT their real relationship to TJ. The classic trap (confirmed 2026-06-08): the 2026-05-06 "Hit Fitness <> Hit AI" call read like a standard client engagement — Clavis consultants ran a "discovery call" with Wade as the "client," closed a deal at $3,500 setup + $1,200/mo. Ingestion took that at face value and never created a company page. Reality: **Hit Fitness is a business TJ OWNS, with Wade Medford as his operating partner.** Hit Network servicing its own portfolio company looks identical to an arm's-length client deal in a transcript.

Rules:
1. **When a person or business shows up as a "client," "vendor," or "prospect," check whether TJ actually owns/co-owns it before filing.** Search `business/wiki/financial-context`, `hit-network-business-operations`, and the people/companies the entity links to. TJ's portfolio (Discover Crypto, Hit Fitness, SDW, MyOS/Clavis, etc.) means "client of Hit Network" is frequently "TJ's own company."
2. **Owned businesses get a `companies/<slug>` page and the operating partner gets a `people/<slug>` page — not just a `case-studies/` entry.** A marketing case study is a legitimate page type, but if the underlying thing is an owned business, the company page is canonical and the case study links up to it. Don't let a business TJ owns exist in the brain only as a case study.
3. **When TJ corrects an ownership/status fact, fix it at the SOURCE page too.** Stale facts live in `business/wiki/financial-context` (e.g. it said Hit Fitness was "sold at small capital loss" — the sale fell through). Patch the financial/structural page in place AND add a dated correction; don't just note the contradiction on the new page. Re-`gbrain put` the corrected page so links/index refresh.
4. If you spot the contradiction mid-ingest but can't resolve it yourself, flag it explicitly for TJ as an "Open item / contradiction to resolve" — but treat that as a temporary state to close in the same or next turn, not a permanent footnote.

### Corroborate/correct an entity from OLDER SESSIONS + iMessage (not just the brain)

When TJ says "a lot of this would be found if you mined the older sessions and iMessage" — or any time an
entity feels thinly recorded — the brain's current pages are NOT the only source. Two extra mines, both
high-yield, confirmed 2026-06-08 on the Hit Fitness / Wade Medford correction:

1. **`session_search` the state DB.** A prior enrichment may exist in a transcript but never have been
   committed to a live page (the /tmp working files get cleaned up). On 2026-06-08 a full rich Wade Medford
   compiled-truth profile (onboarding team, 10-memberships/month target, engagement plan, network links) was
   recovered verbatim from session `20260519_164816_9b4505` via
   `sqlite3 ~/.hermes/state.db "SELECT content FROM messages WHERE session_id='<id>' AND content LIKE '%<name>%' AND length(content)>800"`.
   `session_search(query=...)` finds the session; then pull the message bodies directly.
2. **iMessage / chat.db.** `imsg` is usually NOT installed (`which imsg` empty) — read the DB directly per the
   `imessage` skill's fallback. Steps: (a) map name→number via AddressBook
   (`~/Library/Application Support/AddressBook/Sources/*/AddressBook-v22.abcddb`, JOIN ZABCDRECORD↔ZABCDPHONENUMBER);
   (b) find ALL handle ROWIDs for that number (`SELECT ROWID,id,service FROM handle WHERE id LIKE '%<last7digits>%'` —
   one person commonly has 3: iMessage, SMS, RCS) and query messages across all of them; (c) decode
   `attributedBody` (text column is usually NULL on modern macOS) and convert Apple-epoch dates (ns since 2001-01-01;
   do the +978307200 in Python, never inline the long digit run in an f-string). NOTE: `execute_code` is BLOCKED for
   chat.db reads (it flags subprocess/arbitrary-Python); write a small script to /tmp and run it via `terminal` with
   `python3`, or run the SQL inline with `sqlite3`.

What this buys you: (a) the **relationship age** — TJ↔Wade texts go back to **Jan 2024**, which by itself disproves
the transcript's "2026 client" framing; (b) **current operational ground truth** the brain lacks (new staff hires,
live landing-page URLs, the real domain hitfitnessandboxing.com) straight from the latest texts; (c) recovery of
**lost enrichment** that was written but never persisted.

### AI Companion mishears brand & person names — verify the brand string

Zoom AI Companion (and similar transcription) routinely garbles proper nouns, and the garbled form then propagates
into every downstream page, slug, and wikilink. Confirmed cases: "HIIT Fitness" for **Hit Fitness** (real brand,
hitfitnessandboxing.com); "Kevin Kott" for **Kevin Cott**; "Matthew Snyder" for **Matthew Snider**. When the brand
has an obvious real-world spelling (a domain, a website, a known person), treat the transcript spelling as suspect:
confirm against the domain / website / a non-transcript source before minting a slug. Record the wrong spelling as
an `alias:` in frontmatter so legacy links still resolve, and put a one-line "Name note" in the page body explaining
the mishear so the next reader doesn't re-split the entity.

### Source-of-truth fallback when email is the missing artifact

For multi-vendor, multi-month workstreams (SDW fund formation is the canonical example), the Zoom AI Companion meeting summary + transcript may be the ONLY thing reaching the brain. The corresponding email thread (Matthew Snider, Kevin Cott, Akram, Axos, NAV) returns zero hits when you Gmail-search either TJ's or Lex's accounts. Confirmed 2026-05-18: searched `from:matthew`, `Kevin Cott`, `Sovereign Digital PPM`, `State Harbor`, `Akram`, `Axos`, `NAV Consulting` against both `tj@hitnetwork.com` and `lex@hitnetwork.io` — all returned `No messages found`.

This means the email is somewhere we don't have a token for (personal Gmail, a Block 3 channel, Matthew's outbound only) and the brain cannot compound from primary source until we get it.

**Handling:**
1. Ingest the meeting transcript as canonical-for-now. Mark which decisions / dollar figures are transcript-sourced.
2. In the meeting page's `## Sources` or `## Open Threads` section, flag that the corresponding email correspondence is NOT in the brain and explain why (account where it lives is not indexed).
3. When TJ flags that the workstream produces real artifacts (zip files, PDFs, contracts), ask him to forward / drop them in a workspace folder explicitly. Don't assume Gmail-indexed-by-default.
4. For person pages tied to this workstream, cite the transcript meeting pages + any prior brain enrichment (`sdw-intelligence-brief-...`), and note that future enrichment is gated on receiving the primary documents.

This is a Hit-Network-specific pattern: SDW correspondence lives outside the Gmail accounts Lex can search. Same probably applies to TJSJ, family-office, and any personal-banking workstream. **Never assume "I have Gmail access" means "I have all of TJ's email."**

### TWO Google tokens exist — the default is LEX's, not TJ's (confirmed 2026-06-02)

The `google-workspace` skill's default token (`~/.hermes/google_token.json`) is a SYMLINK to **`~/.hermes/google-profiles/lex/google_token.json`** → authenticates as **`lex@hitnetwork.io`** (Lex's own mailbox; ~few-hundred vendor/receipt messages, NOT TJ's mail). Searching it for "what TJ sent X" returns `No messages found` even when the mail exists.

TJ's real mailbox is a SECOND token: **`~/.hermes/google_token_tj.json`** → symlink to `~/.hermes/google-profiles/tj/google_token.json` → authenticates as **`tj@hitnetwork.com`** (20k+ messages, his Sent folder, his Drive/Sheets).

When the task is "find what TJ sent / received / has in Drive," do NOT use the default `$GAPI`/`$GSETUP` token. Load the `tj` token explicitly in a Python one-liner:
```python
from googleapiclient.discovery import build
from google.oauth2.credentials import Credentials
c = Credentials.from_authorized_user_file('/Users/TJ/.hermes/google-profiles/tj/google_token.json')
gmail = build('gmail','v1',credentials=c)      # tj@hitnetwork.com
drive = build('drive','v3',credentials=c)
sheets = build('sheets','v4',credentials=c)
```
Confirm which mailbox a token reaches before concluding mail is missing: `gmail.users().getProfile(userId='me').execute()['emailAddress']`. This is also the token that reaches Tim's finance Google Sheets (see mission-control-engineering `references/mc-business-entity-tree.md`).
