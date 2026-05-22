"""synthesize.py: merge a research artifact into a target gbrain page (draft).

CLI:
    python3 synthesize.py --artifact PATH --target-slug SLUG \
        [--dry-run] [--draft-out PATH]

Workflow:
    1. Load artifact JSON.
    2. `gbrain get <slug>` -> current page markdown. Exit 4 if not found.
    3. parse_frontmatter -> (fm, body).
    4. For each suggested_link: verify target exists via `gbrain get`; skip
       and log if missing.
    5. For each structured_fact: add `key: value` line under ## Facts fence
       (create fence if absent at end of body).
    6. For each narrative_addition:
       - FAIL-SAFE non-destructive: if target section exists with >=30 words
         and is not in fm['auto_enrich_overwrite'], APPEND; else create or
         overwrite.
       - Annotate paragraphs with `[^N]` footnote markers from citation_indexes.
    7. ## Sources section: rebuild from unique claim citation URLs with quote
       excerpts.
    8. Update frontmatter: last_enriched, enriched_by, enriched_version.
    9. Write draft to --draft-out (default /tmp/auto-enrich-draft-<slug>.md).
    10. Print the draft path on stdout.
    11. NEVER calls `gbrain put` (the pipeline runner does that AFTER quality
        check passes).

Exit codes:
    0 ok
    1 target page not loadable (gbrain CLI failed)
    2 artifact invalid (missing required keys, bad JSON)
    3 synthesis error (write failure, etc.)
    4 target page does not exist in brain
"""

from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

import auto_enrich_lib  # noqa: E402
from auto_enrich_lib import GBrainCLIError, parse_frontmatter  # noqa: E402

SYNTH_VERSION = "0.3.0"

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)


