"""Tests for synthesize.py."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import synthesize  # noqa: E402
from auto_enrich_lib import GBrainCLIError  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures"


@pytest.fixture
def good_artifact():
    return json.loads((FIXTURES / "research_artifact_good.json").read_text())


@pytest.fixture
def destructive_artifact():
    return json.loads((FIXTURES / "research_artifact_destructive.json").read_text())


@pytest.fixture
def stub_page():
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
        "---\n"
        "# Tom Blomfield\n\n"
        f"## Background\n{long_para}\n"
    )


def _patch_page_exists(existing: set[str]):
    """Patch synthesize.page_exists so suggested_link existence is controllable."""
    return patch.object(synthesize, "page_exists",
                        side_effect=lambda slug: slug in existing)


def test_synthesize_good_stub_page_produces_draft(good_artifact, stub_page):
    """Existing stub sections receive new prose, ## Sources appears, frontmatter
    updated."""
    with _patch_page_exists({
        "companies/y-combinator",
        "companies/monzo-bank",
        "companies/gocardless",
    }):
        draft, issues = synthesize.synthesize(good_artifact, stub_page)
    assert "## Sources" in draft
    assert "last_enriched" in draft
    assert "enriched_by: auto-enrich-recipe" in draft
    assert "enriched_version" in draft
    # Footnote markers from citation_indexes [0, 1].
    assert "[^1]" in draft and "[^2]" in draft
    # ## Facts fence should be created with structured_facts.
    assert "## Facts" in draft
    assert "role: Group Partner" in draft


def test_synthesize_long_section_is_appended_not_overwritten(
    destructive_artifact, page_with_long_background,
):
    """Without auto_enrich_overwrite opt-in, the ## Background addition must
    APPEND, leaving the existing 60-word paragraph intact."""
    original_para = " ".join(["word"] * 60)
    with _patch_page_exists(set()):
        draft, issues = synthesize.synthesize(
            destructive_artifact, page_with_long_background,
        )
    # Original prose still present (non-destructive merge).
    assert original_para in draft, "existing prose must not be overwritten"
    # New text appended.
    assert "once-in-a-decade operator" in draft


def test_synthesize_with_optin_overwrites(
    destructive_artifact, page_with_overwrite_optin,
):
    """With auto_enrich_overwrite listing ## Background, the long original
    paragraph is replaced by the new prose."""
    original_para = " ".join(["word"] * 60)
    with _patch_page_exists(set()):
        draft, issues = synthesize.synthesize(
            destructive_artifact, page_with_overwrite_optin,
        )
    assert original_para not in draft, "opt-in section should be overwritten"
    assert "once-in-a-decade operator" in draft


def test_structured_facts_create_facts_fence(good_artifact, stub_page):
    with _patch_page_exists(set()):
        draft, _ = synthesize.synthesize(good_artifact, stub_page)
    assert "## Facts" in draft
    assert "- role: Group Partner" in draft
    assert "- prior_role: CEO" in draft


def test_suggested_link_to_missing_target_logged(good_artifact, stub_page):
    """Suggested links to nonexistent pages produce a 'low' issue, not a block."""
    # No targets exist -> all suggested_links should be flagged.
    with _patch_page_exists(set()):
        _, issues = synthesize.synthesize(good_artifact, stub_page)
    missing = [i for i in issues if i["rule"] == "missing_link_target"]
    assert len(missing) == 3, f"expected 3 missing-link issues, got {issues}"


def test_run_missing_target_page_returns_4(good_artifact, tmp_path):
    """fetch_page returning None -> exit code 4, no draft written."""
    art_path = tmp_path / "art.json"
    art_path.write_text(json.dumps(good_artifact))
    with patch.object(synthesize, "fetch_page", return_value=None):
        rc = synthesize.run(str(art_path), "people/nonexistent")
    assert rc == 4


def test_run_dry_run_emits_diff(good_artifact, stub_page, tmp_path, capsys):
    """--dry-run produces a draft AND prints a unified diff to stderr."""
    art_path = tmp_path / "art.json"
    art_path.write_text(json.dumps(good_artifact))
    draft_out = tmp_path / "draft.md"
    with patch.object(synthesize, "fetch_page", return_value=stub_page), \
         _patch_page_exists(set()):
        rc = synthesize.run(
            str(art_path), "people/tom-blomfield",
            dry_run=True, draft_out=str(draft_out),
        )
    assert rc == 0
    assert draft_out.exists()
    captured = capsys.readouterr()
    assert "DIFF" in captured.err
    # Unified diff hunk header marker.
    assert "@@" in captured.err
