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


def test_resolve_via_prefix_variants_finds_concepts_for_ai_entities():
    calls = []

    def fake_exists(slug):
        calls.append(slug)
        return slug == "concepts/claude-code"

    assert run_research.resolve_via_prefix_variants(
        "ai/entities/claude-code",
        exists=fake_exists,
    ) == "concepts/claude-code"
    assert "ai/entities/claude-code" in calls
    assert "concepts/claude-code" in calls


def test_resolve_via_prefix_variants_finds_companies_for_tools():
    assert run_research.resolve_via_prefix_variants(
        "tools/cursor",
        exists=lambda slug: slug == "companies/cursor",
    ) == "companies/cursor"


def test_resolve_via_prefix_variants_returns_self_if_already_canonical():
    assert run_research.resolve_via_prefix_variants(
        "concepts/codex",
        exists=lambda slug: slug == "concepts/codex",
    ) == "concepts/codex"


def test_resolve_via_prefix_variants_returns_none_when_no_variant_exists():
    assert run_research.resolve_via_prefix_variants(
        "ai/entities/not-real",
        exists=lambda slug: False,
    ) is None


def test_ground_suggested_links_uses_prefix_variant_before_search():
    artifact = {
        "suggested_links": [
            {"type": "mentions", "target": "tools/cursor"},
        ]
    }

    def fake_exists(slug):
        return slug == "companies/cursor"

    with patch("run_research.slug_exists", side_effect=fake_exists), \
         patch("run_research.search_slug_resolution") as search:
        grounded = run_research.ground_suggested_links(artifact)

    search.assert_not_called()
    assert grounded["suggested_links"] == [
        {"type": "mentions", "target": "companies/cursor"}
    ]
    assert grounded["suggested_links_resolved_count"] == 1
    assert grounded["suggested_links_valid_rate"] == 1.0


def test_ground_suggested_links_caches_prefix_variant_slug_checks():
    artifact = {
        "suggested_links": [
            {"type": "mentions", "target": "ai/entities/claude-code"},
            {"type": "mentions", "target": "ai/entities/claude-code"},
        ]
    }
    calls = []

    def fake_exists(slug):
        calls.append(slug)
        return slug == "concepts/claude-code"

    with patch("run_research.slug_exists", side_effect=fake_exists):
        grounded = run_research.ground_suggested_links(artifact)

    assert [link["target"] for link in grounded["suggested_links"]] == [
        "concepts/claude-code",
        "concepts/claude-code",
    ]
    assert calls.count("ai/entities/claude-code") == 1
    assert calls.count("concepts/claude-code") == 1


def test_ground_suggested_links_filters_unverified_targets():
    artifact = {
        "suggested_links": [
            {"type": "mentions", "target": "concepts/claude"},
            {"type": "mentions", "target": "ai/entities/not-real"},
        ]
    }

    with patch("run_research.slug_exists", side_effect=lambda s: s == "concepts/claude"), \
         patch("run_research.resolve_suggested_link_target", return_value=(None, 0.0)):
        grounded = run_research.ground_suggested_links(artifact)

    assert grounded["suggested_links"] == [
        {"type": "mentions", "target": "concepts/claude"}
    ]
    assert grounded["suggested_links_original_count"] == 2
    assert grounded["suggested_links_valid_count"] == 1
    assert grounded["suggested_links_resolved_count"] == 0
    assert grounded["suggested_links_valid_rate"] == 0.5
    assert grounded["suggested_links_invalid_targets"] == ["ai/entities/not-real"]


