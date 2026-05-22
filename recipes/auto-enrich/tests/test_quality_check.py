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

@pytest.fixture(autouse=True)
def _disable_gstack_browse_by_default(request):
    """Autouse: stub _fetch_via_gstack_browse to return None so existing
    tests fall through to the mocked urllib path. Tests that exercise the
    gstack-browse code path opt out by marking ``no_gstack_stub``."""
    if "no_gstack_stub" in request.keywords:
        yield
        return
    with patch.object(quality_check, "_fetch_via_gstack_browse", return_value=None):
        yield


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


# --- X API gate tests (T1-T9) ---


def test_x_url_pattern_match():
    """T1: _X_TWEET_RE matches x.com/twitter.com status URLs with numeric ids,
    and rejects non-status, non-numeric, and lookalike-domain URLs."""
    r = quality_check._X_TWEET_RE
    assert r.match("https://x.com/kloss_xyz/status/2039849322574205190")
    assert r.match("https://twitter.com/foo/status/123")
    assert r.match("http://x.com/bar/status/456")
    assert r.match("https://www.x.com/bar/status/789")

    assert not r.match("https://x.com/foo")
    assert not r.match("https://x.com/foo/status/abc")
    assert not r.match("https://x.com.fake.com/foo/status/123")
    assert not r.match("https://example.com/foo/status/123")


def test_fetch_x_tweet_text_uses_xurl():
    """T2: _fetch_x_tweet_text shells out to xurl with the right path and
    returns data.text + double-newline + data.note_tweet.text."""
    captured = {}

    def fake_run(cmd, capture_output, text, timeout, check):  # noqa: ARG001
        captured["cmd"] = cmd
        body = {"data": {"text": "short", "note_tweet": {"text": "long form body"}}}
        return MagicMock(returncode=0, stdout=json.dumps(body), stderr="")

    with patch.object(quality_check.subprocess, "run", fake_run):
        out = quality_check._fetch_x_tweet_text("12345")

    assert captured["cmd"] == ["xurl", "/2/tweets/12345?tweet.fields=text,note_tweet"]
    assert out == "short\n\nlong form body"


def test_fetch_x_tweet_text_handles_no_note_tweet():
    """T3: with no note_tweet field, result equals data.text."""
    def fake_run(cmd, capture_output, text, timeout, check):  # noqa: ARG001
        body = {"data": {"text": "just the short one"}}
        return MagicMock(returncode=0, stdout=json.dumps(body), stderr="")

    with patch.object(quality_check.subprocess, "run", fake_run):
        out = quality_check._fetch_x_tweet_text("9")
    assert out == "just the short one"


def test_fetch_x_tweet_text_xurl_failure_returns_none():
    """T4: TimeoutExpired and non-zero exit both yield None."""
    def boom(cmd, capture_output, text, timeout, check):  # noqa: ARG001
        raise subprocess.TimeoutExpired(cmd, timeout)

    with patch.object(quality_check.subprocess, "run", boom):
        assert quality_check._fetch_x_tweet_text("1") is None

    def nonzero(cmd, capture_output, text, timeout, check):  # noqa: ARG001
        return MagicMock(returncode=1, stdout="", stderr="auth error")

    with patch.object(quality_check.subprocess, "run", nonzero):
        assert quality_check._fetch_x_tweet_text("1") is None


