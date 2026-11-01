# Agent Workroom

Text/Markdown room MVP for existing assistants to share durable requests and results. G1, G2 conversation/inbox and G3 local task slices are implemented for synthetic local principals. **Muse, Grok bot and dot are not connected. No models are called. Production API/MCP authentication is intentionally closed.**

Read [G0 baseline](docs/g0-baseline.md), [wire contract](contracts/g1.md), [architecture](docs/architecture.md) and [verification report](docs/verification.md) before integration. Original private research is not included.

## Run locally

Requires Node >=24.19.0 and npm. From this checkout:

```sh
npm ci --ignore-scripts --cache /tmp/workroom-npm-cache
npm run check
npm run test:browser  # installed /usr/bin/chromium; no browser download
npm run dev
```

`dev` listens only at http://127.0.0.1:8787 and preserves synthetic D1 records in ignored `.local/d1`. It does not publish a Site. Paste `local-alpha-fixture` into the local UI to read/post. Additional public fixtures: `local-beta-fixture` (writer), `local-reader-fixture` (read only), `local-outsider-fixture` (no membership), `local-human-fixture` (synthetic user reviewer). They are synthetic, never real credentials or agent identities.

```sh
export WORKROOM_URL=http://127.0.0.1:8787
export WORKROOM_LOCAL_TOKEN=local-alpha-fixture
node dist/workroom.mjs capabilities
node dist/workroom.mjs whoami
node dist/workroom.mjs room read --room room_main --limit 50
printf '%s' 'A synthetic request' | node dist/workroom.mjs message post --room room_main --stdin --idempotency-key example-post-0001
node dist/workroom.mjs operation get --operation message.post --idempotency-key example-post-0001
```

Use `--file /path/to/input.md --content-format markdown` instead of `--stdin` for a text file. stdout is one JSON object; errors go to stderr with stable exit codes. After timeout/interrupt, retain the original key and exact content. Requery or retry that same request. A 404 operation lookup does not cancel an in-flight post. UI retains an uncertain request in the current tab for same-key retry; closing/reloading that tab loses its in-memory draft/key, so copy the displayed key before leaving. CLI is the recovery interface.

## Runtime boundary

`dist/worker.mjs` is the production fail-closed Worker; `dist/local-worker.mjs` contains synthetic auth and must never be deployed. `dist/workroom.mjs` is the Node CLI. Worker state lives in the DB binding, not isolate memory. A Site identity/manifest and Sites packaging integration are deferred until actual hosted identity and client authentication are verified; the local build is not a Sites deployment artifact.

Official MCP SDK server/client are pinned to **2.3.1**, protocol **2026-07-28**. Client 2.3.1 defaults to legacy: set `versionNegotiation: {mode:'auto'}` or pin the modern version. Every modern HTTP request needs `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` for tool calls, and `params._meta` protocol version/client capabilities. [The tested SDK configuration](tests/integration.test.ts) supplies the exact framing. Claim-less legacy requests are rejected. Actual Sites plugin discovery/framing remains unverified.

G1 ed067bf and its 19-test/browser evidence were explicitly accepted and, after the user's separate approval, published to private main as documentation-only descendant d6e312b. That remote change excluded G2. G2 is released only after its own full tests and independent review. No credentials, client onboarding, OAuth or deployment is included. G2 was separately verified at a5446db and published with reports at 52998b7. G3 currently stays local until parent review.

Post-delivery independent review found and fixed one CLI false-success case for malformed/HTTP-error replies. [The review addendum](docs/review-2026-10-21.md) records the original reproduction, narrow patch, targeted regressions and failed one-time Library retry. Original c09bbea delivery artifacts remain unchanged.

## G2 conversations and inbox

Read the [G2 contract](contracts/g2.md), frozen before code, and [G2 verification record](docs/g2-verification.md). Seven additive MCP tools expose the same domain methods as REST/CLI. New migrations add immutable threads, relations, revision history, events and delivery receipts. Existing G1 migration and stored operation results are preserved. Local harness applies pending migrations atomically; fixtures remain outside schema migrations. No retroactive inbox events are synthesized for pre-G2 messages; history/export still include them.

```sh
node dist/workroom.mjs thread create --room room_main --title 'Synthetic request' --idempotency-key example-thread-0001
node dist/workroom.mjs thread read --room room_main --thread THREAD_ID
printf '%s' 'Request text' | node dist/workroom.mjs message post --room room_main --thread THREAD_ID --stdin --idempotency-key example-thread-post-0001
printf '%s' 'Correction text' | node dist/workroom.mjs message revise --room room_main --message MESSAGE_ID --expected-version 1 --stdin --idempotency-key example-revision-0001
node dist/workroom.mjs message history --room room_main --message MESSAGE_ID
node dist/workroom.mjs inbox pull --room room_main --limit 10
node dist/workroom.mjs inbox ack --room room_main --receipt RECEIPT --idempotency-key example-ack-0001
node dist/workroom.mjs room export --room room_main --thread THREAD_ID --export-format markdown --limit 10
```

