# Bounded execution, independent evidence, and host driver

This change connects the existing task, execution, context, budget, and verifier
receipt authorities. It does not deploy a worker, change a wallet cap, approve a
task, or establish a live provider result. Source reconciliation is against the
adopted WR-TER-RE-20261031-r1 roadmap and the later architecture audit; synthetic
tests are implementation evidence, not Lean proofs or independent GitHub review.

## Independent evaluation

Execution receipts whose verifier is `verifier:g1` describe the execution's own
checks. They do not establish non-author acceptance. `run-evaluation.ts` provides
a separate authenticated reviewer path using the existing `verifier_receipts`
table (migration 0029).

1. A current posting member with an `agent` or `user` role, other than the execution author, calls
   `POST /api/v1/rooms/room_main/execution-runs/{run}/evaluation/manifest`, with an
   `Idempotency-Key` and exactly `{"schema_version":"1"}`.
2. The host freezes the immutable task's done conditions, run/attempt, spec and
   execution digests, lease epoch, intent revision, cancellation generation,
   actual artifact content and version, generation, reservation, and settled
   actual cost. The immutable billing attempt is recorded separately from a
   recovered execution attempt. Reserved estimate and actual charge remain
   distinct; `actual_exceeds_reserved_hold` reports a reservation overrun, not
   the global wallet's cap status. The caller cannot supply the expected shard set. The manifest is
   stored before evaluation evidence and initially has disposition `HOLD`.
3. The same reviewer submits `POST .../{run}/evaluation`, with a distinct key,
   `manifest_id`, `manifest_digest`, and one shard for every frozen condition.
   Each shard includes `condition_id`, `command`, `exit_code`, and nonempty
   `cases`. Each case has a globally unique `case_id`, terminal `status`, evidence
   text, and the lowercase SHA-256 hex digest of that exact evidence text.
4. `GET .../{run}/evaluation` returns current disposition and the most recent
   50 receipts. All rows remain stored, including old PASS, failed, and superseded
   evidence; the read limit is not deletion or a claim to return full history.

PASS requires the exact nonempty expected shard set, no duplicate or unexpected
shard, nonzero unique cases, exit code zero, every case PASS, nonblank digest-bound
evidence, and matching current authority/source/artifact/settlement. A historical
FAIL, ABORTED case, or nonzero exit keeps that run on HOLD, including if another
manifest is created. A repaired execution requires a new run; no implicit
adjudication or history reset is implemented. Missing, skipped, not-run, unknown,
stale, or malformed evidence cannot pass vacuously.

The final INSERT checks the exact observed database snapshot and reviewer
membership in the same SQL statement. Readback makes a final guarded SQL read,
so source/authority changes or a newer receipt arriving during readback cannot
produce a current PASS from an earlier snapshot. An idempotent replay retains
the original immutable `data.result`; consumers must use
`data.current_disposition` for present applicability. The dedicated GET endpoint
also reports present applicability and retained historical receipts.

The proof mode is **authenticated reviewer evidence**. The server verifies the
identity, binding, census and evidence digest; it does not run a caller's command
or infer that prose evidence proves a natural-language condition. Case names and
commands are reviewer evidence; they are not an independently frozen executable
test suite. Results expressly report `task_approved: false` and
`live_proof: false`. Existing task approval authority remains separate.

New evaluation wire hashes are lowercase SHA-256 hex. Existing supervisor spec
and checkpoint hashes retain their base64url representation; changing their
encoding would invalidate existing execution bindings.

## MCP access

`execution-tools.ts` registers adapters for the same REST handlers:

| Tool | Effect |
| --- | --- |
| `workroom_execution_start` | Bounded admitted provider execution |
| `workroom_execution_resume` | Exact-envelope continuation or reconciliation |
| `workroom_execution_reconcile_cost` | Read known original generation cost and settle; zero chat POSTs |
| `workroom_execution_status` | Read durable run/checkpoint/cost state |
| `workroom_execution_heartbeat` | Fenced lease renewal |
| `workroom_execution_interrupt` | Creator/owner cancellation generation advance |
| `workroom_execution_evaluation_freeze` | Persist host-derived expected conditions |
| `workroom_execution_evaluation_record` | Persist authenticated non-author evidence |
| `workroom_execution_evaluation_read` | Read currently applicable evaluation |

Status and evaluation read are read-only tools. Start and resume explicitly
advertise open-world provider effects. Heartbeat and interrupt are mutations;
their annotations do not promise idempotent state changes. Identity cannot be
supplied in the tool body and every adapter reuses the original authorization.

## Host driver

`scripts/orch/run.mts` is a bounded host client. It runs one task at a time; hosts
with distinct authorized principals can run concurrently against the same D1
task and execution leases. A local process never creates a second queue, task
engine, lease authority, or budget ledger. Run-level L/C/P/T admission stays in
the server.

```sh
node --import tsx scripts/orch/run.mts --help
node --import tsx scripts/orch/run.mts --max-tasks 1
```

These commands require no service credentials and perform no network call. An
actual invocation requires `--execute`, `WORKROOM_URL`, and `WORKROOM_TOKEN_FILE`
in the process environment. The token is read from that file only at execution
time; its value is not a command-line argument or an environment value. The
OpenRouter key remains in the service. The CLI does not print credentials or
the service URL. These tests use synthetic transports and do not invoke a live
service or provider.

