"""run_research.py: dispatch Cal to research a candidate and collect a research artifact.

CLI:
    python3 run_research.py --candidate-json PATH --output-artifact PATH [--dry-run]

Workflow:
    1. Load candidate JSON from Phase 1 sensor output
    2. Call research_strategy.build_query_plan() to produce queries
    3. Compile a Cal prompt via prompt-builder.py
    4. Dispatch Cal via `hermes -z <prompt> --model claude-haiku-4-5 --yolo`
    5. Capture structured JSON output, validate against the artifact schema
    6. Write artifact to --output-artifact

Exit codes:
    0: success, artifact written
    1: dispatch error (hermes subprocess non-zero)
    2: schema validation error
    3: CLI/config error (missing files, bad args)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_SCRIPT_DIR))

import auto_enrich_lib  # noqa: E402
from auto_enrich_lib import Heartbeat  # noqa: E402
import research_strategy  # noqa: E402

RECIPE_ID = "auto-enrich"
RECIPE_VERSION_RESEARCH = "0.2.0"
PROMPT_BUILDER_PATH = Path.home() / "hermes-workspace" / "Lex-Workspace" / "scripts" / "prompt-builder.py"
MODEL_MARKER_RE = re.compile(r"^<!-- HERMES-MODEL: (.*?) -->\s*$", re.MULTILINE)

# Seven-skill anchor set for Cal research dispatch
REQUIRED_SKILLS = [
    "data-research",
    "enrich",
    "perplexity-research",
    "live-web-research-fallback-chain",
    "academic-verify",
    "cal",
    "sage",
]

TASK_TEMPLATE = """\
Research the candidate at slug "{slug}".

You have the following skills pre-loaded for this task: {skills_csv}.
Use them as your toolbox: data-research and perplexity-research for primary
lookups, live-web-research-fallback-chain when primary sources miss,
academic-verify for concept-type claims, enrich for the artifact shape,
cal and sage for research discipline.

Follow this query plan exactly. Execute each query in order and collect results:
{query_plan_json}

The candidate's current page content is:
---
{page_content}
---

After executing all queries, produce a research artifact JSON that matches this schema:
{schema_text}

IRON LAW (HARD REQUIREMENT, READ TWICE):

Every citation.quote MUST be a literal, character-for-character copy-paste of
text that appears verbatim on the cited URL. The Iron Law gate runs a
substring match: if the quote is not a verbatim substring of the fetched
page body, the claim is REJECTED.

NO paraphrasing. NO summarizing. NO inference. NO synthesis of multiple
sentences. NO "in other words" rewrites. The quote field is not a
description of what the source says; it IS what the source says.

DATES AND NUMBERS — DO NOT REFORMAT (READ THIS BEFORE WRITING ANY CLAIM):
- If the source string is "2008-10-27T20:08:30.000Z", your quote must
  contain "2008-10-27" (or the full timestamp). DO NOT write "October 2008".
- If the API returns 803, your quote must contain "803". DO NOT write
  "around 800" or "approximately 800".
- If the source says "May 14, 2026", your quote must contain "May 14, 2026"
  exactly — not "May 2026" and not "14 May 2026".
The gate has zero calendar logic and zero rounding logic. It only knows
"does this exact string appear on the page." Quote the raw source value
verbatim. The synthesized prose around the claim can phrase it
human-friendly later.

BAD examples (these all FAIL the gate because they are paraphrases):
  BAD quote: "@Prisma listed in profile work history"
  BAD quote: "the #1 customer platform for financial services, retail, tech, and insurance"
  BAD quote: "Eoghan McCabe, the controversial Intercom co-founder who left the CEO role in 2020"
  BAD quote: "Profile mentions previous work at Scandit"

GOOD examples (these PASS because they appear verbatim on the source):
  GOOD quote: "Head of DX at @warpdotdev. Previously @Prisma & @Scandit."
  GOOD quote: "Eoghan McCabe, the controversial Intercom co-founder who left the CEO role in 2020, is stepping back in"
  GOOD quote: "We're the #1 AI Customer Service platform"

