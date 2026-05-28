"""run_research.py: dispatch Cal to research a candidate and collect a research artifact.

CLI:
    python3 run_research.py --candidate-json PATH --output-artifact PATH [--dry-run]

Workflow:
    1. Load candidate JSON from Phase 1 sensor output
    2. Call research_strategy.build_query_plan() to produce queries
    3. Compile a Cal prompt via prompt-builder.py
    4. Dispatch Cal via `hermes -z <prompt> --model claude-haiku-4-5 --yolo`
    5. Capture structured JSON output, validate against the artifact schema
    6. Write artifact to --output-artifact

Exit codes:
    0: success, artifact written
    1: dispatch error (hermes subprocess non-zero)
    2: schema validation error
    3: CLI/config error (missing files, bad args)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

_SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_SCRIPT_DIR))

import auto_enrich_lib  # noqa: E402
from auto_enrich_lib import Heartbeat  # noqa: E402
import research_strategy  # noqa: E402

RECIPE_ID = "auto-enrich"
RECIPE_VERSION_RESEARCH = "0.2.0"
PROMPT_BUILDER_PATH = Path.home() / "hermes-workspace" / "Lex-Workspace" / "scripts" / "prompt-builder.py"
MODEL_MARKER_RE = re.compile(r"^<!-- HERMES-MODEL: (.*?) -->\s*$", re.MULTILINE)
SEARCH_RESULT_RE = re.compile(r"^\[(?P<score>\d+(?:\.\d+)?)\]\s+(?P<slug>\S+)\s+--")

# Tiered acceptance for gbrain search-based slug resolution.
# HIGH: any candidate at or above this score is auto-accepted (still must
# exist + pass type-family guard). MEDIUM: candidate must additionally pass
# token guards (type-family, version preservation, non-stopword overlap).
SLUG_RESOLUTION_HIGH = 1.0
SLUG_RESOLUTION_MEDIUM = 0.5
# Legacy alias retained for back-compat with tests/external callers.
SLUG_RESOLUTION_MIN_SCORE = SLUG_RESOLUTION_HIGH

# Basename similarity floor for the basename-fuzzy resolver (Step 4).
BASENAME_SIM_FLOOR = 0.6

# Stopwords + min-len gate for non-stopword token overlap guard.
_TOKEN_STOPWORDS = frozenset({
    "the", "and", "for", "ai", "model", "code", "tool", "api",
    "of", "a", "an", "on", "in",
})
_VERSION_TOKEN_RE = re.compile(r"\b\d+(?:-\d+)*\b")

# gbrain search currently scores exact canonical slugs like concepts/claude-code
# at 1.0 or higher. Lower scores are noisy for wrong-path rewrites, especially
# short tool names, so resolution only keeps matches at or above this floor.
MANUAL_SLUG_RESOLUTIONS = {
    "ai/tools/codex": "concepts/codex",
    "ai/tools/cursor-ide": "concepts/cursor",
    "ai/entities/claude-code": "concepts/claude-code",
    "tools/cursor": "companies/cursor",
    "tools/codex-cli": "concepts/codex",
    "ai/products/claude-code": "concepts/claude-code",
    "ai/products/claude-cowork": "concepts/claude-cowork",
    "ai/entities/anthropic-cowork": "concepts/claude-cowork",
    "open-source/projects/hermes-agent": "ai/entities/hermes-agent",
}

# Canonical prefixes in this brain, ordered by frequency and preferred match.
CANONICAL_PREFIXES = [
    "concepts/",
    "ai/concepts/",
    "ai/entities/",
    "companies/",
    "people/",
    "tools/",
    "ai/tools/",
    "crypto/concepts/",
    "crypto/entities/",
    "investors/",
    "organizations/",
    "open-source/projects/",
    "ai/products/",
    "ai/models/",
]


SLUG_GROUNDING_TEXT = """\
SUGGESTED_LINKS GROUNDING (HARD REQUIREMENT):