def test_ground_suggested_links_rewrites_wrong_path_targets():
    artifact = {
        "suggested_links": [
            {"type": "mentions", "target": "ai/tools/codex"},
            {"type": "mentions", "target": "ai/tools/cursor-ide"},
            {"type": "mentions", "target": "ai/entities/claude-code"},
        ]
    }
    # v5: ground_suggested_links now calls resolve_suggested_link_target_detailed.
    details = {
        "ai/tools/codex": {
            "resolved": "concepts/codex", "score": 1.2,
            "search_top_score": 1.2, "search_top_candidate": "concepts/codex",
            "basename_top_score": None, "basename_top_candidate": None,
        },
        "ai/tools/cursor-ide": {
            "resolved": "concepts/cursor", "score": 1.1,
            "search_top_score": 1.1, "search_top_candidate": "concepts/cursor",
            "basename_top_score": None, "basename_top_candidate": None,
        },
        "ai/entities/claude-code": {
            "resolved": "concepts/claude-code", "score": 1.3,
            "search_top_score": 1.3, "search_top_candidate": "concepts/claude-code",
            "basename_top_score": None, "basename_top_candidate": None,
        },
    }

    with patch("run_research.slug_exists", return_value=False), \
         patch("run_research.resolve_suggested_link_target_detailed",
               side_effect=lambda s, exists=None: details[s]):
        grounded = run_research.ground_suggested_links(artifact)

    assert grounded["suggested_links"] == [
        {"type": "mentions", "target": "concepts/codex"},
        {"type": "mentions", "target": "concepts/cursor"},
        {"type": "mentions", "target": "concepts/claude-code"},
    ]
    assert grounded["suggested_links_valid_count"] == 3
    assert grounded["suggested_links_resolved_count"] == 3
    assert grounded["suggested_links_valid_rate"] == 1.0
    assert "suggested_links_invalid_targets" not in grounded
    assert "suggested_links_unresolved" not in grounded


def test_search_slug_resolution_drops_below_medium_threshold():
    """v5: scores below SLUG_RESOLUTION_MEDIUM (0.5) are skipped entirely."""
    with patch("run_research.auto_enrich_lib.run_gbrain",
               return_value="[0.4000] concepts/codex -- # Codex\n"), \
         patch("run_research.slug_exists") as exists:
        resolved, score = run_research.search_slug_resolution("ai/tools/codex")

    assert resolved is None
    assert score == 0.4
    exists.assert_not_called()


def test_search_slug_resolution_medium_tier_requires_token_guards():
    """v5: scores between MEDIUM and HIGH need passes_token_guards to accept."""
    # 0.7 score, candidate slug shares 'codex' token with target 'ai/tools/codex'.
    with patch("run_research.auto_enrich_lib.run_gbrain",
               return_value="[0.7000] concepts/codex -- # Codex\n"), \
         patch("run_research.slug_exists", return_value=True):
        resolved, score = run_research.search_slug_resolution("ai/tools/codex")

    assert resolved == "concepts/codex"
    assert score == 0.7


def test_search_slug_resolution_medium_tier_rejects_no_token_overlap():
    """v5: medium-tier candidate with zero token overlap is rejected."""
    # 0.7 score, candidate has no shared non-stopword token with 'foo-bar'.
    with patch("run_research.auto_enrich_lib.run_gbrain",
               return_value="[0.7000] concepts/widget-zap -- # Widget\n"), \
         patch("run_research.slug_exists", return_value=True):
        resolved, score = run_research.search_slug_resolution("ai/tools/foo-bar")

    assert resolved is None
    # top_score is still surfaced for telemetry.
    assert score == 0.7


def test_search_slug_resolution_accepts_threshold_edge():
    with patch("run_research.auto_enrich_lib.run_gbrain", return_value="[1.0000] concepts/codex -- # Codex\n"), \
         patch("run_research.slug_exists", return_value=True):
        resolved, score = run_research.search_slug_resolution("ai/tools/codex")

    assert resolved == "concepts/codex"
    assert score == 1.0


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
    args, env, resolved = run_research._model_to_cli_args(None)

    assert args == []
    assert env == {}
    assert resolved == {}