REJECTION GUIDANCE: If you cannot find a verbatim substring on the source
that supports a claim, DROP the claim entirely. Quality beats quantity.
Three verified claims is better than sixteen claims of which twelve fail
the gate. Do NOT fabricate a quote to fill the citation field.

SECOND PASS (mandatory before returning the artifact): re-read every claim
and ask: "Does the quote text appear, character-for-character, in the
source content I actually fetched?" If not, either replace it with a real
adjacent sentence copied verbatim from the source, OR drop the claim.

Do NOT overwrite existing human prose in sections with >30 words.
Output ONLY valid JSON. No markdown fence, no preamble, no trailing text.
"""


def load_candidate(path: Path) -> dict[str, Any]:
    """Load a candidate dict from a JSON file."""
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def validate_artifact(artifact: dict[str, Any]) -> list[str]:
    """Validate a research artifact against the schema.

    Returns a list of error strings (empty = valid).
    Checks:
      - All top-level required keys present
      - Every claim has citation.url (non-empty) and citation.quote (non-empty)
    """
    errors: list[str] = []
    required_keys = [
        "target_slug", "researched_at", "researcher",
        "queries_run", "claims", "structured_facts",
        "suggested_links", "narrative_additions",
    ]
    for key in required_keys:
        if key not in artifact:
            errors.append(f"missing top-level key: {key}")

    claims = artifact.get("claims", [])
    if not isinstance(claims, list):
        errors.append("claims must be an array")
        return errors

    # Basic key-presence + array-type checks for the other top-level arrays
    # (existence + is-list only; deep validation belongs to Phase 3 quality gate).
    for arr_key in ("queries_run", "structured_facts", "suggested_links", "narrative_additions"):
        if arr_key in artifact and not isinstance(artifact[arr_key], list):
            errors.append(f"{arr_key} must be an array")

    for i, claim in enumerate(claims):
        citation = claim.get("citation")
        if not isinstance(citation, dict):
            errors.append(f"claims[{i}]: citation is not a dict")
            continue
        url = citation.get("url", "")
        if not url or not url.strip():
            errors.append(f"claims[{i}]: citation.url is empty (Iron Law violation)")
        quote = citation.get("quote", "")
        if not quote or not quote.strip():
            errors.append(f"claims[{i}]: citation.quote is empty (Iron Law violation)")

    return errors


def compile_cal_prompt(slug: str, query_plan: list[dict], page_content: str,
                       schema_text: str, skills: list[str] | None = None) -> str:
    """Build the compiled prompt text for Cal."""
    qp_json = json.dumps(query_plan, indent=2)
    skills_csv = ", ".join(skills or REQUIRED_SKILLS)
    return TASK_TEMPLATE.format(
        slug=slug,
        query_plan_json=qp_json,
        page_content=page_content,
        schema_text=schema_text,
        skills_csv=skills_csv,
    )


def get_page_content(slug: str) -> str:
    """Fetch current page content from the brain via gbrain."""
    return auto_enrich_lib.run_gbrain(["get", slug])


def load_schema_text() -> str:
    """Load the research artifact schema markdown for inclusion in the Cal prompt."""
    schema_path = _SCRIPT_DIR.parent / "docs" / "research-artifact-schema.md"
    if schema_path.exists():
        return schema_path.read_text(encoding="utf-8")
    # Fallback: embed a minimal schema inline
    return """Research artifact JSON must have these top-level keys:
- target_slug (string): the page slug
- researched_at (ISO8601 string)
- researcher (string): "cal-subagent"
- queries_run (array of {query, source, result_count})
- claims (array of {text, citation: {url, fetched_at, quote}, section_hint})
- structured_facts (array of {key, value, ...})
- suggested_links (array of {type, target})
- narrative_additions (array of {section, text, citation_indexes})

