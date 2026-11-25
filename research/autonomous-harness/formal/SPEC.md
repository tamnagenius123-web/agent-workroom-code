# Autonomous harness contract kernel v0.1

Date: 2026-11-25. Toolchain: `leanprover/lean4:v4.19.0`.

Integration reference: Workroom PR38 head `14ec58e854b6705498d233e796b4e243605b2dd5`. This is a read-only design pin, not a statement that PR38 includes this package, that its head is current, or that production deployment has been accepted.

## 1. Claim and trust boundary

This package defines and checks a small contract kernel for a harness that can change its plan, tools, procedural memory, and next-run bundle while preserving a task's global limits. A controller may propose changes. The modeled admission functions decide which changes enter the reference state. The candidate is not itself trusted to assert that its evidence is valid.

There are three distinct kinds of conclusion:

- **REFERENCE_PROVED**: Lean checks a proposition about the definitions here, with the listed premises and the transitive axiom audit in the receipt.
- **RUNTIME_REFINEMENT_OPEN**: the production/Python implementation has not been proved to realize those definitions, including parsing, persistence, concurrency, identities, hashes, and external services.
- **EMPIRICAL_OPEN**: accuracy, transfer, latency, learning value, cost savings, and cumulative improvement on future tasks require experiments. The conditional cumulative theorem does not discharge these premises.

The root evidence receipt reports the actual compilation and audits. No source uses an authored proof placeholder or custom axiom. The accepted axiom set is the standard Lean foundation subset `propext` and `Quot.sound`; the auditor rejects any additional dependency. The standard compiler/kernel, its pinned imported library, OS/hardware execution, and authentic toolchain distribution remain trusted. Fresh source elaboration uses the same Lean implementation; it is not an independent implementation or a proof of the compiler.

## 2. Six modules and their interfaces

| Module | State / function | Its purpose |
|---|---|---|
| Session | `Session`, `reserve`, `step`, `continueRun`, `ProgressTrace`, `Effect` | Preserve global limits across successor runs and keep ambiguous external effects ambiguous. |
| Tools | `Capability`, `Allows`, `CertifiedTool`, `composeTool` | Separate permission to call a tool from a proof of the tool's pure semantic contract. |
| Memory | `Memory`, `MemoryQuery`, `MemoryEligible`, `retrieve` | Filter ranked experience against provenance, project scope, validity, tool compatibility, and current permissions. |
| Promotion | `Candidate`, `Evaluation`, `ReleaseContract`, `Registry`, `promote` | Bind admission to the exact candidate and current contract while preserving already active run pins. |
| Certificates | `Walk`, potential/cut theorems, `cumulative_improvement` | Connect verifiable tool results to semantic guarantees; state the actual premise needed for cumulative improvement. |
| Witnesses | Ground examples and deliberately weak alternative rules | Demonstrate accepted behavior, rejected behavior, and failures of relaxed rules. |

Digests and versions are abstract natural-number identifiers. Equality of these IDs does not prove canonical serialization, cryptographic collision resistance, signature validity, or that a running binary equals its registered manifest. These are explicit external obligations.

## 3. Task-global budget and continuation

The reference invariant is:

\[
spent+holds\le cap,\quad usedSteps+localFuel\le maxSteps,\quad usedContinuations\le maxContinuations.
\]

`holds` includes unresolved liabilities. `reserve` admits a reservation only when the new sum remains within the cap. It is a reservation accounting statement, not a statement about an external provider's actual invoice. There is no settlement model in this package.

`step` requires an uncanceled, nonquiescing run, positive local fuel, and a time before the existing deadline. It consumes one global step and one local fuel unit. `continueRun` requires quiescing, no cancellation, exact checkpoint epoch and event sequence, the existing deadline, a remaining continuation allowance, and enough remaining global steps for one transition plus the successor's local fuel.

A successful continuation changes the bundle, local fuel, epoch, event sequence, and continuation counter. It preserves the global budget, spent amount, holds, maximum steps, and original deadline. Starting a new run therefore cannot refill the task's global budget. `trace_preserves` proves the corresponding invariant for an arbitrary finite chain of modeled progress actions. `trace_length_bounded` proves that its length is at most the initial remaining global steps.

This finite-trace bound does not prove wall-clock termination. Waiting on a provider, reservation-only loops, schedulers, arbitrary host loops, fairness, and recovery from external failures are not `ProgressTransition` constructors. The deployed runtime must route every modeled action through the guard and enforce its own wall-clock deadline.

