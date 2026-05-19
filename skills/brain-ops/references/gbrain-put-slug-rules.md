# gbrain put: slug rules and the uppercase trap

## TL;DR

`gbrain put <slug> --content <markdown>` runs an internal `addTag` step that
re-reads the page by **exact** slug after the write. If the slug contains any
uppercase letter, the re-read fails with:

```
addTag failed: page "<slug>" not found
```

The put then exits 1. The page write itself may or may not have landed depending
on how `addTag` interacts with the transaction; either way, the caller
correctly treats the whole call as failed.

This is silent if your caller logs only success counts. Always lowercase every
slug component at construction time.

## Repro

Verified 2026-05-15 on local PGLite engine.

```bash
# FAILS
gbrain put sources/test/2026-05-15-AbcDef-foo --content "---
title: probe
type: source
---
body"
# stderr: addTag failed: page "sources/test/2026-05-15-AbcDef-foo" not found
# exit code: 1

# SUCCEEDS
gbrain put sources/test/2026-05-15-abcdef-foo --content "---
title: probe
type: source
---
body"
# stdout: { "slug": "...", "status": "created_or_updated", ... }
# exit code: 0
```

The two calls differ only in case. The failing one has `AbcDef`; the passing
one has `abcdef`. Hyphens, digits, and underscores are all fine.

## The incident

The youtube-channel-to-brain recipe's first dogfood run, 2026-05-15:

- 30 video pages constructed with slugs like
  `sources/youtube/alexhormozi/2026-05-14-Uh2v6tgRMAY-why-small-business-owners-always-undercharge`
- YouTube video_ids are mixed-case (`Uh2v6tgRMAY`, `nXqF-F6By40`,
  `Wia0oSOu7ZQ`); the slug builder embedded them verbatim
- All 30 puts failed with the addTag error
- Brain ended up with zero new pages despite the heartbeat saying
  `total_ingested: 30`
- Diagnosis took ~10 minutes; the fix was 1 line:
  `vid_for_slug = video.video_id.lower()`

After the fix, the same poll re-ran cleanly and all 30 pages landed.

## Canonical slug-builder pattern

For any slug constructed from external identifiers (YouTube `video_id`, X
tweet ID, GitHub repo names with mixed case, etc.):

```python
def build_slug(*parts: str) -> str:
    """All slug components must be lowercase. Hyphens, digits, underscores OK."""
    return "/".join(p.lower() for p in parts)

# Use:
slug = build_slug(
    "sources",
    "youtube",
    channel.author_slug,        # already lowercased at subscribe time
    f"{pub_date}-{video.video_id.lower()}-{title_slug}",
)

# Frontmatter and the user-facing URL keep the original case:
frontmatter["video_id"] = video.video_id  # "Uh2v6tgRMAY", case preserved
frontmatter["url"] = video.url            # case preserved
```

The canonical identifier (case-sensitive) lives in frontmatter and links. The
slug is a URL-safe identifier; it should follow the same rules as a path
segment: lowercase, alphanumeric plus `-` and `_`, no spaces, no special
characters.

## What this means for recipe authors

Any GBrain recipe that ingests content from a system using mixed-case IDs
needs a slug-normalization layer between the upstream identifier and the
gbrain put. The pattern:

1. Upstream returns an ID (`Uh2v6tgRMAY`).
2. Recipe stores it as `video_id` in frontmatter, in the user-facing URL,
   and anywhere users will copy it.
3. Recipe derives `slug_id = upstream_id.lower()` ONLY at slug-construction
   time.
4. Slug goes into `gbrain put` and `gbrain link`.

Do not lowercase the upstream ID anywhere else; you'll lose the ability to
round-trip back to the source.

## Other slug-character pitfalls (observed but not always fatal)

- **Leading hyphen in a slug component** (e.g. video_id `-QmnCJL_dGE`
  produces `2026-05-14--qmncjl_dge-...`). gbrain handles this but it's
  ugly. Optional fix: prefix with a literal `v-` or strip leading hyphens.
- **Dots in slugs.** Avoid. They confuse some downstream tools that
  treat slugs as path stems.
- **Slashes inside a single slug component.** Use them only as path
  separators between components. Inside a component, replace `/` with `-`.
- **Spaces, smart quotes, apostrophes.** All must be stripped or
  replaced. Use a `_slugify(title)` helper that does
  `re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")`.

## Diagnostic recipe

If you see `addTag failed: page "<slug>" not found` in any gbrain context:

1. Look at the slug string in the error message.
2. Scan it for uppercase letters. If any are present, that is your bug.
3. Grep your slug-builder for the source of those uppercase letters
   (usually an external ID interpolated without `.lower()`).
4. Fix at construction time, not after the put. Mutating the slug
   between write and read is not safe.

## See also

- `brain-ops/SKILL.md` Anti-Patterns section, slug rule entry
- `brain-ops/references/cli-default-limits.md` (different gbrain CLI footgun)
- `brain-ops/references/namespace-fallback-discipline.md` (slug-fetch fallback chain)
