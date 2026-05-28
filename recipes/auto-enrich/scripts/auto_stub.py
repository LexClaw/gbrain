"""auto_stub.py: Phase 2 of the link-resolver hardening plan.

After an auto-enrich artifact passes both quality gates (Iron Law +
non-destructive + fabricated-command), this module scans
artifact["suggested_links_unresolved"] for missing people/<slug> and
companies/<slug> entries. For each one that has evidence in either the
source page Cal researched OR an Iron-Law-checked claim quote, it creates
a stub page via `gbrain put` and rewrites the link target.

Safety properties:
  - Stubs only fire AFTER pipeline quality gates pass (caller's responsibility).
  - Only people/<slug> and companies/<slug> qualify (eligibility regex).
  - Existence rechecked at stub time (avoids overwrites on race / recent run).
  - Evidence gate: title MUST appear in page_content OR a claim quote.
    Narrative additions are NOT valid evidence (quality gates do not verify
    narrative prose is sourced).
  - Dry-run is honored (no gbrain put in dry mode).
  - Per-run cap (MAX_AUTO_STUBS_PER_RUN) prevents runaway creation.
  - Stub-create failures are caught: link stays unresolved, no half-state.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Callable

import auto_enrich_lib

ELIGIBLE_TARGET_RE = re.compile(r"^(people|companies)/[a-z0-9-]+$")
MAX_AUTO_STUBS_PER_RUN = 10
EVIDENCE_FUZZY_RATIO = 0.85


@dataclass
class AutoStubContext:
    """Run-scoped state shared across all candidates in one pipeline run."""
    dry_run: bool = False
    stubs_created: int = 0
    max_stubs: int = MAX_AUTO_STUBS_PER_RUN
    # Events for telemetry / heartbeat. Each is a dict with keys
    # {kind: str, slug: str, ...}. Kinds:
    #   auto_stub_created, auto_stub_would_create, auto_stub_rejected_no_evidence,
    #   auto_stub_skipped_now_exists, auto_stub_cap_hit, auto_stub_create_failed,
    #   auto_stub_ineligible_target.
    events: list[dict[str, Any]] = field(default_factory=list)


def _title_case_basename(slug: str) -> str:
    basename = Path(slug).name
    parts = [p for p in basename.split("-") if p]
    return " ".join(w.capitalize() for w in parts)


def _is_eligible_target(target: str) -> bool:
    return bool(ELIGIBLE_TARGET_RE.match(target or ""))


def _line_fuzzy_match(needle: str, haystack: str) -> bool:
    """Return True if needle appears or fuzzy-matches at >= 0.85 per-line."""
    if not needle or not haystack:
        return False
    needle_low = needle.lower()
    hay_low = haystack.lower()
    if needle_low in hay_low:
        return True
    for line in hay_low.splitlines():
        if not line.strip():
            continue
        ratio = SequenceMatcher(None, needle_low, line.strip()).ratio()
        if ratio >= EVIDENCE_FUZZY_RATIO:
            return True
    return False


def has_evidence(title: str, artifact: dict[str, Any]) -> tuple[bool, str]:
    """Check whether `title` is evidenced by source page OR a claim quote.

    Returns (passed, evidence_path) where evidence_path is one of
    "page_content", "claim_quote", or "" on failure.

    NARRATIVE IS NOT VALID EVIDENCE (v4): the non-destructive and
    fabricated-command gates do NOT verify narrative_addition.text is
    sourced; checking it here would let fabricated names through.
    """
    if not title:
        return False, ""
    page_content = artifact.get("page_content") or ""
    if _line_fuzzy_match(title, page_content):
        return True, "page_content"
    for claim in artifact.get("claims", []) or []:
        if not isinstance(claim, dict):
            continue
        citation = claim.get("citation")
        if not isinstance(citation, dict):
            continue
        quote = citation.get("quote") or ""
        if _line_fuzzy_match(title, quote):
            return True, "claim_quote"
    return False, ""


def _build_stub_markdown(
    slug: str,
    title: str,
    page_type: str,
    source_slug: str,
    evidence_path: str,
) -> str:
    """Build the stub page markdown body. evidence_path must be one of
    'page_content' or 'claim_quote' (never 'narrative' per v4 evidence gate)."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return (
        "---\n"
        f"title: {title}\n"
        f"type: {page_type}\n"
        "auto_stub: true\n"
        "stub_source: auto-enrich\n"
        f"stub_created_at: {ts}\n"
        f"stub_source_slug: {source_slug}\n"
        f"stub_evidence: {evidence_path}\n"
        "---\n"
        f"# {title}\n"
        "\n"
        f"_Stub auto-created by auto-enrich. Mentioned in [[{source_slug}]]. "
        "Pending enrichment._\n"
    )


def _default_slug_exists(s: str) -> bool:
    try:
        return bool(auto_enrich_lib.run_gbrain(["get", s]).strip())
    except auto_enrich_lib.GBrainCLIError:
        return False


def _default_gbrain_put(s: str, content: str) -> None:
    """Default `gbrain put` impl: passes content via the required --content flag.

    Verified against `gbrain put --help`: --content is REQUIRED.
    """
    import subprocess
    import os
    argv = [
        os.environ.get("GBRAIN_BIN", "gbrain"),
        "put", s, "--content", content,
    ]
    proc = subprocess.run(
        argv, capture_output=True, text=True,
        timeout=60, check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            (proc.stderr or proc.stdout or "gbrain put failed").strip()
        )


