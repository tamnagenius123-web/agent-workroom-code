# Execution safety and release boundaries

This implementation uses the existing task engine, D1 budget ledger, unit
leases, execution checkpoints, and verifier receipts. It adds no migration and
does not apply a migration, deploy, change permissions, or run a live provider
experiment. Runtime execution requires the shared schema through migration 0084.

## Authority and concurrency

Every supervisor invocation gets a unique execution holder. D1 leases serialize
the run, task, and authenticated principal. Separate admission pools bound
logical agents (4), process slots (4), concurrent requests per model (2), and
tool slots (2). These are server admission slots, not observations of physical
host processes or a proof of starvation-free scheduling. Admission fails with
the specific busy/capacity plane, and partially acquired leases are released.

A successful unit claim returns its own `UPSERT ... RETURNING` generation from
the D1 transaction. Heartbeat, release, and protected writes require the exact
holder and generation. The `fencedDatabase` adapter places an assertion and the
protected statements in one D1 batch: losing any resource lease aborts the whole
transaction. Database time determines execution lease expiry.

The task engine remains authoritative. Provider-start admission and artifact
publication require the current task holder, agent role, active posting
membership, task epoch, intent revision, cancellation generation, satisfied
dependencies, and exact current input revisions. Heartbeat uses the existing
task renewal action for its version and audit behavior, and requires the stored
run epoch. An active invocation also requires its pinned execution generation.
Only explicit resume can move a run to a new task epoch or execution attempt.

## External effects and recovery

The supervisor records `sending` and a counted unknown hold before provider
transmission. It then uses the one reservation-aware OpenRouter client. The
held principal/project/run/billing-attempt/model and price-card prompt/token
bounds are checked before transmission. There is no automatic chat POST retry.
Both transports use portable manual redirect handling and reject redirect
responses; credentials are never forwarded to a redirected origin. Workers
does not implement the Node/browser `redirect: "error"` option.

Provider acceptance and local persistence cannot be one transaction. If a
response or process is lost, the run retains UNKNOWN rather than asserting a
free or exactly-once external effect. A known generation is persisted before
the modeled checkpoint. The crash window between those two writes is recovered
without a second chat request. Generationless uncertainty remains held and
requires provider-side reconciliation evidence; a fresh attempt is not an
automatic recovery strategy.

Model text is the artifact, rather than a hash presented as its content. The
artifact ID is deterministic for the run; publication and the run pointer are
one fenced transaction. A resume preserves the original billing attempt while
binding the new execution attempt and task epoch. Self-check receipts bind
run/attempt/author/task/epoch/intent/generation/artifact/verifier. A missing or
foreign receipt cannot become PASS from a stored state label alone.

## Exact monetary vocabulary

`src/or-harness/client.ts` owns endpoint literals, reservation/settlement types,
counted hold states, and integer micro-dollar conversion. Worker defaults come
from the bundled roster; the configured cap amount and its wallet-wide scope
are preserved. The private JSON adapter retains its separate per-project scope.
Neither a project tag nor a retry creates additional budget.

Reservation replays validate the complete original identity and price card.
Actual settlement is idempotent only for the same generation, provider label,
model, cost field, amount, and token receipt. Conflicting actuals are rejected.
Reserved estimates and actual costs remain distinct. An actual cost over the
reservation is recorded rather than erased; that flag alone is not a statement
about the total wallet cap. UNKNOWN and pending-actual holds remain counted.

One inherited identity limitation remains explicit: `provider_account` is
currently populated from OpenRouter's upstream `provider_name`. It is not an
attested OpenRouter wallet/account identifier. This change does not invent an
account namespace or claim cross-account proof. Multiple-wallet operation and
key/account rotation require a separately specified stable account binding and
legacy-data reconciliation before that stronger claim can be made.

## Cost-only reconciliation

`POST /api/v1/rooms/room_main/execution-runs/reconcile` accepts only
`{"schema_version":"1","run_id":"..."}`. Its MCP adapter is
`workroom_execution_reconcile_cost`. The authenticated run author must still
have posting access. Reservation ownership must match principal, run, and
project; generation pointers must agree.

This endpoint performs bounded GET readback of the original generation and
settles its existing hold. It never reserves or sends chat. It works after
task cancellation or lease expiry without restoring execution authority. Late
reconciliation appends evidence and preserves original UNKNOWN receipts. A
known generation left in `sending` becomes a recoverable UNKNOWN record; absent
artifact or stale task authority prevents PASS. Completed reconciliation is
an idempotent read, with `chat_posts: 0` in the result.

## Evidence and acceptance

Execution self-check PASS is separate from independent evidence and task
approval. See [execution-evaluation-driver-v1.md](execution-evaluation-driver-v1.md)
for the reviewer manifest, retained failures, bounded host journal, and CLI.
See [context-delivery-v1.md](context-delivery-v1.md) for mandatory standing
context, source revisions, serialized response budgets, and token UNKNOWN.

The new driver performs a bounded text execution and submits the resulting
artifact for review. Its in-worker tool step is a deterministic content hash.
It does not implement a general code-editing tool loop, automatic repository
commit/push, or a new executable test runner. The reviewer evidence endpoint
checks identity, binding, completeness, and evidence digests; it does not execute
the submitted command or prove natural-language completion conditions. These
limits must remain visible in roadmap acceptance records.

Reproduction uses synthetic transports and local D1. The relevant regressions
include concurrent starts, same-holder token return races, stale transactional
writes, revoked roles, missing/foreign receipts, distinct reservation and actual
amounts, original billing attempts on resume, cancellation during cost lookup,
and crashes before/after generation persistence. Existing research failures and
Lean findings are not changed by these runtime tests.

Release requires the exact proposed head's selected GitHub CI tests and policy
check, plus the repository's non-author opencodereview verdict for Tier L.
Local evidence does not replace that gate. This change has not established live
multi-host, dormant-wake, throughput/RSS, or billable provider acceptance. Merge,
deployment, migration application, and live spending are separate authorized
actions; this implementation work does not perform them.
