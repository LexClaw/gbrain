# GitHub Repo Ingestion (depth pattern)

When TJ shares a GitHub repo (or a tweet announcing one + the repo links), the goal
is NOT a "what's in this repo" summary. It's a **concept page** that captures the
architectural thesis, the lineage of ideas, and an explicit "relevance to Hit Network"
section. Repos are class-level knowledge, not media artifacts. File them at
`concepts/<repo-name>` (or `concepts/<topic>/<repo>` for a topic family), NOT
`media/repos/...`.

## Fetch pattern (use this order)

1. **Landing page first** (project marketing site if one exists, e.g. `printingpress.dev`).
   This gives you the public thesis in the author's own words and the polished framing
   they want people to remember.
2. **Main repo README** via raw GitHub: `curl -sL https://raw.githubusercontent.com/<owner>/<repo>/main/README.md`
3. **Companion repo READMEs** (libraries, examples, related repos linked from the main one).
4. **The launch tweet or announcement** (use `x-article-ingest` for full text + metrics).
   The bookmark-to-like ratio is a strong signal of how much the audience wants to
   actually use the thing vs. just admire it.

Don't clone unless you actually need to grep code. README + landing page is usually
enough for the concept page; clone only when the question is implementation-level.

## Required sections in the concept page

A good GitHub-repo concept page has all of these:

1. **The thesis (verbatim).** Quote the author's one-line framing of why the project
   exists. Verbatim, with `[Source: ...]` citation. The author's exact language IS
   the insight (per the ingest skill's anti-paraphrase rule).
2. **Architectural pillars** as a numbered list. What are the 3-7 design choices
   that make this thing different? Not features, design choices.
3. **Lineage / inspirations.** Who did they cite? What prior work are they building
   on? This is where you find adjacent people worth creating brain pages for.
4. **Notable quotes worth keeping** as a short section. Highest-value sentences
   from the docs, verbatim.
5. **Relevance to Hit Network.** THIS IS THE SECTION THAT MATTERS. Three sub-bullets:
   - **Competitive read:** is this competition, complement, or replacement for something we ship?
   - **Pattern to steal:** what architectural idea applies to our work even if we never use the tool?
   - **Tool to actually try:** is there a specific binary/skill from the repo that fits a current need (Clavis, MyOS, GBrain, etc.)?
6. **Install / quick reference** as a tight code block. Future-you wants the command, not a tutorial.
7. **Timeline entry** for the launch date.

## Entity propagation (don't skip)

For each repo:

- **Author(s):** create `people/<firstname-lastname>` for each, even if they're just a
  GitHub handle. Pull bio from X (`xurl /2/users/by/username/<handle>`) or GitHub
  profile. The `description` field on the X user object is gold.
- **Co-builders and explicit collaborators:** mentioned in the announcement tweet
  via `@handle`, in the README "built with" section, or in the catalog's "Printed by"
  attribution. Each gets a person page.
- **Inspirations / cited prior art:** mentioned authors of related projects (e.g.
  Peter Steinberger for discrawl/gogcli). Stub page is fine if you don't know much
  yet, but create it so links resolve.
- **Adjacent companies:** if the author lists prior exits in their bio (e.g. June ->
  Weber Grills, the co that became Lyft), those companies are worth a stub
  `companies/<slug>` if they're potentially relevant.

## Catalog repos (the library pattern)

Some repos ARE catalogs (printing-press-library has 87 sub-tools). Don't write
a brain page per sub-tool. Instead:

- One umbrella concept page for the catalog itself
- A "notable entries" subsection that filters down to ones with direct Hit Network
  relevance (5-15 entries max, with one-line rationale each)
- Mark the rest as "browse the full catalog at <URL>" and stop

Filing 87 brain pages for a single repo's sub-binaries is anti-compounding. The
catalog page IS the index.

## Auto-link verification

After `gbrain put`, check the `auto_links` block in the response:

```json
"auto_links": { "created": 3, "removed": 0, "errors": 0, "unresolved": [] }
```

`unresolved` is the watch-list. If a `[Person Name](people/slug)` reference fails to
resolve, either (a) the page doesn't exist yet so go create the stub, or (b) you
got the slug wrong. Either way, fix before declaring done.

## What "good" looks like

Reference example: `concepts/printing-press` written 2026-05-13. ~9KB. Five sections
of architectural breakdown, lineage to Peter Steinberger's discrawl/gogcli, an
explicit "Relevance to Hit Network" with three actionable takeaways, a notable-CLIs
subsection that filters 87 entries down to ~15 with one-line relevance notes for
each. Plus a Matt Van Horn person page and an article page for the launch tweet,
all cross-linked.

That's the bar. Not a README mirror, not a feature list. **A page that compounds when
future-you re-reads it because the takeaways are framed for OUR work.**

## Anti-patterns

- Filing the repo as `media/repos/<name>` instead of `concepts/<name>`. Repos
  carry ideas; ideas are concepts.
- Summarizing the README in the agent's voice. Quote the thesis verbatim with
  citation.
- Skipping the "Relevance to Hit Network" section. Without it, the page is
  encyclopedia content that won't get re-read.
- Creating a brain page per sub-tool in a catalog repo. The catalog page is the
  index.
- Forgetting the launch tweet. The X post almost always has the cleanest one-line
  pitch; ingest it via `x-article-ingest` and link from the concept page.
