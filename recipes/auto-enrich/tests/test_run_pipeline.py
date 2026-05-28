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


# ---------------------------------------------------------------------------
# Phase 2: auto-stub integration (v5)
# ---------------------------------------------------------------------------


def _artifact_with_unresolved(target_slug="people/test-source", page_content="",
                              unresolved=None, claims=None):
    """Build an artifact dict carrying suggested_links_unresolved."""
    art = dict(GOOD_ARTIFACT)
    art["target_slug"] = target_slug
    art["page_content"] = page_content
    art["claims"] = claims if claims is not None else art.get("claims", [])
    art["suggested_links"] = []
    art["suggested_links_original_count"] = len(unresolved or [])
    art["suggested_links_valid_count"] = 0
    art["suggested_links_resolved_count"] = 0
    art["suggested_links_valid_rate"] = 0.0
    art["suggested_links_unresolved"] = unresolved or []
    return art


def test_auto_stub_fires_when_evidence_present_and_quality_passes(tmp_path, monkeypatch):
    """Pipeline passes quality, has unresolved people/X with evidence, stub created."""
    monkeypatch.setenv("AUTO_ENRICH_WORK", str(tmp_path))
    monkeypatch.setenv("AUTO_ENRICH_LOG_PATH", str(tmp_path / "runs.jsonl"))
    monkeypatch.setattr(run_pipeline, "ESCALATIONS_PATH", tmp_path / "esc.jsonl")

    art = _artifact_with_unresolved(
        target_slug="people/source-page",
        page_content="Swadesh Kumar is a key advisor on the team.",
        unresolved=[{
            "original_link": {"type": "mentions", "target": "people/swadesh-kumar"},
            "target": "people/swadesh-kumar",
            "search_top_score": 0.4, "search_top_candidate": None,
            "basename_top_score": 0.55, "basename_top_candidate": None,
        }],
    )
    art_path = tmp_path / "artifact.json"
    art_path.write_text(json.dumps(art))

    put_calls = []

    def fake_put(slug, content):
        put_calls.append((slug, content))

    with _patch_sensor([SAMPLE_CANDIDATE]), \
         _patch_research_ok(art_path), \
         _patch_fetch_page_empty(), \
         _patch_quality(pre_pass=True, post_pass=True), \
         _patch_synth_ok(), \
         _patch_gbrain_put_ok(), \
         patch("run_pipeline.auto_stub._default_gbrain_put", side_effect=fake_put), \
         patch("run_pipeline.auto_stub._default_slug_exists", return_value=False):
        rc = run_pipeline.run(limit=1, dry_run=False)

    assert rc == 0
    # Stub put call happened.
    assert any(s == "people/swadesh-kumar" for s, _ in put_calls), (
        f"expected stub put for people/swadesh-kumar, got {[s for s, _ in put_calls]}"
    )
    # On-disk artifact was rewritten: unresolved entry gone, link in suggested_links.
    on_disk = json.loads(art_path.read_text())
    assert "suggested_links_unresolved" not in on_disk
    assert any(l.get("target") == "people/swadesh-kumar"
               for l in on_disk.get("suggested_links", []))


