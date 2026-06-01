# Namespace Fallback Discipline (brain-first lookup pitfall)

**Captured:** 2026-05-12 after a Lex failure in production.

## The incident

TJ asked Lex for his phone number. Lex's lookup sequence:

1. `gbrain search "TJ phone"` → returned 9 weak matches, none with a phone number
2. `gbrain get people/tj-shedd` → 404 (`Page not found: people/tj-shedd`)
3. **STOPPED HERE.** Concluded "no TJ page exists in the brain."
4. Created a stub page at `people/tj-shedd` with bare-bones content
5. Reported back to TJ: "you don't have a page, here's what's missing"

TJ pushed back: "How did I not have a person page, you're supposed to be tracking all kinds of information about me!?"

Lex re-ran the search using a different query (`gbrain query "what do we know about TJ Shedd personally"`) and found:
- `people/wiki/tj-shedd` — comprehensive profile, 4KB+, full bio
- `people/wiki/tj-shedd-comprehensive-profile` — even more detail
- `tj-shedd-comprehensive-profile` — bare-root duplicate
- `operations/wiki/tj-shedd` — third copy
- Plus family pages: `tj-shedd-family`, `tj-family`, `personal/people/alli-shedd`, `people/wiki/alli-shedd`, etc.

Real failure: the namespace assumption was wrong, the fallback discipline was missing, and Lex's stub-write polluted the brain with a duplicate.

## The rule

A 404 from `gbrain get <exact-slug>` is **NOT** proof the entity has no page. Person and entity pages exist across multiple namespaces in this brain because:

- Migration history: pages moved from `personal/people/` to `people/wiki/`, but not all sources got rewritten
- Entity-detector default namespace is `people/<slug>`, which collides with `people/wiki/<slug>` for the same human
- Some older work created bare-root slugs (no prefix) like `tj-shedd`, `tim-shedd`, `bryan-emory`
- `entities/<slug>` namespace is mixed-type, holds some persons (Adam Simons, Karpathy) alongside companies and concepts

When you need to verify an entity's brain coverage, exhaust this fallback chain before declaring "no page exists":

```
1. gbrain get people/<slug>            # the obvious guess
2. gbrain get people/wiki/<slug>       # post-migration canonical for older content
3. gbrain get personal/people/<slug>   # legacy namespace, especially family
4. gbrain get entities/<slug>          # mixed-type namespace
5. gbrain get <slug>                   # bare root (older sessions)
6. gbrain search "<name>"              # keyword fallback, catches typos and variants
7. gbrain query "<natural question>"   # hybrid search, last resort
```

If steps 1-7 all return nothing useful, THEN you can conclude no page exists. Even then, double-check: is the canonical_name spelled differently in frontmatter than you'd guess from the slug?

## Anti-pattern

**Never write a duplicate page when the exact-slug fetch fails.** Always run the fallback chain first. If you find an existing page at a different namespace, the right move is:

1. Read the existing page
2. Use it as context for your response
3. If filing a card to consolidate namespaces, file ONE card for the whole class of duplicates, not a one-off

Lex's stub-write created another duplicate that had to be deleted minutes later, plus a backlog card to audit the namespace mess. The duplicate was avoidable.

## Forcing function

When you find yourself about to write `gbrain put <slug>` for a person who you THINK might already exist:

1. Run the full fallback chain above
2. If ANY hit comes back, do NOT write. Patch the existing page instead.
3. If no hits come back, write only after a second pass with a fuzzy keyword search: `gbrain search "<firstname>"` and `gbrain search "<lastname>"` separately.

## Related skills

- `brain-ops` (parent) — Phase 1 lookup protocol
- `gbrain-architecture-ops` — when consolidating duplicate namespaces is the actual task