def test_model_to_cli_args_honors_override(monkeypatch):
    """CAL_DISPATCH_MODEL_OVERRIDE can still replace a bad builder model."""
    monkeypatch.setenv("CAL_DISPATCH_MODEL_OVERRIDE", "override-model")

    args, env, resolved = run_research._model_to_cli_args({"provider": "anthropic", "model": "bad"})

    assert args == ["--provider", "anthropic", "--model", "override-model"]
    assert env["HERMES_INFERENCE_MODEL"] == "override-model"
    assert resolved["model"] == "override-model"


def test_run_writes_resolved_cal_model_to_artifact(tmp_path, monkeypatch):
    """run() stores the actual dispatched model in the Cal artifact."""
    monkeypatch.setenv("CAL_DISPATCH_MODEL_OVERRIDE", "moonshotai/kimi-k2-thinking")
    candidate_path = _make_candidate_json(tmp_path)
    artifact_path = tmp_path / "artifact.json"

    with patch("run_research.get_page_content", return_value=FAKE_PAGE), \
         patch("run_research.compile_with_prompt_builder", return_value=("prompt", {
             "provider": "openrouter",
             "model": "google/gemma-3-27b-it",
         })), \
         patch("run_research.dispatch_cal", return_value=(0, json.dumps({
             "target_slug": "people/alice-smith",
             "researched_at": "2026-05-27T00:00:00Z",
             "researcher": "cal-subagent",
             "queries_run": [],
             "claims": [],
             "structured_facts": [],
             "suggested_links": [],
             "narrative_additions": [],
         }), "")):
        rc = run_research.run(str(candidate_path), str(artifact_path))

    assert rc == 0
    artifact = json.loads(artifact_path.read_text())
    assert artifact["model"] == "moonshotai/kimi-k2-thinking"
    assert artifact["provider"] == "openrouter"


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


# ---------------------------------------------------------------------------
# Phase 1: resolver hardening (v5)
# ---------------------------------------------------------------------------


def test_type_family_guard_people_blocks_companies():
    """passes_type_family_guard HARD invariant: people/ cannot cross to companies/."""
    assert run_research.passes_type_family_guard("people/foo", "people/foo-bar") is True
    assert run_research.passes_type_family_guard("people/foo", "companies/foo") is False
    assert run_research.passes_type_family_guard("people/foo", "concepts/foo") is False


def test_type_family_guard_companies_blocks_people():
    assert run_research.passes_type_family_guard("companies/foo", "companies/foo-bar") is True
    assert run_research.passes_type_family_guard("companies/foo", "people/foo") is False
    assert run_research.passes_type_family_guard("companies/foo", "concepts/foo") is False


def test_type_family_guard_other_prefixes_unconstrained():
    """concepts/, ai/entities/, tools/, etc. can cross-resolve freely."""
    assert run_research.passes_type_family_guard("tools/cursor", "companies/cursor") is True
    assert run_research.passes_type_family_guard("ai/entities/x", "concepts/x") is True
    assert run_research.passes_type_family_guard("concepts/x", "ai/concepts/x") is True


def test_token_guards_version_preservation_rejects_mismatch():
    """claude-3 must not rewrite to claude-4."""
    assert run_research.passes_token_guards("concepts/claude-3", "concepts/claude-4") is False


def test_token_guards_version_preservation_allows_loss():
    """claude-3 to claude (no version on target) is allowed."""
    assert run_research.passes_token_guards("concepts/claude-3", "concepts/claude") is True


def test_token_guards_version_preservation_allows_same_set():
    """claude-opus-model -> claude-opus-4-7 fails token guard (versions differ)."""
    # Original has no versions; candidate has 4-7. That's allowed under the rule:
    # if original has NO versions, the guard does not require any specific set.
    assert run_research.passes_token_guards(
        "ai/concepts/claude-opus-model", "concepts/claude-opus-4-7"
    ) is True


def test_token_guards_requires_token_overlap():
    """No shared non-stopword token after stripping = reject."""
    # 'foo' and 'widget' share nothing non-stopword.
    assert run_research.passes_token_guards("concepts/foo-bar", "concepts/widget-zap") is False


