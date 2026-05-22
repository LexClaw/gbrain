"""quality_check.py: Phase 3 quality gate for auto-enrich.

check(artifact, current_page_content, draft_path) -> (passed, issues)

Issues are dicts with keys: rule, severity, detail. Severities:
  critical, high -> block (passed=False)
  med, low       -> warn only

Rules:
  Rule #1 (iron_law, critical):  every claim has citation.url + citation.quote,
                                 and quote is a substring of the live URL body.
                                 Fail-open on network errors (warn, do not block).
  Rule #3 (non_destructive, high, FAIL-SAFE): synthesize output cannot overwrite
                                 an existing prose section of >=30 words unless
                                 that section name appears in the target page's
                                 auto_enrich_overwrite frontmatter list.
  Rule #4 (fabricated_command, high): scan artifact text for "gbrain <verb>"
                                 references and verify <verb> against live
                                 `gbrain --help` output.
  Rule #5 (lint, high):          run `gbrain lint <draft_path>`; non-zero blocks.

Rule #2 was dropped in the recipe v2; not implemented.
"""

from __future__ import annotations

import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from auto_enrich_lib import parse_frontmatter  # noqa: E402

# Severities that block.
BLOCKING = {"critical", "high"}

# HTTP fetch settings for Iron Law.
FETCH_TIMEOUT = 5
FETCH_UA = "auto-enrich-quality-gate/0.3.0"

# Subprocess timeouts.
GBRAIN_HELP_TIMEOUT = 10
GBRAIN_LINT_TIMEOUT = 30


def _issue(rule: str, severity: str, detail: str) -> dict[str, str]:
    return {"rule": rule, "severity": severity, "detail": detail}


def _fetch_url_body(url: str) -> tuple[str | None, str | None]:
    """Fetch a URL with a short timeout. Returns (body, error_message)."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": FETCH_UA})
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
            raw = resp.read()
        try:
            return raw.decode("utf-8", errors="replace"), None
        except Exception as exc:  # pragma: no cover - decode safety
            return None, f"decode failed: {exc}"
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ConnectionError, OSError) as exc:
        return None, f"fetch failed: {exc}"
    except Exception as exc:  # pragma: no cover - defensive
        return None, f"unexpected fetch error: {exc}"


def _normalize(text: str) -> str:
    """Normalize whitespace for fuzzy quote substring matching."""
    return re.sub(r"\s+", " ", text or "").strip().lower()


def check_iron_law(artifact: dict[str, Any]) -> tuple[list[dict[str, str]], dict[str, int]]:
    """Rule #1. Returns (issues, stats) where stats has fetch counters."""
    issues: list[dict[str, str]] = []
    claims = artifact.get("claims", []) or []
    fetch_attempts = 0
    fetch_failures = 0

    # Cache URL bodies so repeated citations to the same URL only fetch once.
    body_cache: dict[str, tuple[str | None, str | None]] = {}

    for i, claim in enumerate(claims):
        cit = claim.get("citation") if isinstance(claim, dict) else None
        if not isinstance(cit, dict):
            issues.append(_issue("iron_law", "critical", f"claims[{i}]: missing citation"))
            continue
        url = (cit.get("url") or "").strip()
        quote = (cit.get("quote") or "").strip()
        if not url:
            issues.append(_issue("iron_law", "critical", f"claims[{i}]: citation.url empty"))
            continue
        if not quote:
            issues.append(_issue("iron_law", "critical", f"claims[{i}]: citation.quote empty"))
            continue

        if url not in body_cache:
            fetch_attempts += 1
            body_cache[url] = _fetch_url_body(url)
        body, err = body_cache[url]
        if body is None:
            fetch_failures += 1
            issues.append(_issue(
                "iron_law", "low",
                f"claims[{i}]: fetch fail for {url}: {err} (fail-open, did not block)"
            ))
            continue
        if _normalize(quote) not in _normalize(body):
            issues.append(_issue(
                "iron_law", "critical",
                f"claims[{i}]: quote not found on page {url}"
            ))

    stats = {
        "fetch_attempts": fetch_attempts,
        "fetch_failures": fetch_failures,
    }
    return issues, stats


_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)


def _split_sections(body: str) -> dict[str, str]:
    """Split a markdown body into a dict of section_heading -> section_body.

    Heading key is the literal markdown form, e.g. '## Background'. Body
    text excludes the heading line. Anything before the first heading is
    stored under key '' (empty string).
    """
    sections: dict[str, str] = {}
    matches = list(_HEADING_RE.finditer(body))
    if not matches:
        return {"": body}
    pre = body[: matches[0].start()]
    if pre.strip():
        sections[""] = pre
    for i, m in enumerate(matches):
        heading = f"{m.group(1)} {m.group(2).strip()}"
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        sections[heading] = body[start:end]
    return sections


def _word_count(text: str) -> int:
    return len(re.findall(r"\S+", text or ""))


def check_non_destructive(
    artifact: dict[str, Any],
    current_page_content: str,
) -> list[dict[str, str]]:
    """Rule #3. FAIL-SAFE: reject if any narrative_addition section name targets
    an existing section with >=30 words that is NOT in auto_enrich_overwrite.
    """
    issues: list[dict[str, str]] = []
    fm, body = parse_frontmatter(current_page_content)
    overwrite_list = fm.get("auto_enrich_overwrite") if isinstance(fm, dict) else None
    if not isinstance(overwrite_list, list):
        overwrite_list = []
    overwrite_set = {str(s).strip() for s in overwrite_list}

    sections = _split_sections(body)
    additions = artifact.get("narrative_additions", []) or []
    for i, add in enumerate(additions):
        if not isinstance(add, dict):
            continue
        section = str(add.get("section") or "").strip()
        if not section:
            continue
        existing = sections.get(section)
        if existing is None:
            continue
        wc = _word_count(existing)
        if wc < 30:
            continue
        if section in overwrite_set:
            continue
        issues.append(_issue(
            "non_destructive", "high",
            (
                f"narrative_additions[{i}] targets section {section!r} with "
                f"{wc} existing words; section not in auto_enrich_overwrite "
                "frontmatter list (FAIL-SAFE default: append-only)."
            ),
        ))
    return issues