def test_iron_law_x_url_uses_api_path_when_quote_matches(stub_page, tmp_path):
    """T5: claim cites an X URL; mocked xurl returns long-form text containing
    the quote; Iron Law passes for that claim and NO plain HTTP fetch happens."""
    artifact = {
        "claims": [
            {
                "text": "Pedro likes pipelines",
                "citation": {
                    "url": "https://x.com/pedro_franceschi/status/1234567890",
                    "quote": "signal ingestion pipeline screens his email",
                },
            }
        ],
        "narrative_additions": [],
        "structured_facts": [],
    }
    full_tweet = (
        "short hook here.\n\n"
        "The signal ingestion pipeline screens his email and triages it."
    )

    def fake_xurl_run(cmd, capture_output, text, timeout, check):  # noqa: ARG001
        body = {"data": {"text": "short hook here.", "note_tweet": {
            "text": "The signal ingestion pipeline screens his email and triages it."}}}
        return MagicMock(returncode=0, stdout=json.dumps(body), stderr="")

    def boom_urlopen(req, timeout=None):  # noqa: ARG001
        raise AssertionError("plain HTTP fetch must NOT happen for X URL")

    draft = tmp_path / "draft.md"
    draft.write_text("# stub\n")
    with patch.object(quality_check.subprocess, "run", fake_xurl_run), \
         patch.object(quality_check.urllib.request, "urlopen", boom_urlopen), \
         _patch_live_verbs(KNOWN_VERBS):
        # Patch lint via _live_gbrain_verbs path + draft-less call: run only iron law.
        issues, stats = quality_check.check_iron_law(artifact)
    crit = [i for i in issues if i["severity"] == "critical"]
    assert crit == [], f"expected no critical issues, got {issues}"
    assert stats["fetch_attempts"] == 1
    assert stats["fetch_failures"] == 0
    # confirm full_tweet variable used so flake8 stays quiet
    assert "signal ingestion pipeline" in full_tweet


def test_iron_law_x_url_falls_back_to_http_when_xurl_fails(stub_page, tmp_path):
    """T6: xurl returns None; the existing plain HTTP path runs (and we assert
    it was called)."""
    artifact = {
        "claims": [
            {
                "text": "fallback claim",
                "citation": {
                    "url": "https://x.com/foo/status/42",
                    "quote": "fallback page contents",
                },
            }
        ],
    }
    http_calls: list[str] = []

    def fake_xurl(cmd, capture_output, text, timeout, check):  # noqa: ARG001
        # Simulate xurl auth / network failure.
        return MagicMock(returncode=1, stdout="", stderr="boom")

    def fake_urlopen(req, timeout=None):  # noqa: ARG001
        http_calls.append(req.get_full_url())
        body = b"<html>here is fallback page contents from http</html>"
        resp = MagicMock()
        resp.read.return_value = body
        resp.__enter__ = lambda self: self
        resp.__exit__ = lambda self, *a: False
        return resp

    with patch.object(quality_check.subprocess, "run", fake_xurl), \
         patch.object(quality_check.urllib.request, "urlopen", fake_urlopen):
        issues, stats = quality_check.check_iron_law(artifact)

    assert http_calls == ["https://x.com/foo/status/42"], (
        f"expected HTTP fallback to fire, got {http_calls}"
    )
    crit = [i for i in issues if i["severity"] == "critical"]
    assert crit == [], f"expected fallback substring match to succeed, got {issues}"


def test_normalize_for_match_unescapes_html_entities():
    """T7."""
    assert quality_check._normalize_for_match("foo &gt; bar") == "foo > bar"
    assert quality_check._normalize_for_match("a &amp; b") == "a & b"


def test_normalize_for_match_collapses_whitespace():
    """T8."""
    assert quality_check._normalize_for_match("foo  \n\t bar") == "foo bar"
    assert quality_check._normalize_for_match("  leading   trailing  ") == "leading trailing"


def test_iron_law_uses_normalized_comparison_so_html_entities_dont_break_match(tmp_path):  # noqa: ARG001
    """T9: tweet body has literal &gt;; claim quote uses raw >. After
    normalization both reduce to the same string and Iron Law passes."""
    artifact = {
        "claims": [
            {
                "text": "blockquote claim",
                "citation": {
                    "url": "https://x.com/pf/status/99",
                    "quote": "> signal ingestion pipeline screens his email",
                },
            }
        ],
    }

    def fake_xurl(cmd, capture_output, text, timeout, check):  # noqa: ARG001
        body = {"data": {"text": "intro", "note_tweet": {
            "text": "&gt; signal ingestion pipeline screens his email"}}}
        return MagicMock(returncode=0, stdout=json.dumps(body), stderr="")

    with patch.object(quality_check.subprocess, "run", fake_xurl):
        issues, _ = quality_check.check_iron_law(artifact)
    crit = [i for i in issues if i["severity"] == "critical"]
    assert crit == [], f"normalization should have matched, got {issues}"


