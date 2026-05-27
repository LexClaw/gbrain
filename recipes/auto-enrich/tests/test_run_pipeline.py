"""Tests for run_pipeline.py.

All external modules (detect_sparse, run_research, synthesize, quality_check,
gbrain put) are mocked. Verifies the orchestration logic only.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import run_pipeline  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures"

SAMPLE_CANDIDATE = {
    "slug": "people/alice-smith",
    "page_type": "person",
    "score": 0.85,
}

GOOD_ARTIFACT = json.loads((FIXTURES / "research_artifact_good.json").read_text())


def _patch_sensor(candidates):
    return patch.object(run_pipeline.detect_sparse, "detect", return_value=candidates)


def _patch_research_ok(artifact_path: Path):
    def fake(candidate, work_dir):
        return 0, artifact_path
    return patch.object(run_pipeline, "_run_research_for", side_effect=fake)


def _patch_research_fail():
    def fake(candidate, work_dir):
        return 1, None
    return patch.object(run_pipeline, "_run_research_for", side_effect=fake)


def _patch_synth_ok(draft_text: str = "---\ntitle: ok\n---\nbody\n"):
    def fake(art_path, slug, dry_run=False, draft_out=None):
        Path(draft_out).write_text(draft_text)
        return 0
    return patch.object(run_pipeline.synth_mod, "run", side_effect=fake)


def _patch_fetch_page_empty():
    return patch.object(run_pipeline.synth_mod, "fetch_page", return_value="")


def _patch_quality(pre_pass=True, post_pass=True, pre_issues=None, post_issues=None):
    """Patch quality_check.check. Two calls per candidate: pre and post."""
    pre_issues = pre_issues or []
    post_issues = post_issues or []

    def fake(artifact, current_page, draft_path):
        if draft_path is None:
            return (pre_pass, pre_issues)
        return (post_pass, post_issues)

    return patch.object(run_pipeline.quality_check, "check", side_effect=fake)


def _patch_gbrain_put_ok():
    return patch.object(run_pipeline, "_gbrain_put", return_value=(True, ""))


def _patch_gbrain_put_fail():
    return patch.object(run_pipeline, "_gbrain_put", return_value=(False, "put failed"))


@pytest.fixture
def artifact_file(tmp_path):
    p = tmp_path / "artifact.json"
    p.write_text(json.dumps(GOOD_ARTIFACT))
    return p


# --- Tests ---

def test_good_candidate_full_pass_calls_gbrain_put(artifact_file, tmp_path, monkeypatch):
    monkeypatch.setenv("AUTO_ENRICH_WORK", str(tmp_path))
    with _patch_sensor([SAMPLE_CANDIDATE]), \
         _patch_research_ok(artifact_file), \
         _patch_fetch_page_empty(), \
         _patch_quality(pre_pass=True, post_pass=True), \
         _patch_synth_ok(), \
         _patch_gbrain_put_ok() as put_mock:
        rc = run_pipeline.run(limit=1, dry_run=False)
    assert rc == 0
    assert put_mock.called, "gbrain put must be called on full pass"


def test_run_log_includes_suggested_links_valid_rate(artifact_file, tmp_path, monkeypatch):
    monkeypatch.setenv("AUTO_ENRICH_WORK", str(tmp_path))
    monkeypatch.setenv("AUTO_ENRICH_LOG_PATH", str(tmp_path / "runs.jsonl"))

    with _patch_sensor([SAMPLE_CANDIDATE]), \
         _patch_research_ok(artifact_file), \
         _patch_fetch_page_empty(), \
         _patch_quality(pre_pass=True, post_pass=True), \
         _patch_synth_ok(), \
         _patch_gbrain_put_ok():
        rc = run_pipeline.run(limit=1, dry_run=False)

    assert rc == 0
    run_rec = json.loads((tmp_path / "runs.jsonl").read_text().strip())
    assert run_rec["cal"]["suggested_links_valid_rate"] == 1.0
    assert run_rec["cal"]["suggested_links_valid_count"] == 1
    assert run_rec["cal"]["suggested_links_original_count"] == 1
    assert run_rec["cal"]["suggested_links_resolved_count"] == 0


def test_cal_model_populated_when_stages_cal_nonzero(artifact_file, tmp_path, monkeypatch):
    """When Cal runs, the run row records the artifact's resolved model."""
    artifact = {**GOOD_ARTIFACT, "model": "moonshotai/kimi-k2-thinking"}
    artifact_file.write_text(json.dumps(artifact))
    monkeypatch.setenv("AUTO_ENRICH_WORK", str(tmp_path))
    monkeypatch.setenv("AUTO_ENRICH_LOG_PATH", str(tmp_path / "runs.jsonl"))

    with _patch_sensor([SAMPLE_CANDIDATE]), \
         _patch_research_ok(artifact_file), \
         _patch_fetch_page_empty(), \
         _patch_quality(pre_pass=True, post_pass=True), \
         _patch_synth_ok(), \
         _patch_gbrain_put_ok():
        rc = run_pipeline.run(limit=1, dry_run=False)

    assert rc == 0
    run_rec = json.loads((tmp_path / "runs.jsonl").read_text().strip())
    assert "cal" in run_rec["stages_ms"]
    assert run_rec["cal"]["model"] == "moonshotai/kimi-k2-thinking"


