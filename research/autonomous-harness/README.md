# Autonomous harness control: executable research slice

This package connects approved harness selection to the existing Workroom host
driver and demonstrates durable procedural memory, checked CPU specialists,
task-global continuation and fixed-evaluator candidate selection. It is original
code with synthetic fixtures. It does not copy private project source.

The integration base is orchestration PR38, commit
`14ec58e854b6705498d233e796b4e243605b2dd5`. The optional hook uses the existing
`runDriver` execution, reservation, recovery and submission path. It does not add
a second provider client or automatically enable a production workload.

## Implemented pieces

| Piece | Source | Behavior |
|---|---|---|
| Driver admission | `scripts/orch/harness-contract.ts` at repository root | Host-approved bundle/model/project/context, exact bytes and task binding |
| Existing driver integration | `scripts/orch/driver.ts` at repository root | Persisted harness pin; reuse on retry; explicit project binding; bounded hook waits |
| Session reference | `session_runtime.py` | SQLite effect intent before send, task-global fuel/cost/deadline, UNKNOWN hold, quiesce/checkpoint/continuation |
| Memory | `procedural_memory.py` | Episode, candidate, validation, scoped retrieval, actual-use receipts, expiry/retraction/supersession |
| Specialist | `model_tools.py` | Bounded BFS/Dijkstra/Bellman–Ford selection; task/tool/plan digest checks; independent certificate verifier |
| Integration demo | `end_to_end.py` | Actual tool → checked experience → durable procedure → later task → continuation → semantic fallback |
| Candidate experiment | `rsi_campaign.py` | Frozen evaluator/candidate, validation selection, separate-process confirmation, strong baseline gate |
| Lean | `formal/` | 16 obligation groups, 62 checked theorem declarations; explicit refinement gaps |

The public package is a working local prototype and an opt-in driver API seam.
Remote memory-service IPC, arbitrary generated-tool execution, a D1 continuation
service, GPU jobs and a learned improver are future adapters/research units.

## Run

From repository root, with its existing Node dependencies installed:

```bash
node --import tsx --test tests/harness-control.test.ts tests/orch-driver.test.ts
node node_modules/typescript/bin/tsc -b
node node_modules/eslint/bin/eslint.js scripts/orch/harness-contract.ts scripts/orch/driver.ts tests/harness-control.test.ts
cd research/autonomous-harness
python -B -m unittest discover -v
python -B end_to_end.py
python -B demo_transfer.py
python -B model_tools.py --demo --output evidence/solver-replay.json
python -B rsi_campaign.py --output evidence/campaign-replay.json
python -B run_mutation_controls.py
python -B validate.py
```

Python 3.12 uses only its standard library. No API key is needed. The `tsx` CLI's
IPC server was unavailable in the development environment; `node --import tsx`
ran the actual test files without that CLI server.

With the pinned Lean 4.19.0 toolchain available:

```bash
cd formal
python scripts/verify.py --lake /absolute/path/to/lean-4.19.0-linux/bin/lake
```

The downloaded toolchain, `.lake`, SQLite files and Python caches are not part of
the deliverable. Formal logs and source-bound receipts are included.

## Driver API

```typescript
const harness = createApprovedHarnessHook(
  async signal => loadHostApprovedAdmission(signal),
  async (task, admission, signal) => selectBundleModelAndValidatedMemory(task, admission, signal),
);
const summary = await runDriver(options, { ...existingDriverIO, harness });
```

The two callback names illustrate host integration; they are not built-in APIs.
The selector is advisory. It must use a trusted retrieval service and cannot
acquire an unmetered provider/tool path. The actual proposed JSON is checked
against `harnessAdmissionSchema`; its project must also match an explicit driver
project. A saved pin is checked again, not regenerated on resume. Host-side
deadline racing bounds waiting for a selector that ignores cancellation, but
cannot kill external work already started by a callback.

The memory snapshot's hash binds the selected bytes. Authentic source/evaluator
identity is a service responsibility. The TypeScript hook does not prove that
arbitrary caller-supplied memory is true, current or independently reviewed.

## Specialist API

```python
from model_tools import compile_specialist, execute_plan, verify_certificate

task = {"schema_version": "1", "n": 4,
        "edges": [[0, 1, 1], [1, 3, 2], [0, 2, 1], [2, 3, 8]],
        "source": 0, "target": 3}
plan = compile_specialist(task)
result = execute_plan(task, plan)
assert verify_certificate(task, result["certificate"])["valid"]
assert result["certificate"]["cost"] == 3
```

The original input and certificate are passed to a separate checker. A shortest
path certificate contains a valid path and nonnegative integer potentials whose
edge inequalities telescope to a lower bound. A path attaining that bound is
optimal. An unreachable certificate is a source-containing, target-excluding
set closed under outgoing edges. These mathematical claims are modeled in Lean;
the Python-to-Lean parser/checker refinement is still open.

## Measured results

| Experiment | Observed result | Interpretation |
|---|---|---|
| Python suite | 84 tests passed | Memory, solver, campaign, session and integrated synthetic contracts |
| Driver + existing driver suite | 36 tests passed | Actual optional hook and existing recovery/submission regressions |
| Lean | 62 theorem declarations checked in 16 groups | 25 general theorems and 37 witnesses; foundation dependencies `propext`, `Quot.sound` only |
| Procedure transfer | 6/6 in all three arms; calls 30 / 30 / 24 | Scripted protocol reuse, not LLM accuracy gain; source/validation/retrieval cost is additional |
| Solver comparison | 48/48 per condition; Dijkstra and typed compiler both 62,497 work units | No measured gain over the strong algorithm baseline |
| Candidate campaign | 24/24 confirmation; selected policy and strong baseline both 10,438 work units | `promotion_eligible=false`; active version unchanged |

Six targeted predicate-removal mutants were killed by semantic assertion
failures: four memory admission controls and two certificate/plan controls.
Actual regression RED logs also cover driver admission, project binding, hook
deadline, exact validation identity, stale validation/evidence, and immutable
input/result bytes. Cross-lane review found concrete issues that were fixed and
rechecked; it does not replace repository review gates.

`evidence/end-to-end.json`, `evidence/python-tests.txt`,
`evidence/bridge-green.txt`, the memory/model receipts and
`formal/evidence/validation.json` record the observations. Timing categories may
overlap; full campaign time is not the sum of inclusive sub-times. Algorithm
work units and modeled tool boundaries are not CPU cycles, actual MCP calls or
money. Provider calls and GPU jobs were zero.

Some console logs contained trailing display whitespace. Their text views were
normalized for repository formatting; `evidence/raw-log-preservation.json`
retains the exact original text and SHA-256. No test outcomes or messages were
changed. Formal sources use normalized line endings and were checked again in
the published package after that formatting change.

## What remains an experiment

The goal is to improve verified completion under a full resource budget through
better tools, procedures, model choices and improvers. This package does not
establish general project accuracy gains, learned routing, unbounded RSI,
production multi-host safety or remote exactly-once effects. It gives those
claims concrete interfaces, negative controls, reference proofs and experiments
that can reject an unhelpful candidate.

See `SOURCE_RESEARCH.ko.md` for LoopedWSP's actual comparison/cost conditions,
small-model roles, training labels, OOS evaluation, CPU/GPU/MCP resource design,
cost amortization and the proposed I0/I1 meta-improver experiment.
