"""Tests for detect_sparse.py.

Mocks the gbrain subprocess boundary so tests do not touch the live brain.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import auto_enrich_lib  # noqa: E402
import detect_sparse  # noqa: E402


# --- Fixtures ---

SPARSE_PAGE_MD = """---
type: person
title: Sparse Person
---

# Sparse Person

Just a stub.
"""

FULL_PAGE_MD = (
    """---
type: person
title: Full Person
last_enriched: '2026-05-15T00:00:00Z'
---

# Full Person

"""
    + ("Detailed biography paragraph. " * 200)
)

LIST_TSV_FIVE_ROWS = "\n".join(
    [
        "people/p1\tperson\t2026-01-01\tP1",
        "people/p2\tperson\t2026-01-02\tP2",
        "people/p3\tperson\t2026-01-03\tP3",
        "people/p4\tperson\t2026-01-04\tP4",
        "people/p5\tperson\t2026-01-05\tP5",
    ]
)


def fake_gbrain_factory(pages: dict[str, str], backlinks: dict[str, list[dict]], list_output: str):
    """Build a fake run_gbrain that dispatches by subcommand."""

    def fake_run(args: list[str], *, timeout: int = 60) -> str:
        if args[0] == "list":
            return list_output + "\n"
        if args[0] == "get":
            slug = args[1]
            if slug not in pages:
                raise auto_enrich_lib.GBrainCLIError(
                    ["gbrain", *args], 1, "", f"unknown slug {slug}"
                )
            return pages[slug]
        if args[0] == "backlinks":
            slug = args[1]
            return json.dumps(backlinks.get(slug, []))
        raise AssertionError(f"unexpected gbrain call: {args}")

    return fake_run


# --- Tests ---


def test_parse_frontmatter_extracts_yaml_block():
    fm, body = auto_enrich_lib.parse_frontmatter(SPARSE_PAGE_MD)
    assert fm["type"] == "person"
    assert fm["title"] == "Sparse Person"
    assert body.startswith("# Sparse Person")


def test_parse_frontmatter_no_fence_returns_empty_dict():
    fm, body = auto_enrich_lib.parse_frontmatter("# Just a body\n\nNo frontmatter.\n")
    assert fm == {}
    assert body.startswith("# Just a body")


def test_score_sparse_page_is_higher_than_full_page():
    cfg = detect_sparse.SensorConfig()
    sparse_score = detect_sparse.compute_score(
        body_length=20, inbound_count=0, last_enriched=None, cfg=cfg
    )
    full_score = detect_sparse.compute_score(
        body_length=5000, inbound_count=10, last_enriched="2026-05-15T00:00:00Z", cfg=cfg, now_iso="2026-05-20T00:00:00Z"
    )
    assert sparse_score > full_score
    assert sparse_score > 0.99


def test_score_is_deterministic():
    cfg = detect_sparse.SensorConfig()
    a = detect_sparse.compute_score(body_length=300, inbound_count=1, last_enriched=None, cfg=cfg)
    b = detect_sparse.compute_score(body_length=300, inbound_count=1, last_enriched=None, cfg=cfg)
    assert a == b


def test_missing_last_enriched_max_age_penalty():
    cfg = detect_sparse.SensorConfig()
    score = detect_sparse.compute_score(
        body_length=1500, inbound_count=3, last_enriched=None, cfg=cfg
    )
    # Body + links perfect, only age penalty contributes (weight 0.3, value 1.0)
    assert score == pytest.approx(0.3, abs=1e-6)


def test_sensor_flags_sparse_fixture_not_full_fixture():
    pages = {
        "people/sparse": SPARSE_PAGE_MD,
        "people/full": FULL_PAGE_MD,
    }
    backlinks = {"people/sparse": [], "people/full": [{"f": "x"}] * 5}
    list_tsv = "people/sparse\tperson\t2026-01-01\tSparse Person\npeople/full\tperson\t2026-01-02\tFull Person"

    fake = fake_gbrain_factory(pages, backlinks, list_tsv)
    with patch.object(detect_sparse, "run_gbrain", side_effect=fake):
        results = detect_sparse.detect(
            cfg=detect_sparse.SensorConfig(page_types=["person"], candidate_pool_per_type=5),
            limit=10,
        )

    slugs = [r["slug"] for r in results]
    assert "people/sparse" in slugs
    # Sparse must rank above full
    sparse_idx = slugs.index("people/sparse")
    if "people/full" in slugs:
        assert sparse_idx < slugs.index("people/full")
    # Sparse score must exceed full score
    sparse_score = next(r["score"] for r in results if r["slug"] == "people/sparse")
    if any(r["slug"] == "people/full" for r in results):
        full_score = next(r["score"] for r in results if r["slug"] == "people/full")
        assert sparse_score > full_score


def test_limit_truncates_results():
    pages = {f"people/p{i}": SPARSE_PAGE_MD for i in range(1, 6)}
    backlinks = {f"people/p{i}": [] for i in range(1, 6)}

    fake = fake_gbrain_factory(pages, backlinks, LIST_TSV_FIVE_ROWS)
    with patch.object(detect_sparse, "run_gbrain", side_effect=fake):
        results = detect_sparse.detect(
            cfg=detect_sparse.SensorConfig(page_types=["person"], candidate_pool_per_type=5),
            limit=3,
        )
    assert len(results) == 3


def test_cli_subprocess_error_exits_1(tmp_path, monkeypatch, capsys):
    def boom(args, *, timeout: int = 60):
        raise auto_enrich_lib.GBrainCLIError(["gbrain", *args], 1, "", "engine down")

    monkeypatch.setattr(detect_sparse, "run_gbrain", boom)
    with pytest.raises(SystemExit) as exc:
        detect_sparse.main(["--limit", "1"])
    assert exc.value.code == 1


def test_main_writes_output_file(tmp_path, monkeypatch):
    pages = {"people/p1": SPARSE_PAGE_MD}
    backlinks = {"people/p1": []}
    list_tsv = "people/p1\tperson\t2026-01-01\tP1"
    fake = fake_gbrain_factory(pages, backlinks, list_tsv)
    monkeypatch.setattr(detect_sparse, "run_gbrain", fake)

    # Avoid touching the real heartbeat path during tests
    hb_path = tmp_path / "heartbeat.jsonl"
    monkeypatch.setattr(auto_enrich_lib, "DEFAULT_HEARTBEAT_PATH", hb_path)
    monkeypatch.setattr(detect_sparse.auto_enrich_lib, "DEFAULT_HEARTBEAT_PATH", hb_path)

    out_path = tmp_path / "out.json"
    detect_sparse.main(["--limit", "1", "--output", str(out_path), "--types", "person"])
    data = json.loads(out_path.read_text())
    assert isinstance(data, list)
    assert data[0]["slug"] == "people/p1"
    # Heartbeat written
    assert hb_path.exists()
    line = hb_path.read_text().strip().splitlines()[-1]
    entry = json.loads(line)
    assert entry["event"] == "sensor_run"
    assert entry["status"] == "ok"