`Effect.state = unknown` cannot be dispatched. Ownership takeover increments an epoch while retaining the same logical effect identifier, request digest, hold, and uncertainty. This prevents the reference transition from treating a timeout as a fresh request. Exactly-once external effects are not proved; the broker and provider semantics must supply the necessary guarantees.

## 4. Tool permissions and semantic certificates

`Allows grant requirements` checks set-like membership of every required capability. Lists may contain duplicates without changing authorization. A compound tool requires the concatenated requirements of its components; the authorization theorem reduces admission of the compound to admission of both parts. CPU and GPU here are **capability labels**, not a resource scheduler, VRAM bound, or spend approval.

`CertifiedTool α β` contains a pure function, precondition, postcondition, required capabilities, and a proof of its postcondition whenever its precondition holds. `composeTool` additionally requires a bridge showing that the first tool's postcondition establishes the second tool's precondition. The composition theorem proves an existential intermediate result satisfying both contracts.

This bridge is material: two individually correct tools do not compose safely if the second expects an input property not delivered by the first. The theorem does not establish that a Python process, an MCP server, or a remote model implements the stored pure function. For an effectful tool, a future refinement must model requests, receipts, resource consumption, cancellation, and partial/UNKNOWN outcomes.

## 5. Procedural memory under an open world

The relevance ranking can be arbitrary. Admission happens **after** ranking and checks:

1. The source digest is in the query's trusted source set.
2. Project and task-family match.
3. The recorded tool version equals the current version, or the exact directional pair is in a reviewed compatibility list.
4. The current policy version matches.
5. `now < validUntil`, the record is reviewed, it is not retracted, and it is not sealed.
6. The current grant covers every capability the procedure requires.

`retrieval_sound` proves that every returned record satisfies the entire conjunction. The scope, sealed-memory exclusion, and tool-compatibility corollaries make important parts directly auditable. A cross-version positive example requires an explicit compatibility pair; merely changing a version string is rejected.

The metadata and compatibility list are supplied by a trusted catalog/reviewer. Time is supplied by a trusted clock. The theorem does not say that a claim remains true until its expiry: facts may become false earlier in an open world. Retractions, evidence refresh, source authenticity, revocation propagation, compatibility proof quality, and query-time context checks are still necessary. Exact policy version equality is conservative; policy migration is not implemented.

A useful runtime memory record should also bind input domain, observed outcome, failure modes, tool/schema digest, provenance trace, evidence dates, and an independently measured utility estimate. A retrieved procedure is advice/evidence; it must not silently become a current authorization or an evaluator's sealed answer. Retrieval utility and causal effects on long tasks require controlled experiments.

## 6. Candidate, evidence, and champion

Candidate, evaluation, release contract, and registry are separate types. A candidate becomes the registry's champion only through `promote`, which checks:

- Expected registry champion and revision, plus candidate parent binding.
- Candidate and evidence policy digests against the current registry policy.
- Exact candidate, contract, evaluator, and environment bindings.
- The evidence author matching the candidate author, a distinct allowed reviewer, and a PASS verdict.

The transition increments the registry revision and preserves the existing active run's immutable pin. Updating the default champion is different from changing an already executing task's bundle. The latter requires continuation.

`promotion_sound` proves the checked conditions and resulting state. It does not prove the truth of a PASS verdict. Reviewer identity and independence, evaluator isolation, calibrated statistics, benchmark freshness, protected policy ownership, and registry transaction linearizability remain outside the theorem. A candidate cannot be trusted to populate its own reviewer's metadata in production.

The deliberately weak gate `badPromote` accepts a PASS whose evidence refers to a different candidate. `pass_label_is_insufficient` is a concrete countermodel to that rule. Merely having a passed report is insufficient for exact-artifact promotion.

## 7. A substantive certified-tool example

The sibling demo `../model_tools.py` implements a checker for finite directed graphs with exact nonnegative integer weights. The Lean model uses `Edges := Nat → Nat → Nat → Prop` and an inductively defined finite `Walk`. A finite Python graph embeds into this more general relation. The checker additionally restricts returned paths to simple paths; Lean's optimality statement ranges over all finite walks.

### Shortest-path certificate

For every edge \((u,v,w)\), require:

\[
p(v)\le p(u)+w,\quad p(source)=0.
\]

By induction over a valid competitor path of cost \(C\), `potential_bound` proves \(p(target)\le C\). If the returned valid path has cost \(C^*=p(target)\), `certified_shortest_path` proves both its validity and \(C^*\le C\) for every valid competitor path. The solver may be an algorithm, a model, generated code, or a specialized small network. The certificate conditions, not the solver's reputation, support the conclusion.