def try_auto_stub_link(
    unresolved_entry: dict[str, Any],
    artifact: dict[str, Any],
    ctx: AutoStubContext,
    *,
    slug_exists: Callable[[str], bool] | None = None,
    gbrain_put: Callable[[str, str], None] | None = None,
) -> str | None:
    """Attempt to auto-stub a single unresolved entry.

    Returns the rewritten target slug on success (i.e. the stub was
    created or already existed), or None when no stub action was taken.

    `slug_exists` and `gbrain_put` are injectable for tests. Defaults
    call into auto_enrich_lib.run_gbrain.
    """
    exists_fn = slug_exists if slug_exists is not None else _default_slug_exists
    put_fn = gbrain_put if gbrain_put is not None else _default_gbrain_put

    target = str(unresolved_entry.get("target") or "").strip()
    source_slug = str(artifact.get("target_slug") or "").strip()

    if not _is_eligible_target(target):
        ctx.events.append({
            "kind": "auto_stub_ineligible_target",
            "slug": target, "source_slug": source_slug,
        })
        return None

    # Existence recheck (paranoia: race or recent run created it).
    if exists_fn(target):
        ctx.events.append({
            "kind": "auto_stub_skipped_now_exists",
            "slug": target, "source_slug": source_slug,
        })
        return target

    derived_title = _title_case_basename(target)

    # Evidence gate.
    passed, evidence_path = has_evidence(derived_title, artifact)
    if not passed:
        ctx.events.append({
            "kind": "auto_stub_rejected_no_evidence",
            "slug": target, "derived_title": derived_title,
            "source_slug": source_slug,
        })
        return None

    # Cap gate.
    if ctx.stubs_created >= ctx.max_stubs:
        ctx.events.append({
            "kind": "auto_stub_cap_hit",
            "slug": target, "source_slug": source_slug,
            "stubs_created": ctx.stubs_created, "cap": ctx.max_stubs,
        })
        return None

    page_type = "person" if target.startswith("people/") else "company"
    markdown = _build_stub_markdown(
        slug=target, title=derived_title, page_type=page_type,
        source_slug=source_slug, evidence_path=evidence_path,
    )

    # Dry-run gate.
    if ctx.dry_run:
        ctx.events.append({
            "kind": "auto_stub_would_create",
            "slug": target, "derived_title": derived_title,
            "source_slug": source_slug, "evidence_path": evidence_path,
        })
        return None

    try:
        put_fn(target, markdown)
    except Exception as exc:  # noqa: BLE001
        ctx.events.append({
            "kind": "auto_stub_create_failed",
            "slug": target, "source_slug": source_slug,
            "error": str(exc)[:300],
        })
        return None

    ctx.stubs_created += 1
    ctx.events.append({
        "kind": "auto_stub_created",
        "slug": target, "derived_title": derived_title,
        "source_slug": source_slug, "evidence_path": evidence_path,
    })
    return target


def process_unresolved_links(
    artifact: dict[str, Any],
    ctx: AutoStubContext,
    *,
    slug_exists: Callable[[str], bool] | None = None,
    gbrain_put: Callable[[str, str], None] | None = None,
) -> dict[str, Any]:
    """Walk artifact['suggested_links_unresolved'], attempt stub on each.

    Mutates and returns the artifact. On any stub success, the link is
    appended to artifact['suggested_links'] (the field synthesize reads),
    the entry is removed from suggested_links_unresolved, and link metrics
    are refreshed.

    Caller is responsible for writing the mutated artifact back to disk
    before invoking synthesize (run_pipeline does this at the call site).
    """
    unresolved = artifact.get("suggested_links_unresolved") or []
    if not isinstance(unresolved, list) or not unresolved:
        return artifact

    verified = artifact.get("suggested_links") or []
    if not isinstance(verified, list):
        verified = []
    remaining: list[dict[str, Any]] = []

    for entry in unresolved:
        if not isinstance(entry, dict):
            remaining.append(entry)
            continue
        new_target = try_auto_stub_link(
            entry, artifact, ctx,
            slug_exists=slug_exists, gbrain_put=gbrain_put,
        )
        if new_target is None:
            # No stub action (rejected, capped, or already-exists noop with no link rewrite).
            remaining.append(entry)
            continue
        if ctx.dry_run:
            # Would-create path takes "no stub action" too; keep entry in unresolved.
            remaining.append(entry)
            continue
        original_link = entry.get("original_link")
        if not isinstance(original_link, dict):
            original_link = {"target": new_target}
        rewritten = dict(original_link)
        rewritten["target"] = new_target
        verified.append(rewritten)

    artifact["suggested_links"] = verified
    if remaining:
        artifact["suggested_links_unresolved"] = remaining
    else:
        artifact.pop("suggested_links_unresolved", None)

    # Refresh metrics. valid_count counts everything that ended up in
    # suggested_links; original_count is unchanged from grounding.
    original_count = int(artifact.get("suggested_links_original_count") or 0)
    valid_count = len(verified)
    artifact["suggested_links_valid_count"] = valid_count
    if original_count > 0:
        artifact["suggested_links_valid_rate"] = round(valid_count / original_count, 4)
    return artifact
