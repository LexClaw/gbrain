"""Integration tests for partial-credit recovery wiring in run_pipeline.

The helpers (failing_iron_law_indices, filter_artifact_drop_claims) are
covered by test_partial_credit.py. This file covers the *wiring* in
process_candidate(): how the pipeline actually consumes those helpers,
persists the filtered artifact, re-runs the gate, and dispatches synthesize.

Three branches under test (per Grant code review R2, 2026-05-22):

  1. Happy partial-credit path — gate fails pre with only per-claim iron
     law issues, drop succeeds, re-check passes, synthesize and put fire
     against the FILTERED artifact (not the original).
  2. Re-check still fails after filter — partial_credit_attempted=True
     in escalation, no synthesize, no put.
  3. All claims fail — recovery is skipped (len(drop) >= original count),
     standard failure path runs, no synthesize, no put.

All external modules (detect_sparse, run_research, synthesize, quality_check,
gbrain put) are mocked. We assert on the file system (filtered artifact
written) and on the mocks (which artifact path synthesize received).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import run_pipeline  # noqa: E402


FIXTURES = ROOT / "tests" / "fixtures"

SAMPLE_CANDIDATE = {
    "slug": "people/test-user",
    "page_type": "person",
    "score": 0.85,
}

# Use a 4-claim artifact so partial-credit has room to drop some without
# tripping the all-claims-fail short-circuit.
FOUR_CLAIM_ARTIFACT = {
    "target_slug": "people/test-user",
    "researched_at": "2026-05-22T20:00:00Z",
    "researcher": "cal-subagent",
    "queries_run": [{"query": "test", "source": "web", "result_count": 1}],
    "claims": [
        {
            "text": f"Claim {i}",
            "citation": {
                "url": f"https://example.com/{i}",
                "fetched_at": "2026-05-22T20:00:00Z",
                "quote": f"quote {i}",
            },
            "section_hint": "## Section",
        }
        for i in range(4)
    ],
    "structured_facts": [],
    "suggested_links": [],
    "narrative_additions": [],
}


def _patch_sensor(candidates):
    return patch.object(run_pipeline.detect_sparse, "detect", return_value=candidates)


def _patch_research_ok(artifact_path: Path):
    def fake(candidate, work_dir):
        return 0, artifact_path
    return patch.object(run_pipeline, "_run_research_for", side_effect=fake)


def _patch_fetch_page_empty():
    return patch.object(run_pipeline, "_current_page_safe", return_value="")


def _patch_synth_ok(seen_paths: list):
    """Record which artifact path synthesize received."""
    def fake(art_path, slug, dry_run=False, draft_out=None):
        seen_paths.append(art_path)
        Path(draft_out).write_text("---\ntitle: ok\n---\nbody\n")
        return 0
    return patch.object(run_pipeline.synth_mod, "run", side_effect=fake)


def _patch_gbrain_put_ok():
    return patch.object(run_pipeline, "_gbrain_put", return_value=(True, ""))


def _make_per_claim_iron_law_issues(indices, severity="critical"):
    """Build a list of structured Iron Law issues for the given claim indices."""
    return [
        {
            "rule": "iron_law",
            "severity": severity,
            "detail": f"claims[{i}]: quote not found on page https://example.com/{i}",
            "claim_index": i,
        }
        for i in indices
    ]


def _patch_quality_partial_credit_recovery(
    failing_indices: list[int],
    re_check_passes: bool = True,
    pre_extra_issues: list[dict] | None = None,
    post_pass: bool = True,
):
    """Stub quality_check.check to simulate the partial-credit recovery flow.

    Call sequence per candidate when partial-credit fires:
      call 1: pre-check on original artifact   -> returns (False, iron_law issues)
      call 2: re-check on FILTERED artifact    -> returns (re_check_passes, [])
      call 3: post-check on synthesized draft  -> returns (post_pass, [])

    When all claims fail (recovery skipped) only the first call fires.
    """
    extra = pre_extra_issues or []

    def fake(artifact, current_page, draft_path):
        if draft_path is not None:
            # Post-synthesize lint pass
            return (post_pass, [])
        # Pre-synthesize. If the artifact still has the failing claims,
        # this is the FIRST call (original artifact). If it doesn't, it's
        # the re-check (filtered artifact).
        kept_indices = {
            int(c["citation"]["url"].rsplit("/", 1)[-1])
            for c in (artifact.get("claims") or [])
        }
        if any(i in kept_indices for i in failing_indices):
            return (False, _make_per_claim_iron_law_issues(failing_indices) + extra)
        # Re-check on filtered artifact
        if re_check_passes:
            return (True, [])
        return (False, _make_per_claim_iron_law_issues([0]))

    return patch.object(run_pipeline.quality_check, "check", side_effect=fake)


@pytest.fixture
def artifact_file(tmp_path):
    p = tmp_path / "artifact.json"
    p.write_text(json.dumps(FOUR_CLAIM_ARTIFACT))
    return p


# --- Tests ---

def test_partial_credit_happy_path_synthesizes_filtered_artifact(
    artifact_file, tmp_path, monkeypatch,
):
    """The big one: gate rejects 2 of 4 claims, partial-credit drops them,
    re-check passes, synthesize runs against the FILTERED artifact, put fires."""
    monkeypatch.setenv("AUTO_ENRICH_WORK", str(tmp_path))
    seen_paths: list = []
    with _patch_sensor([SAMPLE_CANDIDATE]), \
         _patch_research_ok(artifact_file), \
         _patch_fetch_page_empty(), \
         _patch_quality_partial_credit_recovery(failing_indices=[1, 3]), \
         _patch_synth_ok(seen_paths), \
         _patch_gbrain_put_ok() as put_mock:
        rc = run_pipeline.run(limit=1, dry_run=False)

    assert rc == 0, "run should succeed end-to-end on partial-credit happy path"
    assert put_mock.called, "gbrain put must fire after partial-credit recovery"

    # Synthesize should have received the FILTERED artifact path, not the
    # original. The filtered file is written next to the work_dir with a
    # -filtered suffix.
    assert len(seen_paths) == 1
    seen_path = Path(seen_paths[0])
    assert "filtered" in seen_path.name, (
        f"synth received non-filtered path: {seen_path.name}"
    )
    # And that file should contain only claims 0 and 2 (dropping 1 and 3).
    filtered = json.loads(seen_path.read_text())
    kept_urls = sorted(c["citation"]["url"] for c in filtered["claims"])
    assert kept_urls == ["https://example.com/0", "https://example.com/2"]
    assert filtered["dropped_claim_count"] == 2


def test_partial_credit_re_check_still_fails_does_not_synthesize(
    artifact_file, tmp_path, monkeypatch,
):
    """Edge case: gate fails pre, partial-credit attempts recovery, but
    the re-check ALSO fails (e.g. another claim turned out to have a
    quote-mismatch we hadn't caught yet). Pipeline must abort with
    partial_credit_attempted=True in the escalation log, NOT synthesize."""
    monkeypatch.setenv("AUTO_ENRICH_WORK", str(tmp_path))
    monkeypatch.setenv("AUTO_ENRICH_LOG_PATH", str(tmp_path / "runs.jsonl"))
    seen_paths: list = []
    with _patch_sensor([SAMPLE_CANDIDATE]), \
         _patch_research_ok(artifact_file), \
         _patch_fetch_page_empty(), \
         _patch_quality_partial_credit_recovery(
             failing_indices=[1], re_check_passes=False,
         ), \
         _patch_synth_ok(seen_paths), \
         _patch_gbrain_put_ok() as put_mock:
        rc = run_pipeline.run(limit=1, dry_run=False)

    # run() returns 0 unless 100% of candidates fail; with only one candidate
    # and it failing, rc should be non-zero. The contract we care about: NO
    # synth, NO put.
    assert seen_paths == [], "synth must not run when re-check fails"
    assert not put_mock.called, "put must not run when re-check fails"
    assert rc != 0, "rc should signal candidate failure"
    run_rec = json.loads((tmp_path / "runs.jsonl").read_text().strip())
    assert run_rec["outcome"] == "refused"
    assert run_rec["refusal_reason"] == "quality_pre_partial_credit_recheck_failed"


def test_partial_credit_skipped_when_all_claims_fail(
    artifact_file, tmp_path, monkeypatch,
):
    """When every claim has a blocking iron_law issue, partial-credit is
    skipped (would leave an empty claims list = nothing to synthesize).
    Standard failure path runs, no synth, no put."""
    monkeypatch.setenv("AUTO_ENRICH_WORK", str(tmp_path))
    monkeypatch.setenv("AUTO_ENRICH_LOG_PATH", str(tmp_path / "runs.jsonl"))
    seen_paths: list = []
    with _patch_sensor([SAMPLE_CANDIDATE]), \
         _patch_research_ok(artifact_file), \
         _patch_fetch_page_empty(), \
         _patch_quality_partial_credit_recovery(
             failing_indices=[0, 1, 2, 3], re_check_passes=True,
         ), \
         _patch_synth_ok(seen_paths), \
         _patch_gbrain_put_ok() as put_mock:
        rc = run_pipeline.run(limit=1, dry_run=False)

    assert seen_paths == [], "synth must not run when all claims fail"
    assert not put_mock.called, "put must not run when all claims fail"
    assert rc != 0, "rc should signal candidate failure"
    run_rec = json.loads((tmp_path / "runs.jsonl").read_text().strip())
    assert run_rec["outcome"] == "refused"
    assert run_rec["refusal_reason"] == "quality_pre_all_claims_dropped"


def test_partial_credit_skipped_when_non_iron_blocker_present(
    artifact_file, tmp_path, monkeypatch,
):
    """If the pre-check has any blocking non-iron issue (e.g. fabricated
    command, non-destructive overwrite), partial-credit must NOT run —
    those classes of failure are not per-claim and dropping iron-law claims
    won't fix them. Standard failure path runs."""
    monkeypatch.setenv("AUTO_ENRICH_WORK", str(tmp_path))
    seen_paths: list = []
    fabricated = [{
        "rule": "no_fabrication",
        "severity": "high",
        "detail": "fabricated gbrain verb 'nuke'",
    }]
    with _patch_sensor([SAMPLE_CANDIDATE]), \
         _patch_research_ok(artifact_file), \
         _patch_fetch_page_empty(), \
         _patch_quality_partial_credit_recovery(
             failing_indices=[1], pre_extra_issues=fabricated,
         ), \
         _patch_synth_ok(seen_paths), \
         _patch_gbrain_put_ok() as put_mock:
        rc = run_pipeline.run(limit=1, dry_run=False)

    assert seen_paths == [], "synth must not run when non-iron blocker present"
    assert not put_mock.called, "put must not run when non-iron blocker present"
    assert rc != 0
