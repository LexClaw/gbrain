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

import html
import json
import re
import os
import subprocess
import sys
import unicodedata
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
XURL_TIMEOUT = 5

# gstack-browse fetch settings. The binary is the Hit Network canonical
# headless browser; it renders JS-heavy pages plain urllib cannot reach.
GSTACK_BROWSE_BIN = str(Path(os.path.expanduser(
    "~/.hermes/skills/gstack/browse/dist/browse"
)))
GSTACK_GOTO_TIMEOUT = 20
GSTACK_TEXT_TIMEOUT = 10
_GSTACK_SENTINEL_BEGIN_PREFIX = "--- BEGIN UNTRUSTED EXTERNAL CONTENT"
_GSTACK_SENTINEL_END = "--- END UNTRUSTED EXTERNAL CONTENT ---"

# X / Twitter status URL detector. Matches:
#   https://x.com/<handle>/status/<id>
#   https://twitter.com/<handle>/status/<id>
# Rejects: non-numeric ids, x.com.fake.com lookalikes, missing /status/.
_X_TWEET_RE = re.compile(
    r"^https?://(?:www\.)?(?:x|twitter)\.com/[^/\s]+/status/(\d+)(?:[/?#].*)?$"
)

# X / Twitter profile URL detector. Matches:
#   https://x.com/<handle>
#   https://twitter.com/<handle>
# Tweet path takes precedence; the dispatch in check_iron_law tries
# _X_TWEET_RE first and only falls through here for bare profile URLs.
_X_PROFILE_RE = re.compile(
    r"^https?://(?:www\.)?(?:x|twitter)\.com/([A-Za-z0-9_]+)/?$"
)


