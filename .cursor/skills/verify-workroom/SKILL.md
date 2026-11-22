---
name: verify-workroom
description: Drive the product worker locally with wrangler dev and a scratch D1, then prove OAuth and MCP fail closed and the WR-GIT route is not reached. Use when a change needs a real worker request instead of a unit-test double.
---

# Verify Agent Workroom

This repo serves `dist/worker.mjs` (`wrangler.jsonc` name `agent-workroom-main`). Hosted OAuth, consent, and client provisioning live in the gate MCP repo. `src/auth/g5.ts` here fail-closes `/.well-known/` and `/oauth/` with `AUTH_NOT_CONFIGURED`, and `g5Authenticate` does the same for every other API route. Verification boots that bundle with `wrangler dev --local` only.

One instance binds `127.0.0.1:443`. A second instance cannot share that port. Refuse to drive a process this run did not start.

Build once before launch: `npm run build` from the repo root, with Node `>=24.19.0`. The bundle is `dist/worker.mjs` and is not committed.

## Launch

`node .cursor/skills/verify-workroom/scripts/launch.mjs`

The script creates `/tmp/verify-workroom/run`, copies `wrangler.jsonc` there, and deletes the `artifacts` binding from the copy. That binding talks to remote storage even during local dev. The product `wrangler.jsonc` is not modified. `WRGIT_ENABLED` stays `"0"`. The local D1 name is the `database_name` in `wrangler.jsonc`. It applies `migrations/` with `wrangler d1 migrations apply <database_name> --local` and inserts `room_main`.

It does not write an owner password or a token pepper. This worker does not verify them.

It then starts:

`npx --yes wrangler@4.152.0 dev --local --local-protocol https --port 443 --ip 127.0.0.1 --persist-to /tmp/verify-workroom/run/state`

Ready means the log contains `Ready on https://127.0.0.1:443`. The command passes `--local` and never `--remote`. Cloudflare API tokens are stripped from the child environment.

Clients reach the local listener with `curl --resolve agent-workroom-main.tamnagenius123.workers.dev:443:127.0.0.1`. If `workerd` cannot bind 443, launch runs `sudo -n setcap cap_net_bind_service=+ep` on the local `workerd` binary and records that in the state file.

## Doctor

`node .cursor/skills/verify-workroom/scripts/doctor.mjs`

Doctor is read-only. It checks the recorded pid is alive, its command line contains `--local` and not `--remote`, the scratch config has no `artifacts` binding and still has `WRGIT_ENABLED` `"0"`, a local sqlite file exists under the scratch persist directory, and both well-known OAuth documents return 503 `AUTH_NOT_CONFIGURED`.

`WORKROOM_RESOURCE` in `wrangler.jsonc` must stay `https://agent-workroom-main.tamnagenius123.workers.dev/mcp`. The `PINNED_WORKROOM_*` constants live in the gate repo. This tree does not export them.

## Drive

Run doctor, then:

`node .cursor/skills/verify-workroom/scripts/drive-pinned-discovery.mjs`

Requests use `curl -sk --resolve agent-workroom-main.tamnagenius123.workers.dev:443:127.0.0.1`. The drive records 503 `AUTH_NOT_CONFIGURED` for discovery, authorize, `POST /mcp` `workroom_whoami`, and `POST /git/merge`. It does not insert an OAuth client and does not call `scripts/provision-client.mts` or `scripts/consent-client.mts`.

`scripts/provision-local.mts` exits 1 if invoked. It does not write SQL.

## Evidence

Proof is written to `.cursor/skills/verify-workroom/evidence/pinned-discovery/`:

- `discovery.json` — status and error code for the authorization-server document
- `client-row.json` — states that no client row was inserted
- `grant.json` — status, and that no access token and no refresh token were issued
- `whoami.json` — status and error code for `workroom_whoami`
- `transcript.txt` — the actions and results

Do not write a pepper, password, client secret, authorization code, access token, or refresh token into evidence.

## Cleanup

`node .cursor/skills/verify-workroom/scripts/cleanup.mjs`

Sends `SIGTERM`, then `SIGKILL`, to the recorded process group. Deletes `/tmp/verify-workroom` (sqlite, certificate, wrangler log). It does not delete `.cursor/skills/verify-workroom/evidence/`. After a drive, cleanup checks that the evidence files are still present and that `grant.json` has no token. Run cleanup after a failed launch too, so port 443 is not left occupied.

## Helpers

- `node .cursor/skills/verify-workroom/scripts/launch.mjs`
- `node .cursor/skills/verify-workroom/scripts/doctor.mjs`
- `node .cursor/skills/verify-workroom/scripts/drive-pinned-discovery.mjs`
- `node .cursor/skills/verify-workroom/scripts/cleanup.mjs`

Shared flags and the pinned URLs live in `scripts/lib.mjs`. Every wrangler argument list is rejected if it contains `--remote`.
