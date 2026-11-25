# Workroom Lean proof reference — AP-WR-LEAN-41-20261122-r1

**Classification:** isolated research/reference verification, NOT production implementation.  
**Contract:** `AP-WR-LEAN-41-20261122-r1`; audit source: private docs PR #284 (merged separately).  
**Safety boundary:** this public repository contains only the abstract Lean sources and matching proof receipts. It intentionally **does not publish** private gate, INORI, Socratic AI, or Gungri source snapshots, credentials, the underlying live-code test harness, or the complete private 379-file archive.

The original 41 obligations include full implementation refinement. **Only T01 (uniqueness within one canonical Task snapshot) is contract-level PROVED.** 34 remain PARTIAL; six are REFUTED at explicitly scoped implementation seams in the private evidence review. A clean Lean build establishes properties of the listed abstract model, not multi-host D1, external effects, production authorization, actual model tokenization or provider billing correctness.

## Reproduce abstract proofs

Pinned toolchain: `leanprover/lean4:v4.19.0`, no Mathlib in this Workroom library. Run from this directory, not the root TypeScript project:

```sh
lake build
lake env lean Workroom/AxiomAudit.lean
# Optional fresh checker, matching lean4checker commit e11f65c651edd58d68ba260015d2bfde5102cd7f:
python3 scripts/verify.py --clean --checker /absolute/path/to/lean4checker
```

The last command writes its own `evidence/` logs. Its supplied `LEAN_BUILD_RECEIPT.json` and `PROOF_AXIOMS.tsv` report the already executed, pinned original verification; do not represent them as a new check of this PR until it has been rerun.

## Source and evidence correspondence

The full owner package SHA256 is `07b07da28682aa6bac640d90c6e3ff4b703cde14949781c85a10553f1bb1a357`. Private evidence and the 41-row acceptance matrix are published separately under the private Workroom docs repository in a documentation-only PR. The archive includes private source bytes: do not copy it into this public tree. See `README.md` in the private execution evidence directory and the original contract for the precise proof acceptance rules.

**No production paths, auth, migrations, CI, runtime budget or deployment are changed by this PR.**