def test_token_guards_stopwords_dont_count():
    """Sharing only stopwords like 'the' or 'ai' does not satisfy the overlap floor."""
    # 'ai' is a stopword; 'the' is a stopword; no other shared tokens.
    assert run_research.passes_token_guards("concepts/ai-the-thing", "concepts/ai-the-other") is False


def test_token_guards_type_family_dominates():
    """Even with perfect token overlap, people/ -> companies/ is blocked."""
    assert run_research.passes_token_guards(
        "people/swadesh-kumar", "companies/swadesh-kumar"
    ) is False


def test_prefix_variant_blocks_people_to_companies():
    """v5: resolve_via_prefix_variants will not return companies/foo for people/foo."""
    # In a fixture where ONLY companies/swadesh-kumar exists, the variant resolver
    # must NOT return it for a people/swadesh-kumar input.
    def fake_exists(slug):
        return slug == "companies/swadesh-kumar"

    assert run_research.resolve_via_prefix_variants(
        "people/swadesh-kumar",
        exists=fake_exists,
    ) is None


def test_prefix_variant_blocks_companies_to_people():
    def fake_exists(slug):
        return slug == "people/acme-corp"

    assert run_research.resolve_via_prefix_variants(
        "companies/acme-corp",
        exists=fake_exists,
    ) is None


def test_full_chain_people_prefers_people_over_companies():
    """v5 (Grant v4 finding): full resolve_suggested_link_target picks people/ first."""
    # Both people/foo and companies/foo exist. Original is people/foo.
    # The chain must resolve to people/foo (via exists() short-circuit), never companies/foo.
    def fake_exists(slug):
        return slug in {"people/foo", "companies/foo"}

    resolved, score = run_research.resolve_suggested_link_target(
        "people/foo", exists=fake_exists,
    )
    assert resolved == "people/foo"
    assert score == run_research.SLUG_RESOLUTION_HIGH


def test_full_chain_people_missing_does_not_fall_to_companies():
    """v5: when people/foo does NOT exist but companies/foo does, return unresolved."""
    def fake_exists(slug):
        return slug == "companies/foo"

    # Mock the search/basename steps so the chain can't reach them with stale data.
    with patch("run_research.search_slug_resolution", return_value=(None, 0.0)), \
         patch("run_research.resolve_via_basename_similarity", return_value=(None, 0.0)):
        resolved, _ = run_research.resolve_suggested_link_target(
            "people/foo", exists=fake_exists,
        )
    assert resolved is None


def test_search_resolution_walks_all_results():
    """v5 Change A: search must walk ALL 10 hits, not stop at first."""
    # First hit is below MEDIUM (skipped), second is at HIGH but not exists,
    # third is at HIGH and exists -> should win.
    output = (
        "[0.3000] junk/below-medium -- # Junk\n"
        "[1.0500] concepts/notexist -- # Not Exist\n"
        "[1.1000] concepts/codex -- # Codex\n"
    )
    def fake_exists(slug):
        return slug == "concepts/codex"
    with patch("run_research.auto_enrich_lib.run_gbrain", return_value=output):
        resolved, score = run_research.search_slug_resolution(
            "ai/tools/codex", exists=fake_exists,
        )
    assert resolved == "concepts/codex"
    assert score == 1.1


def test_basename_similarity_resolves_claude_opus_model():
    """v5 Change C: basename ratio ~0.74 for claude-opus-model -> claude-opus-4-7."""
    output = "[0.4000] concepts/claude-opus-4-7 -- # Claude Opus 4.7\n"
    def fake_exists(slug):
        return slug == "concepts/claude-opus-4-7"
    with patch("run_research.auto_enrich_lib.run_gbrain", return_value=output):
        resolved, ratio = run_research.resolve_via_basename_similarity(
            "ai/concepts/claude-opus-model", exists=fake_exists,
        )
    assert resolved == "concepts/claude-opus-4-7"
    assert ratio >= run_research.BASENAME_SIM_FLOOR