IRON LAW: every claim's citation must have non-empty url AND quote."""


# Synthetic return code emitted by dispatch_cal() when hermes exits 0 with
# empty stdout. Distinct from real hermes exit codes so run() can route
# the error path to a clearer status than the legacy "parse_error".
DISPATCH_ANOMALY_EMPTY_STDOUT = 99


def parse_hermes_model_marker(compiled_prompt: str) -> tuple[str, dict[str, str] | None]:
    """Strip prompt-builder's HERMES-MODEL marker and return its JSON payload."""
    payload: dict[str, str] | None = None

    def _replace(match: re.Match[str]) -> str:
        nonlocal payload
        try:
            parsed = json.loads(match.group(1))
        except json.JSONDecodeError:
            return ""
        if isinstance(parsed, dict):
            payload = {str(k): str(v) for k, v in parsed.items() if v is not None}
        return ""

    stripped = MODEL_MARKER_RE.sub(_replace, compiled_prompt).strip() + "\n"
    return stripped, payload


def compile_with_prompt_builder(task: str, heartbeat: "Heartbeat | None" = None,
                                slug: str | None = None) -> tuple[str, dict[str, str] | None]:
    """Compile the Cal task through prompt-builder.py and honor HERMES-MODEL."""
    cmd = [
        sys.executable,
        str(PROMPT_BUILDER_PATH),
        "--agent", "cal",
        "--task-type", "research",
        "--task", task,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "prompt-builder failed").strip())
    prompt, model_payload = parse_hermes_model_marker(result.stdout)
    if heartbeat is not None:
        heartbeat.emit("prompt_builder_compile", status="ok", details={
            "slug": slug,
            "agent": "cal",
            "task_type": "research",
            "model": model_payload,
        })
    return prompt, model_payload


def _model_to_cli_args(model_payload: dict[str, str] | None) -> tuple[list[str], dict[str, str]]:
    """Convert prompt-builder model payload into hermes -z CLI args and env."""
    if not model_payload:
        return [], {}
    args: list[str] = []
    env: dict[str, str] = {}
    provider = model_payload.get("provider")
    model = os.environ.get("CAL_DISPATCH_MODEL_OVERRIDE") or model_payload.get("model")
    if provider:
        args += ["--provider", provider]
    if model:
        args += ["--model", model]
        env["HERMES_INFERENCE_MODEL"] = model
    base_url = model_payload.get("base_url")
    if base_url:
        env["CUSTOM_BASE_URL"] = base_url
    return args, env


def dispatch_cal(prompt: str, skills: list[str] | None = None,
                 heartbeat: "Heartbeat | None" = None,
                 slug: str | None = None,
                 model_payload: dict[str, str] | None = None) -> tuple[int, str, str]:
    """Spawn Cal via hermes -z and return (returncode, stdout, stderr).

    Empty-stdout-on-exit-0 is treated as a dispatch anomaly. The model payload
    comes from prompt-builder.py's HERMES-MODEL marker and is threaded into the
    dispatch command for HR-2 companion compliance.
    """
    import time as _time
    skills_list = skills if skills is not None else REQUIRED_SKILLS
    model_args, model_env = _model_to_cli_args(model_payload)
    cmd = ["hermes", "-z", prompt] + model_args + ["--skills", ",".join(skills_list), "--yolo"]

    started = _time.monotonic()
    env = os.environ.copy()
    env.update(model_env)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300, check=False, env=env)
    wall = _time.monotonic() - started

    if result.returncode == 0 and not (result.stdout or "").strip():
        if heartbeat is not None:
            heartbeat.emit(
                "dispatch_anomaly",
                status="empty_stdout_on_success_exit",
                details={
                    "slug": slug,
                    "model": model_payload,
                    "stderr": (result.stderr or "")[:500],
                    "wall_seconds": round(wall, 3),
                },
            )
        return DISPATCH_ANOMALY_EMPTY_STDOUT, result.stdout, result.stderr

    return result.returncode, result.stdout, result.stderr