def test_auto_stub_rejected_when_no_evidence(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTO_ENRICH_WORK", str(tmp_path))
    monkeypatch.setenv("AUTO_ENRICH_LOG_PATH", str(tmp_path / "runs.jsonl"))
    monkeypatch.setattr(run_pipeline, "ESCALATIONS_PATH", tmp_path / "esc.jsonl")

    art = _artifact_with_unresolved(
        target_slug="people/source-page",
        page_content="Completely unrelated content body.",
        unresolved=[{
            "original_link": {"type": "mentions", "target": "people/fake-fabrication"},
            "target": "people/fake-fabrication",
            "search_top_score": 0.3, "search_top_candidate": None,
            "basename_top_score": 0.4, "basename_top_candidate": None,
        }],
    )
    art_path = tmp_path / "artifact.json"
    art_path.write_text(json.dumps(art))

    put_calls = []

    def fake_put(slug, content):
        put_calls.append(slug)

    with _patch_sensor([SAMPLE_CANDIDATE]), \
         _patch_research_ok(art_path), \
         _patch_fetch_page_empty(), \
         _patch_quality(pre_pass=True, post_pass=True), \
         _patch_synth_ok(), \
         _patch_gbrain_put_ok(), \
         patch("run_pipeline.auto_stub._default_gbrain_put", side_effect=fake_put), \
         patch("run_pipeline.auto_stub._default_slug_exists", return_value=False):
        rc = run_pipeline.run(limit=1, dry_run=False)

    assert rc == 0
    assert put_calls == [], f"no stub put should happen, got {put_calls}"
    # Escalation written with rejected event.
    esc_lines = (tmp_path / "esc.jsonl").read_text().strip().splitlines()
    rejects = [json.loads(l) for l in esc_lines
               if json.loads(l).get("kind") == "auto_stub_rejected_no_evidence"]
    assert len(rejects) == 1


def test_auto_stub_never_fires_when_quality_pre_fails(tmp_path, monkeypatch):
    """Critical: if quality_pre fails, Phase 2 must NOT run."""
    monkeypatch.setenv("AUTO_ENRICH_WORK", str(tmp_path))
    monkeypatch.setenv("AUTO_ENRICH_LOG_PATH", str(tmp_path / "runs.jsonl"))
    monkeypatch.setattr(run_pipeline, "ESCALATIONS_PATH", tmp_path / "esc.jsonl")

    art = _artifact_with_unresolved(
        target_slug="people/source-page",
        # Evidence present, but quality fails.
        page_content="Swadesh Kumar is here on the page.",
        unresolved=[{
            "original_link": {"type": "mentions", "target": "people/swadesh-kumar"},
            "target": "people/swadesh-kumar",
        }],
    )
    art_path = tmp_path / "artifact.json"
    art_path.write_text(json.dumps(art))

    put_calls = []

    def fake_put(slug, content):
        put_calls.append(slug)

    pre_issues = [{"rule": "iron_law", "severity": "critical",
                   "detail": "claims[1]: citation.url empty"}]
    with _patch_sensor([SAMPLE_CANDIDATE]), \
         _patch_research_ok(art_path), \
         _patch_fetch_page_empty(), \
         _patch_quality(pre_pass=False, pre_issues=pre_issues), \
         _patch_synth_ok(), \
         _patch_gbrain_put_ok(), \
         patch("run_pipeline.auto_stub._default_gbrain_put", side_effect=fake_put), \
         patch("run_pipeline.auto_stub._default_slug_exists", return_value=False):
        rc = run_pipeline.run(limit=1, dry_run=False)

    assert rc == 1
    assert put_calls == [], (
        "Phase 2 must never fire when pre-synthesize gates fail; "
        f"got stub put calls: {put_calls}"
    )


def test_auto_stub_dry_run_logs_would_create_no_put(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTO_ENRICH_WORK", str(tmp_path))
    monkeypatch.setenv("AUTO_ENRICH_LOG_PATH", str(tmp_path / "runs.jsonl"))
    monkeypatch.setattr(run_pipeline, "ESCALATIONS_PATH", tmp_path / "esc.jsonl")

    art = _artifact_with_unresolved(
        target_slug="people/source-page",
        page_content="Dry Person is here on the page.",
        unresolved=[{
            "original_link": {"type": "mentions", "target": "people/dry-person"},
            "target": "people/dry-person",
        }],
    )
    art_path = tmp_path / "artifact.json"
    art_path.write_text(json.dumps(art))

    put_calls = []

    def fake_put(slug, content):
        put_calls.append(slug)

    with _patch_sensor([SAMPLE_CANDIDATE]), \
         _patch_research_ok(art_path), \
         _patch_fetch_page_empty(), \
         _patch_quality(pre_pass=True, post_pass=True), \
         _patch_synth_ok(), \
         _patch_gbrain_put_ok(), \
         patch("run_pipeline.auto_stub._default_gbrain_put", side_effect=fake_put), \
         patch("run_pipeline.auto_stub._default_slug_exists", return_value=False):
        rc = run_pipeline.run(limit=1, dry_run=True)

    assert rc == 0
    assert put_calls == [], "dry-run must not call gbrain put for stubs"
    esc_lines = (tmp_path / "esc.jsonl").read_text().strip().splitlines() if (tmp_path / "esc.jsonl").exists() else []
    would = [json.loads(l) for l in esc_lines
             if json.loads(l).get("kind") == "auto_stub_would_create"]
    assert len(would) == 1


def test_auto_stub_cap_enforcement_across_candidates(tmp_path, monkeypatch):
    """Cap of MAX_AUTO_STUBS_PER_RUN applies pipeline-wide, not per-candidate."""
    monkeypatch.setenv("AUTO_ENRICH_WORK", str(tmp_path))
    monkeypatch.setenv("AUTO_ENRICH_LOG_PATH", str(tmp_path / "runs.jsonl"))
    monkeypatch.setattr(run_pipeline, "ESCALATIONS_PATH", tmp_path / "esc.jsonl")

    candidates = [
        {"slug": f"people/source-{i}", "page_type": "person", "score": 0.5}
        for i in range(3)
    ]
    art_paths = []
    for i, c in enumerate(candidates):
        art = _artifact_with_unresolved(
            target_slug=c["slug"],
            page_content=f"Alpha Person {i} appears here on this page.",
            unresolved=[{
                "original_link": {"type": "mentions", "target": f"people/alpha-person-{i}"},
                "target": f"people/alpha-person-{i}",
            }],
        )
        p = tmp_path / f"artifact-{i}.json"
        p.write_text(json.dumps(art))
        art_paths.append(p)

    call_count = {"n": 0}

    def fake_research(candidate, work_dir):
        i = call_count["n"]
        call_count["n"] += 1
        return 0, art_paths[i]

    put_calls = []
    def fake_put(slug, content):
        put_calls.append(slug)

    # Pipeline-wide cap of 2 enforced by overriding the default max_stubs
    # on AutoStubContext init.
    original_ctx = run_pipeline.auto_stub.AutoStubContext

    def make_capped(dry_run=False, **kw):
        return original_ctx(dry_run=dry_run, max_stubs=2)

    with _patch_sensor(candidates), \
         patch.object(run_pipeline, "_run_research_for", side_effect=fake_research), \
         _patch_fetch_page_empty(), \
         _patch_quality(pre_pass=True, post_pass=True), \
         _patch_synth_ok(), \
         _patch_gbrain_put_ok(), \
         patch("run_pipeline.auto_stub._default_gbrain_put", side_effect=fake_put), \
         patch("run_pipeline.auto_stub._default_slug_exists", return_value=False), \
         patch.object(run_pipeline.auto_stub, "AutoStubContext",
                      side_effect=make_capped):
        rc = run_pipeline.run(limit=3, dry_run=False)

    assert rc == 0
    assert len(put_calls) == 2, (
        f"cap=2 must clamp stub creates pipeline-wide; got {put_calls}"
    )