The brain's slug taxonomy is not a generic web ontology. Do NOT invent paths
like ai/entities/*, companies/*, ai/tools/*, or anything that merely sounds
right. Before adding any suggested_links entry, run `gbrain search <topic>`
against the local brain, choose the closest existing result, then verify it
with `gbrain get <slug>`. Only emit a suggested_links target after `gbrain get`
succeeds for that exact slug.

Observed common prefixes in this brain include concepts/, people/,
ai/concepts/, crypto/concepts/, companies/, sessions/, and sources/. Prefer the
actual slug returned by `gbrain search`, even if its prefix is less specific
than the slug you expected. Examples from this brain: Claude maps to
concepts/claude, Codex or computer-use topics map to concepts/computer-use.

If search finds no verified target, omit the suggested_links entry entirely.
Quality beats quantity. Never fabricate a target to fill the array.
"""

# Seven-skill anchor set for Cal research dispatch
REQUIRED_SKILLS = [
    "data-research",
    "enrich",
    "perplexity-research",
    "live-web-research-fallback-chain",
    "academic-verify",
    "cal",
    "sage",
]

TASK_TEMPLATE = """\
Research the candidate at slug "{slug}".

You have the following skills pre-loaded for this task: {skills_csv}.
Use them as your toolbox: data-research and perplexity-research for primary
lookups, live-web-research-fallback-chain when primary sources miss,
academic-verify for concept-type claims, enrich for the artifact shape,
cal and sage for research discipline.

Follow this query plan exactly. Execute each query in order and collect results:
{query_plan_json}

The candidate's current page content is:
---
{page_content}
---

After executing all queries, produce a research artifact JSON that matches this schema:
{schema_text}

{slug_grounding_text}

IRON LAW (HARD REQUIREMENT, READ TWICE):

Every citation.quote MUST be a literal, character-for-character copy-paste of
text that appears verbatim on the cited URL. The Iron Law gate runs a
substring match: if the quote is not a verbatim substring of the fetched
page body, the claim is REJECTED.

NO paraphrasing. NO summarizing. NO inference. NO synthesis of multiple
sentences. NO "in other words" rewrites. The quote field is not a
description of what the source says; it IS what the source says.

DATES AND NUMBERS — DO NOT REFORMAT (READ THIS BEFORE WRITING ANY CLAIM):
- If the source string is "2008-10-27T20:08:30.000Z", your quote must
  contain "2008-10-27" (or the full timestamp). DO NOT write "October 2008".
- If the API returns 803, your quote must contain "803". DO NOT write
  "around 800" or "approximately 800".
- If the source says "May 14, 2026", your quote must contain "May 14, 2026"
  exactly — not "May 2026" and not "14 May 2026".
The gate has zero calendar logic and zero rounding logic. It only knows
"does this exact string appear on the page." Quote the raw source value
verbatim. The synthesized prose around the claim can phrase it
human-friendly later.

BAD examples (these all FAIL the gate because they are paraphrases):
  BAD quote: "@Prisma listed in profile work history"
  BAD quote: "the #1 customer platform for financial services, retail, tech, and insurance"
  BAD quote: "Eoghan McCabe, the controversial Intercom co-founder who left the CEO role in 2020"
  BAD quote: "Profile mentions previous work at Scandit"

GOOD examples (these PASS because they appear verbatim on the source):
  GOOD quote: "Head of DX at @warpdotdev. Previously @Prisma & @Scandit."
  GOOD quote: "Eoghan McCabe, the controversial Intercom co-founder who left the CEO role in 2020, is stepping back in"
  GOOD quote: "We're the #1 AI Customer Service platform"

REJECTION GUIDANCE: If you cannot find a verbatim substring on the source
that supports a claim, DROP the claim entirely. Quality beats quantity.
Three verified claims is better than sixteen claims of which twelve fail
the gate. Do NOT fabricate a quote to fill the citation field.

SECOND PASS (mandatory before returning the artifact): re-read every claim
and ask: "Does the quote text appear, character-for-character, in the
source content I actually fetched?" If not, either replace it with a real
adjacent sentence copied verbatim from the source, OR drop the claim.

VERBATIM RULE, RESTATED FOR EMPHASIS:
The citation.quote field is a COPY-PASTE, not a summary.
- "MCP server with 60+ tools for AI agent integration" is BAD if the page
  actually says "Provides an MCP server exposing 60+ tools for agents".
  The exact text on the page wins. Copy what is there, not what you remember.
- If a page uses smart quotes, em-dashes, or odd capitalization, preserve them.
- If a page wraps the fact across two sentences, quote ONE of them verbatim
  rather than smashing them together.
- When in doubt, drop the claim. A run with 3 verbatim claims passes the gate;
  a run with 10 paraphrased claims gets refused.

NARRATIVE_ADDITIONS DISCIPLINE (non-destructive merge gate):
- narrative_additions[].section MUST be a section that does NOT already
  exist on the page, OR a section that contains <30 words of existing prose.
- Read the candidate's current page content (provided in the prompt). Note
  which sections already have substantive prose (>30 words). DO NOT target
  those sections in narrative_additions.
- Safe pattern: ADD NEW sections (## Scale, ## Payments, ## Technical
  Integration, ## Funding, ## Team). The page synthesizer will append them
  cleanly.
- Unsafe pattern: targeting "## Overview" or "## Key Insights" or any
  existing prose section. The non-destructive gate WILL reject the artifact
  and the entire run will refuse, even if your claims are perfect.

Output ONLY valid JSON. No markdown fence, no preamble, no trailing text.
"""


def load_candidate(path: Path) -> dict[str, Any]:
    """Load a candidate dict from a JSON file."""
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def validate_artifact(artifact: dict[str, Any]) -> list[str]:
    """Validate a research artifact against the schema.

    Returns a list of error strings (empty = valid).
    Checks:
      - All top-level required keys present
      - Every claim has citation.url (non-empty) and citation.quote (non-empty)
    """
    errors: list[str] = []
    required_keys = [
        "target_slug", "researched_at", "researcher",
        "queries_run", "claims", "structured_facts",
        "suggested_links", "narrative_additions",
    ]
    for key in required_keys:
        if key not in artifact:
            errors.append(f"missing top-level key: {key}")

    claims = artifact.get("claims", [])
    if not isinstance(claims, list):
        errors.append("claims must be an array")
        return errors

    # Basic key-presence + array-type checks for the other top-level arrays
    # (existence + is-list only; deep validation belongs to Phase 3 quality gate).
    for arr_key in ("queries_run", "structured_facts", "suggested_links", "narrative_additions"):
        if arr_key in artifact and not isinstance(artifact[arr_key], list):
            errors.append(f"{arr_key} must be an array")

    for i, claim in enumerate(claims):
        citation = claim.get("citation")
        if not isinstance(citation, dict):
            errors.append(f"claims[{i}]: citation is not a dict")
            continue
        url = citation.get("url", "")
        if not url or not url.strip():
            errors.append(f"claims[{i}]: citation.url is empty (Iron Law violation)")
        quote = citation.get("quote", "")
        if not quote or not quote.strip():
            errors.append(f"claims[{i}]: citation.quote is empty (Iron Law violation)")

    return errors


def compile_cal_prompt(slug: str, query_plan: list[dict], page_content: str,
                       schema_text: str, skills: list[str] | None = None) -> str:
    """Build the compiled prompt text for Cal."""
    qp_json = json.dumps(query_plan, indent=2)
    skills_csv = ", ".join(skills or REQUIRED_SKILLS)
    return TASK_TEMPLATE.format(
        slug=slug,
        query_plan_json=qp_json,
        page_content=page_content,
        schema_text=schema_text,
        slug_grounding_text=SLUG_GROUNDING_TEXT,
        skills_csv=skills_csv,
    )


def get_page_content(slug: str) -> str:
    """Fetch current page content from the brain via gbrain."""
    return auto_enrich_lib.run_gbrain(["get", slug])


def load_schema_text() -> str:
    """Load the research artifact schema markdown for inclusion in the Cal prompt."""
    schema_path = _SCRIPT_DIR.parent / "docs" / "research-artifact-schema.md"
    if schema_path.exists():
        return schema_path.read_text(encoding="utf-8")
    # Fallback: embed a minimal schema inline
    return """Research artifact JSON must have these top-level keys:
- target_slug (string): the page slug
- researched_at (ISO8601 string)
- researcher (string): "cal-subagent"
- queries_run (array of {query, source, result_count})
- claims (array of {text, citation: {url, fetched_at, quote}, section_hint})
- structured_facts (array of {key, value, ...})
- suggested_links (array of {type, target})
- suggested_links_valid_rate (number, filled by run_research)
- narrative_additions (array of {section, text, citation_indexes})

IRON LAW: every claim's citation must have non-empty url AND quote."""


def slug_exists(slug: str) -> bool:
    """Return True if `gbrain get <slug>` succeeds and returns content."""
    target = str(slug or "").strip()
    if not target:
        return False
    try:
        return bool(auto_enrich_lib.run_gbrain(["get", target]).strip())
    except auto_enrich_lib.GBrainCLIError:
        return False


def passes_type_family_guard(original: str, candidate: str) -> bool:
    """HARD invariant: people/ and companies/ cannot cross-resolve.

    - If original starts with people/, candidate MUST start with people/.
    - If original starts with companies/, candidate MUST start with companies/.
    - All other prefixes: returns True (no family constraint; concepts/,
      ai/entities/, etc. can cross-resolve).

    The standalone callable lets both `passes_token_guards` and
    `resolve_via_prefix_variants` apply the same invariant at every
    candidate-acceptance point in the resolver chain.
    """
    o = str(original or "").strip()
    c = str(candidate or "").strip()
    if o.startswith("people/"):
        return c.startswith("people/")
    if o.startswith("companies/"):
        return c.startswith("companies/")
    return True


def _version_tokens(basename: str) -> set[str]:
    """Extract digit-version tokens from a basename (e.g. {'3', '4-7'})."""
    return set(_VERSION_TOKEN_RE.findall(basename))


def _non_stopword_tokens(basename: str) -> set[str]:
    """Tokenize a basename on '-', drop stopwords and tokens <3 chars."""
    tokens = [t for t in basename.split("-") if t]
    return {t for t in tokens if len(t) >= 3 and t.lower() not in _TOKEN_STOPWORDS}


def passes_token_guards(original_slug: str, candidate_slug: str) -> bool:
    """Compose the three sub-guards for medium-confidence acceptance.

    1. Type-family (HARD: people/ and companies/ cannot cross).
    2. Version-token preservation: if original has version tokens, candidate
       must have the SAME set OR no version tokens at all.
    3. Non-stopword token overlap: at least 1 shared token after dropping
       stopwords and tokens <3 chars.
    """
    if not passes_type_family_guard(original_slug, candidate_slug):
        return False
    o_basename = Path(str(original_slug or "").strip()).name
    c_basename = Path(str(candidate_slug or "").strip()).name
    if not o_basename or not c_basename:
        return False
    o_versions = _version_tokens(o_basename)
    c_versions = _version_tokens(c_basename)
    if o_versions:
        if c_versions and c_versions != o_versions:
            return False
    o_tokens = _non_stopword_tokens(o_basename)
    c_tokens = _non_stopword_tokens(c_basename)
    if not (o_tokens & c_tokens):
        return False
    return True


def resolve_via_prefix_variants(
    target: str,
    exists: Callable[[str], bool] = slug_exists,
) -> str | None:
    """Resolve <wrong-prefix>/<basename> by testing canonical exact slugs.

    Candidate acceptance is wrapped with passes_type_family_guard so
    people/ and companies/ cannot cross-resolve here, regardless of the
    order of CANONICAL_PREFIXES (v5).
    """
    slug = str(target or "").strip()
    if not slug or "/" not in slug:
        return None
    basename = slug.rsplit("/", 1)[-1]
    if not basename:
        return None
    if exists(slug):
        return slug
    for prefix in CANONICAL_PREFIXES:
        candidate = prefix + basename
        if candidate == slug:
            continue
        if not passes_type_family_guard(slug, candidate):
            continue
        if exists(candidate):
            return candidate
    return None


def _slug_search_query(slug: str) -> str:
    """Turn a wrong-path slug into the shortest useful canonical search query."""
    return Path(str(slug or "").strip()).name.replace("-", " ").strip()


def _parse_search_hits(output: str) -> list[tuple[str, float]]:
    """Parse gbrain search lines into [(slug, score), ...] sorted by score desc."""
    hits: list[tuple[str, float]] = []
    for line in (output or "").splitlines():
        match = SEARCH_RESULT_RE.match(line.strip())
        if not match:
            continue
        try:
            score = float(match.group("score"))
        except (TypeError, ValueError):
            continue
        hits.append((match.group("slug"), score))
    hits.sort(key=lambda h: h[1], reverse=True)
    return hits


def search_slug_resolution(
    slug: str,
    exists: Callable[[str], bool] = slug_exists,
) -> tuple[str | None, float]:
    """Return the top verified search slug and score for a wrong-path target.

    Walks ALL parseable hits (sorted by score desc):
    - score >= HIGH: accept if exists() and passes type-family guard.
    - HIGH > score >= MEDIUM: accept only if passes_token_guards() also holds.
    - score < MEDIUM: skip.
    Returns (resolved_slug or None, top_score_seen).
    """
    target = str(slug or "").strip()
    query = _slug_search_query(target)
    if not query:
        return None, 0.0
    try:
        output = auto_enrich_lib.run_gbrain(["search", query, "--limit", "10"])
    except auto_enrich_lib.GBrainCLIError:
        return None, 0.0
    hits = _parse_search_hits(output)
    if not hits:
        return None, 0.0
    top_score = hits[0][1]
    for candidate, score in hits:
        if score < SLUG_RESOLUTION_MEDIUM:
            break
        if not exists(candidate):
            continue
        if score >= SLUG_RESOLUTION_HIGH:
            if passes_type_family_guard(target, candidate):
                return candidate, score
            continue
        # MEDIUM tier: full token-guard battery.
        if passes_token_guards(target, candidate):
            return candidate, score
    return None, top_score


def resolve_via_basename_similarity(
    slug: str,
    exists: Callable[[str], bool] = slug_exists,
) -> tuple[str | None, float]:
    """Step 4: fuzzy basename match across up to 20 search candidates.

    Returns (best_slug or None, best_ratio_seen). Applies the full
    token-guard battery to every candidate before computing similarity.
    """
    from difflib import SequenceMatcher
    target = str(slug or "").strip()
    query = _slug_search_query(target)
    if not query:
        return None, 0.0
    try:
        output = auto_enrich_lib.run_gbrain(["search", query, "--limit", "20"])
    except auto_enrich_lib.GBrainCLIError:
        return None, 0.0
    hits = _parse_search_hits(output)
    if not hits:
        return None, 0.0
    target_basename = Path(target).name
    best_slug: str | None = None
    best_ratio = 0.0
    for candidate, _score in hits:
        if not exists(candidate):
            continue
        if not passes_token_guards(target, candidate):
            continue
        cand_basename = Path(candidate).name
        ratio = SequenceMatcher(None, target_basename, cand_basename).ratio()
        if ratio > best_ratio:
            best_ratio = ratio
            if ratio >= BASENAME_SIM_FLOOR:
                best_slug = candidate
    if best_slug is None:
        return None, best_ratio
    return best_slug, best_ratio


def resolve_suggested_link_target(
    slug: str,
    exists: Callable[[str], bool] = slug_exists,
) -> tuple[str | None, float]:
    """Resolve a non-existent suggested_links target to a canonical brain slug.

    Chain: manual lookup -> prefix variants -> search (tiered) -> basename
    similarity. Returns (None, last_top_score) only when all four fail.
    """
    target = str(slug or "").strip()
    if not target:
        return None, 0.0
    manual = MANUAL_SLUG_RESOLUTIONS.get(target)
    if manual and exists(manual) and passes_type_family_guard(target, manual):
        return manual, SLUG_RESOLUTION_HIGH
    variant = resolve_via_prefix_variants(target, exists=exists)
    if variant:
        return variant, SLUG_RESOLUTION_HIGH
    search_result, search_score = search_slug_resolution(target, exists=exists)
    if search_result:
        return search_result, search_score
    basename_result, basename_ratio = resolve_via_basename_similarity(target, exists=exists)
    if basename_result:
        return basename_result, basename_ratio
    # All failed. Return the highest "informative" score seen for telemetry.
    return None, max(search_score, basename_ratio)


def resolve_suggested_link_target_detailed(
    slug: str,
    exists: Callable[[str], bool] = slug_exists,
) -> dict[str, Any]:
    """Like resolve_suggested_link_target but returns per-stage diagnostics.

    Used by ground_suggested_links to populate suggested_links_unresolved
    with full payloads for downstream auto-stub and audit.

    Returns a dict:
      {
        "resolved": <slug or None>,
        "score": <float, the score used at resolution time>,
        "search_top_score": <float or None>,
        "search_top_candidate": <slug or None>,
        "basename_top_score": <float or None>,
        "basename_top_candidate": <slug or None>,
      }
    """
    target = str(slug or "").strip()
    out: dict[str, Any] = {
        "resolved": None,
        "score": 0.0,
        "search_top_score": None,
        "search_top_candidate": None,
        "basename_top_score": None,
        "basename_top_candidate": None,
    }
    if not target:
        return out
    manual = MANUAL_SLUG_RESOLUTIONS.get(target)
    if manual and exists(manual) and passes_type_family_guard(target, manual):
        out["resolved"] = manual
        out["score"] = SLUG_RESOLUTION_HIGH
        return out
    variant = resolve_via_prefix_variants(target, exists=exists)
    if variant:
        out["resolved"] = variant
        out["score"] = SLUG_RESOLUTION_HIGH
        return out
    search_result, search_score = search_slug_resolution(target, exists=exists)
    out["search_top_score"] = search_score
    # Best-effort: peek at the top parsed hit for diagnostics even if unused.
    try:
        peek_output = auto_enrich_lib.run_gbrain(
            ["search", _slug_search_query(target), "--limit", "1"]
        )
        peek_hits = _parse_search_hits(peek_output)
        if peek_hits:
            out["search_top_candidate"] = peek_hits[0][0]
    except auto_enrich_lib.GBrainCLIError:
        pass
    if search_result:
        out["resolved"] = search_result
        out["score"] = search_score
        return out
    basename_result, basename_ratio = resolve_via_basename_similarity(target, exists=exists)
    out["basename_top_score"] = basename_ratio
    out["basename_top_candidate"] = basename_result
    if basename_result:
        out["resolved"] = basename_result
        out["score"] = basename_ratio
    return out


def ground_suggested_links(artifact: dict[str, Any]) -> dict[str, Any]:
    """Verify suggested_links, rewrite wrong-path targets, and add metrics.

    On full chain failure, append a full-payload entry to
    artifact["suggested_links_unresolved"] preserving the original link dict
    plus per-stage diagnostics (search_top_*, basename_top_*). Downstream
    Phase 2 auto-stub reads this field.
    """
    links = artifact.get("suggested_links", []) or []
    if not isinstance(links, list):
        artifact["suggested_links_valid_rate"] = 0.0
        artifact["suggested_links_original_count"] = 0
        artifact["suggested_links_valid_count"] = 0
        artifact["suggested_links_resolved_count"] = 0
        return artifact

    verified: list[dict[str, Any]] = []
    invalid: list[str] = []
    unresolved: list[dict[str, Any]] = []
    resolved: list[dict[str, Any]] = []
    exists_cache: dict[str, bool] = {}

    def cached_slug_exists(slug: str) -> bool:
        target = str(slug or "").strip()
        if not target:
            return False
        if target not in exists_cache:
            exists_cache[target] = slug_exists(target)
        return exists_cache[target]

    for link in links:
        if not isinstance(link, dict):
            invalid.append("")
            continue
        target = str(link.get("target") or "").strip()
        if target and cached_slug_exists(target):
            verified.append(link)
            continue
        detail = resolve_suggested_link_target_detailed(target, exists=cached_slug_exists)
        resolved_target = detail.get("resolved")
        if resolved_target:
            rewritten = dict(link)
            rewritten["target"] = resolved_target
            verified.append(rewritten)
            resolved.append({
                "from": target,
                "to": resolved_target,
                "score": detail.get("score", 0.0),
            })
        else:
            invalid.append(target)
            unresolved.append({
                "original_link": dict(link) if isinstance(link, dict) else {},
                "target": target,
                "search_top_score": detail.get("search_top_score"),
                "search_top_candidate": detail.get("search_top_candidate"),
                "basename_top_score": detail.get("basename_top_score"),
                "basename_top_candidate": detail.get("basename_top_candidate"),
            })

    original_count = len(links)
    valid_count = len(verified)
    artifact["suggested_links"] = verified
    artifact["suggested_links_original_count"] = original_count
    artifact["suggested_links_valid_count"] = valid_count
    artifact["suggested_links_resolved_count"] = len(resolved)
    artifact["suggested_links_valid_rate"] = (
        1.0 if original_count == 0 else round(valid_count / original_count, 4)
    )
    if invalid:
        artifact["suggested_links_invalid_targets"] = [s for s in invalid if s]
    else:
        artifact.pop("suggested_links_invalid_targets", None)
    if resolved:
        artifact["suggested_links_resolved_targets"] = resolved
    else:
        artifact.pop("suggested_links_resolved_targets", None)
    if unresolved:
        artifact["suggested_links_unresolved"] = unresolved
    else:
        artifact.pop("suggested_links_unresolved", None)
    return artifact


# Synthetic return code emitted by dispatch_cal() when hermes exits 0 with
# empty stdout. Distinct from real hermes exit codes so run() can route
# the error path to a clearer status than the legacy "parse_error".
DISPATCH_ANOMALY_EMPTY_STDOUT = 99


def parse_hermes_model_marker(compiled_prompt: str) -> tuple[str, dict[str, str] | None]:
    """Strip prompt-builder's HERMES-MODEL marker and return its JSON payload."""
    payload: dict[str, str] | None = None

    def _replace(match: re.Match[str]) -> str:
        nonlocal payload
        try:
            parsed = json.loads(match.group(1))
        except json.JSONDecodeError:
            return ""
        if isinstance(parsed, dict):
            payload = {str(k): str(v) for k, v in parsed.items() if v is not None}
        return ""

    stripped = MODEL_MARKER_RE.sub(_replace, compiled_prompt).strip() + "\n"
    return stripped, payload


def compile_with_prompt_builder(task: str, heartbeat: "Heartbeat | None" = None,
                                slug: str | None = None) -> tuple[str, dict[str, str] | None]:
    """Compile the Cal task through prompt-builder.py and honor HERMES-MODEL."""
    cmd = [
        sys.executable,
        str(PROMPT_BUILDER_PATH),
        "--agent", "cal",
        "--task-type", "research",
        "--task", task,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "prompt-builder failed").strip())
    prompt, model_payload = parse_hermes_model_marker(result.stdout)
    if heartbeat is not None:
        heartbeat.emit("prompt_builder_compile", status="ok", details={
            "slug": slug,
            "agent": "cal",
            "task_type": "research",
            "model": model_payload,
        })
    return prompt, model_payload


def _model_to_cli_args(
    model_payload: dict[str, str] | None,
) -> tuple[list[str], dict[str, str], dict[str, str]]:
    """Convert prompt-builder model payload into hermes -z CLI args and env."""
    model_payload = model_payload or {}
    args: list[str] = []
    env: dict[str, str] = {}
    provider = os.environ.get("CAL_DISPATCH_PROVIDER_OVERRIDE") or model_payload.get("provider")
    model = os.environ.get("CAL_DISPATCH_MODEL_OVERRIDE") or model_payload.get("model")
    if provider:
        args += ["--provider", provider]
    if model:
        args += ["--model", model]
        env["HERMES_INFERENCE_MODEL"] = model
    base_url = os.environ.get("CAL_DISPATCH_BASE_URL_OVERRIDE") or model_payload.get("base_url")
    if base_url:
        env["CUSTOM_BASE_URL"] = base_url
    resolved = {"provider": provider, "model": model, "base_url": base_url}
    return args, env, {k: v for k, v in resolved.items() if v}


def dispatch_cal(prompt: str, skills: list[str] | None = None,
                 heartbeat: "Heartbeat | None" = None,
                 slug: str | None = None,
                 model_payload: dict[str, str] | None = None) -> tuple[int, str, str]:
    """Spawn Cal via hermes -z and return (returncode, stdout, stderr).

    Empty-stdout-on-exit-0 is treated as a dispatch anomaly. The model payload
    comes from prompt-builder.py's HERMES-MODEL marker and is threaded into the
    dispatch command for HR-2 companion compliance.
    """
    import time as _time
    skills_list = skills if skills is not None else REQUIRED_SKILLS
    model_args, model_env, _resolved_model = _model_to_cli_args(model_payload)
    cmd = ["hermes", "-z", prompt] + model_args + ["--skills", ",".join(skills_list), "--yolo"]

    started = _time.monotonic()
    env = os.environ.copy()
    env.update(model_env)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600, check=False, env=env)
    wall = _time.monotonic() - started

    if result.returncode == 0 and not (result.stdout or "").strip():
        if heartbeat is not None:
            heartbeat.emit(
                "dispatch_anomaly",
                status="empty_stdout_on_success_exit",
                details={
                    "slug": slug,
                    "model": model_payload,
                    "stderr": (result.stderr or "")[:500],
                    "wall_seconds": round(wall, 3),
                },
            )
        return DISPATCH_ANOMALY_EMPTY_STDOUT, result.stdout, result.stderr

    return result.returncode, result.stdout, result.stderr


class EmptyCalOutputError(ValueError):
    """Raised when Cal stdout is empty or whitespace-only."""


def parse_cal_json_output(stdout: str) -> dict[str, Any]:
    """Extract JSON from Cal's stdout.

    Cal may return just the JSON or wrap it in a markdown fence.
    Raises EmptyCalOutputError if the input is empty/whitespace-only
    (a distinct failure mode from "output present but unparseable").
    """
    text = (stdout or "").strip()
    if not text:
        raise EmptyCalOutputError("Cal produced no output")
    # Try bare JSON first
    if text.startswith("{"):
        return json.loads(text)

    # Try code fence
    import re
    m = re.search(r"```(?:json\s*\n)?(.*?)```", text, re.DOTALL)
    if m:
        return json.loads(m.group(1).strip())

    # Last-ditch: find the first and last braces
    first = text.find("{")
    last = text.rfind("}")
    if first >= 0 and last > first:
        return json.loads(text[first:last + 1])

    raise ValueError(f"Could not parse JSON from Cal output (first 200 chars: {text[:200]})")


def run(candidate_json_path: str, output_artifact_path: str,
        dry_run: bool = False, page_content_override: str | None = None) -> int:
    """Main entry point. Returns exit code.

    Mock mode: when CAL_DISPATCH_MODE=mock is set in the environment, the
    function skips the live `hermes -z` dispatch entirely and copies the
    good fixture artifact (tests/fixtures/research_artifact_good.json) to
    --output-artifact with the candidate's slug substituted. This is the
    smoke-test toggle documented in scripts/smoke.sh; it lets the end-to-end
    pipeline run when Cal dispatch is environmentally blocked.
    """
    import os as _os
    hb = Heartbeat()

    # Load candidate (still required so we can fill target_slug correctly).
    try:
        candidate = load_candidate(Path(candidate_json_path))
    except (json.JSONDecodeError, FileNotFoundError) as exc:
        hb.emit("research_dispatch", status="error", error=f"load candidate: {exc}")
        return 3

    slug = candidate.get("slug", candidate.get("target_slug", "unknown"))
    page_type = candidate.get("page_type", "unknown")

    if _os.environ.get("CAL_DISPATCH_MODE") == "mock":
        fixture = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "research_artifact_good.json"
        if not fixture.exists():
            hb.emit("research_dispatch", status="mock_fixture_missing",
                    error=str(fixture), details={"slug": slug})
            return 3
        artifact = json.loads(fixture.read_text(encoding="utf-8"))
        artifact["target_slug"] = slug
        artifact["researched_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        artifact["researcher"] = "cal-subagent-mock"
        # Run the grounding filter even in mock mode so the smoke path
        # exercises slug_exists/gbrain-get end-to-end and emits real
        # suggested_links_valid_rate metrics instead of trusting the
        # fixture's baked-in 1.0. This is the proof point Grant flagged
        # in the CHANGES_REQUIRED review for card kn73rn3r.
        artifact = ground_suggested_links(artifact)
        try:
            output = Path(output_artifact_path)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
        except OSError as exc:
            hb.emit("research_dispatch", status="write_error", error=str(exc))
            return 3
        hb.emit("research_dispatch", status="mock_ok",
                details={"slug": slug, "fixture": str(fixture)})
        return 0

    # Build query plan
    if page_content_override is not None:
        page_content = page_content_override
    else:
        try:
            page_content = get_page_content(slug)
        except auto_enrich_lib.GBrainCLIError as exc:
            hb.emit("research_dispatch", status="error", error=f"gbrain get: {exc}")
            return 3

    query_plan = research_strategy.build_query_plan(candidate, page_content)
    schema_text = load_schema_text()

    # Compose task, then compile it through prompt-builder.py for Cal routing.
    task = compile_cal_prompt(slug, query_plan, page_content, schema_text)
    try:
        prompt, model_payload = compile_with_prompt_builder(task, heartbeat=hb, slug=slug)
    except RuntimeError as exc:
        hb.emit("research_dispatch", status="prompt_builder_error",
                error=str(exc)[:500], details={"slug": slug})
        return 1

    if dry_run:
        model_args, _, resolved_model = _model_to_cli_args(model_payload)
        print("=== PLANNED CAL PROMPT (dry-run) ===")
        print(f"candidate: {slug}")
        print(f"page_type: {page_type}")
        print(f"queries planned: {len(query_plan)}")
        print(f"skills loaded: {','.join(REQUIRED_SKILLS)}")
        print(f"model payload: {json.dumps(model_payload, sort_keys=True)}")
        print("dispatch cmd: hermes -z <prompt> "
              f"{' '.join(model_args)} --skills {','.join(REQUIRED_SKILLS)} --yolo")
        print("---")
        print(prompt)
        print("---")
        hb.emit("research_dispatch", status="dry_run", details={
            "slug": slug,
            "page_type": page_type,
            "queries_planned": len(query_plan),
            "skills": REQUIRED_SKILLS,
            "model": resolved_model or model_payload,
        })
        return 0

    # Dispatch Cal
    # Append a final JSON-only reinforcement so the persona/skill prelude
    # cannot override the contract. Some models (Kimi K2-Thinking observed
    # 2026-05-27) interpret the long compiled prelude as "write a deliverable
    # brief" and produce markdown instead of the JSON artifact. This trailing
    # block sits AFTER all persona text and reasserts the contract last.
    prompt = prompt.rstrip() + (
        "\n\n## FINAL CONTRACT (overrides all prior framing)\n"
        "Output ONLY a single valid JSON object matching the Research Artifact Schema above.\n"
        "No markdown. No prose. No `## Research Complete` header. No code fences.\n"
        "No \"Here's what I found\" framing. No file-write tool calls. No `## Learnings` section.\n"
        "The JSON object IS the deliverable. Stdout must start with `{` and end with `}`.\n"
        "\n"
        "VERBATIM CHECK: For every claim, the citation.quote MUST be a direct copy-paste\n"
        "from the URL's body. Paraphrasing fails the gate. If you cannot copy-paste a real\n"
        "sentence that supports the claim, DROP the claim. 3 verbatim claims > 10 paraphrased.\n"
        "\n"
        "NARRATIVE_ADDITIONS CHECK: Do NOT target sections that already have substantive\n"
        "prose (>30 words) on the current page. Add NEW sections only (e.g., ## Scale,\n"
        "## Payments, ## Technical Integration). The non-destructive gate REJECTS the whole\n"
        "run if you target an existing prose section like ## Overview or ## Key Insights.\n"
        "If unsure whether a section is safe, omit narrative_additions entirely; claims alone\n"
        "are enough to pass the gate.\n"
    )
    returncode, stdout, stderr = dispatch_cal(prompt, heartbeat=hb, slug=slug,
                                              model_payload=model_payload)
    _, _, resolved_model = _model_to_cli_args(model_payload)
    if returncode == DISPATCH_ANOMALY_EMPTY_STDOUT:
        # dispatch_cal already emitted a `dispatch_anomaly` event; emit a
        # research_dispatch event with the clearer cal_no_output status so
        # downstream tooling sees both signals.
        hb.emit("research_dispatch", status="cal_no_output",
                error="Cal exited 0 with empty stdout (dispatch anomaly)",
                details={"slug": slug, "exit_code": returncode,
                         "stderr": (stderr or "")[:500]})
        return 1
    if returncode != 0:
        hb.emit("research_dispatch", status="dispatch_error", error=stderr[:500], details={
            "slug": slug,
            "exit_code": returncode,
        })
        return 1

    # Parse artifact
    try:
        artifact = parse_cal_json_output(stdout)
    except EmptyCalOutputError as exc:
        # Defensive: dispatch_cal should have already caught this above, but
        # surface it cleanly if it slips through (e.g. tests that bypass
        # dispatch_cal and feed empty stdout straight into run()).
        hb.emit("research_dispatch", status="cal_no_output",
                error=str(exc), details={"slug": slug})
        return 1
    except (json.JSONDecodeError, ValueError) as exc:
        hb.emit("research_dispatch", status="parse_error",
                error=f"Cal JSON parse: {exc}", details={"slug": slug})
        return 2

    # Validate
    errors = validate_artifact(artifact)
    if errors:
        hb.emit("research_dispatch", status="schema_validation_failed",
                error=" | ".join(errors), details={"slug": slug})
        return 2

    # Enforce researcher tag, timestamp, prompt-builder model attribution, and
    # verified suggested_links metrics before the artifact enters the pipeline.
    artifact = ground_suggested_links(artifact)
    artifact["researcher"] = "cal-subagent"
    artifact["researched_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    # v4 Change D: persist the source page Cal researched so Phase 2's
    # evidence gate has a haystack to match titles against.
    artifact["page_content"] = page_content
    if resolved_model:
        artifact["model"] = resolved_model.get("model")
        artifact["provider"] = resolved_model.get("provider")
        artifact["model_payload"] = {**model_payload, **resolved_model} if model_payload else resolved_model

    # Write artifact
    try:
        output = Path(output_artifact_path)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
    except OSError as exc:
        hb.emit("research_dispatch", status="write_error",
                error=f"Could not write artifact: {exc}")
        return 3

    hb.emit("research_dispatch", status="ok", details={
        "slug": slug,
        "claims_count": len(artifact.get("claims", [])),
        "queries_run": len(artifact.get("queries_run", [])),
        "suggested_links_valid_rate": artifact.get("suggested_links_valid_rate"),
        "suggested_links_valid_count": artifact.get("suggested_links_valid_count"),
        "suggested_links_original_count": artifact.get("suggested_links_original_count"),
        "suggested_links_resolved_count": artifact.get("suggested_links_resolved_count"),
        "artifact_path": str(output),
    })
    return 0


def main():
    parser = argparse.ArgumentParser(description="Dispatch Cal to research a candidate page")
    parser.add_argument("--candidate-json", required=True, help="Path to candidate JSON from sensor")
    parser.add_argument("--output-artifact", required=True, help="Path to write research artifact JSON")
    parser.add_argument("--dry-run", action="store_true", help="Print planned prompt without dispatching")
    args = parser.parse_args()

    sys.exit(run(args.candidate_json, args.output_artifact, dry_run=args.dry_run))


if __name__ == "__main__":
    main()
