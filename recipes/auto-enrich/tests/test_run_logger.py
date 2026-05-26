"""Tests for the structured per-run logger (scripts/run_logger.py).

The logger MUST never raise: every test verifies a property *and* the
absence of an exception escaping log_run().
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

_SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import run_logger  # noqa: E402


def _sample_run(**overrides):
    base = {
        "run_id": "2026-05-22T21:25:29Z",
        "run_mode": "dry",
        "candidate": {"slug": "companies/lavender", "score": 0.87,
                       "pool_size": 50, "pool_rank": 1},
        "stages_ms": {"sensor": 100, "cal": 200, "gate": 50,
                       "synthesize": 30, "write": 0, "total": 380},
        "cal": {"model": "test-model", "claims_returned": 2,
                 "raw_response_chars": 123},
        "gate": {"kept": 1, "dropped": 1,
                  "drop_reasons": {"not_verbatim": 1, "not_found": 0,
                                    "fetch_failed": 0, "other": 0},
                  "per_claim": []},
        "outcome": "dry_pass",
        "write": {"slug_written": None, "facts_added": 0,
                   "sections_added": [], "existing_preserved": True,
                   "partial_credit_applied": False},
        "tools_used": {"gstack_browse": 0, "xurl": 0, "http": 0,
                        "fallback_chain_hits": 0},
        "errors": [],
    }
    base.update(overrides)
    return base


@pytest.fixture
def log_path(tmp_path, monkeypatch):
    p = tmp_path / "logs" / "auto-enrich-runs.jsonl"
    monkeypatch.setenv("AUTO_ENRICH_LOG_PATH", str(p))
    return p


def test_writes_one_line_per_call(log_path):
    run_logger.log_run(_sample_run())
    run_logger.log_run(_sample_run(run_id="2026-05-22T21:30:00Z"))
    lines = log_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    for line in lines:
        json.loads(line)  # must round-trip


def test_atomic_append(log_path):
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text('{"pre":"existing"}\n', encoding="utf-8")
    run_logger.log_run(_sample_run())
    content = log_path.read_text(encoding="utf-8")
    lines = content.splitlines()
    assert lines[0] == '{"pre":"existing"}'
    assert len(lines) == 2
    payload = json.loads(lines[1])
    assert payload["run_id"] == "2026-05-22T21:25:29Z"
    # File ends with newline so concurrent appenders never glue lines.
    assert content.endswith("\n")


def test_schema_warning_but_still_writes(log_path, capsys):
    bad = _sample_run()
    del bad["outcome"]
    run_logger.log_run(bad)
    captured = capsys.readouterr()
    assert "outcome" in captured.err
    lines = log_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    payload = json.loads(lines[0])
    assert any("outcome" in e for e in payload["errors"])


def test_logger_never_raises(log_path, capsys):
    # All these inputs must return None without raising.
    assert run_logger.log_run(None) is None
    assert run_logger.log_run("not-a-dict") is None
    assert run_logger.log_run(42) is None
    assert run_logger.log_run(["list", "input"]) is None
    captured = capsys.readouterr()
    assert "run_logger" in captured.err
    # Unserializable values inside a dict must also not raise.
    class Weird:
        pass
    payload = _sample_run()
    payload["weird"] = Weird()
    assert run_logger.log_run(payload) is None
    # Line is still written (default=str coerces).
    lines = log_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1


def test_creates_log_dir_if_missing(tmp_path, monkeypatch):
    nested = tmp_path / "a" / "b" / "c" / "runs.jsonl"
    monkeypatch.setenv("AUTO_ENRICH_LOG_PATH", str(nested))
    assert not nested.parent.exists()
    run_logger.log_run(_sample_run())
    assert nested.parent.is_dir()
    assert nested.is_file()


def test_json_is_valid(log_path):
    payload = _sample_run()
    run_logger.log_run(payload)
    line = log_path.read_text(encoding="utf-8").splitlines()[0]
    parsed = json.loads(line)
    # Top-level structural keys preserved.
    for key in ("run_id", "run_mode", "candidate", "stages_ms", "cal",
                 "gate", "outcome", "write", "tools_used", "errors"):
        assert key in parsed, f"missing key: {key}"
    assert parsed["candidate"]["slug"] == "companies/lavender"
    assert parsed["gate"]["drop_reasons"]["not_verbatim"] == 1
    assert parsed["outcome"] == "dry_pass"


def test_refused_run_preserves_refusal_reason(log_path):
    payload = _sample_run(
        outcome="refused",
        refusal_reason="quality_pre_blocking_issue",
    )
    run_logger.log_run(payload)
    line = log_path.read_text(encoding="utf-8").splitlines()[0]
    parsed = json.loads(line)
    assert parsed["outcome"] == "refused"
    assert parsed["refusal_reason"] == "quality_pre_blocking_issue"
