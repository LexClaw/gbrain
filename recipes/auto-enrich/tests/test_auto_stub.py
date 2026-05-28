"""Tests for auto_stub.py (Phase 2 of the link-resolver hardening plan).

Covers:
  - eligibility regex (only people/companies)
  - evidence gate (page_content, claim_quote, narrative rejected)
  - dry-run path (would_create event, no put)
  - cap enforcement
  - put failure caught, no half-state
  - existence recheck (skipped_now_exists path)
  - per-call argv shape
  - frontmatter values match plan (auto_stub: true, stub_evidence in {page_content, claim_quote})
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import auto_stub  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _artifact(target_slug="people/source-page", page_content="", claims=None):
    return {
        "target_slug": target_slug,
        "page_content": page_content,
        "claims": claims or [],
    }


def _unresolved(target, **extras):
    base = {
        "original_link": {"type": "mentions", "target": target},
        "target": target,
        "search_top_score": 0.4,
        "search_top_candidate": None,
        "basename_top_score": 0.5,
        "basename_top_candidate": None,
    }
    base.update(extras)
    return base


# ---------------------------------------------------------------------------
# Eligibility
# ---------------------------------------------------------------------------


def test_ineligible_concept_target_no_stub():
    ctx = auto_stub.AutoStubContext(dry_run=False)
    art = _artifact(page_content="anything")
    entry = _unresolved("concepts/foo-missing")
    out = auto_stub.try_auto_stub_link(
        entry, art, ctx,
        slug_exists=lambda s: False,
        gbrain_put=MagicMock(),
    )
    assert out is None
    kinds = [e["kind"] for e in ctx.events]
    assert "auto_stub_ineligible_target" in kinds


def test_ineligible_uppercase_or_slashes_no_stub():
    ctx = auto_stub.AutoStubContext(dry_run=False)
    art = _artifact()
    for bad in ("people/Foo-Bar", "PEOPLE/foo", "people/", "people/foo/bar"):
        entry = _unresolved(bad)
        out = auto_stub.try_auto_stub_link(
            entry, art, ctx,
            slug_exists=lambda s: False, gbrain_put=MagicMock(),
        )
        assert out is None, f"target {bad!r} should be ineligible"


# ---------------------------------------------------------------------------
# Evidence gate
# ---------------------------------------------------------------------------


def test_evidence_gate_page_content_substring_passes():
    ctx = auto_stub.AutoStubContext(dry_run=False)
    art = _artifact(page_content="Swadesh Kumar leads the team.")
    entry = _unresolved("people/swadesh-kumar")
    put = MagicMock()
    out = auto_stub.try_auto_stub_link(
        entry, art, ctx, slug_exists=lambda s: False, gbrain_put=put,
    )
    assert out == "people/swadesh-kumar"
    assert put.called
    assert ctx.stubs_created == 1
    ev = [e for e in ctx.events if e["kind"] == "auto_stub_created"][0]
    assert ev["evidence_path"] == "page_content"
    assert ev["derived_title"] == "Swadesh Kumar"


def test_evidence_gate_claim_quote_passes():
    ctx = auto_stub.AutoStubContext(dry_run=False)
    art = _artifact(page_content="", claims=[
        {"text": "x", "citation": {"url": "u", "quote": "Quote mentions Jensen Huang directly here."}},
    ])
    entry = _unresolved("people/jensen-huang")
    put = MagicMock()
    out = auto_stub.try_auto_stub_link(
        entry, art, ctx, slug_exists=lambda s: False, gbrain_put=put,
    )
    assert out == "people/jensen-huang"
    ev = [e for e in ctx.events if e["kind"] == "auto_stub_created"][0]
    assert ev["evidence_path"] == "claim_quote"


def test_evidence_gate_narrative_NOT_evidence():
    """v4: narrative_addition.text is NOT valid evidence. Stub must be rejected."""
    ctx = auto_stub.AutoStubContext(dry_run=False)
    art = _artifact(
        page_content="Unrelated content with no person mentioned.",
        claims=[{"text": "x", "citation": {"url": "u", "quote": "different stuff"}}],
    )
    # Even if a narrative_addition mentions the person, that field is not consulted.
    art["narrative_additions"] = [
        {"section": "## Team", "text": "Fake Fabrication is a key advisor."}
    ]
    entry = _unresolved("people/fake-fabrication")
    put = MagicMock()
    out = auto_stub.try_auto_stub_link(
        entry, art, ctx, slug_exists=lambda s: False, gbrain_put=put,
    )
    assert out is None
    assert not put.called
    kinds = [e["kind"] for e in ctx.events]
    assert "auto_stub_rejected_no_evidence" in kinds


def test_evidence_gate_no_match_anywhere_rejected():
    ctx = auto_stub.AutoStubContext(dry_run=False)
    art = _artifact(
        page_content="One thing about something else entirely.",
        claims=[{"text": "x", "citation": {"url": "u", "quote": "and another unrelated quote"}}],
    )
    entry = _unresolved("people/totally-missing")
    put = MagicMock()
    out = auto_stub.try_auto_stub_link(
        entry, art, ctx, slug_exists=lambda s: False, gbrain_put=put,
    )
    assert out is None
    assert not put.called


# ---------------------------------------------------------------------------
# Existence recheck (race / recent run)
# ---------------------------------------------------------------------------


def test_existence_recheck_skips_when_now_exists():
    ctx = auto_stub.AutoStubContext(dry_run=False)
    art = _artifact(page_content="Name Mentioned is here.")
    entry = _unresolved("people/name-mentioned")
    put = MagicMock()
    out = auto_stub.try_auto_stub_link(
        entry, art, ctx,
        slug_exists=lambda s: True,  # exists now
        gbrain_put=put,
    )
    assert out == "people/name-mentioned"
    assert not put.called
    kinds = [e["kind"] for e in ctx.events]
    assert "auto_stub_skipped_now_exists" in kinds


# ---------------------------------------------------------------------------
# Dry-run
# ---------------------------------------------------------------------------


def test_dry_run_emits_would_create_no_put():
    ctx = auto_stub.AutoStubContext(dry_run=True)
    art = _artifact(page_content="Some Person is here.")
    entry = _unresolved("people/some-person")
    put = MagicMock()
    out = auto_stub.try_auto_stub_link(
        entry, art, ctx, slug_exists=lambda s: False, gbrain_put=put,
    )
    assert out is None
    assert not put.called
    assert ctx.stubs_created == 0
    kinds = [e["kind"] for e in ctx.events]
    assert "auto_stub_would_create" in kinds


# ---------------------------------------------------------------------------
# Cap enforcement
# ---------------------------------------------------------------------------


def test_cap_enforcement_blocks_beyond_max():
    ctx = auto_stub.AutoStubContext(dry_run=False, max_stubs=2)
    put = MagicMock()
    titles = [
        ("people/alpha-one", "Alpha One"),
        ("people/beta-two", "Beta Two"),
        ("people/gamma-three", "Gamma Three"),
    ]
    for slug, title in titles:
        art = _artifact(page_content=f"{title} is here.")
        entry = _unresolved(slug)
        auto_stub.try_auto_stub_link(
            entry, art, ctx, slug_exists=lambda s: False, gbrain_put=put,
        )
    assert ctx.stubs_created == 2
    assert put.call_count == 2
    kinds = [e["kind"] for e in ctx.events]
    assert "auto_stub_cap_hit" in kinds


# ---------------------------------------------------------------------------
# Failure handling
# ---------------------------------------------------------------------------


def test_put_failure_caught_no_half_state():
    ctx = auto_stub.AutoStubContext(dry_run=False)
    art = _artifact(page_content="Faulty Name is mentioned.")
    entry = _unresolved("people/faulty-name")

    def boom(slug, content):
        raise RuntimeError("gbrain exit 1: boom")

    out = auto_stub.try_auto_stub_link(
        entry, art, ctx, slug_exists=lambda s: False, gbrain_put=boom,
    )
    assert out is None
    assert ctx.stubs_created == 0
    kinds = [e["kind"] for e in ctx.events]
    assert "auto_stub_create_failed" in kinds


# ---------------------------------------------------------------------------
# Frontmatter shape (Grant v5 callout: stub_evidence must NEVER be 'narrative')
# ---------------------------------------------------------------------------


def test_stub_frontmatter_evidence_is_page_content_or_claim_quote():
    captured = {}

    def capture(slug, content):
        captured["slug"] = slug
        captured["content"] = content

    ctx = auto_stub.AutoStubContext(dry_run=False)
    art = _artifact(page_content="Captured Person appears here.")
    entry = _unresolved("people/captured-person")
    auto_stub.try_auto_stub_link(
        entry, art, ctx, slug_exists=lambda s: False, gbrain_put=capture,
    )
    body = captured["content"]
    assert "auto_stub: true" in body
    assert "type: person" in body
    assert "stub_source: auto-enrich" in body
    assert "stub_evidence: page_content" in body
    assert "stub_evidence: narrative" not in body, (
        "stub_evidence must NEVER be 'narrative' (Grant v5 callout)"
    )
    assert "[[people/source-page]]" in body
    assert "stub_source_slug: people/source-page" in body


def test_stub_frontmatter_company_target():
    captured = {}

    def capture(slug, content):
        captured["content"] = content

    ctx = auto_stub.AutoStubContext(dry_run=False)
    art = _artifact(target_slug="people/x", page_content="Acme Corp is mentioned here.")
    entry = _unresolved("companies/acme-corp")
    auto_stub.try_auto_stub_link(
        entry, art, ctx, slug_exists=lambda s: False, gbrain_put=capture,
    )
    body = captured["content"]
    assert "type: company" in body
    assert "title: Acme Corp" in body


# ---------------------------------------------------------------------------
# process_unresolved_links: full mutation flow
# ---------------------------------------------------------------------------


def test_process_unresolved_rewrites_links_and_clears_unresolved():
    ctx = auto_stub.AutoStubContext(dry_run=False)
    art = {
        "target_slug": "people/source",
        "page_content": "Real Person is here in the page.",
        "claims": [],
        "suggested_links": [],
        "suggested_links_unresolved": [
            _unresolved("people/real-person"),
        ],
        "suggested_links_original_count": 1,
    }
    put = MagicMock()
    out = auto_stub.process_unresolved_links(
        art, ctx, slug_exists=lambda s: False, gbrain_put=put,
    )
    assert put.called
    # Link rewritten into suggested_links.
    assert out["suggested_links"] == [
        {"type": "mentions", "target": "people/real-person"},
    ]
    # Entry removed from unresolved.
    assert "suggested_links_unresolved" not in out
    # Metrics refreshed.
    assert out["suggested_links_valid_count"] == 1
    assert out["suggested_links_valid_rate"] == 1.0


def test_process_unresolved_keeps_rejected_entries_in_unresolved():
    ctx = auto_stub.AutoStubContext(dry_run=False)
    art = {
        "target_slug": "people/source",
        "page_content": "Irrelevant content with nothing matching.",
        "claims": [],
        "suggested_links": [],
        "suggested_links_unresolved": [
            _unresolved("people/no-evidence"),
        ],
        "suggested_links_original_count": 1,
    }
    out = auto_stub.process_unresolved_links(
        art, ctx, slug_exists=lambda s: False, gbrain_put=MagicMock(),
    )
    assert out["suggested_links"] == []
    assert isinstance(out.get("suggested_links_unresolved"), list)
    assert len(out["suggested_links_unresolved"]) == 1


def test_process_unresolved_dry_run_keeps_unresolved():
    ctx = auto_stub.AutoStubContext(dry_run=True)
    art = {
        "target_slug": "people/source",
        "page_content": "Dry Person is here.",
        "claims": [],
        "suggested_links": [],
        "suggested_links_unresolved": [
            _unresolved("people/dry-person"),
        ],
        "suggested_links_original_count": 1,
    }
    put = MagicMock()
    out = auto_stub.process_unresolved_links(
        art, ctx, slug_exists=lambda s: False, gbrain_put=put,
    )
    assert not put.called
    # Dry run: unresolved entry stays, link not rewritten.
    assert out["suggested_links"] == []
    assert len(out["suggested_links_unresolved"]) == 1


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def test_title_case_basename_person():
    assert auto_stub._title_case_basename("people/jensen-huang") == "Jensen Huang"


def test_title_case_basename_company_multi_word():
    assert auto_stub._title_case_basename("companies/acme-widget-co") == "Acme Widget Co"


def test_fuzzy_line_match_apostrophe_tolerance():
    """SequenceMatcher per-line should tolerate small surface differences."""
    # "Jensen Huang's" in haystack should still match "Jensen Huang".
    assert auto_stub._line_fuzzy_match(
        "Jensen Huang",
        "Jensen Huang's keynote happens tomorrow morning here.",
    )


def test_default_gbrain_put_argv_shape():
    """Plan acceptance: gbrain put invoked with [put, <slug>, --content, <markdown>]."""
    import subprocess
    captured = {}

    class FakeCompleted:
        returncode = 0
        stdout = ""
        stderr = ""

    def fake_run(argv, **kwargs):
        captured["argv"] = argv
        return FakeCompleted()

    with pytest.MonkeyPatch.context() as m:
        m.setattr(subprocess, "run", fake_run)
        m.setenv("GBRAIN_BIN", "gbrain")
        auto_stub._default_gbrain_put("people/x", "---\ntitle: X\n---\n# X\n")

    argv = captured["argv"]
    assert argv[0] == "gbrain"
    assert argv[1] == "put"
    assert argv[2] == "people/x"
    assert argv[3] == "--content"
    assert "title: X" in argv[4]
