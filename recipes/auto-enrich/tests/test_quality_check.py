"""Tests for quality_check.py.

Mocks URL fetches (urllib.request.urlopen) and gbrain subprocess calls so
tests do not touch the network or the live brain.
"""

from __future__ import annotations

import json
import subprocess
import sys
from io import BytesIO
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import quality_check  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures"


# Live `gbrain --help` returns a known verb set. We patch the helper directly
# so we do not depend on the developer's installed gbrain version.
KNOWN_VERBS = {
    "get", "put", "delete", "list", "search", "query", "ask",
    "import", "sync", "export", "lint", "orphans", "salience",
    "anomalies", "dream", "report", "stats", "health", "history",
    "revert", "features", "autopilot", "config", "doctor", "init",
    "migrate", "upgrade", "integrations", "serve", "call", "version",
    "sources", "code-def", "code-refs", "code-callers", "code-callees",
    "reconcile-links", "reindex-code", "jobs", "backlinks",
}


def _mock_urlopen_factory(url_to_body: dict[str, str]):
    """Build a urlopen replacement that serves canned bodies per URL."""

    def fake_urlopen(req, timeout=None):  # noqa: ARG001
        url = req.get_full_url() if hasattr(req, "get_full_url") else str(req)
        if url not in url_to_body:
            raise quality_check.urllib.error.URLError(f"no canned body for {url}")
        body = url_to_body[url].encode("utf-8")
        resp = MagicMock()
        resp.read.return_value = body
        resp.__enter__ = lambda self: self  # support context-manager use
        resp.__exit__ = lambda self, *a: False
        return resp

    return fake_urlopen


def _patch_live_verbs(known: set[str]):
    return patch.object(quality_check, "_live_gbrain_verbs", return_value=(known, None))


def _patch_lint_ok():
    proc = MagicMock(returncode=0, stdout="", stderr="")
    return patch.object(quality_check.subprocess, "run", return_value=proc)


def _patch_lint_fail(stderr="malformed frontmatter"):
    proc = MagicMock(returncode=1, stdout="", stderr=stderr)
    return patch.object(quality_check.subprocess, "run", return_value=proc)


# --- Fixtures (artifact + page) ---

@pytest.fixture
def good_artifact():
    return json.loads((FIXTURES / "research_artifact_good.json").read_text())


@pytest.fixture
def fabricated_artifact():
    return json.loads((FIXTURES / "research_artifact_fabricated.json").read_text())


@pytest.fixture
def destructive_artifact():
    return json.loads((FIXTURES / "research_artifact_destructive.json").read_text())


@pytest.fixture
def stub_page():
    """Stub Tom Blomfield page with no large prose section."""
    return (
        "---\n"
        "type: person\n"
        "title: Tom Blomfield\n"
        "---\n"
        "# Tom Blomfield\n\n"
        "## Role\n"
        "(stub)\n\n"
        "## Background\n"
        "Stub line.\n"
    )


@pytest.fixture
def page_with_long_background():
    """Page where ## Background has a >=30-word existing prose section."""
    long_para = " ".join(["word"] * 60)
    return (
        "---\n"
        "type: person\n"
        "title: Tom Blomfield\n"
        "---\n"
        "# Tom Blomfield\n\n"
        f"## Background\n{long_para}\n"
    )


@pytest.fixture
def page_with_overwrite_optin():
    long_para = " ".join(["word"] * 60)
    return (
        "---\n"
        "type: person\n"
        "title: Tom Blomfield\n"
        "auto_enrich_overwrite:\n"
        "  - \"## Background\"\n"
        "  - \"## Public Thesis\"\n"
        "---\n"
        "# Tom Blomfield\n\n"
        f"## Background\n{long_para}\n"
    )


@pytest.fixture
def good_url_bodies(good_artifact):
    """Build a url->body map where every claim's quote appears in the body."""
    bodies: dict[str, str] = {}
    for claim in good_artifact["claims"]:
        url = claim["citation"]["url"]
        quote = claim["citation"]["quote"]
        bodies.setdefault(url, "")
        bodies[url] += f"\n<html><body>...{quote}...</body></html>\n"
    return bodies


# --- Tests ---

def test_good_artifact_passes(good_artifact, stub_page, tmp_path, good_url_bodies):
    """Happy path: Iron Law passes, non-destructive trivially fine, no fabricated
    commands, lint OK -> passed=True, issues=[]."""
    draft = tmp_path / "draft.md"
    draft.write_text("# stub draft\n")
    with patch.object(quality_check.urllib.request, "urlopen",
                      _mock_urlopen_factory(good_url_bodies)), \
         _patch_live_verbs(KNOWN_VERBS), \
         _patch_lint_ok():
        passed, issues = quality_check.check(good_artifact, stub_page, draft)
    assert passed is True, f"expected pass, got issues={issues}"
    blocking = [i for i in issues if i["severity"] in quality_check.BLOCKING]
    assert blocking == []


def test_fabricated_uncited_claim_blocks(fabricated_artifact, stub_page, tmp_path):
    """Iron Law critical: claim with empty citation.url -> passed=False."""
    draft = tmp_path / "draft.md"
    draft.write_text("# stub draft\n")
    with _patch_live_verbs(KNOWN_VERBS), _patch_lint_ok():
        passed, issues = quality_check.check(fabricated_artifact, stub_page, draft)
    assert passed is False
    iron = [i for i in issues if i["rule"] == "iron_law" and i["severity"] == "critical"]
    assert iron, f"expected critical iron_law issue, got {issues}"


