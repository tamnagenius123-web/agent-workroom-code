# Deploy parity against agent-workroom-main at 8089647

Compared the docs monorepo commit `8089647` (deployment `main 8089647`) with this build. Blob ids below are git blob SHAs. No live resource ids are copied here.

## Bindings and vars

Both wrangler files name the worker `agent-workroom-main`, set `main` to `dist/worker.mjs`, use compatibility date `2026-07-28`, and declare the same binding names: D1 `DB`, R2 `FILES`, Artifacts `ARTIFACTS` on namespace `workroom`. Both schedule `*/5 * * * *`.

Var keys and values match: `WORKROOM_RESOURCE`, `WORKROOM_INGRESS_ID` (`workers-dev`), `MCP_COMPAT` (`1`), `RETENTION_MODE` (`dry_run`), `FILE_MAX_BYTES`, `FILE_TTL_SECONDS`, `FILE_HOUR_BYTES`, `FILE_ROOM_MAX_BYTES`, `WRGIT_ENABLED` (`0`).

This repo's wrangler file keeps a zero database id and placeholder database and bucket names. The live file pins the real D1 and R2 resources. Uploading this file unchanged would retarget those bindings. A deploy has to keep the resources already attached to the worker.

Secrets are not in either file. OAuth still needs `WORKROOM_TOKEN_PEPPER` (at least 32 characters) and `OWNER_PASSWORD_HASH` (`pbkdf2-sha256` or `pbkdf2c-sha256`). `OPENROUTER_API_KEY` is read from the worker environment and is not written by this change.

## Auth bytes

These files match `8089647` byte for byte:

| File | Blob |
| --- | --- |
| `src/auth/g5.ts` | `772607a13843ec6a2580c2d5d654cc608125b46b` |
| `src/auth/provision.ts` | `a3fceea453eb8437b7677d956f7e941ffacb5eb9` |
| `src/auth/password.ts` | `4afc0df35a34c7ea4c8c9cb71ce865e08045836e` |
| `src/auth/crypto.ts` | `7b8c1c2002e6c5905b5bcec073f9178104469a92` |
| `src/connection/authority.ts` | `899844ca66462bcda3df8babeeb6b3272011ab9c` |
| `src/connection/policy.ts` | `b87e2480bb60da63000d2d7ea276a187a97069fe` |

Client secret hash is `base64url(HMAC-SHA256(pepper, "client:" + secret))`. Access and refresh token hashes use the `token:` prefix. `POST /oauth/token` with `grant_type=urn:test:none` returns 400 `unsupported_grant_type` for a valid client and 401 `invalid_client` otherwise. Resource checks require `principal_bindings.credential_version` to equal the token's `credential_version`.

OAuth tables already exist on the live D1 from the docs migrations (`0004` through `0007`, `requester_gate` in `0010`, `0060`). This repo does not add those files again. `tests/fixtures/g5-auth.sql` is test-only.

## Routes

`src/server/app.ts` at `8089647` mounts the same HTTP paths this build mounts. Production `ui` is false, so `/` and `/app.js` are not served. Shared paths:

- `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration`
- `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`
- `/telegram/webhook`
- `/mcp`
- `/v1/telegram/notify`, `/v1/intent`, `/v1/intent/diff`, `/v1/decisions`, `/owner/intent`
- `/connection/capabilities`, `/api/v1/capabilities`, `/api/v1/me`
- `/api/v1/rooms/:room/messages`, `/api/v1/operations/:operation/:key`
- `/api/v1/batch`, room tasks (including claim, renew, submit, cancel, approve, request_changes), claims/stale, verifier-queue
- G2 threads, revisions, history, inbox, export
- handoffs, verifier-receipts, council agendas/records, research packets
- `/api/v1/rooms/:room/unit-costs`, `/api/v1/rooms/:room/dispatch`
- status records, community posts, room files and file-links
- `/git/workspaces`, `/git/workspaces/:id`, `/git/workspaces/:id/submit`, `/git/merge` (hidden while `WRGIT_ENABLED` is `0`)

No mounted path from `8089647` is absent in this build.

## Behavior that would change on deploy

- `/telegram/webhook` stays mounted and is not required. `8089647` accepts an owner update when the Telegram secrets are set. This build always returns 503 `TELEGRAM_NOT_CONFIGURED`. Inbound Telegram is served by worker `agent-workroom-gate`.
- `/v1/telegram/notify` follows the same stub. A configured live worker can send; this build reports unconfigured.
- `/git/workspaces/:id/submit` and `/git/merge` are not reached while `WRGIT_ENABLED` is `0` (both configs). If that flag is later set to `1`, `8089647` runs submit and merge, and this build returns 503 `WR-GIT merge is served by the gate MCP repo.`
- The `*/5` cron still runs. At UTC minute 7, `8089647` calls `retain()`. This build calls `retainBookkeeping()`, whose default gate throws `BoundaryUnavailableError`, so retention deletes do not run.
- `/v1/decisions` stays mounted. `src/server/decisions.ts` in this build fail-closes. The file bytes differ from `8089647`.
- These server files also differ and fail closed here: `notify.ts`, `owner-decisions.ts`, `owner-session.ts`, `retention.ts`, `server/policy.ts` is the SQL fragment only.
- MCP gains `workroom_usage_read`. The `8089647` `READ_TOOLS` list does not include it. This is an added tool, not a removed route.
- OAuth and bearer-authenticated routes match `8089647` when the resource, ingress, pepper, and owner hash are set. Missing config still returns 503 `AUTH_NOT_CONFIGURED`.

## Decision layer

`DECISION_LIVE_ENABLED` stays false. A successful `POST /api/v1/rooms/:room/tasks/:id/claim` schedules a shadow `t2.rebalance` judgment after the response is built. The verdict is not applied to the claim. The judgment is inserted when `judgments` exists. A missing table is ignored. The general-model roster is the bundled `config/models.openrouter.json`, so the `z-ai/glm-5.3` fallback does not read `node:fs`.

Routing is unchanged: `liquid/d1.2-ultra` under 65,536 tokens, `typesafe/jev-1.14` under 262,144, then `z-ai/glm-5.3`, then the deterministic rule. Decider is not called. When `OPENROUTER_API_KEY` is unset, the shadow row is the rule fallback and no provider call is made. When the key is set and the budget tables exist, the shadow call can spend on that claim. The claim response itself does not change.