_GBRAIN_VERB_RE = re.compile(r"\bgbrain\s+([a-z][a-z0-9_\-]*)", re.IGNORECASE)


def _extract_gbrain_verbs(artifact: dict[str, Any]) -> set[str]:
    """Scan artifact text fields for `gbrain <verb>` references."""
    verbs: set[str] = set()

    def scan(text: str) -> None:
        if not isinstance(text, str):
            return
        for m in _GBRAIN_VERB_RE.finditer(text):
            verbs.add(m.group(1).lower())

    for add in artifact.get("narrative_additions", []) or []:
        if isinstance(add, dict):
            scan(add.get("text", ""))
    for fact in artifact.get("structured_facts", []) or []:
        if isinstance(fact, dict):
            val = fact.get("value")
            if isinstance(val, str):
                scan(val)
    for claim in artifact.get("claims", []) or []:
        if isinstance(claim, dict):
            scan(claim.get("text", ""))
            cit = claim.get("citation")
            if isinstance(cit, dict):
                scan(cit.get("quote", ""))
    return verbs


def _live_gbrain_verbs() -> tuple[set[str], str | None]:
    """Parse `gbrain --help` and extract the leading verb of each command line."""
    try:
        proc = subprocess.run(
            ["gbrain", "--help"],
            capture_output=True, text=True,
            timeout=GBRAIN_HELP_TIMEOUT, check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return set(), f"gbrain --help unavailable: {exc}"
    help_text = (proc.stdout or "") + "\n" + (proc.stderr or "")
    verbs: set[str] = set()
    # Verb lines look like: "  get <slug>    Read a page"
    # Capture leading lowercase token on indented lines.
    for line in help_text.splitlines():
        m = re.match(r"^\s{2,}([a-z][a-z0-9_\-]*)\b", line)
        if m:
            verbs.add(m.group(1).lower())
    return verbs, None


def check_fabricated_commands(artifact: dict[str, Any]) -> list[dict[str, str]]:
    """Rule #4."""
    issues: list[dict[str, str]] = []
    cited_verbs = _extract_gbrain_verbs(artifact)
    if not cited_verbs:
        return issues
    live_verbs, err = _live_gbrain_verbs()
    if err:
        # Cannot verify; warn but do not block. Better than false positives.
        issues.append(_issue(
            "fabricated_command", "low",
            f"could not verify gbrain verbs (fail-open): {err}",
        ))
        return issues
    for verb in sorted(cited_verbs):
        if verb not in live_verbs:
            issues.append(_issue(
                "fabricated_command", "high",
                f"artifact references `gbrain {verb}` which is not in `gbrain --help`",
            ))
    return issues


def check_lint(draft_path: Path) -> list[dict[str, str]]:
    """Rule #5: run gbrain lint on the synthesized draft."""
    issues: list[dict[str, str]] = []
    if draft_path is None:
        return issues
    p = Path(draft_path)
    if not p.exists():
        issues.append(_issue(
            "lint", "high",
            f"draft path does not exist: {p}",
        ))
        return issues
    try:
        proc = subprocess.run(
            ["gbrain", "lint", str(p)],
            capture_output=True, text=True,
            timeout=GBRAIN_LINT_TIMEOUT, check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        issues.append(_issue(
            "lint", "low",
            f"gbrain lint unavailable (fail-open): {exc}",
        ))
        return issues
    if proc.returncode != 0:
        combined = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()
        issues.append(_issue(
            "lint", "high",
            f"gbrain lint exit {proc.returncode}: {combined[:800]}",
        ))
    return issues


def check(
    artifact: dict[str, Any],
    current_page_content: str,
    draft_path: Path | None,
) -> tuple[bool, list[dict[str, Any]]]:
    """Run all rules and return (passed, issues).

    passed=False if any issue has severity in BLOCKING.
    """
    issues: list[dict[str, Any]] = []

    iron_issues, iron_stats = check_iron_law(artifact)
    issues.extend(iron_issues)
    # Surface fetch stats for morning-brief / heartbeat consumers.
    if iron_stats["fetch_attempts"] > 0:
        rate = iron_stats["fetch_failures"] / iron_stats["fetch_attempts"]
        if iron_stats["fetch_failures"] > 0:
            issues.append({
                "rule": "iron_law_fetch_stats",
                "severity": "low",
                "detail": (
                    f"fetch_attempts={iron_stats['fetch_attempts']} "
                    f"fetch_failures={iron_stats['fetch_failures']} "
                    f"failure_rate={rate:.2f}"
                ),
                "fetch_attempts": iron_stats["fetch_attempts"],
                "fetch_failures": iron_stats["fetch_failures"],
            })

    issues.extend(check_non_destructive(artifact, current_page_content))
    issues.extend(check_fabricated_commands(artifact))
    if draft_path is not None:
        issues.extend(check_lint(Path(draft_path)))

    blocking = [i for i in issues if i.get("severity") in BLOCKING]
    passed = len(blocking) == 0
    return passed, issues
