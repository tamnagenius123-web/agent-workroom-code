# Context delivery, standing notices, and accounting

This change completes the read-side context boundary. It does not grant tool,
task, reviewer, owner, merge, or deployment authority. Memory content remains
data. No existing memory item, owner decision, or production setting is changed.

## Reviewed standing-notice policy

The selection policy is `approved-standing-title-tier2-v1`:

- The memory item belongs to the authorized room and is approved.
- Its tier is at least 2, and its title starts with the exact `[standing]` marker.
- It is valid at the requested time and has not been superseded at that time.
- Its pinned source revision is readable in the same room.

The marker is part of the title covered by the existing review content digest.
An ordinary certified fact does not opt in automatically. Propose and review a
new marked item, then use the existing reviewed supersession flow to replace an
old one. This change does not seed notices or approve records.

`standing_memory` is distinct from `owner_memory`. The latter still uses the
private owner-decision boundary; its absence is not replaced with fabricated
owner authority. Approved notices are emitted in decision, fact, skill order,
then by id. They retain their complete reviewed title and body. The prefix has
no query terms, retrieval score, current time, or current source revision, so an
unchanged notice set has stable serialized bytes across tasks and wake reads.

A standing block is never clipped to make a response fit. An unreadable source
fails with `MANDATORY_SOURCE_MISSING`; an oversized mandatory block fails with
`MANDATORY_EXCEEDS_BUDGET`. The read is bounded to 1,001 candidate rows, detecting
an over-limit set instead of silently returning its first 1,000. A complete
standing block cannot exceed 20,000 UTF-16 code units, the context-pack maximum.
The brief's lower caller-selected budget can impose a tighter limit.

## Final pack budget and evidence

The plain and folded pack compilers still rank optional candidates using their
existing rules. `Workroom.contextPack` then applies a final envelope budget:

```text
JSON.stringify(result.data).length <= budget_chars
```

This includes standing notices, owner memory when supplied by its boundary,
sections, lineage, fold ids, source pins, and the manifest itself. `used_chars`
is the exact size of that complete serialized `data` object, including its own
decimal count. Optional entries drop from messages, folds, facts, skills, then
decisions. Mandatory fields are never clipped. HTTP/MCP transport framing is
outside this character budget.

`pin_table` identifies each emitted entry's source message, pinned revision,
current revision, basis, and presence. `source_sha256` hashes the full raw pinned
revision from this room, not a summary or truncated excerpt. A missing optional
source is explicit (`status: missing`, `source_present: false`, null hash).
Missing mandatory notice sources fail the response.

The manifest records room scope, upstream truncation, the count of additional
entries removed by the final budget, UTF-8 payload size, and a SHA-256 of the
emitted payload. To reproduce that payload hash, remove only `used_chars` and
`manifest` from `data`, preserve the remaining property order, stringify it,
encode as UTF-8, and hash. Fold source pins remain in `pin_table`; the existing
`lineage` convention still lists non-fold message sources, now including notices.

The manifest reports `count_unit: utf16_code_units`, `token_count: null`, and
`token_status: unknown`. This is an exact JavaScript-string budget. It is not a
provider tokenizer, model context-window certificate, or complete provider-wire
token count.

## Context compile response migration

`workroom_context_compile` retains its numeric `budget`, now explicitly a
rendered-string UTF-16-unit budget. Consumers must read `used_units` and
`count_unit` instead of treating string length as provider tokens:

| Field | Current meaning |
|---|---|
| `budget` | Maximum UTF-16 code units in `rendered` |
| `used_units` | Exact UTF-16 code units in `rendered` |
| `count_unit` | `utf16_code_units` |
| `token_count` | `null`; no tokenizer is configured |
| `token_counter` | `null` |
| `token_status` | `unknown` |
| Manifest `declared_cost_units` | Original candidate-supplied weight, not measured usage |
| Manifest `token_cost` | `null` |

The previous numeric `token_count` and `token_cost` fields mislabeled string
units or declared weights as model tokens. Their null values are a deliberate
response correction; clients must migrate to the explicit unit fields. The
pure selector's legacy internal names remain compatible, and its emitted string
selection behavior does not change. Caller-supplied scope/freshness still do not
grant authority or certify retrieval isolation.

## Context consumers and wake boundary

| Consumer | Notice behavior |
|---|---|
| `workroom_context_pack`, plain | Stable prefix; complete serialized `data` budget and source manifest |
| `workroom_context_pack`, `folds=true` | Same final fitter and prefix; fold lineage preserved |
| `workroom_brief_get` | Same prefix; the entire brief fits `max_chars` or fails explicitly |
| `workroom_memory_recall`, handoff/question/decision | Same prefix even for trivial text; owner boundary remains separate |
| `workroom_my_queue` | Same prefix at queue pickup; existing task/review/handoff selection is preserved |
| `workroom_unread`, `workroom_mentions`, inbox pages | History/event feeds, not context compilers; no authority-bearing notice injection |
| Signed webhook delivery and wake listeners | Deliver or journal a message reference; they do not prove that a host fetched or consumed a context pack |

The public `notify.ts` webhook payload carries message metadata and a preview.
The private wake listeners verify/journal that delivery; the Dots receiver does
not have a third-party run API. A client must call one of the compiled context
surfaces after wake. Local API tests prove notice inclusion at those surfaces;
they do not prove remote host startup or first-context consumption. The open
MCP Events work is outside this change.

Current private owner pins cannot be audited or retired by this public
read-side implementation. Their keep/replace/remove decision requires the
authoritative owner-decision source and its normal approval flow. No old pin is
declared reconciled merely because these context surfaces now work.

## Verification boundary

`tests/standing-notices.test.ts` exercises real local D1 proposal, independent
review, supersession, source revision hashes, prefix stability, mandatory
overflow, complete response size, and the context consumers above.
`tests/p5-context-wire.test.ts` exercises the actual bundled MCP endpoint,
including Korean and supplementary Unicode. Existing pack, folded-pack and
brief tests retain their ranking and historical behavior without marked items.
These are local runtime regressions, not Lean proofs or production acceptance.
