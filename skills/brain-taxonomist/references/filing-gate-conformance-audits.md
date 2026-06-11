# Filing Gate Conformance Audits

Use this reference when auditing whether brain-writing skills need a filing gate.

## Key distinction

Brain-first and filing-gate are different conventions.

- **Brain-first lookup**: before answering about a person, company, deal, meeting, concept, idea, or decision, search/query/get existing brain context before external fallback.
- **Filing gate**: before creating any new brain page, consult the resolver plus `brain-taxonomist`, then file according to the active schema pack. Do not hardcode page paths unless the active schema or a shared filing-rules doc explicitly sanctions the path.

A script or patch that inserts only a brain-first lookup callout does not satisfy filing-gate conformance.

## Classification rule

Classify a skill as one of three buckets:

1. **True brain-writer-needs-gate**
   - Creates new brain pages, tracker pages, report pages, meeting notes, originals, ideas, concepts, entity pages, or bulk import outputs.
   - Uses or documents `put_page`, `gbrain put`, `put_raw_data`, or page creation as part of its normal pipeline.
   - Should have `mutating: true`, `writes_pages: true`, a `writes_to:` declaration, and a body `FILING GATE` callout.

2. **Exempt**
   - Updates existing pages in place, appends timeline entries, repairs frontmatter, fixes citations, repairs links, merges duplicates, or mutates graph edges without deciding where a new page goes.
   - These still need citation, backlink, snapshot, and safety discipline, but they do not need a new-page filing gate.

3. **False positive**
   - Mentions `gbrain put` or brain writing inside examples, quotes, incident references, smoke tests, infrastructure recipes, or meta-checklists.
   - The skill's actual behavior is not brain-page creation.

## Shared filing rules doc check

During filing-gate conformance audits, verify whether the active skill tree has a shared filing rules document that skills can consult. Check the active skills root first, not just upstream examples:

- `~/.hermes/skills/_brain-filing-rules.md`
- `~/.hermes/skills/_brain-filing-rules.json`

If only an upstream clone such as `~/gbrain/skills/_brain-filing-rules.md` exists, record that as a gap for Hermes skills that use relative links or expect the shared doc in the active skill tree.

## Safe fixer shape

If remediation is approved, use a separate filing-gate fixer rather than repurposing a brain-first autofix script.

A safe fixer should:

1. Target an explicit allowlist from the audit, not a broad heuristic.
2. Insert a body callout near the top of the skill: `FILING GATE: before creating any brain page, consult RESOLVER.md and brain-taxonomist; do not hardcode page paths.`
3. Add `writes_pages: true` and `writes_to:` only when the target paths are unambiguous.
4. Refuse to guess `writes_to:` for dynamic recipe-defined paths without operator review.
5. Leave exempt update/repair/linking skills untouched.
6. Dry-run first and output a manifest of proposed changes.