The checker should verify the actual edge chain, exact cost, all edge inequalities, potential domain/length, and task binding. The Python source uses arbitrary-precision nonnegative integers and rejects booleans where integers are required; the Lean proof uses `Nat`. Parser correctness, bounds validation, and the list-to-`Walk` refinement are still OPEN. `task_digest` integrity is a separate artifact-binding obligation. There is no theorem equating the Python function's Boolean return with the Lean premises yet.

### Unreachable certificate

A set \(R\) containing the source, excluding the target, and closed under every outgoing graph edge certifies no path to the target. `closed_cut_contains_path` proves that any path from a vertex in \(R\) stays in \(R\); `certified_unreachable` follows. No complete path search is trusted at verification time, although the checker must scan the graph edges for closure.

### Adversarial certificate

`infeasible_potential_is_not_a_certificate` uses an actual cost-5 path, a potential with source value 0 and target value 9, and a violated edge inequality. A checker omitting that inequality can claim a false lower bound. This is a concrete semantic failure, rather than a gate that merely reasserts a desired Boolean.

## 8. What cumulative RSI would require

`cumulative_improvement` proves:

\[
\left(\forall n,\; S_n+g_n\le S_{n+1}\right)
\Longrightarrow
S_0+\sum_{i<n}g_i\le S_n.
\]

Here \(S\) is the same nonnegative integer-valued target score function across versions and every \(g_n\) is a genuine gain. The proof is induction and arithmetic. It does not prove the premise from development scores, an LLM judge, an optimizer's claims, or a finite benchmark. It also does not allow costs or safety losses to disappear from the score definition.

The arithmetic witness `development_gain_is_not_true_gain` demonstrates a consistent world in which development scores rise from 80 to 90 while a separate target drops from 70 to 60. It is a countermodel to the logical implication “development increase implies target increase,” not an empirical measurement. A deployable RSI gate needs protected task distributions, paired repeated trials, failure/cost accounting, multiplicity control across adaptive search, family-level regression checks, and a new evaluation protocol when the task distribution or evaluator changes.

For a meta-improver, compare the total future target gain produced under the same total search-and-evaluation budget, not the quality of one lucky candidate. Improvement of the improver and improvement of its generated harnesses are separate hypotheses. Finite compute and bounded scores also prevent a claim of unlimited strictly positive guaranteed progress.

## 9. Sixteen concrete obligation groups

All statuses in the reference column apply only to the pinned sources in this package. Every application column identifies work still needed before the corresponding real-system claim can be accepted.

| ID | Obligation and theorem evidence | Reference | Application obligation |
|---|---|---|---|
| K01 | Reservation preserves `spent + holds ≤ cap`: `reserve_preserves`; positive and overflow witnesses. | REFERENCE_PROVED | OPEN: provider liabilities, settlement, price bounds, concurrent reservation path. |
| K02 | A step consumes global fuel and occurs before the deadline: `step_preserves`. | REFERENCE_PROVED | OPEN: all model/tool/host steps pass through the guard; trusted time. |
| K03 | Continuation preserves global cap, holds, deadline, and maximum steps: `continuation_preserves`, `no_global_fuel_refill`. | REFERENCE_PROVED | OPEN: checkpoint/fence/quiescing transaction refinement and successor uniqueness. |
| K04 | Stale epoch or event sequence is rejected: `stale_checkpoint_rejected`; canceled/late witnesses. | REFERENCE_PROVED | OPEN: authoritative CAS, actual cancellation generation, late external results. |
| K05 | Any modeled progress trace has preserved invariants and bounded length: `trace_preserves`, `trace_length_bounded`; reset countermodel. | REFERENCE_PROVED | OPEN: action coverage, scheduling/waiting liveness, wall-clock termination. |
| K06 | Takeover retains effect identity/hold and cannot reissue UNKNOWN: `unknown_never_reissued`, `takeover_preserves_identity`; reset countermodel. | REFERENCE_PROVED | OPEN: durable request-before-send and provider/broker effects. |
| K07 | A composition is permitted exactly when both requirement lists are permitted: `allows_composition`, `tool_capability_composition`. | REFERENCE_PROVED | OPEN: tool declarations, authorization mapping, CPU/GPU quota enforcement. |
| K08 | Semantic contracts compose with an explicit post-to-pre bridge: `tool_semantic_composition`. | REFERENCE_PROVED | OPEN: executable adapter/IR compiler refinement; effects and failures. |
| K09 | Every retrieved record has admitted provenance/project/family and excludes sealed records: `retrieval_sound`, scope/sealed corollaries. | REFERENCE_PROVED | OPEN: catalog authenticity, complete retraction propagation, sealed storage isolation. |
| K10 | Retrieval enforces current policy, expiry, capabilities, and reviewed tool compatibility: `retrieval_sound`, `retrieval_compatible_tool`, rejection witnesses. | REFERENCE_PROVED | OPEN: clock trust, open-world truth, semantic compatibility proof, useful retrieval. |
| K11 | Promotion binds exact candidate/contract/evaluator/environment/current policy: `promotion_sound`, `mismatched_candidate_rejected`; wrong-artifact countermodel. | REFERENCE_PROVED | OPEN: content hashes, manifests, evidence authenticity and truth, evaluator isolation. |
| K12 | Promotion requires allowed distinct reviewer and expected registry revision, while retaining active run pin: `author_cannot_self_promote`, `promotion_sound`; stale/self-review witnesses. | REFERENCE_PROVED | OPEN: identity authority, independent review, linearizable registry and protected policy. |
| K13 | Edge-local potential inequalities imply a lower bound on every finite path: `potential_bound`. | REFERENCE_PROVED | OPEN: Python parser, graph/potential representation, checker completeness. |
| K14 | A valid tight returned path is globally shortest: `certified_shortest_path`, `graph_optimal`; infeasible-potential countermodel. | REFERENCE_PROVED | OPEN: Python `valid=true` implies all Lean premises; task digest binding. |
| K15 | A closed source-containing target-excluding cut proves unreachability: `certified_unreachable`. | REFERENCE_PROVED | OPEN: parsed cut membership and edge closure refinement. |
| K16 | Genuine per-step improvement on one target accumulates: `cumulative_improvement`; development/target countermodel. | REFERENCE_PROVED, CONDITIONAL | OPEN: target/generalization evidence, uncertainty, adaptive search bias, compute budget, meta-improver benefit. |

