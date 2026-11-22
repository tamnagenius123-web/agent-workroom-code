#!/bin/bash
# Pinned production deploy (민성 t790u/t791u 2026-10-27): the ONLY production target is
# worker agent-workroom-main bound to D1 agent-workroom-test. Never use --env.
set -euo pipefail
for a in "$@"; do case "$a" in --env|--env=*|-e) echo "REFUSED: --env is forbidden; production is pinned to agent-workroom-main (top-level config)" >&2; exit 64;; esac; done
grep -q '"name": "agent-workroom-main"' wrangler.jsonc || { echo "REFUSED: wrangler.jsonc top-level name is not agent-workroom-main" >&2; exit 65; }
grep -q '"env"[[:space:]]*:' wrangler.jsonc && { echo "REFUSED: wrangler.jsonc must not define env sections" >&2; exit 66; }
npx --yes wrangler@4.152.0 d1 time-travel info agent-workroom-test
echo "NOTE: this script does not apply D1 migrations. Apply migrations/0077_unit_leases.sql and migrations/0078_judgments.sql with wrangler d1 execute agent-workroom-test --remote --file=... before deploy." >&2
npm run build
npx --yes wrangler@4.152.0 deploy "$@"