def test_cal_model_falls_back_to_dispatch_override(artifact_file, tmp_path, monkeypatch):
    """CAL_DISPATCH_MODEL_OVERRIDE is the fallback when an old artifact has no model."""
    artifact = {k: v for k, v in GOOD_ARTIFACT.items() if k not in {"model", "cal_model"}}
    artifact_file.write_text(json.dumps(artifact))
    monkeypatch.setenv("AUTO_ENRICH_WORK", str(tmp_path))
    monkeypatch.setenv("AUTO_ENRICH_LOG_PATH", str(tmp_path / "runs.jsonl"))
    monkeypatch.setenv("CAL_DISPATCH_MODEL_OVERRIDE", "moonshotai/kimi-k2-thinking")

    with _patch_sensor([SAMPLE_CANDIDATE]), \
         _patch_research_ok(artifact_file), \
         _patch_fetch_page_empty(), \
         _patch_quality(pre_pass=True, post_pass=True), \
         _patch_synth_ok(), \
         _patch_gbrain_put_ok():
        rc = run_pipeline.run(limit=1, dry_run=False)

    assert rc == 0
    run_rec = json.loads((tmp_path / "runs.jsonl").read_text().strip())
    assert run_rec["cal"]["model"] == "moonshotai/kimi-k2-thinking"


def test_bad_iron_law_escalates(artifact_file, tmp_path, monkeypatch):
    monkeypatch.setenv("AUTO_ENRICH_WORK", str(tmp_path))
    monkeypatch.setenv("AUTO_ENRICH_LOG_PATH", str(tmp_path / "runs.jsonl"))
    monkeypatch.setattr(run_pipeline, "ESCALATIONS_PATH", tmp_path / "esc.jsonl")
    pre_issues = [{"rule": "iron_law", "severity": "critical",
                   "detail": "claims[1]: citation.url empty"}]
    with _patch_sensor([SAMPLE_CANDIDATE]), \
         _patch_research_ok(artifact_file), \
         _patch_fetch_page_empty(), \
         _patch_quality(pre_pass=False, pre_issues=pre_issues), \
         _patch_synth_ok(), \
         _patch_gbrain_put_ok() as put_mock:
        rc = run_pipeline.run(limit=1, dry_run=False)
    assert rc == 1
    assert not put_mock.called
    # Escalation written
    esc = (tmp_path / "esc.jsonl").read_text().strip().splitlines()
    assert len(esc) == 1
    rec = json.loads(esc[0])
    assert rec["stage"] == "quality_pre"
    run_rec = json.loads((tmp_path / "runs.jsonl").read_text().strip())
    assert run_rec["outcome"] == "refused"
    assert run_rec["refusal_reason"] == "quality_pre_blocking_issue"