def test_basename_similarity_rejects_version_mismatch():
    """claude-3 candidate must not rewrite to claude-4 even with high basename ratio."""
    output = "[0.8000] concepts/claude-4 -- # Claude 4\n"
    def fake_exists(slug):
        return slug == "concepts/claude-4"
    with patch("run_research.auto_enrich_lib.run_gbrain", return_value=output):
        resolved, _ = run_research.resolve_via_basename_similarity(
            "concepts/claude-3", exists=fake_exists,
        )
    assert resolved is None


def test_basename_similarity_rejects_people_to_companies():
    """Type-family hard reject in basename path too."""
    output = "[0.9000] companies/swadesh-kumar -- # Swadesh Kumar Co\n"
    def fake_exists(slug):
        return slug == "companies/swadesh-kumar"
    with patch("run_research.auto_enrich_lib.run_gbrain", return_value=output):
        resolved, _ = run_research.resolve_via_basename_similarity(
            "people/swadesh-kumar", exists=fake_exists,
        )
    assert resolved is None


def test_ground_suggested_links_populates_unresolved_payload():
    """v5 Change D: failed entries land in suggested_links_unresolved with full payload."""
    artifact = {
        "suggested_links": [
            {"type": "mentions", "target": "people/random-name", "context": "saw on page"},
        ]
    }
    fake_detail = {
        "resolved": None,
        "score": 0.0,
        "search_top_score": 0.42,
        "search_top_candidate": "people/random-name-something",
        "basename_top_score": 0.55,
        "basename_top_candidate": "people/random-name-something",
    }
    with patch("run_research.slug_exists", return_value=False), \
         patch("run_research.resolve_suggested_link_target_detailed",
               return_value=fake_detail):
        grounded = run_research.ground_suggested_links(artifact)

    unresolved = grounded.get("suggested_links_unresolved")
    assert isinstance(unresolved, list) and len(unresolved) == 1
    entry = unresolved[0]
    assert entry["target"] == "people/random-name"
    assert entry["original_link"] == {
        "type": "mentions", "target": "people/random-name", "context": "saw on page",
    }
    assert entry["search_top_score"] == 0.42
    assert entry["search_top_candidate"] == "people/random-name-something"
    assert entry["basename_top_score"] == 0.55
    assert entry["basename_top_candidate"] == "people/random-name-something"


def test_ground_suggested_links_no_unresolved_when_all_resolved():
    """No suggested_links_unresolved field when every link resolves cleanly."""
    artifact = {"suggested_links": [{"type": "mentions", "target": "concepts/codex"}]}
    with patch("run_research.slug_exists", return_value=True):
        grounded = run_research.ground_suggested_links(artifact)
    assert "suggested_links_unresolved" not in grounded


def test_search_malformed_output_returns_unresolved_gracefully():
    """Empty / malformed gbrain search output does not crash; returns (None, 0.0)."""
    with patch("run_research.auto_enrich_lib.run_gbrain", return_value="garbage\n\n\n"), \
         patch("run_research.slug_exists", return_value=True):
        resolved, score = run_research.search_slug_resolution("ai/tools/x")
    assert resolved is None
    assert score == 0.0


def test_run_persists_page_content_in_artifact(tmp_path):
    """v4 Change D: run_research.run writes page_content into the on-disk artifact."""
    candidate_path = _make_candidate_json(tmp_path)
    good_artifact = json.loads((FIXTURES / "research_artifact_good.json").read_text())
    page = "Source page content with Alice Smith mentioned here."

    with patch("run_research.get_page_content", return_value=page), \
         patch("run_research.dispatch_cal", return_value=(0, json.dumps(good_artifact), "")), \
         patch("run_research.slug_exists", return_value=True):
        rc = run_research.run(str(candidate_path), str(tmp_path / "artifact.json"))

    assert rc == 0
    written = json.loads((tmp_path / "artifact.json").read_text())
    assert written["page_content"] == page