def load_artifact(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def validate_artifact_min(artifact: dict[str, Any]) -> list[str]:
    """Minimal artifact validation. Deep validation is the quality gate's job."""
    errors: list[str] = []
    required = ["target_slug", "claims", "structured_facts",
                "suggested_links", "narrative_additions"]
    for k in required:
        if k not in artifact:
            errors.append(f"missing key: {k}")
    if "claims" in artifact and not isinstance(artifact["claims"], list):
        errors.append("claims must be list")
    return errors


def fetch_page(slug: str) -> str | None:
    """Return the page markdown, or None if the brain reports no such page."""
    try:
        out = auto_enrich_lib.run_gbrain(["get", slug])
    except GBrainCLIError as exc:
        # gbrain typically exits non-zero for missing pages. Treat any
        # non-zero with empty stdout as "page does not exist". Real CLI
        # errors (network etc.) bubble up.
        stderr = (exc.stderr or "").lower()
        if "not found" in stderr or "no such" in stderr or "does not exist" in stderr:
            return None
        # Unknown shape: caller decides. Re-raise.
        raise
    if not out or not out.strip():
        return None
    return out


def page_exists(slug: str) -> bool:
    try:
        return fetch_page(slug) is not None
    except GBrainCLIError:
        return False


def _split_sections(body: str) -> list[tuple[str, str]]:
    """Split body into ordered (heading_or_empty, body_text) pairs.

    First chunk has heading='' if there's text before the first heading.
    Heading strings include the leading '#'s, e.g. '## Background'.
    """
    matches = list(_HEADING_RE.finditer(body))
    if not matches:
        return [("", body)]
    out: list[tuple[str, str]] = []
    pre = body[: matches[0].start()]
    if pre:
        out.append(("", pre))
    for i, m in enumerate(matches):
        heading = f"{m.group(1)} {m.group(2).strip()}"
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        section_body = body[start:end]
        out.append((heading, section_body))
    return out


def _join_sections(parts: list[tuple[str, str]]) -> str:
    chunks: list[str] = []
    for heading, content in parts:
        if heading:
            # Ensure heading is its own line, body follows on next line.
            chunks.append(f"{heading}\n{content.lstrip(chr(10))}")
        else:
            chunks.append(content)
    return "\n".join(chunks)


def _word_count(text: str) -> int:
    return len(re.findall(r"\S+", text or ""))


def _annotate_with_footnotes(text: str, indexes: list[int]) -> str:
    """Append [^N] markers (1-based) for each citation_index."""
    if not indexes:
        return text
    markers = "".join(f"[^{int(i) + 1}]" for i in indexes)
    # Avoid double-annotating if text already ends with a marker.
    if text.rstrip().endswith("]") and "[^" in text.rstrip()[-12:]:
        return text
    return f"{text.rstrip()} {markers}"


def _upsert_facts(body: str, structured_facts: list[dict]) -> str:
    """Append key: value lines under a ## Facts fence. Create fence if absent."""
    if not structured_facts:
        return body
    parts = _split_sections(body)
    facts_idx = next((i for i, (h, _) in enumerate(parts) if h.strip() == "## Facts"), None)
    fact_lines = []
    for f in structured_facts:
        if not isinstance(f, dict):
            continue
        key = str(f.get("key", "")).strip()
        val = f.get("value", "")
        if not key:
            continue
        extras = " ".join(f"{k}={v}" for k, v in f.items() if k not in ("key", "value"))
        line = f"- {key}: {val}"
        if extras:
            line += f" ({extras})"
        fact_lines.append(line)
    if not fact_lines:
        return body
    if facts_idx is None:
        new_section = "\n".join(fact_lines) + "\n"
        parts.append(("## Facts", "\n" + new_section))
    else:
        heading, content = parts[facts_idx]
        if not content.endswith("\n"):
            content += "\n"
        content += "\n".join(fact_lines) + "\n"
        parts[facts_idx] = (heading, content)
    return _join_sections(parts)


def _apply_narrative_additions(
    body: str,
    additions: list[dict],
    overwrite_set: set[str],
    issues: list[dict],
) -> str:
    parts = _split_sections(body)
    headings = {h.strip(): i for i, (h, _) in enumerate(parts) if h}

    for add in additions:
        if not isinstance(add, dict):
            continue
        section = str(add.get("section") or "").strip()
        text = str(add.get("text") or "").strip()
        if not section or not text:
            continue
        cite_idx = add.get("citation_indexes") or []
        annotated = _annotate_with_footnotes(text, cite_idx)

        if section in headings:
            i = headings[section]
            heading, content = parts[i]
            wc = _word_count(content)
            if wc >= 30 and section not in overwrite_set:
                # FAIL-SAFE: append (do not overwrite).
                if not content.endswith("\n"):
                    content += "\n"
                content += "\n" + annotated + "\n"
                parts[i] = (heading, content)
            else:
                # Stub or opt-in: replace content with the new paragraph,
                # preserving prior content for opt-in only as a discardable
                # original (in FAIL-SAFE we already chose append above).
                if section in overwrite_set:
                    parts[i] = (heading, "\n" + annotated + "\n")
                else:
                    # Stub (<30 words): replace content with the addition.
                    parts[i] = (heading, "\n" + annotated + "\n")
        else:
            # Section does not exist. Insert after ## Summary or ## Role if
            # present, else at end of body.
            insert_after = None
            for marker in ("## Summary", "## Role"):
                if marker in headings:
                    insert_after = headings[marker]
                    break
            new_part = (section, "\n" + annotated + "\n")
            if insert_after is not None:
                parts.insert(insert_after + 1, new_part)
            else:
                parts.append(new_part)
            # Rebuild heading index.
            headings = {h.strip(): i for i, (h, _) in enumerate(parts) if h}

    return _join_sections(parts)


def _build_sources_section(claims: list[dict]) -> str:
    """Return '## Sources' section text built from unique claim URLs."""
    seen: dict[str, str] = {}
    for claim in claims:
        if not isinstance(claim, dict):
            continue
        cit = claim.get("citation")
        if not isinstance(cit, dict):
            continue
        url = (cit.get("url") or "").strip()
        if not url:
            continue
        quote = (cit.get("quote") or "").strip()
        if url not in seen:
            seen[url] = quote
    lines = []
    for i, (url, quote) in enumerate(seen.items(), start=1):
        if quote:
            quote_excerpt = quote if len(quote) <= 240 else quote[:237] + "..."
            lines.append(f"[^{i}]: [{url}]({url}): \"{quote_excerpt}\"")
        else:
            lines.append(f"[^{i}]: [{url}]({url})")
    if not lines:
        return ""
    return "## Sources\n" + "\n".join(lines) + "\n"


def _replace_sources_section(body: str, sources_text: str) -> str:
    if not sources_text:
        return body
    parts = _split_sections(body)
    src_idx = next((i for i, (h, _) in enumerate(parts) if h.strip() == "## Sources"), None)
    new_heading, new_content = "## Sources", "\n" + sources_text[len("## Sources\n"):]
    if src_idx is None:
        parts.append((new_heading, new_content))
    else:
        parts[src_idx] = (new_heading, new_content)
    return _join_sections(parts)


def _render_frontmatter(fm: dict[str, Any]) -> str:
    """Render frontmatter dict back to YAML. Uses pyyaml."""
    import yaml
    text = yaml.safe_dump(fm, sort_keys=False, allow_unicode=True).rstrip("\n")
    return f"---\n{text}\n---\n"


def synthesize(
    artifact: dict[str, Any],
    current_page: str,
) -> tuple[str, list[dict]]:
    """Synthesize a draft markdown from artifact + current page.

    Returns (draft_markdown, issues_list).
    """
    issues: list[dict] = []
    fm, body = parse_frontmatter(current_page)
    overwrite_list = fm.get("auto_enrich_overwrite") if isinstance(fm, dict) else None
    if not isinstance(overwrite_list, list):
        overwrite_list = []
    overwrite_set = {str(s).strip() for s in overwrite_list}

    # 1. Suggested links: verify each target exists.
    for link in artifact.get("suggested_links", []) or []:
        if not isinstance(link, dict):
            continue
        target = str(link.get("target") or "").strip()
        if not target:
            continue
        if not page_exists(target):
            issues.append({
                "rule": "missing_link_target",
                "severity": "low",
                "detail": f"suggested_link target {target!r} does not exist; skipped",
            })

    # 2. Structured facts -> ## Facts fence.
    body = _upsert_facts(body, artifact.get("structured_facts", []) or [])

    # 3. Narrative additions -> non-destructive merge.
    body = _apply_narrative_additions(
        body,
        artifact.get("narrative_additions", []) or [],
        overwrite_set,
        issues,
    )

    # 4. Sources section.
    sources_text = _build_sources_section(artifact.get("claims", []) or [])
    body = _replace_sources_section(body, sources_text)

    # 5. Frontmatter updates.
    if not isinstance(fm, dict):
        fm = {}
    fm["last_enriched"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    fm["enriched_by"] = "auto-enrich-recipe"
    fm["enriched_version"] = SYNTH_VERSION

    draft = _render_frontmatter(fm) + body.lstrip("\n")
    if not draft.endswith("\n"):
        draft += "\n"
    return draft, issues


def _default_draft_path(slug: str) -> Path:
    safe = slug.replace("/", "_")
    return Path("/tmp") / f"auto-enrich-draft-{safe}.md"


def run(
    artifact_path: str,
    target_slug: str,
    dry_run: bool = False,
    draft_out: str | None = None,
) -> int:
    try:
        artifact = load_artifact(Path(artifact_path))
    except (json.JSONDecodeError, FileNotFoundError) as exc:
        print(f"artifact load error: {exc}", file=sys.stderr)
        return 2
    errs = validate_artifact_min(artifact)
    if errs:
        print(f"artifact invalid: {errs}", file=sys.stderr)
        return 2

    try:
        current = fetch_page(target_slug)
    except GBrainCLIError as exc:
        print(f"gbrain get failed: {exc}", file=sys.stderr)
        return 1
    if current is None:
        print(
            f"target page not in brain; refusing to create new page from "
            f"research artifact (slug={target_slug})",
            file=sys.stderr,
        )
        return 4

    try:
        draft, issues = synthesize(artifact, current)
    except Exception as exc:  # noqa: BLE001
        print(f"synthesis error: {exc}", file=sys.stderr)
        return 3

    out_path = Path(draft_out) if draft_out else _default_draft_path(target_slug)
    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(draft, encoding="utf-8")
    except OSError as exc:
        print(f"write error: {exc}", file=sys.stderr)
        return 3

    print(str(out_path))
    for iss in issues:
        print(f"[issue] {iss['rule']} ({iss['severity']}): {iss['detail']}",
              file=sys.stderr)

    if dry_run:
        diff_lines = list(difflib.unified_diff(
            current.splitlines(keepends=True),
            draft.splitlines(keepends=True),
            fromfile=f"current/{target_slug}",
            tofile=f"draft/{target_slug}",
            n=3,
        ))
        capped = diff_lines[:200]
        sys.stderr.write("--- DIFF (dry-run, capped at 200 lines) ---\n")
        sys.stderr.writelines(capped)
        if len(diff_lines) > 200:
            sys.stderr.write(f"... ({len(diff_lines) - 200} more diff lines truncated)\n")
    return 0


def main():
    parser = argparse.ArgumentParser(description="Synthesize a draft page from research artifact")
    parser.add_argument("--artifact", required=True)
    parser.add_argument("--target-slug", required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--draft-out", default=None)
    args = parser.parse_args()
    sys.exit(run(args.artifact, args.target_slug, args.dry_run, args.draft_out))


if __name__ == "__main__":
    main()
