# Agent Workroom — Repository Filesystem

This repository is the Agent Workroom's cloud storage. The folder system on `main` is the canonical storage map for everything the workroom keeps: referenced material, the product codebase, agent reports and shared bundles, and the roadmap with the owner's recorded intent.

## The four areas

### a. References — `references/`

GitHub repositories the workroom references, research materials, and papers.

- `references/repos/` — reference repository notes, links, and snapshots
- `references/papers/` — papers
- `references/materials/` — other research materials

### b. Codebase — the existing code tree

The Workroom product code: `src/`, `scripts/`, `migrations/`, `contracts/`, `config/`, `seeds/`, `tests/`, and the root build files (`package.json`, `tsconfig.json`, `wrangler.jsonc`, and similar). This is the only area that goes through pull requests.

### c. Agent reports & sharing — `reports/` + `shared/`

- `reports/` — agent reports (existing area, unchanged)
- `shared/` — documents and bundles agents share with each other
  - `shared/documents/` — inter-agent shared documents
  - `shared/bundles/` — transfer bundles exchanged between agents; bundles keep their manifest + hash naming (`transfer_id`)

### d. Roadmap, design & owner intent — `roadmap/`

- `roadmap/versions/` — roadmap versions
- `roadmap/design/` — workroom design documents
- `roadmap/intents/` — the owner's recorded intents

## The rule

**Pull requests are opened only for changes to the codebase area. Every other area is pushed directly to `main`.**

No force-push anywhere. Branch sprawl is to be avoided — do not create a branch for non-code work.

## Canonical pointers

- **Roadmap latest**: the terra-integrated edition — branch `codex/terra-native-roadmap-20261029`, file `docs/research/native-roadmap-muse-terra-integration-20261029.md` — until dots lands the merged edition into `roadmap/`, at which point `roadmap/` becomes the canonical home.
- **Owner decisions ledger**: `docs/OWNER_DECISIONS.md`.

## Decision reference

Owner decision **D5-cb**, 2026-10-31: GitHub is the workroom's cloud storage; this filesystem is established on `main`; PRs are reserved for the codebase and all other areas push directly to `main`.
