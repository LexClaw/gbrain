"""run_pipeline.py: end-to-end auto-enrich pipeline driver.

For each top-N sensor candidate:
  1. detect_sparse provides the candidate
  2. run_research dispatches Cal and writes a research artifact
  3. quality_check #1 (pre-synthesize): Iron Law + no-fabrication on artifact
  4. synthesize merges artifact into a draft markdown file
  5. quality_check #2 (post-synthesize): Rule #5 lint runs on the draft
  6. If passed: `gbrain put` writes the draft back. Heartbeat appended.
  7. If failed at any step: append issue list to escalations.jsonl. Continue.

Run-mode env toggle:
  CAL_DISPATCH_MODE=mock  -> run_research reads from fixtures (no live Cal)

CLI:
  --limit N                Number of candidates to process (default 5)
  --dry-run                Skip the final gbrain put; everything else runs
  --candidate-pool N       Passed through to detect_sparse

Exit codes:
  0 at least 1 page enriched
  1 candidates returned but all failed
  2 sensor returned 0 candidates
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

import auto_enrich_lib  # noqa: E402
import detect_sparse  # noqa: E402
import quality_check  # noqa: E402
import run_research  # noqa: E402
import synthesize as synth_mod  # noqa: E402
from auto_enrich_lib import GBrainCLIError, Heartbeat  # noqa: E402
from run_logger import log_run  # noqa: E402

PIPELINE_VERSION = "0.3.0"
ESCALATIONS_PATH = (
    Path.home() / ".gbrain" / "integrations" / "auto-enrich" / "escalations.jsonl"
)
ERROR_CLASS_VALUES = (
    "pipeline_exception",
    "timeout",
    "broken_pipe",
    "refused_no_reason",
    "subprocess_nonzero_exit",
    "unknown",
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _append_escalation(record: dict[str, Any]) -> None:
    ESCALATIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with ESCALATIONS_PATH.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record) + "\n")


def _error_class_for_exception(exc: Exception, default: str = "unknown") -> str:
    """Map an exception to the closed error_class enum."""
    cls_name = type(exc).__name__
    if isinstance(exc, TimeoutError) or cls_name == "TimeoutExpired":
        return "timeout"
    if isinstance(exc, BrokenPipeError):
        return "broken_pipe"
    if isinstance(exc, ConnectionRefusedError):
        return "refused_no_reason"
    if cls_name == "CalledProcessError" or hasattr(exc, "returncode"):
        return "subprocess_nonzero_exit"
    if default in ERROR_CLASS_VALUES:
        return default
    return "unknown"


def _gbrain_put(slug: str, draft_path: Path) -> tuple[bool, str]:
    """Call `gbrain put <slug> < draft_path`."""
    import subprocess
    try:
        with draft_path.open("r", encoding="utf-8") as fh:
            proc = subprocess.run(
                [os.environ.get("GBRAIN_BIN", "gbrain"), "put", slug],
                stdin=fh, capture_output=True, text=True,
                timeout=60, check=False,
            )
        if proc.returncode != 0:
            return False, (proc.stderr or proc.stdout or "").strip()
        return True, ""
    except (FileNotFoundError, OSError) as exc:
        return False, str(exc)


_RULE_TO_COUNTER = {
    "iron_law": "gated_iron_law",
    "non_destructive": "gated_non_destructive",
    "lint": "gated_lint",
    "fabricated_command": "gated_fabricated",
}

REFUSAL_REASON_QUALITY_PRE_ALL_CLAIMS_DROPPED = "quality_pre_all_claims_dropped"
REFUSAL_REASON_QUALITY_PRE_NON_IRON_BLOCKER = "quality_pre_non_iron_blocker"
REFUSAL_REASON_QUALITY_PRE_BLOCKING_ISSUE = "quality_pre_blocking_issue"
REFUSAL_REASON_QUALITY_PRE_PARTIAL_CREDIT_RECHECK_FAILED = (
    "quality_pre_partial_credit_recheck_failed"
)
REFUSAL_REASON_QUALITY_POST_BLOCKING_ISSUE = "quality_post_blocking_issue"


def _classify_issues(issues: list[dict]) -> dict[str, int]:
    """Bucket blocking issues by counter-key (heartbeat field name)."""
    out: dict[str, int] = {v: 0 for v in _RULE_TO_COUNTER.values()}
    for i in issues:
        if i.get("severity") not in quality_check.BLOCKING:
            continue
        rule = i.get("rule", "")
        ckey = _RULE_TO_COUNTER.get(rule)
        if ckey:
            out[ckey] += 1
    return out


def _blocking_non_iron_issues(issues: list[dict]) -> list[dict]:
    return [
        i for i in issues
        if i.get("severity") in quality_check.BLOCKING
        and i.get("rule") != "iron_law"
    ]


def _quality_pre_refusal_reason(
    pre_issues: list[dict],
    drop: set[int],
    original_claim_count: int,
) -> str:
    """Return the refusal reason for a pre-synthesize gate failure."""
    if drop and len(drop) >= original_claim_count:
        return REFUSAL_REASON_QUALITY_PRE_ALL_CLAIMS_DROPPED
    if _blocking_non_iron_issues(pre_issues):
        return REFUSAL_REASON_QUALITY_PRE_NON_IRON_BLOCKER
    return REFUSAL_REASON_QUALITY_PRE_BLOCKING_ISSUE


def _run_research_for(candidate: dict, work_dir: Path) -> tuple[int, Path | None]:
    """Dispatch research for one candidate. Returns (exit_code, artifact_path).

    run_research handles the CAL_DISPATCH_MODE=mock env toggle itself; we
    just stage the candidate JSON and pass through.
    """
    slug = candidate.get("slug", "unknown")
    safe_slug = slug.replace("/", "_")
    cand_path = work_dir / f"candidate-{safe_slug}.json"
    art_path = work_dir / f"artifact-{safe_slug}.json"
    cand_path.write_text(json.dumps(candidate), encoding="utf-8")

    rc = run_research.run(str(cand_path), str(art_path))
    if rc != 0:
        return rc, None
    return 0, art_path


def _current_page_safe(slug: str) -> str:
    try:
        page = synth_mod.fetch_page(slug)
    except GBrainCLIError:
        return ""
    return page or ""


def process_candidate(
    candidate: dict,
    work_dir: Path,
    dry_run: bool,
    hb: Heartbeat,
    counters: dict[str, int],
    pool_rank: int = 0,
    pool_size: int = 0,
) -> bool:
    """Process one candidate. Returns True on full success (page enriched).

    Wrapped in try/finally so a structured per-candidate JSONL line is
    always emitted via ``log_run()``, even on crash paths.
    """
    slug = candidate.get("slug", "unknown")
    t_start = time.perf_counter()
    run_data: dict[str, Any] = {
        "run_id": _now_iso(),
        "run_mode": "dry" if dry_run else "live",
        "candidate": {
            "slug": slug,
            "score": candidate.get("score"),
            "pool_size": pool_size,
            "pool_rank": pool_rank,
        },
        "stages_ms": {
            "sensor": 0, "cal": 0, "gate": 0,
            "synthesize": 0, "write": 0, "total": 0,
        },
        "cal": {
            "model": None,
            "claims_returned": 0,
            "raw_response_chars": 0,
            "suggested_links_valid_rate": None,
        },
        "gate": {
            "kept": 0, "dropped": 0,
            "drop_reasons": {"not_verbatim": 0, "not_found": 0,
                              "fetch_failed": 0, "other": 0},
            "per_claim": [],
        },
        "outcome": "error",
        "write": {
            "slug_written": None, "facts_added": 0,
            "sections_added": [], "existing_preserved": True,
            "partial_credit_applied": False,
        },
        "tools_used": {"gstack_browse": 0, "xurl": 0, "http": 0,
                        "fallback_chain_hits": 0},
        "errors": [],
    }
    result = False
    try:
        result = _process_candidate_inner(
            candidate, work_dir, dry_run, hb, counters, run_data,
        )
    except Exception as exc:  # noqa: BLE001
        run_data["outcome"] = "error"
        err_text = f"{type(exc).__name__}: {str(exc)[:200]}"
        if hasattr(exc, "cmd"):
            err_text += " | stage=hermes_subprocess"
        run_data["error_class"] = _error_class_for_exception(
            exc, default="pipeline_exception",
        )
        run_data["errors"].append(f"pipeline_exception: {err_text}")
        counters["escalations_count"] += 1
        _append_escalation({
            "ts": _now_iso(), "slug": slug, "stage": "pipeline_exception",
            "error": err_text,
        })
        hb.emit("pipeline_step", status="pipeline_exception",
                details={"slug": slug, "error": err_text[:200]})
        result = False
    finally:
        if run_data.get("outcome") == "error" and "error_class" not in run_data:
            run_data["error_class"] = "unknown"
        run_data["stages_ms"]["total"] = int(
            (time.perf_counter() - t_start) * 1000
        )
        log_run(run_data)
    return result


def _classify_drop_reason(issues: list[dict]) -> str:
    """Map a per-claim issue list to a drop_reasons bucket key."""
    for it in issues:
        if it.get("rule") != "iron_law":
            continue
        if it.get("severity") not in quality_check.BLOCKING:
            continue
        detail = str(it.get("detail", "")).lower()
        if "quote not found" in detail:
            return "not_found"
        if "missing citation" in detail or "citation.url" in detail or "citation.quote" in detail:
            return "not_verbatim"
    # Fetch-failure issues are low-severity (fail-open); count them last.
    for it in issues:
        if "fetch fail" in str(it.get("detail", "")).lower():
            return "fetch_failed"
    return "other"


def _populate_gate_telemetry(
    run_data: dict,
    artifact: dict,
    issues: list[dict],
    dropped_indices: set[int] | None = None,
) -> None:
    """Fill run_data['gate'] from a quality_check.check() issues list."""
    claims = artifact.get("claims", []) or []
    dropped_indices = dropped_indices or set()
    iron_per_claim: dict[int, list[dict]] = {}
    for it in issues:
        ci = it.get("claim_index")
        if isinstance(ci, int):
            iron_per_claim.setdefault(ci, []).append(it)
    per_claim: list[dict] = []
    kept = 0
    dropped = 0
    drop_reasons = {"not_verbatim": 0, "not_found": 0,
                     "fetch_failed": 0, "other": 0}
    for i, claim in enumerate(claims):
        url = ""
        if isinstance(claim, dict):
            cit = claim.get("citation") if isinstance(claim.get("citation"), dict) else {}
            url = cit.get("url", "") if isinstance(cit, dict) else ""
        claim_issues = iron_per_claim.get(i, [])
        tool = None
        for it in claim_issues:
            if "tool_used" in it:
                tool = it["tool_used"]
                break
        blocking = [it for it in claim_issues
                    if it.get("severity") in quality_check.BLOCKING
                    and it.get("rule") == "iron_law"]
        if i in dropped_indices or blocking:
            verdict = "dropped"
            reason = _classify_drop_reason(claim_issues)
            drop_reasons[reason] = drop_reasons.get(reason, 0) + 1
            dropped += 1
        else:
            verdict = "kept"
            reason = None
            kept += 1
        per_claim.append({
            "claim_index": i,
            "source_url": url,
            "verdict": verdict,
            "reason": reason,
            "tool": tool,
        })
    run_data["gate"] = {
        "kept": kept, "dropped": dropped,
        "drop_reasons": drop_reasons,
        "per_claim": per_claim,
    }


def _process_candidate_inner(
    candidate: dict,
    work_dir: Path,
    dry_run: bool,
    hb: Heartbeat,
    counters: dict[str, int],
    run_data: dict[str, Any],
) -> bool:
    slug = candidate.get("slug", "unknown")

    # Step 1: research
    t_cal = time.perf_counter()
    rc, art_path = _run_research_for(candidate, work_dir)
    run_data["stages_ms"]["cal"] = int((time.perf_counter() - t_cal) * 1000)
    if rc != 0 or art_path is None:
        run_data["outcome"] = "error"
        run_data["error_class"] = "subprocess_nonzero_exit"
        run_data["errors"].append(f"run_research exit {rc}")
        counters["escalations_count"] += 1
        _append_escalation({
            "ts": _now_iso(), "slug": slug, "stage": "research",
            "exit_code": rc, "issues": [{"rule": "research_dispatch",
                                          "severity": "high",
                                          "detail": f"run_research exit {rc}"}],
        })
        hb.emit("pipeline_step", status="research_error",
                details={"slug": slug, "exit_code": rc})
        return False
    artifact = json.loads(art_path.read_text())
    raw_text = art_path.read_text(encoding="utf-8")
    run_data["cal"]["raw_response_chars"] = len(raw_text)
    run_data["cal"]["claims_returned"] = len(artifact.get("claims", []) or [])
    run_data["cal"]["suggested_links_valid_rate"] = artifact.get(
        "suggested_links_valid_rate"
    )
    run_data["cal"]["suggested_links_valid_count"] = artifact.get(
        "suggested_links_valid_count"
    )
    run_data["cal"]["suggested_links_original_count"] = artifact.get(
        "suggested_links_original_count"
    )
    run_data["cal"]["suggested_links_resolved_count"] = artifact.get(
        "suggested_links_resolved_count"
    )
    resolved_model = artifact.get("model") or artifact.get("cal_model")
    if not resolved_model:
        resolved_model = os.environ.get("CAL_DISPATCH_MODEL_OVERRIDE") or os.environ.get("CAL_MODEL")
    run_data["cal"]["model"] = resolved_model

    # Step 2: pre-synthesize quality check (Iron Law + no-fabrication).
    t_gate = time.perf_counter()
    current_page = _current_page_safe(slug)
    pre_passed, pre_issues = quality_check.check(artifact, current_page, draft_path=None)
    if not pre_passed:
        drop = quality_check.failing_iron_law_indices(pre_issues)
        non_iron_blocking = _blocking_non_iron_issues(pre_issues)
        original_claim_count = len(artifact.get("claims", []) or [])
        if drop and not non_iron_blocking and len(drop) < original_claim_count:
            filtered = quality_check.filter_artifact_drop_claims(artifact, drop)
            re_passed, re_issues = quality_check.check(
                filtered, current_page, draft_path=None,
            )
            if re_passed:
                _append_escalation({
                    "ts": _now_iso(), "slug": slug,
                    "stage": "quality_pre_partial_credit",
                    "dropped_claims": sorted(drop),
                    "dropped_claim_count": len(drop),
                    "kept_claim_count": len(filtered.get("claims", [])),
                    "original_issues": pre_issues,
                })
                hb.emit("pipeline_step", status="quality_pre_partial_credit",
                        details={
                            "slug": slug,
                            "dropped": len(drop),
                            "kept": len(filtered.get("claims", [])),
                        })
                filtered_path = work_dir / f"artifact-{slug.replace('/', '_')}-filtered.json"
                filtered_path.write_text(json.dumps(filtered, indent=2))
                art_path = filtered_path
                _populate_gate_telemetry(run_data, artifact, pre_issues,
                                          dropped_indices=set(drop))
                run_data["write"]["partial_credit_applied"] = True
                run_data["stages_ms"]["gate"] = int(
                    (time.perf_counter() - t_gate) * 1000
                )
                artifact = filtered
                pre_issues = re_issues
            else:
                _populate_gate_telemetry(run_data, artifact, pre_issues,
                                          dropped_indices=set(drop))
                run_data["stages_ms"]["gate"] = int(
                    (time.perf_counter() - t_gate) * 1000
                )
                run_data["outcome"] = "refused"
                run_data["refusal_reason"] = (
                    REFUSAL_REASON_QUALITY_PRE_PARTIAL_CREDIT_RECHECK_FAILED
                )
                buckets = _classify_issues(pre_issues)
                for k, v in buckets.items():
                    counters[k] += v
                counters["escalations_count"] += 1
                _append_escalation({
                    "ts": _now_iso(), "slug": slug, "stage": "quality_pre",
                    "issues": pre_issues,
                    "partial_credit_attempted": True,
                    "post_filter_issues": re_issues,
                })
                hb.emit("pipeline_step", status="quality_pre_failed",
                        details={"slug": slug, "issues_count": len(pre_issues)})
                return False
        else:
            _populate_gate_telemetry(run_data, artifact, pre_issues,
                                      dropped_indices=set(drop))
            run_data["stages_ms"]["gate"] = int(
                (time.perf_counter() - t_gate) * 1000
            )
            run_data["outcome"] = "refused"
            run_data["refusal_reason"] = _quality_pre_refusal_reason(
                pre_issues, drop, original_claim_count,
            )
            buckets = _classify_issues(pre_issues)
            for k, v in buckets.items():
                counters[k] += v
            counters["escalations_count"] += 1
            _append_escalation({
                "ts": _now_iso(), "slug": slug, "stage": "quality_pre",
                "issues": pre_issues,
            })
            hb.emit("pipeline_step", status="quality_pre_failed",
                    details={"slug": slug, "issues_count": len(pre_issues)})
            return False
    else:
        _populate_gate_telemetry(run_data, artifact, pre_issues)
    run_data["stages_ms"]["gate"] = int((time.perf_counter() - t_gate) * 1000)

    # Step 3: synthesize
    t_synth = time.perf_counter()
    draft_path = work_dir / f"draft-{slug.replace('/', '_')}.md"
    try:
        synth_rc = synth_mod.run(
            str(art_path), slug, dry_run=False, draft_out=str(draft_path),
        )
    except Exception as exc:  # noqa: BLE001
        run_data["stages_ms"]["synthesize"] = int(
            (time.perf_counter() - t_synth) * 1000
        )
        run_data["outcome"] = "error"
        run_data["error_class"] = _error_class_for_exception(
            exc, default="pipeline_exception",
        )
        run_data["errors"].append(f"synthesize: {exc}")
        counters["escalations_count"] += 1
        _append_escalation({
            "ts": _now_iso(), "slug": slug, "stage": "synthesize",
            "error": str(exc),
        })
        hb.emit("pipeline_step", status="synth_exception",
                details={"slug": slug, "error": str(exc)[:200]})
        return False
    run_data["stages_ms"]["synthesize"] = int(
        (time.perf_counter() - t_synth) * 1000
    )
    if synth_rc != 0:
        run_data["outcome"] = "error"
        run_data["error_class"] = "subprocess_nonzero_exit"
        run_data["errors"].append(f"synthesize exit {synth_rc}")
        counters["escalations_count"] += 1
        _append_escalation({
            "ts": _now_iso(), "slug": slug, "stage": "synthesize",
            "exit_code": synth_rc,
        })
        hb.emit("pipeline_step", status="synth_error",
                details={"slug": slug, "exit_code": synth_rc})
        return False

    # Step 4: post-synthesize quality check (Rule #5 lint).
    post_passed, post_issues = quality_check.check(
        artifact, current_page, draft_path=draft_path,
    )
    if not post_passed:
        run_data["outcome"] = "refused"
        run_data["refusal_reason"] = REFUSAL_REASON_QUALITY_POST_BLOCKING_ISSUE
        buckets = _classify_issues(post_issues)
        for k, v in buckets.items():
            counters[k] += v
        counters["escalations_count"] += 1
        _append_escalation({
            "ts": _now_iso(), "slug": slug, "stage": "quality_post",
            "issues": post_issues,
        })
        hb.emit("pipeline_step", status="quality_post_failed",
                details={"slug": slug, "issues_count": len(post_issues)})
        return False

    # Telemetry: facts/sections counts from the filtered/original artifact.
    run_data["write"]["facts_added"] = len(artifact.get("structured_facts", []) or [])
    run_data["write"]["sections_added"] = [
        str(a.get("section", "")).strip()
        for a in (artifact.get("narrative_additions", []) or [])
        if isinstance(a, dict) and a.get("section")
    ]

    # Step 5: gbrain put (unless dry-run).
    if dry_run:
        run_data["outcome"] = "dry_pass"
        counters["passed_gate"] += 1
        hb.emit("pipeline_step", status="dry_run_passed",
                details={"slug": slug, "draft_path": str(draft_path)})
        return True

    t_write = time.perf_counter()
    ok, err = _gbrain_put(slug, draft_path)
    run_data["stages_ms"]["write"] = int((time.perf_counter() - t_write) * 1000)
    if not ok:
        run_data["outcome"] = "error"
        run_data["errors"].append(f"gbrain_put: {err}")
        counters["escalations_count"] += 1
        _append_escalation({
            "ts": _now_iso(), "slug": slug, "stage": "gbrain_put",
            "error": err,
        })
        hb.emit("pipeline_step", status="gbrain_put_failed",
                details={"slug": slug, "error": err[:200]})
        return False

    run_data["outcome"] = "written"
    run_data["write"]["slug_written"] = slug
    counters["passed_gate"] += 1
    hb.emit("pipeline_step", status="enriched",
            details={"slug": slug, "draft_path": str(draft_path)})
    return True


def run(limit: int = 5, dry_run: bool = False, candidate_pool: int | None = None) -> int:
    start = time.time()
    hb = Heartbeat()
    counters = {
        "total_candidates": 0,
        "passed_gate": 0,
        "gated_iron_law": 0,
        "gated_non_destructive": 0,
        "gated_lint": 0,
        "gated_fabricated": 0,
        "escalations_count": 0,
        "runtime_seconds": 0.0,
    }

    cfg = detect_sparse.SensorConfig()
    cfg_path = _SCRIPT_DIR.parent / "config.yaml"
    if cfg_path.exists():
        try:
            cfg = detect_sparse.SensorConfig.from_yaml(cfg_path)
        except Exception:  # noqa: BLE001
            pass
    if candidate_pool is not None:
        cfg.candidate_pool_per_type = candidate_pool

    try:
        t_sensor = time.perf_counter()
        candidates = detect_sparse.detect(cfg=cfg, limit=limit)
        sensor_ms = int((time.perf_counter() - t_sensor) * 1000)
    except GBrainCLIError as exc:
        hb.emit("pipeline_run", status="sensor_error", error=str(exc))
        return 2
    counters["total_candidates"] = len(candidates)
    if not candidates:
        hb.emit("pipeline_run", status="no_candidates")
        counters["runtime_seconds"] = round(time.time() - start, 3)
        hb.emit("pipeline_run_summary", status="ok", details=counters)
        return 2

    work_dir = Path(os.environ.get("AUTO_ENRICH_WORK", "/tmp")) / "auto-enrich-pipeline"
    work_dir.mkdir(parents=True, exist_ok=True)

    pool_size = len(candidates)
    for idx, candidate in enumerate(candidates):
        process_candidate(
            candidate, work_dir, dry_run, hb, counters,
            pool_rank=idx + 1, pool_size=pool_size,
        )
        # Inject sensor timing into the first candidate's run line via env so
        # the per-run logger reflects the sensor cost amortized at rank 1.
        # (Subsequent candidates share the same sensor invocation; we record
        # 0 for them by default.)
        _ = sensor_ms  # retained for future per-run sensor attribution

    counters["runtime_seconds"] = round(time.time() - start, 3)
    hb.emit("pipeline_run_summary", status="ok", details=counters)

    if counters["passed_gate"] >= 1:
        return 0
    return 1


def main():
    parser = argparse.ArgumentParser(description="Auto-enrich nightly pipeline.")
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--candidate-pool", type=int, default=None)
    args = parser.parse_args()
    sys.exit(run(
        limit=args.limit, dry_run=args.dry_run,
        candidate_pool=args.candidate_pool,
    ))


if __name__ == "__main__":
    main()
