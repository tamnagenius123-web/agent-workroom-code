# Workroom autonomous harness: Lean contract kernel

이 패키지는 자율 하네스의 **작은 참조 의미론**을 Lean 4.19.0으로 검사한다. 예산과 전역 실행 연료를 이어받는 continuation, 도구 합성, 출처와 유효기간을 고려한 절차 기억 검색, 증거에 결합된 승격, 증서를 동반하는 최단경로 도구가 대상이다. 실제 Workroom 분산 구현의 검증 완료를 뜻하지 않는다.

## Run

With the pinned Lean toolchain installed:

```sh
lake build
python3 scripts/verify.py --lake /absolute/path/to/lake
```

The verification script performs a clean build, elaborates each source in a new Lean process, audits every theorem's transitive axiom dependencies, and emits a source-bound receipt. It uses Python's standard library only and makes no network calls. `--lake` may point to the official downloaded toolchain in this workspace. A normal checkout should install `leanprover/lean4:v4.19.0` through its usual toolchain manager.

## Read in this order

1. `SPEC.md`: exact claims, assumptions, 16 obligation groups, integration boundaries.
2. `WorkroomAutonomy/Certificates.lean`: a substantive semantic result: a valid returned path meeting a feasible potential is shortest among **all** valid finite paths; a closed cut certifies unreachability.
3. `WorkroomAutonomy/Session.lean`: task-global state, guarded continuation, arbitrary finite progress traces, and UNKNOWN effects.
4. `WorkroomAutonomy/Witnesses.lean`: successful and rejected examples, plus deliberate weak-rule countermodels.
5. `evidence/validation.json`: compiler version, source hashes, commands, results, and all theorem axiom dependencies.

## What the result means

All the checked statements are about the Lean definitions in this package. The finite-trace proof establishes a real bound on the number of modeled progress actions. The graph certificate proof establishes semantic optimality, assuming the graph/path/certificate premises. The capability and promotion proofs establish admission conditions for the explicit reference functions. They do not establish that remote tools obey their declarations, that metadata is authentic, that an evaluator is truthful, that cloud transactions refine the model, or that a new harness improves real-world performance.

This package is a new reference kernel. It does not replace prior project acceptance decisions.

## Files suitable for a repository

Include this README, `SPEC.md`, `PROOF_OBLIGATIONS.tsv`, `lean-toolchain`, `lakefile.toml`, `lake-manifest.json`, root/module Lean sources, `scripts/verify.py`, and small evidence files. Exclude the downloaded toolchain directory/archive and `.lake/`. No provider call, remote write, deployment, or GPU job is executed by this package.
