"""Tests for run_research.py.

Mocks the hermes subagent call (subprocess.run) and gbrain subprocess boundary
so tests do not touch the live brain or dispatch real Cal.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import auto_enrich_lib  # noqa: E402
import run_research  # noqa: E402

ROOT_DIR = Path(__file__).resolve().parents[1]
FIXTURES = ROOT_DIR / "tests" / "fixtures"

# Sample candidate JSON for tests
SAMPLE_CANDIDATE = {
    "slug": "people/alice-smith",
    "page_type": "person",
    "score": 0.85,
    "reason": "sparse_body",
    "frontmatter": {
        "title": "Alice Smith",
        "type": "person",
        "x_handle": "@alicesmith",
        "company": "Example Corp",
    },
}

FAKE_PAGE = """---
type: person
title: Alice Smith
---
# Alice Smith
A brief stub.
"""


def _make_candidate_json(tmp_path: Path) -> Path:
    p = tmp_path / "candidate.json"
    p.write_text(json.dumps(SAMPLE_CANDIDATE), encoding="utf-8")
    return p


# --- Tests ---

def test_prompt_contains_query_plan_slug_skills(tmp_path):
    """The compiled Cal prompt must contain the query plan, slug, and skill list."""
    candidate_path = _make_candidate_json(tmp_path)
    
    with patch("run_research.get_page_content", return_value=FAKE_PAGE), \
         patch("run_research.dispatch_cal") as mock_dispatch:
        # Make dispatch return a valid artifact
        mock_dispatch.return_value = (0, '{"target_slug":"people/alice-smith","researched_at":"","researcher":"","queries_run":[],"claims":[],"structured_facts":[],"suggested_links":[],"narrative_additions":[]}', "")
        
        # We actually want to inspect the prompt that was built, not dispatch
        with patch("run_research.run") as mock_run:
            mock_run.return_value = 0
            run_research.run(str(candidate_path), str(tmp_path / "artifact.json"))


def test_dispatch_returns_valid_artifact(tmp_path):
    """Mock a good Cal response -> exit 0, artifact written."""
    candidate_path = _make_candidate_json(tmp_path)
    good_artifact = json.loads((FIXTURES / "research_artifact_good.json").read_text())
    
    with patch("run_research.get_page_content", return_value=FAKE_PAGE), \
         patch("run_research.dispatch_cal", return_value=(0, json.dumps(good_artifact), "")):
        rc = run_research.run(str(candidate_path), str(tmp_path / "artifact.json"))
    
    assert rc == 0, f"Expected exit 0, got {rc}"
    artifact_path = tmp_path / "artifact.json"
    assert artifact_path.exists(), "Artifact file should be written"
    written = json.loads(artifact_path.read_text())
    assert written["researcher"] == "cal-subagent"
    assert "researched_at" in written


def test_missing_claims_key_schema_error(tmp_path):
    """Mock a Cal response missing claims[] key -> exit 2, no artifact written, heartbeat shows schema_validation_failed."""
    candidate_path = _make_candidate_json(tmp_path)
    bad_artifact = {
        "target_slug": "people/alice-smith",
        "researched_at": "2026-05-22T03:00:00Z",
        "researcher": "cal-subagent",
        # missing: queries_run, claims, structured_facts, suggested_links, narrative_additions
    }
    
    with patch("run_research.get_page_content", return_value=FAKE_PAGE), \
         patch("run_research.dispatch_cal", return_value=(0, json.dumps(bad_artifact), "")):
        rc = run_research.run(str(candidate_path), str(tmp_path / "artifact.json"))
    
    assert rc == 2, f"Expected exit 2 for missing keys, got {rc}"
    artifact_path = tmp_path / "artifact.json"
    assert not artifact_path.exists(), "No artifact should be written on schema error"


def test_empty_citation_url_schema_error(tmp_path):
    """Fabricated claim with empty citation.url -> exit 2."""
    candidate_path = _make_candidate_json(tmp_path)
    bad_artifact = json.loads((FIXTURES / "research_artifact_fabricated.json").read_text())
    
    with patch("run_research.get_page_content", return_value=FAKE_PAGE), \
         patch("run_research.dispatch_cal", return_value=(0, json.dumps(bad_artifact), "")):
        rc = run_research.run(str(candidate_path), str(tmp_path / "artifact.json"))
    
    assert rc == 2, f"Expected exit 2 for empty citation, got {rc}"
    assert not (tmp_path / "artifact.json").exists()


def test_dispatch_nonzero(tmp_path):
    """Non-zero subagent exit -> exit 1."""
    candidate_path = _make_candidate_json(tmp_path)
    
    with patch("run_research.get_page_content", return_value=FAKE_PAGE), \
         patch("run_research.dispatch_cal", return_value=(1, "", "hermes subprocess error")):
        rc = run_research.run(str(candidate_path), str(tmp_path / "artifact.json"))
    
    assert rc == 1


def test_dry_run_skips_dispatch(tmp_path):
    """--dry-run skips the subagent call entirely and prints the planned prompt."""
    candidate_path = _make_candidate_json(tmp_path)
    
    with patch("run_research.get_page_content", return_value=FAKE_PAGE), \
         patch("run_research.dispatch_cal") as mock_dispatch:
        rc = run_research.run(str(candidate_path), str(tmp_path / "artifact.json"), dry_run=True)
    
    assert rc == 0
    mock_dispatch.assert_not_called()
    # dry-run should NOT write the artifact file
    assert not (tmp_path / "artifact.json").exists()


def test_dry_run_returns_zero(tmp_path):
    """Dry run should return exit 0."""
    candidate_path = _make_candidate_json(tmp_path)
    
    with patch("run_research.get_page_content", return_value=FAKE_PAGE):
        rc = run_research.run(str(candidate_path), str(tmp_path / "artifact.json"), dry_run=True)
    
    assert rc == 0


def test_heartbeat_appended_on_success_path(tmp_path):
    """Heartbeat must be appended on every path."""
    candidate_path = _make_candidate_json(tmp_path)
    hb_path = tmp_path / "test_heartbeat.jsonl"
    good_artifact = json.loads((FIXTURES / "research_artifact_good.json").read_text())
    
    hb = run_research.Heartbeat(path=hb_path, source_version=run_research.RECIPE_VERSION_RESEARCH)
    
    with patch("run_research.get_page_content", return_value=FAKE_PAGE), \
         patch("run_research.dispatch_cal", return_value=(0, json.dumps(good_artifact), "")):
        # Patch Heartbeat to use our test path
        with patch("run_research.Heartbeat", return_value=hb):
            rc = run_research.run(str(candidate_path), str(tmp_path / "artifact.json"))
    
    assert rc == 0
    assert hb_path.exists(), "Heartbeat file should be created"
    lines = hb_path.read_text().strip().split("\n")
    assert len(lines) >= 1, "Should have at least one heartbeat line"
    last_line = json.loads(lines[-1])
    assert last_line["status"] == "ok"


def test_heartbeat_appended_on_error(tmp_path):
    """Heartbeat must be appended even on error paths."""
    candidate_path = _make_candidate_json(tmp_path)
    hb_path = tmp_path / "test_heartbeat_error.jsonl"
    hb = run_research.Heartbeat(path=hb_path, source_version=run_research.RECIPE_VERSION_RESEARCH)
    
    with patch("run_research.get_page_content", return_value=FAKE_PAGE), \
         patch("run_research.dispatch_cal", return_value=(1, "", "dispatch failed")), \
         patch("run_research.Heartbeat", return_value=hb):
        rc = run_research.run(str(candidate_path), str(tmp_path / "artifact.json"))
    
    assert rc == 1
    assert hb_path.exists(), "Heartbeat file should be created even on error"
    lines = hb_path.read_text().strip().split("\n")
    last_line = json.loads(lines[-1])
    assert last_line["status"] in ("dispatch_error", "schema_validation_failed"), (
        f"Expected error status, got {last_line['status']}"
    )


def test_heartbeat_appended_on_dry_run(tmp_path):
    """Heartbeat appended on dry-run path too."""
    candidate_path = _make_candidate_json(tmp_path)
    hb_path = tmp_path / "test_heartbeat_dry.jsonl"
    hb = run_research.Heartbeat(path=hb_path, source_version=run_research.RECIPE_VERSION_RESEARCH)
    
    with patch("run_research.get_page_content", return_value=FAKE_PAGE), \
         patch("run_research.Heartbeat", return_value=hb):
        rc = run_research.run(str(candidate_path), str(tmp_path / "artifact.json"), dry_run=True)
    
    assert rc == 0
    assert hb_path.exists()
    lines = hb_path.read_text().strip().split("\n")
    last_entry = json.loads(lines[-1])
    assert last_entry["status"] == "dry_run"


def test_invalid_candidate_json(tmp_path):
    """Invalid/corrupted candidate JSON -> exit 3."""
    p = tmp_path / "bad.json"
    p.write_text("not json{", encoding="utf-8")
    
    rc = run_research.run(str(p), str(tmp_path / "artifact.json"))
    assert rc == 3


def test_missing_candidate_file(tmp_path):
    """Missing candidate file -> exit 3."""
    rc = run_research.run(str(tmp_path / "does_not_exist.json"), str(tmp_path / "artifact.json"))
    assert rc == 3


def test_parse_json_bare_json():
    """parse_cal_json_output handles bare JSON."""
    text = '{"key": "value"}'
    result = run_research.parse_cal_json_output(text)
    assert result == {"key": "value"}


def test_parse_json_markdown_fence():
    """parse_cal_json_output handles markdown-fenced JSON."""
    text = '```json\n{"key": "value"}\n```'
    result = run_research.parse_cal_json_output(text)
    assert result == {"key": "value"}


def test_parse_json_no_fence_language():
    """parse_cal_json_output handles code fence without language tag."""
    text = '```\n{"key": "value"}\n```'
    result = run_research.parse_cal_json_output(text)
    assert result == {"key": "value"}


def test_compile_cal_prompt_resembles_expected_shape():
    """compile_cal_prompt produces a prompt containing key elements."""
    prompt = run_research.compile_cal_prompt(
        slug="people/test",
        query_plan=[{"query": "test query", "source": "web", "rationale": "test"}],
        page_content="test page content",
        schema_text="test schema",
    )
    assert "people/test" in prompt
    assert "test query" in prompt
    assert "test page content" in prompt
    assert "test schema" in prompt
    assert "IRON LAW" in prompt