class EmptyCalOutputError(ValueError):
    """Raised when Cal stdout is empty or whitespace-only."""


def parse_cal_json_output(stdout: str) -> dict[str, Any]:
    """Extract JSON from Cal's stdout.

    Cal may return just the JSON or wrap it in a markdown fence.
    Raises EmptyCalOutputError if the input is empty/whitespace-only
    (a distinct failure mode from "output present but unparseable").
    """
    text = (stdout or "").strip()
    if not text:
        raise EmptyCalOutputError("Cal produced no output")
    # Try bare JSON first
    if text.startswith("{"):
        return json.loads(text)

    # Try code fence
    import re
    m = re.search(r"```(?:json\s*\n)?(.*?)```", text, re.DOTALL)
    if m:
        return json.loads(m.group(1).strip())

    # Last-ditch: find the first and last braces
    first = text.find("{")
    last = text.rfind("}")
    if first >= 0 and last > first:
        return json.loads(text[first:last + 1])

    raise ValueError(f"Could not parse JSON from Cal output (first 200 chars: {text[:200]})")


def run(candidate_json_path: str, output_artifact_path: str,
        dry_run: bool = False, page_content_override: str | None = None) -> int:
    """Main entry point. Returns exit code.

    Mock mode: when CAL_DISPATCH_MODE=mock is set in the environment, the
    function skips the live `hermes -z` dispatch entirely and copies the
    good fixture artifact (tests/fixtures/research_artifact_good.json) to
    --output-artifact with the candidate's slug substituted. This is the
    smoke-test toggle documented in scripts/smoke.sh; it lets the end-to-end
    pipeline run when Cal dispatch is environmentally blocked.
    """
    import os as _os
    hb = Heartbeat()

    # Load candidate (still required so we can fill target_slug correctly).
    try:
        candidate = load_candidate(Path(candidate_json_path))
    except (json.JSONDecodeError, FileNotFoundError) as exc:
        hb.emit("research_dispatch", status="error", error=f"load candidate: {exc}")
        return 3

    slug = candidate.get("slug", candidate.get("target_slug", "unknown"))
    page_type = candidate.get("page_type", "unknown")

    if _os.environ.get("CAL_DISPATCH_MODE") == "mock":
        fixture = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "research_artifact_good.json"
        if not fixture.exists():
            hb.emit("research_dispatch", status="mock_fixture_missing",
                    error=str(fixture), details={"slug": slug})
            return 3
        artifact = json.loads(fixture.read_text(encoding="utf-8"))
        artifact["target_slug"] = slug
        artifact["researched_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        artifact["researcher"] = "cal-subagent-mock"
        try:
            output = Path(output_artifact_path)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
        except OSError as exc:
            hb.emit("research_dispatch", status="write_error", error=str(exc))
            return 3
        hb.emit("research_dispatch", status="mock_ok",
                details={"slug": slug, "fixture": str(fixture)})
        return 0

    # Build query plan
    if page_content_override is not None:
        page_content = page_content_override
    else:
        try:
            page_content = get_page_content(slug)
        except auto_enrich_lib.GBrainCLIError as exc:
            hb.emit("research_dispatch", status="error", error=f"gbrain get: {exc}")
            return 3

    query_plan = research_strategy.build_query_plan(candidate, page_content)
    schema_text = load_schema_text()

    # Compose task, then compile it through prompt-builder.py for Cal routing.
    task = compile_cal_prompt(slug, query_plan, page_content, schema_text)
    try:
        prompt, model_payload = compile_with_prompt_builder(task, heartbeat=hb, slug=slug)
    except RuntimeError as exc:
        hb.emit("research_dispatch", status="prompt_builder_error",
                error=str(exc)[:500], details={"slug": slug})
        return 1

    if dry_run:
        model_args, _ = _model_to_cli_args(model_payload)
        print("=== PLANNED CAL PROMPT (dry-run) ===")
        print(f"candidate: {slug}")
        print(f"page_type: {page_type}")
        print(f"queries planned: {len(query_plan)}")
        print(f"skills loaded: {','.join(REQUIRED_SKILLS)}")
        print(f"model payload: {json.dumps(model_payload, sort_keys=True)}")
        print("dispatch cmd: hermes -z <prompt> "
              f"{' '.join(model_args)} --skills {','.join(REQUIRED_SKILLS)} --yolo")
        print("---")
        print(prompt)
        print("---")
        hb.emit("research_dispatch", status="dry_run", details={
            "slug": slug,
            "page_type": page_type,
            "queries_planned": len(query_plan),
            "skills": REQUIRED_SKILLS,
            "model": model_payload,
        })
        return 0

    # Dispatch Cal
    returncode, stdout, stderr = dispatch_cal(prompt, heartbeat=hb, slug=slug,
                                              model_payload=model_payload)
    if returncode == DISPATCH_ANOMALY_EMPTY_STDOUT:
        # dispatch_cal already emitted a `dispatch_anomaly` event; emit a
        # research_dispatch event with the clearer cal_no_output status so
        # downstream tooling sees both signals.
        hb.emit("research_dispatch", status="cal_no_output",
                error="Cal exited 0 with empty stdout (dispatch anomaly)",
                details={"slug": slug, "exit_code": returncode,
                         "stderr": (stderr or "")[:500]})
        return 1
    if returncode != 0:
        hb.emit("research_dispatch", status="dispatch_error", error=stderr[:500], details={
            "slug": slug,
            "exit_code": returncode,
        })
        return 1

    # Parse artifact
    try:
        artifact = parse_cal_json_output(stdout)
    except EmptyCalOutputError as exc:
        # Defensive: dispatch_cal should have already caught this above, but
        # surface it cleanly if it slips through (e.g. tests that bypass
        # dispatch_cal and feed empty stdout straight into run()).
        hb.emit("research_dispatch", status="cal_no_output",
                error=str(exc), details={"slug": slug})
        return 1
    except (json.JSONDecodeError, ValueError) as exc:
        hb.emit("research_dispatch", status="parse_error",
                error=f"Cal JSON parse: {exc}", details={"slug": slug})
        return 2

    # Validate
    errors = validate_artifact(artifact)
    if errors:
        hb.emit("research_dispatch", status="schema_validation_failed",
                error=" | ".join(errors), details={"slug": slug})
        return 2

    # Enforce researcher tag, timestamp, and prompt-builder model attribution.
    artifact["researcher"] = "cal-subagent"
    artifact["researched_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if model_payload:
        artifact["model"] = "/".join(
            part for part in (model_payload.get("provider"), model_payload.get("model")) if part
        )
        artifact["model_payload"] = model_payload

    # Write artifact
    try:
        output = Path(output_artifact_path)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
    except OSError as exc:
        hb.emit("research_dispatch", status="write_error",
                error=f"Could not write artifact: {exc}")
        return 3

    hb.emit("research_dispatch", status="ok", details={
        "slug": slug,
        "claims_count": len(artifact.get("claims", [])),
        "queries_run": len(artifact.get("queries_run", [])),
        "artifact_path": str(output),
    })
    return 0


def main():
    parser = argparse.ArgumentParser(description="Dispatch Cal to research a candidate page")
    parser.add_argument("--candidate-json", required=True, help="Path to candidate JSON from sensor")
    parser.add_argument("--output-artifact", required=True, help="Path to write research artifact JSON")
    parser.add_argument("--dry-run", action="store_true", help="Print planned prompt without dispatching")
    args = parser.parse_args()

    sys.exit(run(args.candidate_json, args.output_artifact, dry_run=args.dry_run))


if __name__ == "__main__":
    main()
