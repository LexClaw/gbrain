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

def test_dispatch_cal_command_contains_skills_flag():
    """dispatch_cal must pass --skills with all seven REQUIRED_SKILLS to hermes -z."""
    captured = {}

    class FakeResult:
        returncode = 0
        stdout = '{"ok": true}'
        stderr = ""

    def fake_run(cmd, *args, **kwargs):
        captured["cmd"] = cmd
        return FakeResult()

    real_prompt = run_research.compile_cal_prompt(
        slug="people/alice", query_plan=[], page_content="x", schema_text="y",
    )
    with patch("run_research.subprocess.run", side_effect=fake_run):
        rc, out, err = run_research.dispatch_cal(real_prompt)

    assert rc == 0
    cmd = captured["cmd"]
    assert "--skills" in cmd, f"--skills flag missing from dispatch cmd: {cmd}"
    skills_idx = cmd.index("--skills")
    skills_arg = cmd[skills_idx + 1]
    skills_list = skills_arg.split(",")
    for skill in run_research.REQUIRED_SKILLS:
        assert skill in skills_list, (
            f"Required skill '{skill}' missing from --skills arg '{skills_arg}'"
        )
    # Defensive: prompt mentions skill list too (belt + suspenders)
    prompt_idx = cmd.index("-z") + 1
    prompt_text = cmd[prompt_idx]
    for skill in run_research.REQUIRED_SKILLS:
        assert skill in prompt_text, (
            f"Required skill '{skill}' missing from prompt body (belt + suspenders)"
        )


def test_dry_run_preview_mentions_skills(tmp_path, capsys):
    """--dry-run output must include the --skills flag for faithful preview."""
    candidate_path = _make_candidate_json(tmp_path)
    with patch("run_research.get_page_content", return_value=FAKE_PAGE):
        rc = run_research.run(str(candidate_path), str(tmp_path / "artifact.json"), dry_run=True)
    assert rc == 0
    captured = capsys.readouterr()
    assert "--skills" in captured.out, "dry-run preview must mention --skills"
    for skill in run_research.REQUIRED_SKILLS:
        assert skill in captured.out, f"dry-run preview missing skill '{skill}'"


def test_prompt_contains_query_plan_slug_skills(tmp_path):
    """compile_cal_prompt embeds the slug, plan, and the seven REQUIRED_SKILLS."""
    prompt = run_research.compile_cal_prompt(
        slug="people/alice-smith",
        query_plan=[{"query": "alice smith", "source": "web", "rationale": "test"}],
        page_content=FAKE_PAGE,
        schema_text="dummy schema",
    )
    assert "people/alice-smith" in prompt
    assert "alice smith" in prompt
    for skill in run_research.REQUIRED_SKILLS:
        assert skill in prompt, f"Required skill '{skill}' missing from prompt"


def test_prompt_requires_grounded_suggested_links():
    """compile_cal_prompt tells Cal to verify suggested_links against gbrain."""
    prompt = run_research.compile_cal_prompt(
        slug="concepts/claude",
        query_plan=[],
        page_content=FAKE_PAGE,
        schema_text="dummy schema",
    )

    assert "SUGGESTED_LINKS GROUNDING" in prompt
    assert "gbrain search <topic>" in prompt
    assert "gbrain get <slug>" in prompt
    assert "ai/entities/*" in prompt
    assert "concepts/claude" in prompt


def test_ground_suggested_links_filters_unverified_targets():
    artifact = {
        "suggested_links": [
            {"type": "mentions", "target": "concepts/claude"},
            {"type": "mentions", "target": "ai/entities/claude-code"},
        ]
    }

    with patch("run_research.slug_exists", side_effect=lambda s: s == "concepts/claude"):
        grounded = run_research.ground_suggested_links(artifact)

    assert grounded["suggested_links"] == [
        {"type": "mentions", "target": "concepts/claude"}
    ]
    assert grounded["suggested_links_original_count"] == 2
    assert grounded["suggested_links_valid_count"] == 1
    assert grounded["suggested_links_valid_rate"] == 0.5
    assert grounded["suggested_links_invalid_targets"] == ["ai/entities/claude-code"]