# ---------------------------------------------------------------------------
# X profile URL support (BUG 1 fix)
# ---------------------------------------------------------------------------


def test_x_profile_url_pattern_match():
    """_X_PROFILE_RE matches bare profile URLs but NOT status URLs."""
    r = quality_check._X_PROFILE_RE
    assert r.match("https://x.com/petradonka")
    assert r.match("https://x.com/foo/")
    assert r.match("https://twitter.com/bar")
    assert r.match("https://www.x.com/baz")
    assert r.match("http://x.com/qux")
    # Status URLs must NOT match the profile regex (tweet path priority).
    assert not r.match("https://x.com/petradonka/status/123")
    assert not r.match("https://x.com/foo/status/456")
    # Other paths and lookalikes rejected.
    assert not r.match("https://x.com.fake.com/foo")
    assert not r.match("https://x.com/foo/extra/path")


def test_fetch_x_profile_text_uses_xurl():
    """Monkeypatch subprocess.run, assert correct xurl path and concatenated output."""
    payload = {
        "data": {
            "name": "Petra Donka",
            "username": "petradonka",
            "description": "Head of DX at @warpdotdev. Previously @Prisma & @Scandit.",
            "location": "Berlin",
            "url": "https://petradonka.com",
            "verified": True,
            "created_at": "2014-01-01T00:00:00.000Z",
        }
    }
    captured = {}

    def fake_run(cmd, capture_output, text, timeout, check):  # noqa: ARG001
        captured["cmd"] = cmd
        return MagicMock(returncode=0, stdout=json.dumps(payload), stderr="")

    with patch.object(quality_check.subprocess, "run", fake_run):
        out = quality_check._fetch_x_profile_text("petradonka")

    assert captured["cmd"][0] == "xurl"
    assert "/2/users/by/username/petradonka" in captured["cmd"][1]
    assert "description" in captured["cmd"][1]
    assert out is not None
    assert "Petra Donka" in out
    assert "@petradonka" in out
    assert "Head of DX at @warpdotdev. Previously @Prisma & @Scandit." in out
    assert "Location: Berlin" in out
    assert "URL: https://petradonka.com" in out
    assert "Verified" in out


def test_fetch_x_profile_text_handles_missing_fields():
    """If only description present, output is just description-ish (no Location/URL lines)."""
    payload = {"data": {"description": "just a bio"}}

    def fake_run(cmd, capture_output, text, timeout, check):  # noqa: ARG001
        return MagicMock(returncode=0, stdout=json.dumps(payload), stderr="")

    with patch.object(quality_check.subprocess, "run", fake_run):
        out = quality_check._fetch_x_profile_text("foo")

    assert out == "just a bio"


def test_fetch_x_profile_text_xurl_failure_returns_none():
    """Timeout and non-zero exit both return None (fail-open)."""
    def fake_timeout(cmd, capture_output, text, timeout, check):  # noqa: ARG001
        raise subprocess.TimeoutExpired(cmd=cmd, timeout=timeout)

    with patch.object(quality_check.subprocess, "run", fake_timeout):
        assert quality_check._fetch_x_profile_text("foo") is None

    def fake_nonzero(cmd, capture_output, text, timeout, check):  # noqa: ARG001
        return MagicMock(returncode=1, stdout="", stderr="boom")

    with patch.object(quality_check.subprocess, "run", fake_nonzero):
        assert quality_check._fetch_x_profile_text("foo") is None

    # Bad JSON also returns None.
    def fake_badjson(cmd, capture_output, text, timeout, check):  # noqa: ARG001
        return MagicMock(returncode=0, stdout="not json{{", stderr="")

    with patch.object(quality_check.subprocess, "run", fake_badjson):
        assert quality_check._fetch_x_profile_text("foo") is None


