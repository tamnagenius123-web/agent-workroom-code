# Targeted integration review

Date: 2026-11-25. Reviewer lane: `formal_build`. Files in the implementation clone were read only; fixes were made by the parent implementation lane. This is targeted technical review evidence, not a GitHub approval or a substitute for the repository's independent review gate.

## Scope

Reviewed the new `scripts/orch/harness-contract.ts`, the harness changes in `scripts/orch/driver.ts`, their synthetic tests, and `research/autonomous-harness/session_runtime.py`. The review challenged immutable bindings, restart behavior, project scope, hook deadlines, continuation budget preservation, and UNKNOWN effect handling. It did not examine every server/provider path or validate deployment.

## Findings and resolution

| Finding | Observed failure | Resolution checked |
|---|---|---|
| R1: admission project was not the execution billing project | A harness admitted for `workroom` initially dispatched with the driver's default `orchestrator` project. The supervisor uses the envelope's project in reservation and cost records. | Parent changed the default to the bound project and rejects an explicit different option, including resume. Independent reproduction now passes. |
| R2: a nonreturning selector defeated the driver deadline | With a 10 ms driver limit, a selector returning a permanently pending promise remained pending beyond a 150 ms watchdog. Existing post-await time checks could not run. | Parent added AbortSignal propagation and a host-side abort race for harness calls. The same reproduction now returns within the bound. This does not kill an external process or preempt a synchronous JavaScript loop. |
| R3: checker input was mutable after the ledger input was bound | The ledger recorded `{x:1}`, the tool observed `{x:1}`, but the caller's original dictionary was changed to `{x:2}` during the tool call. A correct identity checker received the changed dictionary and incorrectly accepted result `{x:2}`. | Parent freezes canonical input bytes once and passes independent copies to reservation, tool, and checker. The same reproduction now produces `failed`. |
| R4: checker could rewrite the settled result | The checker received the same result object later used for settlement, allowing its mutations to change stored output after the claimed check. | Parent freezes result bytes before checking and gives the checker a copy. Targeted reproduction confirms changing the checker's copy to `{x:999}` does not alter the stored `{x:3}`. |

The independent TypeScript reproduction observed **15 tests / 15 pass / exit 0** after the fixes. Its prior run observed **14 pass / 1 fail**, with the nonreturning selector as the failing case; the project fix was already present by the time that run began. The parent separately preserved original red regressions for its fixes. The Python targeted checks both pass after the input/result changes.

Evidence:

- `evidence/runtime-review-reproduction.log` and `runtime-review-inputs.json`: the actual failing hook-deadline run and source hashes.
- `evidence/runtime-review-after-fixes.log` and `runtime-review-after-fixes-inputs.json`: the actual 15/15 run and new source hashes.
- `evidence/session-input-mutation-before-fix.json`: actual inconsistent input/verified-result observation.
- `evidence/session-input-mutation-after-fix.json`: two corrected mutation behaviors and the checked source hash.

`runtime-review-reproduction.test.ts` is a temporary scratch reproduction with absolute local imports. It should not be treated as a portable repository test. The implementation lane's regression tests are the portable test artifacts.

## Remaining boundaries

The saved binding and memory bytes are stable across the tested backpressure restart, and the selector is not rerun. Current admission is checked again before dispatch. Admission currently binds the hash of the entire approval document, so any document change conservatively holds the old run; a future design may separate immutable run admission from current revocation policy and harmless champion-list additions.

The TypeScript hook accepts memory items as data and relies on a trusted retrieval service for provenance, expiry, retraction, and semantic compatibility. A receipt digest binds bytes; it is not an authenticity signature or a proof that the procedure is true. Bundle/interpreter/tool-catalog hashes are manifest bindings in this adapter; the current code does not itself load and verify arbitrary interpreter binaries or model weights from those hashes.

The SQLite reference uses one shared serializing ledger. Reserved, sending, and UNKNOWN effects block new effects and continuation. Continuation decrements the same task's fuel, retains spent units and deadline, fences the predecessor, and records successor/idempotency state in one transaction. No additional violation in those inspected transitions was identified. This is not a claim about multiple independent databases, D1 semantics, provider exactly-once behavior, or truthful external settlement. Tool callables, checkers, and reconciliation callers are trusted local components.

## Relation to Lean

The final Lean package has **62 theorem declarations**, all actually checked and transitively audited, grouped into **16 reference obligations**. The full contract manifest and receipt are separate from these runtime tests. The proof audit permits only `propext` and `Quot.sound`; it reports no additional axiom dependencies.

The Lean modules are a small reference kernel, not a single fully connected production semantics. In particular, `ProgressTrace` counts the modeled `step`/`continueRun` transitions; physical quiescing, reservations between trace steps, scheduler waits, and real storage updates still need a refinement map with preservation of their uncounted transitions. `continueRun` proves global-state preservation for its supplied successor bundle; actual successor admission must also be connected to the promotion/authorization layer. The cumulative RSI theorem explicitly assumes genuine improvements on one fixed target. None of these reference proofs changes the historical **1 PROVED / 34 PARTIAL / 6 REFUTED** Workroom matrix.

After the targeted fixes and checks above, no additional validation scope was opened. Production integration, fresh independent review, and empirical RSI gains remain separate acceptance work.