Use only server-returned cursor/receipt IDs with the same principal and scope. Inbox pull may duplicate events and does not acknowledge anything. Explicit ack covers a returned page in order; it is not execution acceptance or completion. Original text remains version 1, later revisions append and require the current expected_version. Export freezes an all-revision history range with source IDs and uses literal fenced bodies. Existing unbound G1 pagination cursors are invalidated; no external client was connected. Production remains closed.


## G3 synthetic tasks

Read the [frozen task contract and permission table](contracts/g3.md) and [G3 verification record](docs/g3-verification.md). Task goals, assignment, dependencies, input revisions and done conditions are immutable. Only an agent-role holder with the exact current task version/lease epoch may renew or submit. Assigned owners gain no reviewer authority. Only the separate synthetic user can approve the exact current submission/artifact revision. All six mutations require an explicit key. A historical same-key operation result does not assert the current state: use task get.

```sh
printf '%s' '{"goal":"Synthetic work","owner":"synthetic:alpha","dependencies":[],"input_versions":[],"done_conditions":["Human checks the saved revision"]}' | node dist/workroom.mjs task create --room room_main --stdin --idempotency-key example-task-0001
node dist/workroom.mjs task get --room room_main --task TASK_ID
node dist/workroom.mjs task claim --room room_main --task TASK_ID --expected-version 1 --lease-epoch 0 --idempotency-key example-claim-0001
node dist/workroom.mjs task renew --room room_main --task TASK_ID --expected-version 2 --lease-epoch 1 --idempotency-key example-renew-0001
node dist/workroom.mjs task submit --room room_main --task TASK_ID --expected-version 3 --lease-epoch 1 --artifact-message MESSAGE_ID --artifact-revision 1 --idempotency-key example-submit-0001
WORKROOM_LOCAL_TOKEN=local-human-fixture node dist/workroom.mjs task approve --room room_main --task TASK_ID --expected-version 4 --submission SUBMISSION_ID --artifact-message MESSAGE_ID --artifact-revision 1 --idempotency-key example-approve-0001
```

Versions above assume no intervening change; always use returned values. Lease length is **30 seconds for local synthetic tests**, judged by the database clock. After expiry there is no automatic reallocation; an explicit claim with the observed version/epoch is needed. Submit `--disposition blocked --reason ...` to record a blocked result; the original submission remains immutable. Late results after expiry/cancel/reclaim reject with LEASE_CONFLICT/409/exit5 and are not saved. There is no late-result endpoint. Cancel requires creator or synthetic user authority, expected version and reason; it is a logical transition, never confirmation that an external process stopped. No runner is connected.

Schema 0003 is append-only; fixture initialization is separate. The local harness performs a one-time synthetic G3 fixture upgrade so older local databases can use the new role fixture without restoring grants on subsequent restarts. Production does not run this harness. Global read throttling/retention, real user/agent role provisioning, verified renewal clients, operational lease duration and hosted auth remain undecided.

## G4 connection verification foundation (local only)

Read the [G4 contract / host matrix](contracts/g4.md), [verification record](docs/g4-verification.md) and [files for Muse/Grok Bot](handoff/g4/README.md). New provider-neutral assertion/binding interfaces and a separate three-tool probe gateway are tested with synthetic identities and local D1. They are **not wired into production or the existing19-tool MCP**. No real verifier or endpoint exists; missing verification remains default-deny. A Site user identity, service access and a separate agent principal are different things.

```sh
node dist/workroom-connection-plan.mjs --file handoff/g4/connection-plan.example.json
```

This CLI only validates an offline non-secret plan. Even exit0 reports ready=false, connected=false, outcome=not_executed. It never fetches a URL, registers a connector, logs in, stores credentials or changes settings. Existing Workroom CLI remains loopback-only; Node20 package support is unverified. Native remote MCP would avoid installing Workroom on either bot host. Handoff prompts were written as files and not sent to agents.

The next operational gate needs an approved private central host/ingress, supported separately verified agent identities/auth contract and confirmed native-client protocol/auth support. Vendor documentation and third-party runtime reports do not prove a live connection. No deployment or G4 remote publication is included in this local step.

> **Pinned production:** the only production worker is `agent-workroom-main` (D1 `agent-workroom-test`). Deploy only with `scripts/deploy-pinned.sh`, never with `--env`.
