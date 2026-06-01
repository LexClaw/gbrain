# Synthesis-Page Writes (TJ-TRAINING, MEMORY, decisions/, learnings/)

**Learned 2026-05-13.** The brain holds canonical versions of synthesis pages (`lex-workspace/tj-training`, `lex-workspace/memory-curated`, `lex-workspace/learnings/promoted`, `lex-workspace/decisions/YYYY-MM`). On disk, the matching files (`~/hermes-workspace/Lex-Workspace/TJ-TRAINING.md`, etc.) are typically `migrated_stub: true` mirrors with a `# MOVED TO BRAIN` header. Writing to those mirrors does NOT update the brain. Several wasted edits happened mid-session before this was caught.

## The migrated-stub trap

When you open a synthesis file on disk, FIRST check the first ~10 lines:

```bash
head -10 ~/hermes-workspace/Lex-Workspace/TJ-TRAINING.md
```

If you see anything like:

```
# MOVED TO BRAIN
migrated_stub: true
This file is now canonical at: lex-workspace/tj-training
```

Stop. Do NOT append to that file expecting it to update Lex's context. The brain is canonical; the FS file is a mirror.

The migration stub also gives you the brain slug directly (`canonical at: <slug>`). Use it.

## Correct append pattern (synthesis pages)

`gbrain put` clobbers by default. To append, get-then-put:

```python
import subprocess, tempfile, os

slug = "lex-workspace/tj-training"
new_block = """
## YYYY-MM-DD - <correction title>

<append-only content with citations>
"""

# 1. Fetch existing body
r = subprocess.run(["gbrain", "get", slug], capture_output=True, text=True)
existing = r.stdout

# 2. Concatenate with separator
new_body = existing.rstrip() + "\n\n---\n\n" + new_block.lstrip() + "\n"

# 3. Write back via stdin (gbrain put reads stdin when --content is absent)
with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
    f.write(new_body)
    tmp = f.name
r = subprocess.run(f"gbrain put {slug} < {tmp}", shell=True, capture_output=True, text=True)
os.unlink(tmp)
print(r.stdout, r.stderr)
```

Confirms the append landed by inspecting the JSON response (`status: created_or_updated`, `chunks: N`). Then verify with `gbrain get <slug> | tail -30`.

## Mirror the append to the FS stub (optional, audit trail)

The FS stubs are useful as offline-readable mirrors. After `gbrain put`, you can append the same block to the local stub for diff-friendly history. The brain is still authoritative; the mirror is read-only convention.

## YAML-frontmatter fence trap

When drafting brain page bodies in a markdown audit doc, frontmatter often ends up wrapped in ```yaml fences for syntax highlighting:

````
```yaml
---
type: concept
title: Memory Architecture
---
```
# Body starts here
````

If you pipe that body directly into `gbrain put`, the fenced frontmatter becomes part of the body content (not real frontmatter), and the page renders with code-block-styled frontmatter instead of indexed metadata. STRIP the fences first:

```python
import re

def strip_yaml_fence(body):
    """Convert a leading ```yaml ... ``` fence into raw frontmatter."""
    m = re.match(r"^```yaml\s*\n(.*?\n)```\s*\n", body, re.DOTALL)
    if m:
        return m.group(1) + body[m.end():]
    return body
```

Run this on every body before `gbrain put` when the source is a drafting doc.

## Verification after every write

```bash
gbrain get <slug> | wc -l                  # line count grew
gbrain get <slug> | tail -10               # last block is what you wrote
gbrain get <slug> | head -20               # frontmatter is clean
```

The `gbrain put` JSON response also includes `chunks: N` and `auto_links: {created, removed}`. Inspect those — a write that produced `chunks: 0` is suspicious.

## Anti-patterns

- **Editing `TJ-TRAINING.md` directly without checking for the migration stub header.** The brain doesn't update. Lex still doesn't know. Future sessions diverge from the FS mirror.
- **Writing `gbrain put` with `--content` containing a full clobber when you meant to append.** The page loses its prior history. Always get-then-put for synthesis pages.
- **Skipping the YAML-fence strip when copy-pasting from a drafting doc.** Frontmatter ends up indexed as body text.
- **Not verifying with `gbrain get` after the write.** A successful `gbrain put` response means the call was accepted, not that the content is what you wanted.

## Slug map (current 2026-05-13)

| Synthesis file | Brain slug | FS mirror |
|---|---|---|
| TJ-TRAINING | `lex-workspace/tj-training` | `~/hermes-workspace/Lex-Workspace/TJ-TRAINING.md` |
| MEMORY (curated long-term) | `lex-workspace/memory-curated` | `~/hermes-workspace/Lex-Workspace/MEMORY.md` (stub) |
| Promoted learnings | `lex-workspace/learnings/promoted` | `~/hermes-workspace/Lex-Workspace/.learnings/LEARNINGS.md` |
| Monthly decisions | `lex-workspace/decisions/YYYY-MM` | `~/hermes-workspace/Lex-Workspace/decisions/YYYY-MM.md` |

The Hermes runtime memory at `~/.hermes/memories/MEMORY.md` is a separate animal — it's the compact ~2,200 char block injected into every system prompt, managed via the `memory` tool, NOT via `gbrain put`. Don't conflate the two.

## Cross-references

- `brain-ops/SKILL.md` core read/write contract.
- `hit-network/tj-author` for the TJ-Shedd person-page write path (different from synthesis pages).
- The migrate-synthesis-to-brain.py script in Lex-Workspace, which produced the stubs originally.