def test_iron_law_x_profile_url_uses_api_path():
    """End-to-end: claim citing x.com/petradonka with verbatim bio quote passes
    via the X API path. No plain HTTP fetch occurs."""
    artifact = {
        "claims": [
            {
                "text": "Petra works at Warp",
                "citation": {
                    "url": "https://x.com/petradonka",
                    "quote": "Head of DX at @warpdotdev. Previously @Prisma & @Scandit.",
                },
            }
        ],
    }

    def fake_run(cmd, capture_output, text, timeout, check):  # noqa: ARG001
        body = {"data": {
            "name": "Petra Donka",
            "username": "petradonka",
            "description": "Head of DX at @warpdotdev. Previously @Prisma & @Scandit.",
        }}
        return MagicMock(returncode=0, stdout=json.dumps(body), stderr="")

    http_calls = []

    def fake_urlopen(req, timeout=None):  # noqa: ARG001
        http_calls.append(req.get_full_url())
        raise AssertionError("plain HTTP should not be called for profile URL when xurl succeeds")

    with patch.object(quality_check.subprocess, "run", fake_run), \
         patch.object(quality_check.urllib.request, "urlopen", fake_urlopen):
        issues, stats = quality_check.check_iron_law(artifact)

    crit = [i for i in issues if i["severity"] == "critical"]
    assert crit == [], f"expected pass; got critical issues {crit}"
    assert http_calls == [], "plain HTTP must not be hit when xurl profile path succeeds"


def test_x_status_takes_precedence_over_profile_pattern():
    """When URL matches the tweet regex, the profile fetcher is NEVER called."""
    artifact = {
        "claims": [
            {
                "text": "tweet content",
                "citation": {
                    "url": "https://x.com/foo/status/123",
                    "quote": "tweeted hello world",
                },
            }
        ],
    }

    calls = []

    def fake_xurl(cmd, capture_output, text, timeout, check):  # noqa: ARG001
        calls.append(cmd[1])
        # Return the tweet endpoint payload regardless; we just want to assert
        # we never see the by/username path.
        body = {"data": {"text": "tweeted hello world"}}
        return MagicMock(returncode=0, stdout=json.dumps(body), stderr="")

    # If the profile fetcher is wired wrongly, it will hit /2/users/by/username.
    profile_spy_called = {"v": False}
    real_profile = quality_check._fetch_x_profile_text

    def spy_profile(handle, timeout=5):  # noqa: ARG001
        profile_spy_called["v"] = True
        return real_profile(handle, timeout)

    with patch.object(quality_check.subprocess, "run", fake_xurl), \
         patch.object(quality_check, "_fetch_x_profile_text", spy_profile):
        quality_check.check_iron_law(artifact)

    assert profile_spy_called["v"] is False, "profile fetcher must NOT be called for status URLs"
    # And the calls that did happen must be tweet endpoint, not user endpoint.
    assert any("/2/tweets/" in c for c in calls)
    assert not any("/2/users/by/username/" in c for c in calls)


def test_x_profile_xurl_failure_falls_back_to_http():
    """If xurl profile fetch fails, fall back to plain HTTP fetch (fail-open)."""
    artifact = {
        "claims": [
            {
                "text": "claim",
                "citation": {
                    "url": "https://x.com/foo",
                    "quote": "hello world",
                },
            }
        ],
    }

    def fake_run(cmd, capture_output, text, timeout, check):  # noqa: ARG001
        return MagicMock(returncode=1, stdout="", stderr="api down")

    fake_url_opener = _mock_urlopen_factory({"https://x.com/foo": "<html>hello world</html>"})

    with patch.object(quality_check.subprocess, "run", fake_run), \
         patch.object(quality_check.urllib.request, "urlopen", fake_url_opener):
        issues, _ = quality_check.check_iron_law(artifact)

    crit = [i for i in issues if i["severity"] == "critical"]
    assert crit == [], f"http fallback should have matched; got {crit}"
    # Low-severity warning about the xurl failure should appear.
    low = [i for i in issues if i["severity"] == "low" and "profile" in i["detail"]]
    assert low, "expected a low-severity warning about xurl profile fallback"