The machine-readable mapping is `PROOF_OBLIGATIONS.tsv`. These 16 groups apply only to this reference package and do not reclassify prior project acceptance decisions.

## 10. Integration with PR38

Use the existing Workroom run supervisor, lease/fence, reservation/settlement path, source-pinned evidence, and receipts as the implementation seam. This package proposes reference contracts for the new behavior; it does not duplicate provider clients or authorize an alternate unmetered execution path.

| Existing/next component | Required connection to this kernel |
|---|---|
| Task session + run supervisor | Project runtime snapshots into `Session`; preserve the original task's counters, budget, and deadline across successor runs. |
| Execution fence + continuation service | Implement one authoritative transition checking the checkpoint epoch/event sequence and cancel state. Persist unique continuation identity and revoke predecessor dispatch rights in that commit. |
| Effect broker + cost ledger | Preserve logical effect IDs and unresolved holds through ownership changes. Reconcile UNKNOWN instead of resetting it. |
| Tool catalog + typed harness compiler | Bind declared requirements and semantic contracts to exact tool/model/adapter versions. A generated tool is a candidate until independently admitted. |
| Experience ledger + retriever | Build trusted metadata, reviewed compatibility entries, scoped queries, and retraction propagation; rank only within policy-eligible evidence. |
| Evaluation + champion registry | Bind reports to exact candidate and benchmark environment; use current policy and registry CAS. Keep active run pins independent of champion updates. |
| Specialized solver checker | Treat the solver/model as replaceable; retain a fixed independently checked verifier and task binding. |

The next formal step is a refinement map from a minimal actual runtime trace to these states, followed by real transaction/crash/retry tests. Concurrency exploration should include stale controllers, duplicate delivery, cancellation races, lost commit responses, and late provider outcomes. A runtime proof should not simply introduce a hypothesis named “implementation is correct” and report deployment correctness.

## 11. Validation and reproducibility

The package has no external Lean package dependencies. The official Lean 4.19.0 release was downloaded through an ordinary permitted connection into this isolated lane. The verification script reports version and SHA-256 of the used Lean binary. These hashes record what ran; they are not an independent signature verification of the download.

`evidence/compile_history.md` preserves the earlier failed development attempts. `evidence/validation.json` binds the final successful build, fresh source elaborations, full transitive axiom audit, and source manifest. Generated proof code is checked by Lean, but semantic fidelity of the definitions to the intended system still requires human/specification review.

Primary upstream reference for the toolchain: [Lean v4.19.0 release](https://github.com/leanprover/lean4/releases/tag/v4.19.0). The companion project specification records the broader architecture and source audit; this package proves only its own pinned reference definitions.
