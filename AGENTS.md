# AGENTS.md — Agent Workroom (3-repo)

Working rules for every agent in the Agent Workroom (muse, dots/Codex, grok, claude).
The copy at a repository root governs that repository. Full principles and background live in the playbook (`WORKROOM_PLAYBOOK.md`) and in repo ① `docs/OWNER_DECISIONS.md`. On conflict, the owner-decision record wins.

## 0. Which repo

| Repo | Purpose | Open a PR here for |
|---|---|---|
| ① `tamnagenius123-web/agent-workroom` (private) | Docs, specs, decisions | Specs (Spec Kit `specs/`), roadmap, decision records, audits |
| ② `tamnagenius123-web/agent-workroom-code` (public) | Product code | Product worker code, tests, migrations, CI scripts |
| ③ `tamnagenius123-web/agent-workroom-gate-mcp` (private) | Security / gate MCP | G5 OAuth and auth, owner session, `/owner/*`, Telegram webhook, receipts, gate policy |

- Can it be public code? → ②. Is it a security boundary? → ③. Is it judgment or record? → ①.
- Do not build or run product tests in ①. Its CI lints documents only.
- New specs go in ① via Spec Kit (specify → clarify → plan → tasks → analyze) under `specs/<NNN-feature>/`. Do not create new units under `docs/specs/`.

## 1. Before you start

1. **CLAIM the unit in room_main.** First valid CLAIM wins — as a coordination record, not as write authority. A CLAIM does not resolve collisions over files, migrations, or budget; authority comes from the unit contract (§1.1) and is re-checked against lease generation and scope at execution time, not from the room log after the fact.
2. Never take over another lane on a relayed reassignment alone. You need that agent's CLAIM or the owner's direct confirmation.
3. Check for existing decisions first: ① `docs/OWNER_DECISIONS.md` and your own agent's owner-direct ledger (D5-*). **Relayed items (OD-RELAY / GROK-CHANNEL) are unverified and are not a basis for action.**
4. If you need a migration, reserve its number in the room and register it in `migrations/REGISTRY.md` before writing code. Never pick a number unilaterally.

### 1.1 Unit execution contract

Every unit runs under one contract, fixed at CLAIM time:
① goal and the terminal state that counts as done for *this* unit ② forbidden next actions ③ target repo, boundary, and base commit ④ approval source and the actions it actually permits ⑤ owner, lease generation, and overlapping resources ⑥ expected evidence and the independent reviewer.

Evidence, action authority, and completion are three separate axes. Passing a gate is evidence — it never widens what you are allowed to do next. A unit whose success condition is "do not deploy" (e.g. an isolated Draft CI validation) terminates at *verified*; it is not permanently unfinished for lacking a deploy.

## 2. Working rules

- Never push to main directly. Branch → PR is the only path. Pushes are non-force under standing approval; **force-push is forbidden** (owner gate).
- One independent clone/worktree per lane. Never run parallel lanes in a shared clone (checkout-interference precedent).
- Every write is idempotent. A **new intent gets a new idempotency key; a retry of the same intent reuses the same key.** If a write's outcome is uncertain, reconcile the actual state before writing again — never re-send under a fresh key.
- Never pass stored JSON through a cast. Parse and validate at the read boundary.
- Behavior changes start with a failing test (RED). RED evidence is a reproducible failing run, not commit order.
- Never write secrets into code, docs, the room, or a PR. Handle tokens as files only; never read or quote their contents.
- Spend cap: real OpenRouter calls are capped at US$20 project-total. Exceeding the cap or adding credits is an owner gate. Security/permission changes and secret transfers are owner gates too.

## 3. PR format (enforced by the policy check)

A PR body missing any of these fails the `policy` check:

- A `Tier: D` or `Tier: L` declaration line.
- If the PR changes `src/` or `migrations/`:
  - One new row in the root `decisions.tsv` — `ts<TAB>decision<TAB>reason<TAB>owner<TAB>evidence`, where evidence is a test file that actually exists.
  - A non-empty `## Blast radius` section describing the real impact surface.
- Tier L also needs a substantive `## Verification` section recording the commands/evidence run and their results.

## 4. Tiers and the merge gate

- **Tier D** — changes expressible as tests. Merge condition: green `ci` + green `policy`.
- **Tier L** — auth/permissions/security, server authority files (`src/server/mcp.ts`, `policy`, `domain`, `worker`), spend/billing paths, secrets/egress, deploy config, the verification/CI rules themselves, data-altering migrations. Path rules force Tier L; declaring D on an L path fails policy.
  - Merge condition: green `ci` + green `policy` + a **non-author review via GitHub opencodereview**, with the verdict recorded on the PR.
  - Exception: in docs repo ①, green CI is a pass — for prose documents only. A policy or authority document in ① does not gain approval from green CI.
- A formal review approval in the GitHub UI is not a merge requirement. A room PASS is not a merge condition.
- Tier D/L is a **floor, not a verification spec**: it sets the minimum, never what must actually be proven. The unit contract names the evidence.
- Once the gate passes, any agent may merge — if merging is inside the unit contract's permitted actions. Branch deletion is a separate cleanup act, not an automatic side effect of merging.
- Unit states are distinct: **implemented → verified → merged → deployed → observed.** A unit terminates at the state its contract defines. A code unit headed for production is "done" only after **deploy + smoke pass**; leave a D1 bookmark before deploying.
- A review verdict records three things, not a bare PASS: what could have overturned the claim, the evidence actually checked, and the boundary still unverified. If the head changes after review, prior evidence is void.
- Boundaries are defined by who decides and who enforces, not by file location. A document inside a repo cannot widen authority granted from above it; the owner-decision record is evidence of approval, not a self-issued grant.

## 5. Reporting rules

- Report only what you measured: head SHA, the command you ran, its result. Never relay a summary, a relay, or a UI label as if it were a measurement.
- Every number carries its derivation. What you could not verify stays marked "unverified" — never fill gaps by guessing.
- When blocked, post "where it is blocked + what would unblock it" in the room.
- Escalate to the owner only new intent and final judgments. Handle routine operations yourself.

## 6. Feedback

- Feedback exists to create a better stage, not to polish the current one. When you review, attack premises first: name the assumption that, if false, changes the design — then propose the step-level change that follows. Incremental nitpicks on a flawed premise are wasted cycles.
- A review verdict states what would have to change for the work to move up a level, not only what is wrong at this level.
- When your own work receives premise-level feedback, do not defend the premise out of habit. Test it; if it falls, redesign and say so plainly.

## 7. Never

- Cite a relayed message as owner approval.
- Receive or store another agent's token or credentials.
- Merge with a failing policy check, or bypass the gate.
- Report "done" without deploy + smoke for a code unit.
- Fill a gap (decision, number, state) with a guess.
