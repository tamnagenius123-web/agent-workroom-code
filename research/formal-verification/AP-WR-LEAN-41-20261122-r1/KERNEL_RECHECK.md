# Kernel execution and trust boundary

Contract: AP-WR-LEAN-41-20261122-r1. Evidence is in [LEAN_BUILD_RECEIPT.json](LEAN_BUILD_RECEIPT.json), [PROOF_AXIOMS.tsv](PROOF_AXIOMS.tsv), and [evidence/axiom-audit.log](evidence/axiom-audit.log).

## Executed results

| Operation | Result | Recorded duration |
|---|---|---|
| Clean build with Lean 4.19.0: lake clean, lake build | Exit 0 | Build 5.067 s |
| Explicit #check and #print axioms for every main-package theorem declaration | Exit 0; 206 declarations audited | 1.050 s |
| Matching lean4checker --fresh Workroom.All | Exit 0 | 115.889 s |
| Separate non-author review modules | Compiler accepted; receipts in evidence/independent_review_*.json | See individual receipts |
| Selected Gungri EvidenceVersion module, Lean 4.24.0 | Build and matching fresh check exit 0 | Fresh check 243.891 s |

The main package has no Mathlib dependency. Its pinned toolchain is leanprover/lean4:v4.19.0, Lean release commit 6caaee842e94. The matching lean4checker source is leanprover/lean4checker at e11f65c651edd58d68ba260015d2bfde5102cd7f (v4.19.0). Installation evidence records the downloaded archive's SHA256 and the executable's SHA256. Those are locally computed artifact identities, not a claim of publisher-signed checksum verification.

The whole-package fresh check completed at approximately 2026-11-22 19:49 KST. Its empty output log is intentional: the successful process exit is captured in the build receipt. A blank log by itself would not be evidence of success.

## What the count means

The 206 declarations include theorems, constructive witnesses, deliberately bad alternate implementations, supporting lemmas and adversarial countermodels. They are not 206 independent contract obligations. Thirty-eight ID-named main results instantiate the unchanged original Spec predicates in executable reference models. T00 additionally supplies finite history proofs and countermodels; X01 supplies a formal refutation of a disclosed source projection; X03 supplies an explicitly conditional fair-fuel theorem. These are not 41 completed production correctness proofs.

Workroom/Spec.lean is an exact extraction of the original Lean code fence. Its original SPECIFICATION_ONLY commentary remains preserved; it is not used as evidence that any theorem has been proved. Proof terms live in the other modules and are tied to the receipt's source hashes. A source definition of a proposition is never counted as a proof.

## Axiom audit

Every main declaration has a complete row in PROOF_AXIOMS.tsv. Each dependency list is either empty or a subset of:

- propext
- Classical.choice
- Quot.sound

No sorryAx, custom postulated axiom, or native-computation axiom appears in the audited dependency lists. The proof modules do not use sorry, admit, or native_decide as proof shortcuts. Standard Lean axioms remain explicitly disclosed; this is not a claim that every declaration is axiom-free.

Provider truthfulness, storage serialization, clocks, external registry independence, source completeness and schedule fairness are model/refinement premises. They have not been added as secret Lean axioms to force operational acceptance. The row-level assumptions and blockers must be read alongside the axiom list: a small axiom list does not establish a model's fidelity to production.

## Reproduce the main package

Install the pinned Lean release and place its lean and lake binaries on PATH. Obtain and build the matching checker at the pinned commit using that same toolchain. Then run:

```sh
python3 scripts/verify.py --clean --checker /absolute/path/to/lean4checker
```

Without the checker, the same script can rebuild and audit axioms:

```sh
python3 scripts/verify.py --clean
```

That second command deliberately records fresh_kernel_recheck as null; it must not be presented as a fresh-kernel pass. The script rejects a Lean version other than 4.19.0 and rejects unapproved axiom names. The delivered receipt records the full successful run with the checker.

The checker reconstructs declarations through Lean's kernel in a fresh context. This is a useful recheck independent of normal imported-environment trust, but it is not a separately implemented proof kernel, an independently maintained logic, or human certification. The non-author agent reviews are a different layer of evidence and are described in INDEPENDENT_REVIEW.md.

## Gungri reuse boundary

The selected donor module is pinned at PR80 head 128cb79f4901188888b2117b32a252d4cc3942fc, not silently attributed to main. Its Lean release is 4.24.0, release commit 797c613eb9b6d4ec95db23e3e00af9ac6657f24b; Mathlib is f897ebcf72cd16f89ab4577d0c826cd14afaafc7; its matching checker is da26eb05e9959402afcb9bd6dfe5dc4f700f70d6.

Five EvidenceVersion theorems were built, axiom-audited and freshly checked. Every dependency list is empty. Admission.lean was read but was not compiled as part of this donor recheck. No result for the entire Gungri package, Nanoda, or Workroom implementation refinement is inherited from that selected-module success. See reports/GUNGRI_SELECTED_RECHECK.md and evidence/gungri_selected_recheck.json for exact names and commands.

## Receipt integrity

SOURCE_MANIFEST.json records immutable repository/blob identities and compiler/dependency versions. SHA256SUMS pins the delivered package files. scripts/validate_package.py checks proof-source hashes against the recorded build, all main theorem axiom rows, the 41-item catalog and runtime log identities. Runtime and reviewer supplements retain their own receipts; they are not silently added to the main 206 declaration count.
