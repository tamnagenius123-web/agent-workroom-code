# Immutable unit lease policy and expired task recovery

This change uses the existing task engine, `tasks.spec_json`, `task_leases`,
operation receipts and task audit. It adds no migration. It does not deploy,
send provider requests or turn task recovery into permission to replay an
uncertain external effect.

## Lease policy

Ordinary tasks and stored tasks without `unit` retain the existing 30-second
lease. An explicitly declared builder unit has an immutable lease policy:

```json
{
  "goal": "Complete the unit",
  "done_conditions": ["The acceptance command exits zero"],
  "unit": { "kind": "builder", "lease_ms": 2400000 }
}
```

`unit: {"kind":"builder"}` defaults to 40 minutes. An explicit `lease_ms`
must be a positive integer at most 86,400,000 ms (24 hours). The upper bound
is an implementation admission limit, not a measured duration or an extension
of owner permissions. This metadata is separate from a complete executable
UnitSpec and does not itself supply its tool/check contract.

Creation normalizes and stores the policy in the existing immutable spec JSON.
The existing database trigger prevents later changes, and the supervisor's
digest of the entire stored spec includes it. `claim`, `claim_next` and `renew`
all use that stored duration with database time. Renewal requests cannot supply
a new policy. Task creation/readback, claim receipts, idempotent replay and
renewal retain the same unit metadata.

Stored task, lease, submission and claim-receipt JSON are runtime validated.
Legacy records can lack done conditions; their readable empty condition set
does not pass independent evaluation. New task creation still requires at least
one condition. Invalid unit metadata is not treated as an ordinary short lease.

## Ready selection and atomic recovery

`claim_next` considers both open tasks and `in_progress` tasks whose lease has
expired on the database clock. The same owner constraint and completed
dependencies apply. A live lease, another owner's task, unresolved dependencies,
review, blocked and terminal states do not become eligible through this change.

Recovery is lazy: expiry makes the task eligible for the existing pull path;
it does not run a background sweep, delete the task, or rewrite its state to
`open` without an actor. The successful claim moves it to `in_progress`, bumps
task version and lease epoch once, and records the new holder and duration.

Before writing, the engine selects a candidate and validates its immutable
spec. The D1 transaction rechecks that exact candidate and captures its prior
state, holder, epoch and expiry in `claim_precondition`. The guarded mutation
requires the same task version and all four prior values, as well as current
database-clock eligibility. Task, lease, operation and audit writes share the
batch. If another claimant or renewal wins before the batch, a stale selection
cannot overwrite it. Retry of moved candidates remains bounded.

A replay of an old operation remains a historical receipt. It never changes
the current lease or resets its epoch. Consumers must read current task state
before using authority. Even the same principal cannot renew or submit using
an older epoch. Counter exhaustion fails closed; the finite request counter
range is not silently wrapped or presented as unlimited lifetime operation.

Task acquisition grants only task authority. A recovered task may still have a
prior provider invocation with UNKNOWN outcome. Execution admission must retain
that history and reconcile the original run; a new task lease is not evidence
that it is safe to issue another provider POST.

## Local verification

`tests/claim-next-ttl.test.ts` runs real local D1 mutations with no provider
transport. It covers legacy duration, default and explicit unit duration,
immutable spec digest, two competing reclaimers, same-principal stale epoch,
historical idempotency replay, owner/dependency exclusion, stored corruption
before mutation, and a legitimate re-claim between queue read and delayed write.

```sh
node --import tsx --test --test-force-exit tests/claim-next-ttl.test.ts
```

These finite execution traces are implementation evidence, not a proof of all
histories, starvation freedom, multi-host liveness or live provider acceptance.
