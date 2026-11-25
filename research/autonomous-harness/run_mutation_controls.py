"""Executable RED controls: each targeted omission must fail a semantic test.

The real source is not edited. Each temporary mutant omits one load-bearing
predicate; a failing test must report FAILURE, not an import/setup ERROR.
"""

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


CASES = (
    ("missing_project_family_filter",
     "if (spec.project, spec.task_family) != (ctx.project, ctx.task_family):",
     "if False:  # deliberate mutant: no scope check",
     "test_project_and_task_family_are_hard_filters"),
    ("missing_tool_binding_filter",
     "if any(available.get(t.name) != t for t in spec.tools):",
     "if False:  # deliberate mutant: no exact tool binding check",
     "test_tool_schema_and_version_are_hard_filters"),
    ("missing_validation_time_filter",
     "if not validation[\"checked_at\"] <= ctx.now < validation[\"expires_at\"]:",
     "if False:  # deliberate mutant: expired validation is usable",
     "test_expired_and_future_validation_are_excluded"),
    ("missing_context_budget_filter",
     "if len(proposed_text.encode(\"utf-8\")) > context.max_context_bytes:",
     "if False:  # deliberate mutant: context overflow allowed",
     "test_exact_utf8_budget_includes_complete_rendered_context"),
)


def run_controls() -> dict:
    root = Path(__file__).resolve().parent
    source = (root / "procedural_memory.py").read_text(encoding="utf-8")
    results = []
    for name, before, after, test in CASES:
        if source.count(before) != 1:
            raise RuntimeError(f"mutation anchor is not unique: {name}")
        mutant = source.replace(before, after)
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)
            (target / "procedural_memory.py").write_text(mutant, encoding="utf-8")
            shutil.copyfile(root / "test_procedural_memory.py", target / "test_procedural_memory.py")
            run = subprocess.run([sys.executable, "-m", "unittest", "-v", f"test_procedural_memory.MemoryTests.{test}"],
                                 cwd=target, capture_output=True, text=True, timeout=20, check=False)
        output = run.stdout + run.stderr
        killed = run.returncode == 1 and "FAIL:" in output and "ERROR:" not in output
        results.append({"name": name, "target_test": test,
                        "mutant_sha256": hashlib.sha256(mutant.encode("utf-8")).hexdigest(),
                        "exit_code": run.returncode, "expected_red_observed": killed,
                        "before": before, "after": after, "output": output})
    return {"original_source_sha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
            "controls": results, "all_mutants_killed": all(r["expected_red_observed"] for r in results)}


if __name__ == "__main__":
    report = run_controls()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(0 if report["all_mutants_killed"] else 1)