The driver uses existing MCP tools for `task_claim_next` and `context_pack`,
which do not have corresponding REST endpoints. It uses existing REST routes
for identity, intent, task reads/renewal/submission, pinned message history, and
execution start/status/resume/heartbeat.

The driver preserves the full task goal and done conditions, exact pinned input
revision text, owner intent snapshot, and the complete G4 context payload in its
journal and emitted prompt. It verifies the context manifest against every
emitted entry and pin and records a digest of the entire returned context JSON.
Reference content is explicitly identified as untrusted data. A long goal uses
the task ID as a context retrieval query; the full goal remains in the model
prompt. Retrieval query selection does not replace the task specification.

The general execution prompt limit is 8,000 UTF-16 code units. This is a new
admission bound, distinct from the historical 120-character live proof profile.
The driver does not clip mandatory prompt material. Overflow produces HOLD and
preserves the fetched material. Default completion limit remains 1,024 tokens;
the server calculates and admits the hold and the wallet cap is unchanged.
Context token measurement remains unknown until actual provider usage exists.

The journal is durably replaced before claim, renewal, execution start and task
submission requests whose replay depends on local state. It contains immutable
run IDs, exact request bytes and digests, pinned sources/context, and submission
keys. Restart reuses the same envelope. An ambiguous response with no known
generation remains HOLD without another provider start. For known-generation
UNKNOWN, canceled, or rejected outcomes, it calls the dedicated same-run
`/execution-runs/reconcile` endpoint, which can only read the original generation
cost and settle it, with zero chat POSTs. Accounting recovery cannot revive a
canceled or stale run. Explicit checkpoints can continue only through the server's guarded
resume handler. The driver never invents a replacement run to escape UNKNOWN.
An explicit server capacity/busy denial with zero fetches and no reservation
keeps the exact envelope ready for a later bounded invocation. It is distinct
from an uncertain provider effect and never creates a replacement run.

While a provider request is pending, the driver observes and pins the active
`execution_generation` once, persists it, and sends that exact value in
heartbeats. A different generation causes HOLD instead of adoption. Completed
execution is submitted through the existing task engine with disposition
`review`, exact artifact version and an idempotency key. It is never automatically
evaluated or approved by its own author.

The submission also carries the exact run, attempt, intent revision and cancel
generation. The task engine checks these inside its submission transaction.
Pending submissions replay before any renewal, model call or native step. The
host validates and retains the historical submission receipt, then reads the
current task and exact current submission together. A superseded or canceled
submission remains HOLD. Legacy journals without the execution binding are not
silently rewritten or replayed. A normally approved task with the same exact
submission still matches; a new execution lease is not required for this read.

For explicit immutable builder units, see [task-lease-recovery-v1.md](task-lease-recovery-v1.md)
and [native-execution-v1.md](native-execution-v1.md). The latter documents the
four opt-in CLI flags, host-approved UnitSpec, supported checks, isolated local
Git repository, and durable native receipt. It keeps remote push, arbitrary
candidate execution, independent review and live operation as distinct gates.

## Bounds and operating constraints

- Defaults: one task per invocation, 180 seconds total runtime, an 8-second
  heartbeat interval, and 4,000 characters for the context pack.
- Maximums: 20 tasks per invocation, 600 seconds total runtime, and 8,000 prompt
  characters. Histories are read in at most ten pages of 100 revisions per pinned
  input; unavailable required revisions produce HOLD.
- A newly claimed task uses cancellation generation zero in its initial
  envelope. The server rejects any mismatch. There is no separate public
  task-cancellation-generation discovery endpoint; a previously interrupted open
  task can therefore require explicit recovery instead of automatic execution.
- A separate journal is required per worker. The CLI uses Linux/POSIX `flock`
  and atomic fsync/rename journal writes. A helper holds the OS lock while its
  parent stdin pipe is open; parent exit/crash closes the pipe and releases the
  OS lock. Acquisition waits at most five seconds for that asynchronous release,
  then returns `journal_locked` if the owner still holds it. Leftover lock files
  are harmless and never require killing a live PID
  or deleting the journal. A host without `flock` fails closed before execution.
- A HOLD leaves its evidence and active run in the journal. It does not release
  an ambiguous provider hold, assume a canceled external effect, or approve an
  artifact. A server migration, authenticated service configuration, independent
  exact-head review, and authorized deployment remain separate release gates.

## Reproducible local evidence

```sh
node --import tsx --test --test-force-exit tests/orch-driver.test.ts
node --import tsx --test --test-force-exit tests/orch-journal-lock.test.ts
node --import tsx --test --test-force-exit tests/run-evaluation.test.ts
node scripts/build.mjs
node --import tsx --test --test-force-exit tests/execution-tools.test.ts
```

Driver tests use an injected synthetic transport, including lost execution and
submission responses, changed execution generations, context tampering,
mandatory overflow, journal failures and exact replay. Evaluation tests use
local Miniflare D1. MCP frame tests use a local worker with outbound networking
replaced by a rejecting stub. None is a billable provider experiment, a
production D1 test, or an independent implementation review.