def test_dispatch_returns_valid_artifact(tmp_path):
    """Mock a good Cal response -> exit 0, artifact written."""
    candidate_path = _make_candidate_json(tmp_path)
    good_artifact = json.loads((FIXTURES / "research_artifact_good.json").read_text())
    
    with patch("run_research.get_page_content", return_value=FAKE_PAGE), \
         patch("run_research.dispatch_cal", return_value=(0, json.dumps(good_artifact), "")), \
         patch("run_research.slug_exists", return_value=True):
        rc = run_research.run(str(candidate_path), str(tmp_path / "artifact.json"))
    
    assert rc == 0, f"Expected exit 0, got {rc}"
    artifact_path = tmp_path / "artifact.json"
    assert artifact_path.exists(), "Artifact file should be written"
    written = json.loads(artifact_path.read_text())
    assert written["researcher"] == "cal-subagent"
    assert "researched_at" in written
    assert written["suggested_links_valid_rate"] == 1.0


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
         patch("run_research.dispatch_cal", return_value=(0, json.dumps(good_artifact), "")), \
         patch("run_research.slug_exists", return_value=True):
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


# --- Regression tests for Cal empty-output bug (feat/auto-enrich-cal-fix) ---

def test_dispatch_cal_uses_qualified_model_name():
    """dispatch_cal threads the prompt-builder model payload into hermes."""
    captured = {}
    payload = {
        "provider": "anthropic",
        "model": "claude-haiku-4-5-20251001",
    }

    class FakeResult:
        returncode = 0
        stdout = '{"ok": true}'
        stderr = ""

    def fake_run(cmd, *args, **kwargs):
        captured["cmd"] = cmd
        captured["env"] = kwargs.get("env", {})
        return FakeResult()

    with patch("run_research.subprocess.run", side_effect=fake_run):
        rc, _, _ = run_research.dispatch_cal("prompt", model_payload=payload)

    assert rc == 0
    cmd = captured["cmd"]
    assert cmd[cmd.index("--provider") + 1] == "anthropic"
    model = cmd[cmd.index("--model") + 1]
    assert model == "claude-haiku-4-5-20251001"
    assert captured["env"]["HERMES_INFERENCE_MODEL"] == model
    assert model != "claude-haiku-4-5", (
        "Short alias regression: hermes 0.14.0 silently returns empty stdout "
        "for this name. Use the qualified id."
    )


def test_parse_hermes_model_marker_strips_marker_and_returns_payload():
    """prompt-builder HERMES-MODEL markers feed dispatch model args."""
    compiled = (
        '<!-- HERMES-MODEL: {"provider":"ollama","model":"hf.co/test"} -->\n'
        "Prompt body\n"
    )

    prompt, payload = run_research.parse_hermes_model_marker(compiled)

    assert prompt == "Prompt body\n"
    assert payload == {"provider": "ollama", "model": "hf.co/test"}


def test_model_to_cli_args_omits_model_when_builder_has_no_payload():
    """--model remains conditional when prompt-builder has no model marker."""
    args, env = run_research._model_to_cli_args(None)

    assert args == []
    assert env == {}


def test_model_to_cli_args_honors_override(monkeypatch):
    """CAL_DISPATCH_MODEL_OVERRIDE can still replace a bad builder model."""
    monkeypatch.setenv("CAL_DISPATCH_MODEL_OVERRIDE", "override-model")

    args, env = run_research._model_to_cli_args({"provider": "anthropic", "model": "bad"})

    assert args == ["--provider", "anthropic", "--model", "override-model"]
    assert env["HERMES_INFERENCE_MODEL"] == "override-model"


def test_dispatch_cal_empty_stdout_treated_as_error(tmp_path):
    """subprocess returncode=0 + empty stdout -> synthetic non-zero rc + heartbeat anomaly."""
    class FakeResult:
        returncode = 0
        stdout = ""
        stderr = "some stderr text"

    hb_path = tmp_path / "hb.jsonl"
    hb = run_research.Heartbeat(path=hb_path, source_version=run_research.RECIPE_VERSION_RESEARCH)

    with patch("run_research.subprocess.run", return_value=FakeResult()):
        rc, out, err = run_research.dispatch_cal("p", heartbeat=hb, slug="people/test")

    assert rc == run_research.DISPATCH_ANOMALY_EMPTY_STDOUT
    assert rc != 0
    assert out == ""
    assert err == "some stderr text"
    assert hb_path.exists()
    events = [json.loads(l) for l in hb_path.read_text().strip().split("\n") if l]
    anomalies = [e for e in events if e.get("event") == "dispatch_anomaly"]
    assert anomalies, f"No dispatch_anomaly event emitted. events={events}"
    a = anomalies[-1]
    assert a["status"] == "empty_stdout_on_success_exit"
    assert a["details"]["slug"] == "people/test"
    assert a["details"]["stderr"].startswith("some stderr")


