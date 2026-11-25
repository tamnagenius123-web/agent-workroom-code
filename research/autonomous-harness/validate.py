"""Capture real tests and two narrow mutation controls in a reproducible receipt."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def run():
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    baseline = subprocess.run([sys.executable, "-m", "unittest", "-v", "test_model_tools.py", "test_rsi_campaign.py"],
                              cwd=ROOT, text=True, capture_output=True, env=env, timeout=30)
    source = (ROOT / "model_tools.py").read_text()
    mutants = [
        ("remove_potential_feasibility", "require(potentials[v] <= potentials[u] + w, \"infeasible edge potential\")",
         "require(True, \"infeasible edge potential\")",
         "test_model_tools.CertificateTests.test_rejects_valid_but_nonoptimal_path"),
        ("remove_plan_digest_binding", "if plan.get(\"plan_id\") != _digest(unsigned_plan):", "if False:",
         "test_model_tools.CompilerAndAdmissionTests.test_forged_plan_id_rejected"),
    ]
    results = []
    for name, original, mutation, test in mutants:
        if source.count(original) != 1:
            raise RuntimeError(f"mutation target changed: {name}")
        with tempfile.TemporaryDirectory(prefix="mutation_", dir=ROOT) as directory:
            target = Path(directory)
            (target / "model_tools.py").write_text(source.replace(original, mutation))
            (target / "test_model_tools.py").write_text((ROOT / "test_model_tools.py").read_text())
            result = subprocess.run([sys.executable, "-m", "unittest", "-v", test],
                                    cwd=target, text=True, capture_output=True, env=env, timeout=30)
            log = result.stdout + result.stderr
            killed = result.returncode == 1 and "AssertionError" in log and "FAILED (failures=1)" in log
            results.append({"mutation": name, "test": test, "exit_code": result.returncode,
                            "killed_by_semantic_assertion": killed, "log": log})
    report = {
        "schema_version": "1", "checked_at_utc": datetime.now(timezone.utc).isoformat(),
        "python": sys.version.split()[0],
        "source_sha256": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                          for name in ["model_tools.py", "rsi_campaign.py", "test_model_tools.py", "test_rsi_campaign.py"]},
        "unit_tests": {"command": "python -m unittest -v test_model_tools.py test_rsi_campaign.py",
                       "exit_code": baseline.returncode, "log": baseline.stdout + baseline.stderr},
        "mutation_controls": results,
        "passed": baseline.returncode == 0 and all(r["killed_by_semantic_assertion"] for r in results),
        "scope": "local synthetic CPU implementation; no provider/GPU/deploy; mutants never change original files",
    }
    (ROOT / "validation_receipt.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"passed": report["passed"], "source_sha256": report["source_sha256"],
                      "mutants_killed": sum(r["killed_by_semantic_assertion"] for r in results)}, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(run())