def test_pre_gate_non_iron_blocker_logs_refusal_reason(artifact_file, tmp_path, monkeypatch):
    monkeypatch.setenv("AUTO_ENRICH_WORK", str(tmp_path))
    monkeypatch.setenv("AUTO_ENRICH_LOG_PATH", str(tmp_path / "runs.jsonl"))
    monkeypatch.setattr(run_pipeline, "ESCALATIONS_PATH", tmp_path / "esc.jsonl")
    pre_issues = [{"rule": "fabricated_command", "severity": "high",
                   "detail": "artifact references `gbrain nope`"}]
    with _patch_sensor([SAMPLE_CANDIDATE]), \
         _patch_research_ok(artifact_file), \
         _patch_fetch_page_empty(), \
         _patch_quality(pre_pass=False, pre_issues=pre_issues), \
         _patch_synth_ok(), \
         _patch_gbrain_put_ok() as put_mock:
        rc = run_pipeline.run(limit=1, dry_run=False)
    assert rc == 1
    assert not put_mock.called
    run_rec = json.loads((tmp_path / "runs.jsonl").read_text().strip())
    assert run_rec["outcome"] == "refused"
    assert run_rec["refusal_reason"] == "quality_pre_non_iron_blocker"


def test_bad_lint_post_synthesize_escalates(artifact_file, tmp_path, monkeypatch):
    monkeypatch.setenv("AUTO_ENRICH_WORK", str(tmp_path))
    monkeypatch.setenv("AUTO_ENRICH_LOG_PATH", str(tmp_path / "runs.jsonl"))
    monkeypatch.setattr(run_pipeline, "ESCALATIONS_PATH", tmp_path / "esc.jsonl")
    post_issues = [{"rule": "lint", "severity": "high",
                    "detail": "gbrain lint exit 1"}]
    with _patch_sensor([SAMPLE_CANDIDATE]), \
         _patch_research_ok(artifact_file), \
         _patch_fetch_page_empty(), \
         _patch_quality(pre_pass=True, post_pass=False, post_issues=post_issues), \
         _patch_synth_ok(), \
         _patch_gbrain_put_ok() as put_mock:
        rc = run_pipeline.run(limit=1, dry_run=False)
    assert rc == 1
    assert not put_mock.called
    esc = (tmp_path / "esc.jsonl").read_text().strip().splitlines()
    assert any(json.loads(l)["stage"] == "quality_post" for l in esc)
    run_rec = json.loads((tmp_path / "runs.jsonl").read_text().strip())
    assert run_rec["outcome"] == "refused"
    assert run_rec["refusal_reason"] == "quality_post_blocking_issue"


def test_dry_run_skips_put_but_produces_draft(artifact_file, tmp_path, monkeypatch):
    monkeypatch.setenv("AUTO_ENRICH_WORK", str(tmp_path))
    with _patch_sensor([SAMPLE_CANDIDATE]), \
         _patch_research_ok(artifact_file), \
         _patch_fetch_page_empty(), \
         _patch_quality(pre_pass=True, post_pass=True), \
         _patch_synth_ok() as synth_mock, \
         _patch_gbrain_put_ok() as put_mock:
        rc = run_pipeline.run(limit=1, dry_run=True)
    assert rc == 0
    assert synth_mock.called
    assert not put_mock.called, "dry-run must not call gbrain put"


def test_zero_candidates_returns_2(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTO_ENRICH_WORK", str(tmp_path))
    with _patch_sensor([]):
        rc = run_pipeline.run(limit=1)
    assert rc == 2


def test_research_failure_escalates_and_continues(tmp_path, monkeypatch, artifact_file):
    """Two candidates: first research fails, second succeeds. Pipeline returns 0."""
    monkeypatch.setenv("AUTO_ENRICH_WORK", str(tmp_path))
    monkeypatch.setattr(run_pipeline, "ESCALATIONS_PATH", tmp_path / "esc.jsonl")

    call_count = {"n": 0}

    def fake_research(candidate, work_dir):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return 1, None
        return 0, artifact_file

    with _patch_sensor([SAMPLE_CANDIDATE, {**SAMPLE_CANDIDATE, "slug": "people/bob"}]), \
         patch.object(run_pipeline, "_run_research_for", side_effect=fake_research), \
         _patch_fetch_page_empty(), \
         _patch_quality(pre_pass=True, post_pass=True), \
         _patch_synth_ok(), \
         _patch_gbrain_put_ok():
        rc = run_pipeline.run(limit=2, dry_run=False)
    assert rc == 0
    esc = (tmp_path / "esc.jsonl").read_text().strip().splitlines()
    assert any(json.loads(l)["stage"] == "research" for l in esc)
