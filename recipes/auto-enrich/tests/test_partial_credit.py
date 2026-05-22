"""Tests for the partial-credit recovery pattern in run_pipeline.

When the Iron Law gate finds per-claim failures but no other blocking
issues, the pipeline should drop the failing claims and continue with
the verified ones. These tests cover the helpers + the wiring.
"""
from __future__ import annotations

import sys
from pathlib import Path

# scripts/ is a sibling of tests/; add to sys.path so `import quality_check`
# works the same way it does in the other tests.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import quality_check  # noqa: E402


def _issue(rule: str, severity: str, detail: str) -> dict:
    return {"rule": rule, "severity": severity, "detail": detail}


# ---- failing_iron_law_indices ----

def test_failing_iron_law_indices_collects_blocking_only():
    issues = [
        _issue("iron_law", "critical", "claims[0]: quote not found on page https://x"),
        _issue("iron_law", "critical", "claims[2]: citation.quote empty"),
        # Non-blocking iron_law (fetch hint) should NOT be collected
        _issue("iron_law", "low", "claims[1]: fetch fail for https://x: timeout (fail-open)"),
        # Other rules ignored
        _issue("no_fabrication", "high", "fabricated gbrain verb foo"),
    ]
    assert quality_check.failing_iron_law_indices(issues) == {0, 2}


def test_failing_iron_law_indices_empty_when_no_iron_law():
    issues = [_issue("lint", "high", "draft markdown failed")]
    assert quality_check.failing_iron_law_indices(issues) == set()


def test_failing_iron_law_indices_handles_malformed_detail():
    # Detail that doesn't start with "claims[N]:" must not crash, just skip.
    issues = [_issue("iron_law", "critical", "global iron law failure")]
    assert quality_check.failing_iron_law_indices(issues) == set()


# ---- filter_artifact_drop_claims ----

def test_filter_artifact_drop_claims_removes_indices_and_tags():
    artifact = {
        "slug": "example",
        "claims": [
            {"text": "kept-a", "citation": {"url": "u", "quote": "q"}},
            {"text": "drop-b", "citation": {"url": "u", "quote": "q"}},
            {"text": "kept-c", "citation": {"url": "u", "quote": "q"}},
        ],
    }
    out = quality_check.filter_artifact_drop_claims(artifact, {1})
    assert [c["text"] for c in out["claims"]] == ["kept-a", "kept-c"]
    assert out["dropped_claim_count"] == 1
    # Original untouched
    assert len(artifact["claims"]) == 3
    assert "dropped_claim_count" not in artifact


def test_filter_artifact_drop_claims_no_op_when_empty():
    artifact = {"claims": [{"text": "a"}]}
    out = quality_check.filter_artifact_drop_claims(artifact, set())
    # Same object back when nothing to drop, no dropped_claim_count tag.
    assert out is artifact
    assert "dropped_claim_count" not in out


def test_filter_artifact_drop_claims_drops_all():
    artifact = {"claims": [{"text": "a"}, {"text": "b"}]}
    out = quality_check.filter_artifact_drop_claims(artifact, {0, 1})
    assert out["claims"] == []
    assert out["dropped_claim_count"] == 2