# --- gstack-browse fetch path tests (Round 3) ---

GSTACK_BIN_PATH_FRAGMENT = "gstack/browse/dist/browse"


@pytest.mark.no_gstack_stub
def test_fetch_via_gstack_browse_command_shape():
    """Two subprocess calls in order: `<binary> goto <url>` then
    `<binary> text`. Binary path includes gstack/browse/dist/browse."""
    calls = []

    def fake_run(cmd, capture_output, text, timeout, check):  # noqa: ARG001
        calls.append({"cmd": list(cmd), "timeout": timeout})
        if cmd[1] == "goto":
            return MagicMock(returncode=0, stdout="Navigated\n", stderr="")
        return MagicMock(returncode=0, stdout="some page text\n", stderr="")

    with patch.object(quality_check.os.path, "exists", return_value=True), \
         patch.object(quality_check.subprocess, "run", fake_run):
        out = quality_check._fetch_via_gstack_browse("https://example.com")

    assert out is not None
    assert len(calls) == 2
    assert calls[0]["cmd"][1] == "goto"
    assert calls[0]["cmd"][2] == "https://example.com"
    assert GSTACK_BIN_PATH_FRAGMENT in calls[0]["cmd"][0]
    assert calls[1]["cmd"][1] == "text"
    assert GSTACK_BIN_PATH_FRAGMENT in calls[1]["cmd"][0]


@pytest.mark.no_gstack_stub
def test_fetch_via_gstack_browse_strips_sentinels():
    """BEGIN/END sentinel lines stripped from returned content."""
    payload = (
        "--- BEGIN UNTRUSTED EXTERNAL CONTENT (source: https://example.com/) ---\n"
        "Real body line one\n"
        "Real body line two\n"
        "--- END UNTRUSTED EXTERNAL CONTENT ---\n"
    )

    def fake_run(cmd, capture_output, text, timeout, check):  # noqa: ARG001
        if cmd[1] == "goto":
            return MagicMock(returncode=0, stdout="", stderr="")
        return MagicMock(returncode=0, stdout=payload, stderr="")

    with patch.object(quality_check.os.path, "exists", return_value=True), \
         patch.object(quality_check.subprocess, "run", fake_run):
        out = quality_check._fetch_via_gstack_browse("https://example.com")

    assert out is not None
    assert "BEGIN UNTRUSTED EXTERNAL CONTENT" not in out
    assert "END UNTRUSTED EXTERNAL CONTENT" not in out
    assert "Real body line one" in out
    assert "Real body line two" in out


@pytest.mark.no_gstack_stub
def test_fetch_via_gstack_browse_returns_none_on_missing_binary():
    """If binary path does not exist, return None without invoking subprocess."""
    run_called = {"v": False}

    def fake_run(*a, **kw):
        run_called["v"] = True
        return MagicMock(returncode=0, stdout="", stderr="")

    with patch.object(quality_check.os.path, "exists", return_value=False), \
         patch.object(quality_check.subprocess, "run", fake_run):
        out = quality_check._fetch_via_gstack_browse("https://example.com")

    assert out is None
    assert run_called["v"] is False


@pytest.mark.no_gstack_stub
def test_fetch_via_gstack_browse_returns_none_on_timeout():
    """TimeoutExpired and OSError both yield None."""
    def timeout_boom(cmd, capture_output, text, timeout, check):  # noqa: ARG001
        raise subprocess.TimeoutExpired(cmd, timeout)

    with patch.object(quality_check.os.path, "exists", return_value=True), \
         patch.object(quality_check.subprocess, "run", timeout_boom):
        assert quality_check._fetch_via_gstack_browse("https://example.com") is None

    def os_boom(cmd, capture_output, text, timeout, check):  # noqa: ARG001
        raise OSError("exec format error")

    with patch.object(quality_check.os.path, "exists", return_value=True), \
         patch.object(quality_check.subprocess, "run", os_boom):
        assert quality_check._fetch_via_gstack_browse("https://example.com") is None