def test_dispatch_cal_empty_whitespace_only_stdout_treated_as_error():
    """returncode=0 + whitespace-only stdout is also an anomaly."""
    class FakeResult:
        returncode = 0
        stdout = "   \n  \t\n"
        stderr = ""

    with patch("run_research.subprocess.run", return_value=FakeResult()):
        rc, _, _ = run_research.dispatch_cal("p")
    assert rc == run_research.DISPATCH_ANOMALY_EMPTY_STDOUT


def test_run_handles_cal_empty_output(tmp_path):
    """end-to-end run() with empty-stdout dispatch -> exit non-zero, cal_no_output heartbeat, no artifact."""
    candidate_path = _make_candidate_json(tmp_path)
    hb_path = tmp_path / "hb.jsonl"
    hb = run_research.Heartbeat(path=hb_path, source_version=run_research.RECIPE_VERSION_RESEARCH)

    with patch("run_research.get_page_content", return_value=FAKE_PAGE), \
         patch("run_research.dispatch_cal",
               return_value=(run_research.DISPATCH_ANOMALY_EMPTY_STDOUT, "", "stderr")), \
         patch("run_research.Heartbeat", return_value=hb):
        rc = run_research.run(str(candidate_path), str(tmp_path / "artifact.json"))

    assert rc != 0
    assert not (tmp_path / "artifact.json").exists()
    events = [json.loads(l) for l in hb_path.read_text().strip().split("\n") if l]
    statuses = [e.get("status") for e in events]
    assert "cal_no_output" in statuses, f"cal_no_output missing from statuses: {statuses}"
    assert "parse_error" not in statuses, (
        "Misleading parse_error must NOT be emitted on empty stdout; "
        f"got statuses={statuses}"
    )


def test_parse_cal_json_output_rejects_empty():
    """parse_cal_json_output("") and ("   ") raise EmptyCalOutputError, not a generic ValueError message."""
    with pytest.raises(run_research.EmptyCalOutputError):
        run_research.parse_cal_json_output("")
    with pytest.raises(run_research.EmptyCalOutputError):
        run_research.parse_cal_json_output("   \n\t  ")
    # Sanity: legitimate parse failures are still ValueError (EmptyCalOutputError is a subclass).
    with pytest.raises(ValueError):
        run_research.parse_cal_json_output("not json at all")


# ---------------------------------------------------------------------------
# Verbatim-quote prompt enforcement (BUG 2 fix)
# ---------------------------------------------------------------------------


def test_compile_cal_prompt_contains_verbatim_requirement():
    """The Cal prompt must include strong verbatim language plus BAD and GOOD examples."""
    prompt = run_research.compile_cal_prompt(
        slug="people/petra-donka",
        query_plan=[{"query": "x", "source": "p", "result_count": 0}],
        page_content="page",
        schema_text="schema",
    )
    low = prompt.lower()
    # Verbatim language present in at least one form.
    assert "verbatim" in low
    assert "character-for-character" in low
    # Substring matching is mentioned (the actual gate semantics).
    assert "substring" in low
    # At least one concrete BAD and one concrete GOOD example appear.
    assert "BAD" in prompt
    assert "GOOD" in prompt
    assert "@Prisma" in prompt or "Eoghan" in prompt or "Head of DX" in prompt


def test_compile_cal_prompt_contains_drop_not_fabricate_guidance():
    """Prompt must instruct dropping unsupported claims rather than fabricating quotes."""
    prompt = run_research.compile_cal_prompt(
        slug="companies/intercom",
        query_plan=[],
        page_content="",
        schema_text="",
    )
    low = prompt.lower()
    # Drop-rather-than-fabricate framing.
    assert "drop" in low
    assert "fabricate" in low or "do not fabricate" in low
    # Quality > quantity framing or equivalent.
    assert "quality" in low or "rather than" in low
