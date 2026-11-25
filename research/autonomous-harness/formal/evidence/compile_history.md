# Compilation history

All attempts used the official Lean 4.19.0 Linux toolchain in this lane. Development failures are retained separately from the final source-bound receipt.

| Attempt | Observed result | Resolution / evidence |
|---|---|---|
| 01 | Failed: an `EffectState` constructor used Lean's reserved keyword `partial`. Parser recovery generated placeholder-dependent diagnostic declarations. | Renamed the constructor to `partialEffect`. The original console output was inspected but was not saved as a file; this is a written history, not a reconstructed compiler log. |
| 02 | Failed: witness elaboration needed unfolded decidable predicates, corrected record layout, and explicit graph-edge types. | Full actual output in `build-attempt-02.log`. No failed result was accepted. |
| 03 | Successful build after witness fixes, strengthening the shortest-path conclusion, and adding reviewed compatibility/provenance checks. | Full actual output in `build-attempt-03.log`. |
| 04 | Successful build after adding arbitrary progress-trace preservation and length bound, plus stale-registry and inconclusive-verdict witnesses. | Full actual output in `build-attempt-04.log`. |
| Final | See `validation.json`. | Clean build, each source elaborated in a separate new Lean process, all theorem axiom dependencies audited, source hashes recorded. |

The final source audit and transitive axiom audit must be checked independently of this prose. Error-recovery diagnostics in a failed attempt are not proof receipts.