@pytest.mark.no_gstack_stub
def test_iron_law_uses_gstack_browse_for_generic_url():
    """For non-X URL, _fetch_via_gstack_browse is called and plain HTTP urllib is NOT."""
    artifact = {
        "claims": [
            {
                "text": "Anyword has a parent company",
                "citation": {
                    "url": "https://anyword.com/about",
                    "quote": "Keywee Inc. (d.b.a. Anyword)",
                },
            }
        ],
    }

    gstack_called = {"v": False}

    def fake_gstack(url, timeout_seconds=20):  # noqa: ARG001
        gstack_called["v"] = True
        return "About page content: Keywee Inc. (d.b.a. Anyword) operates the platform."

    def fake_urlopen(req, timeout=None):  # noqa: ARG001
        raise AssertionError("plain HTTP must not be called when gstack-browse succeeds")

    with patch.object(quality_check, "_fetch_via_gstack_browse", fake_gstack), \
         patch.object(quality_check.urllib.request, "urlopen", fake_urlopen):
        issues, _ = quality_check.check_iron_law(artifact)

    assert gstack_called["v"] is True
    crit = [i for i in issues if i["severity"] == "critical"]
    assert crit == [], f"expected pass, got {crit}"


@pytest.mark.no_gstack_stub
def test_iron_law_falls_back_to_http_when_gstack_browse_returns_none():
    """When gstack-browse returns None, plain HTTP urllib IS called."""
    artifact = {
        "claims": [
            {
                "text": "claim",
                "citation": {
                    "url": "https://example.com/foo",
                    "quote": "fallback body",
                },
            }
        ],
    }

    http_calls = []
    fake_url_opener = _mock_urlopen_factory({"https://example.com/foo": "<html>fallback body</html>"})

    def tracking_urlopen(req, timeout=None):
        http_calls.append(req.get_full_url())
        return fake_url_opener(req, timeout=timeout)

    with patch.object(quality_check, "_fetch_via_gstack_browse", return_value=None), \
         patch.object(quality_check.urllib.request, "urlopen", tracking_urlopen):
        issues, _ = quality_check.check_iron_law(artifact)

    assert http_calls == ["https://example.com/foo"]
    crit = [i for i in issues if i["severity"] == "critical"]
    assert crit == [], f"http fallback should have matched; got {crit}"
    low = [i for i in issues if i["severity"] == "low" and "gstack-browse" in i["detail"]]
    assert low, "expected low-severity warning about gstack-browse failure"


@pytest.mark.no_gstack_stub
def test_x_urls_still_use_xurl_not_gstack_browse():
    """Regression: x.com/status URLs go to xurl, gstack-browse must NOT be called."""
    artifact = {
        "claims": [
            {
                "text": "tweet content",
                "citation": {
                    "url": "https://x.com/foo/status/123",
                    "quote": "tweeted hello world",
                },
            }
        ],
    }

    gstack_called = {"v": False}

    def fake_gstack(url, timeout_seconds=20):  # noqa: ARG001
        gstack_called["v"] = True
        return None

    xurl_called = {"v": False}

    def fake_xurl(tweet_id, timeout=5):  # noqa: ARG001
        xurl_called["v"] = True
        return "tweeted hello world"

    with patch.object(quality_check, "_fetch_via_gstack_browse", fake_gstack), \
         patch.object(quality_check, "_fetch_x_tweet_text", fake_xurl):
        issues, _ = quality_check.check_iron_law(artifact)

    assert xurl_called["v"] is True, "xurl should handle X status URLs"
    assert gstack_called["v"] is False, "gstack-browse must not be called for X URLs"
    crit = [i for i in issues if i["severity"] == "critical"]
    assert crit == []