def _fetch_x_tweet_text(tweet_id: str, timeout: int = XURL_TIMEOUT) -> str | None:
    """Return concatenated tweet.text + note_tweet.text via xurl, or None on failure.

    Uses the X API via the xurl CLI. `note_tweet.text` contains the full long-form
    version for tweets over 280 chars; `data.text` alone is truncated. We
    concatenate both so substring matching works regardless of tweet length.
    Pure read; never blocks the gate (returns None on any xurl failure so the
    caller can fall back to the plain HTTP path).
    """
    try:
        result = subprocess.run(
            ["xurl", f"/2/tweets/{tweet_id}?tweet.fields=text,note_tweet"],
            capture_output=True, text=True, timeout=timeout, check=False,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None
    if result.returncode != 0 or not (result.stdout or "").strip():
        return None
    try:
        payload = json.loads(result.stdout)
    except (json.JSONDecodeError, ValueError):
        return None
    data = payload.get("data") or {}
    if not isinstance(data, dict):
        return None
    text = data.get("text") or ""
    note_obj = data.get("note_tweet") or {}
    note = note_obj.get("text") if isinstance(note_obj, dict) else ""
    note = note or ""
    combined = text + (("\n\n" + note) if note else "")
    combined = combined.strip()
    return combined or None


def _fetch_x_profile_text(handle: str, timeout: int = XURL_TIMEOUT) -> str | None:
    """Return concatenated name + description + location + URL via xurl
    /2/users/by/username/<handle>, or None on any failure.

    Profile URLs (https://x.com/<handle>) hit a JS shell on plain HTTP, so
    the bio (description) is not available for substring matching. The X
    API returns it cleanly. Fail-open: any xurl / parse / JSON error returns
    None so the caller can fall back to the plain HTTP path.
    """
    try:
        result = subprocess.run(
            ["xurl", f"/2/users/by/username/{handle}?user.fields=description,url,location,verified,name,created_at"],
            capture_output=True, text=True, timeout=timeout, check=False,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None
    if result.returncode != 0 or not (result.stdout or "").strip():
        return None
    try:
        payload = json.loads(result.stdout)
    except (json.JSONDecodeError, ValueError):
        return None
    data = payload.get("data") or {}
    if not isinstance(data, dict):
        return None
    parts: list[str] = []
    if data.get("name"):
        parts.append(str(data["name"]))
    if data.get("username"):
        parts.append(f"@{data['username']}")
    if data.get("description"):
        parts.append(str(data["description"]))
    if data.get("location"):
        parts.append(f"Location: {data['location']}")
    if data.get("url"):
        parts.append(f"URL: {data['url']}")
    if data.get("verified"):
        parts.append("Verified")
    if data.get("created_at"):
        parts.append(f"Joined: {data['created_at']}")
    combined = "\n".join(parts).strip()
    return combined or None


def _normalize_for_match(s: str) -> str:
    """Whitespace + HTML-entity + unicode-tolerant normalizer for quote matching.

    Both sides of the Iron Law substring check pass through this so curly
    quotes vs straight quotes, `&gt;` vs `>`, NBSP vs space, and stray
    newlines do not cause false negatives.
    """
    if not s:
        return ""
    s = html.unescape(s)
    s = unicodedata.normalize("NFKC", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip().lower()


def _issue(rule: str, severity: str, detail: str) -> dict[str, str]:
    return {"rule": rule, "severity": severity, "detail": detail}


def _fetch_via_gstack_browse(
    url: str,
    timeout_seconds: int = GSTACK_GOTO_TIMEOUT,
) -> str | None:
    """Fetch a JS-rendered URL via the gstack-browse headless browser.

    Returns the page text (with the BEGIN/END sentinel lines stripped), or
    None on any failure (missing binary, non-zero exit, timeout, OSError).
    Two-step protocol: `browse goto <url>` then `browse text`.
    """
    binary = GSTACK_BROWSE_BIN
    if not os.path.exists(binary):
        return None
    try:
        goto = subprocess.run(
            [binary, "goto", url],
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
        if goto.returncode != 0:
            return None
        body = subprocess.run(
            [binary, "text"],
            capture_output=True,
            text=True,
            timeout=GSTACK_TEXT_TIMEOUT,
            check=False,
        )
        if body.returncode != 0:
            return None
    except (subprocess.TimeoutExpired, OSError):
        return None

    raw = body.stdout or ""
    # Strip sentinel lines. BEGIN line includes the source URL after the
    # prefix, so we match by prefix; END line is fixed.
    out_lines: list[str] = []
    for line in raw.splitlines():
        stripped = line.strip()
        if stripped.startswith(_GSTACK_SENTINEL_BEGIN_PREFIX):
            continue
        if stripped == _GSTACK_SENTINEL_END:
            continue
        out_lines.append(line)
    return "\n".join(out_lines)


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
            # X / Twitter status URLs: plain HTTP returns a JS shell with no
            # tweet text. Prefer xurl (X API) so the long-form note_tweet.text
            # is available for substring matching. On any xurl failure, fall
            # back to the plain HTTP path (existing fail-open behavior).
            m = _X_TWEET_RE.match(url)
            if m:
                tweet_text = _fetch_x_tweet_text(m.group(1))
                if tweet_text is not None:
                    body_cache[url] = (tweet_text, None)
                else:
                    issues.append(_issue(
                        "iron_law", "low",
                        f"claims[{i}]: xurl X API fetch failed for {url}, falling back to HTTP",
                    ))
                    body_cache[url] = _fetch_url_body(url)
            else:
                m_profile = _X_PROFILE_RE.match(url)
                if m_profile:
                    profile_text = _fetch_x_profile_text(m_profile.group(1))
                    if profile_text is not None:
                        body_cache[url] = (profile_text, None)
                    else:
                        issues.append(_issue(
                            "iron_law", "low",
                            f"claims[{i}]: xurl X profile fetch failed for {url}, falling back to HTTP",
                        ))
                        body_cache[url] = _fetch_url_body(url)
                else:
                    # Non-X URL: prefer gstack-browse (renders JS); fall
                    # back to plain HTTP urllib if browse is unavailable
                    # or fails (last resort, fail-open).
                    gstack_text = _fetch_via_gstack_browse(url)
                    if gstack_text is not None:
                        body_cache[url] = (gstack_text, None)
                    else:
                        issues.append(_issue(
                            "iron_law", "low",
                            f"claims[{i}]: gstack-browse fetch unavailable/failed for {url}, falling back to HTTP",
                        ))
                        body_cache[url] = _fetch_url_body(url)
        body, err = body_cache[url]
        if body is None:
            fetch_failures += 1
            issues.append(_issue(
                "iron_law", "low",
                f"claims[{i}]: fetch fail for {url}: {err} (fail-open, did not block)"
            ))
            continue
        if _normalize_for_match(quote) not in _normalize_for_match(body):
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