def test_destructive_blocked_without_optin(destructive_artifact, page_with_long_background,
                                            tmp_path, good_url_bodies):
    """Rule #3: narrative_addition targets ## Background which has >=30 words and
    no auto_enrich_overwrite opt-in -> high-severity block."""
    bodies = dict(good_url_bodies)
    cit = destructive_artifact["claims"][0]["citation"]
    bodies[cit["url"]] = f"<html>{cit['quote']}</html>"

    draft = tmp_path / "draft.md"
    draft.write_text("# stub draft\n")
    with patch.object(quality_check.urllib.request, "urlopen",
                      _mock_urlopen_factory(bodies)), \
         _patch_live_verbs(KNOWN_VERBS), \
         _patch_lint_ok():
        passed, issues = quality_check.check(
            destructive_artifact, page_with_long_background, draft,
        )
    assert passed is False
    nd = [i for i in issues if i["rule"] == "non_destructive" and i["severity"] == "high"]
    assert nd, f"expected non_destructive high issue, got {issues}"


def test_destructive_allowed_with_optin(destructive_artifact, page_with_overwrite_optin,
                                         tmp_path, good_url_bodies):
    """Same artifact but page frontmatter opts ## Background into overwrites."""
    bodies = dict(good_url_bodies)
    cit = destructive_artifact["claims"][0]["citation"]
    bodies[cit["url"]] = f"<html>{cit['quote']}</html>"

    draft = tmp_path / "draft.md"
    draft.write_text("# stub draft\n")
    with patch.object(quality_check.urllib.request, "urlopen",
                      _mock_urlopen_factory(bodies)), \
         _patch_live_verbs(KNOWN_VERBS), \
         _patch_lint_ok():
        passed, issues = quality_check.check(
            destructive_artifact, page_with_overwrite_optin, draft,
        )
    nd = [i for i in issues if i["rule"] == "non_destructive"]
    assert nd == [], f"expected no non_destructive issue under opt-in, got {nd}"
    # passed depends only on blocking rules
    assert passed is True


def test_fabricated_command_blocks(stub_page, tmp_path, good_url_bodies, good_artifact):
    """Artifact text mentions `gbrain undelete --page X` which is NOT a live
    gbrain verb -> Rule #4 high block."""
    artifact = dict(good_artifact)
    artifact["narrative_additions"] = list(artifact.get("narrative_additions", [])) + [
        {
            "section": "## Operations",
            "text": "Run `gbrain undelete --page foo` to recover.",
            "citation_indexes": [],
        }
    ]
    draft = tmp_path / "draft.md"
    draft.write_text("# stub draft\n")
    with patch.object(quality_check.urllib.request, "urlopen",
                      _mock_urlopen_factory(good_url_bodies)), \
         _patch_live_verbs(KNOWN_VERBS), \
         _patch_lint_ok():
        passed, issues = quality_check.check(artifact, stub_page, draft)
    assert passed is False
    fab = [i for i in issues if i["rule"] == "fabricated_command" and i["severity"] == "high"]
    assert fab, f"expected fabricated_command high issue, got {issues}"


def test_lint_failure_blocks(good_artifact, stub_page, tmp_path, good_url_bodies):
    """Rule #5: gbrain lint non-zero -> high block."""
    draft = tmp_path / "draft.md"
    draft.write_text("---\nbad: : yaml\n---\n")
    with patch.object(quality_check.urllib.request, "urlopen",
                      _mock_urlopen_factory(good_url_bodies)), \
         _patch_live_verbs(KNOWN_VERBS), \
         _patch_lint_fail(stderr="malformed YAML frontmatter"):
        passed, issues = quality_check.check(good_artifact, stub_page, draft)
    assert passed is False
    lint = [i for i in issues if i["rule"] == "lint" and i["severity"] == "high"]
    assert lint, f"expected lint high issue, got {issues}"


def test_iron_law_fetch_timeout_does_not_block(good_artifact, stub_page, tmp_path):
    """Iron Law: network errors are fail-open. Quote-cannot-be-checked because
    URL did not respond -> low-severity warning, not a block."""
    def boom(req, timeout=None):  # noqa: ARG001
        raise quality_check.urllib.error.URLError("simulated timeout")

    draft = tmp_path / "draft.md"
    draft.write_text("# stub draft\n")
    with patch.object(quality_check.urllib.request, "urlopen", boom), \
         _patch_live_verbs(KNOWN_VERBS), \
         _patch_lint_ok():
        passed, issues = quality_check.check(good_artifact, stub_page, draft)
    assert passed is True, f"fail-open expected, got blocking issues={issues}"
    low = [i for i in issues if i["rule"] == "iron_law" and i["severity"] == "low"]
    assert low, "expected low-severity fetch fail-open warnings"


def test_iron_law_quote_not_on_page_blocks(good_artifact, stub_page, tmp_path):
    """Iron Law: URL fetches OK but the quote string isn't anywhere in the body
    -> critical block."""
    # Body that does NOT contain any of the claim quotes.
    bodies = {claim["citation"]["url"]: "<html>unrelated content</html>"
              for claim in good_artifact["claims"]}

    draft = tmp_path / "draft.md"
    draft.write_text("# stub draft\n")
    with patch.object(quality_check.urllib.request, "urlopen",
                      _mock_urlopen_factory(bodies)), \
         _patch_live_verbs(KNOWN_VERBS), \
         _patch_lint_ok():
        passed, issues = quality_check.check(good_artifact, stub_page, draft)
    assert passed is False
    crit = [i for i in issues
            if i["rule"] == "iron_law" and i["severity"] == "critical"
            and "quote not found" in i["detail"]]
    assert crit, f"expected critical quote-not-found issue, got {issues}"
