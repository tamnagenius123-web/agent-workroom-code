#!/usr/bin/env python3
"""Build/check the Lean reference kernel and emit an honest source-bound receipt.

Only the Python standard library is used. No network or provider requests.
Fresh source elaboration uses the same Lean kernel, not an independent checker.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "evidence"
MODULES = ["Tools", "Session", "Memory", "Promotion", "Certificates", "Witnesses"]
ALLOWED_AXIOMS = {"propext", "Quot.sound"}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(command: list[str], name: str) -> dict:
    started = datetime.now(timezone.utc).isoformat()
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
    log = result.stdout + result.stderr
    destination = EVIDENCE / f"{name}.log"
    destination.write_text(log)
    return {
        "command": command,
        "started_utc": started,
        "exit_code": result.returncode,
        "log": str(destination.relative_to(ROOT)),
        "log_sha256": sha256(destination),
        "output": log,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lake", help="Path to lake for the pinned Lean 4.19.0 toolchain")
    args = parser.parse_args()
    selected = args.lake or shutil.which("lake")
    if not selected:
        print("BLOCKED: lake is unavailable; no proof validation was performed.", file=sys.stderr)
        return 2
    lake = str(Path(selected).resolve())
    EVIDENCE.mkdir(exist_ok=True)
    source_paths = [ROOT / "WorkroomAutonomy.lean"] + [
        ROOT / "WorkroomAutonomy" / f"{name}.lean" for name in MODULES
    ]
    names: list[str] = []
    source_violations: list[dict] = []
    for path in source_paths:
        source = path.read_text()
        namespace = "WorkroomAutonomy.Witnesses" if path.stem == "Witnesses" else "WorkroomAutonomy"
        names.extend(f"{namespace}.{name}" for name in re.findall(r"^theorem\s+(\w+)", source, re.M))
        for match in re.finditer(r"\b(?:sorry|admit|native_decide|run_meta|unsafe)\b|^\s*axiom\s", source, re.M):
            source_violations.append({"file": str(path.relative_to(ROOT)), "token": match.group()})
    audit = ROOT / "Audit.lean"
    audit.write_text("import WorkroomAutonomy\n\n" + "\n".join(f"#print axioms {name}" for name in names) + "\n")

    records: list[dict] = []
    version = run([lake, "env", "lean", "--version"], "lean-version")
    records.append(version)
    pinned_version = version["exit_code"] == 0 and "version 4.19.0" in version["output"]
    if pinned_version and not source_violations:
        records.append(run([lake, "clean"], "clean"))
        records.append(run([lake, "build"], "build-final"))
        if all(item["exit_code"] == 0 for item in records):
            for name in MODULES:
                records.append(run([lake, "env", "lean", "-DwarningAsError=true", f"WorkroomAutonomy/{name}.lean"], f"fresh-{name}"))
            records.append(run([lake, "env", "lean", "-DwarningAsError=true", "WorkroomAutonomy.lean"], "fresh-root"))
            records.append(run([lake, "env", "lean", "-DwarningAsError=true", "Audit.lean"], "axiom-audit"))

    dependencies: dict[str, list[str]] = {}
    audit_record = next((record for record in records if record["log"] == "evidence/axiom-audit.log"), None)
    if audit_record:
        for match in re.finditer(r"'([^']+)' (?:depends on axioms: \[([^\]]*)\]|does not depend on any axioms)", audit_record["output"]):
            dependencies[match.group(1)] = sorted(x.strip() for x in (match.group(2) or "").split(",") if x.strip())
    audit_complete = set(names) == set(dependencies)
    unexpected = {name: [x for x in values if x not in ALLOWED_AXIOMS]
                  for name, values in dependencies.items() if set(values) - ALLOWED_AXIOMS}
    success = bool(pinned_version and not source_violations and audit_complete and not unexpected
                   and all(record["exit_code"] == 0 for record in records))
    listed_files = source_paths + [audit, ROOT / "lean-toolchain", ROOT / "lakefile.toml",
        ROOT / "lake-manifest.json", ROOT / "README.md", ROOT / "SPEC.md",
        ROOT / "PROOF_OBLIGATIONS.tsv", ROOT / "scripts/verify.py"]
    manifest = {str(path.relative_to(ROOT)): sha256(path) for path in sorted(listed_files) if path.exists()}
    manifest_path = EVIDENCE / "source-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    lean_binary = Path(lake).parent / "lean"
    archive = ROOT / "lean-4.19.0-linux.tar.zst"
    receipt = {
        "schema": "workroom-lean-validation-v1",
        "status": "REFERENCE_CHECKED" if success else "FAILED_OR_BLOCKED",
        "completed_utc": datetime.now(timezone.utc).isoformat(),
        "reference_pr38_head": "14ec58e854b6705498d233e796b4e243605b2dd5",
        "compiler_version": version["output"].strip(),
        "lean_binary_sha256": sha256(lean_binary) if lean_binary.exists() else None,
        "official_release_url": "https://github.com/leanprover/lean4/releases/download/v4.19.0/lean-4.19.0-linux.tar.zst",
        "download_archive_sha256": sha256(archive) if archive.exists() else None,
        "download_authenticity": "Official HTTPS release origin; no independent signature verification was performed.",
        "platform": platform.platform(),
        "python_version": platform.python_version(),
        "source_manifest": str(manifest_path.relative_to(ROOT)),
        "source_manifest_sha256": sha256(manifest_path),
        "source_token_audit_violations": source_violations,
        "theorem_declarations": len(names),
        "theorem_axiom_audit_complete": audit_complete,
        "axiom_allowlist": sorted(ALLOWED_AXIOMS),
        "unexpected_axioms": unexpected,
        "theorem_axiom_dependencies": dependencies,
        "commands": [{key: value for key, value in record.items() if key != "output"} for record in records],
        "claims": {
            "all_local_sources_elaborated_fresh_process": success,
            "all_theorems_transitively_axiom_audited": success,
            "independent_checker": False,
            "production_runtime_refinement": "OPEN",
            "python_checker_refinement": "OPEN",
            "empirical_rsi_gain": "OPEN",
            "deployment_performed": False,
        },
    }
    destination = EVIDENCE / "validation.json"
    destination.write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({"status": receipt["status"], "theorems": len(names),
        "audit_complete": audit_complete, "unexpected_axioms": unexpected,
        "source_violations": source_violations, "receipt": str(destination)}, ensure_ascii=False))
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())
