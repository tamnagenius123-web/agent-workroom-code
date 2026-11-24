# Local native execution adapter

The optional native lane connects the existing orchestration driver to a local
checkout, frozen command checks, and a branch/head receipt. The service still
owns provider credentials, reservation/settlement, current task authority and
the atomic submission. The local adapter has no push, merge, deployment or
independent-verdict operation.

## Explicit host input

Use all four native arguments together with one task:

```text
npm run orch -- --native-spec /approved/unit.json \
  --native-spec-sha256 <independently-approved-file-sha256> \
  --native-repository /path/to/repository \
  --native-root /path/outside/the/repository
```

The default command is an offline plan. `--execute` separately enables the
existing authenticated service calls and can incur provider charges. This
implementation was checked using synthetic provider responses and local
fixtures; it does not authorize a live call.

The host supplies the immutable `workroom.native-unit.v1` JSON contract defined
in `scripts/orch/native-contract.ts` and separately pins the exact file bytes.
Its `approval_ref` is a locator, not an authorization grant. Retrieved text and
model output cannot create or change this input. It binds the task's immutable
fields and normalized builder metadata, principal, base commit, model, exact
read/write paths, acceptance command census and budgets. Create builder tasks
with `unit: {kind: "builder"}`; the service normalizes the builder lease. A
legacy task without unit metadata is rejected by this adapter.

Example manifest shape (the marked digest/base values must be replaced with
the approved task snapshot and local base before this file can be accepted):

```json
{
  "contract": "workroom.native-unit.v1",
  "id": "EXAMPLE-UNIT",
  "title": "Update a reviewed literal",
  "lane": "builder",
  "spec_md": "Set answer.mjs to the frozen expected text. Candidate code is not executed.",
  "lineage": ["INFERRED"],
  "deps": [],
  "verifier": "agent:independent-reviewer",
  "principal_id": "agent:builder",
  "task_id": "replace-with-existing-builder-task-id",
  "model": "z-ai/glm-5.3-flash",
  "task_spec_sha256": "replace-with-nativeTaskDigest-of-server-task",
  "base_sha": "replace-with-approved-full-local-base-sha",
  "approval_ref": "replace-with-the-host-approved-unit-contract-reference",
  "read_paths": ["answer.mjs"],
  "write_paths": ["answer.mjs"],
  "acceptance": [
    {"id":"syntax","cmd":["node","--check","answer.mjs"],"expect":"exit0","scope":"touched","timeout_ms":5000},
    {"id":"expected-bytes","cmd":["workroom","text-equals","answer.mjs","export const answer = 42;\n"],"expect":"exit0","scope":"touched","timeout_ms":5000}
  ],
  "budget": {"usd_max":1,"tokens_max":4096,"wall_s":180,"max_actions":1,"max_write_bytes":4096}
}
```

`nativeTaskDigest` is exported from `scripts/orch/native-contract.ts`. It hashes
the task ID, goal, owner, dependencies, pinned input versions, done conditions
and normalized `unit` metadata, not the mutable task version or lease expiry.
The CLI's approved SHA256 is over the exact manifest file bytes and is distinct
from this task digest. This example is not itself an approval or a runnable
production unit.

## Supported command boundary

Required checks may use `node --check <candidate-path>`, `git diff --check`, or
the fixed `workroom text-equals/json-equals <path> <expected>` data evaluators.
Each command is represented as a JSON argv array and requires `expect: exit0`.
Candidate source is parsed or compared as data. Arbitrary code execution,
package scripts, shells, regex acceptance and unsupported commands produce
HOLD before dispatch; their requirements are never replaced by syntax checks.
The recorded `scope` is the host's declared command scope and does not attest
to full-suite coverage.

This is checkout isolation on a trusted local host, not an OS security sandbox.
It cannot run an arbitrary unit-test suite against provider-modified code. A
separately approved sandbox that enforces filesystem/process/network limits is
required for that capability. No sandbox backend or host permission is enabled
by this adapter.

Each run gets a new local repository using only copied Git object bytes.
Source configuration, hooks, filters, credentials, templates and remotes are
not copied. Symlinks, hard-link targets, unsafe paths and object alternates are
rejected. Child environments are constructed from an allowlist; provider keys,
tokens, `NODE_OPTIONS`, SSH agents and user Git config are not inherited.
Git lazy fetch, replacement objects and all transport protocols are disabled
for source reads and destination operations. An unavailable promisor object
holds locally instead of starting a remote helper.

## Evidence, recovery and budgets

The durable local journal records `started` before each checkout, write, commit
and check. A surviving `started` entry holds the run for reconciliation; it is
not automatically executed again. The final census includes every required
check and preserves nonzero exits as FAIL. Checks run against the actual local
commit, and any subsequent change to HEAD or candidate bytes invalidates the
receipt. Source files in the original repository remain unchanged.

The driver rechecks current service authority before each local step. That
check is a point-in-time observation, not a distributed filesystem transaction.
Shared publication uses only the server's fenced `execution-runs/native-submit`
transaction. Its exact body is journaled before sending and replayed unchanged
after a lost response. The original model artifact and the native evidence
artifact remain distinct. Native check success is builder evidence; it is not
an independent verdict or task approval.
Historical submission replay preserves its accepted receipt but returns HOLD
when the current task/submission no longer matches (for example, cancellation
after a lost response). It does not renew the task or rerun the provider.

`tokens_max` means total recorded prompt plus completion tokens. Admission
uses the canonical client estimates and clamps output allowance; final native
effects require a complete matching canonical token census. Unit USD uses the
existing reservation estimate before dispatch and exact settled micro-USD
before native effects. Unknown or excess actual cost/tokens holds the unit.
The estimate is not a proved upper bound on provider billing. The existing
wallet-wide service cap and accounting policy are unchanged. The wall budget
covers the driver attempt, including model work; restart does not reset it.

The receipt includes local branch, exact head/tree, command exits and outputs,
log digests, actual cost/tokens and a transcript locator under the native root.
It explicitly records `push: NOT_RUN`, `independent_verdict: NOT_RUN`, and
`execution_boundary: trusted_data_checks_only`. The executable regressions are
`tests/native-execution.test.ts` and the native cases in
`tests/orch-driver.test.ts`.
