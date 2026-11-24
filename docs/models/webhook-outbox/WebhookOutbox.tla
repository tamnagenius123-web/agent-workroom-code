--------------------------- MODULE WebhookOutbox ---------------------------
EXTENDS Integers, FiniteSets, Sequences

CONSTANTS
  Rows,          \* Finite set of outbox row IDs, e.g. {"stale1", "fresh1", "fresh2"}
  MaxAttempts,   \* 6 in src/server/notify.ts
  SweepLimit,    \* 25 in src/server/notify.ts (scaled to 2 for small-state TLC)
  StaleCutoff    \* STALE_OUTBOX_MS (3_600_000 ms; modeled as age > 1 tick)

VARIABLES
  now,           \* Discrete logical clock: 0 = cutover, 1 = <1h, 2 = >1h
  createdAt,     \* row -> creation tick (-1 = pre-existing >1h at cutover, 0 = fresh)
  status,        \* row -> {"pending", "delivered", "failed"}
  lastError,     \* row -> {"none", "http_err", "expired_stale", "webhook_removed"}
  attempts,      \* row -> 0..MaxAttempts
  claimToken,    \* row -> 0 (none) or 1..N
  claimedUntil,  \* row -> -1 (none) or tick
  nextAt,        \* row -> due tick
  deliveredCount,\* row -> count of 2xx completions recorded
  inflight,      \* Set of in-flight attempts: [row: r, token: t, fromSweep: b]
  nextToken,     \* Monotonic claim token allocator
  lastBatchSize  \* Size of most recent cron sweep batch

vars == <<now, createdAt, status, lastError, attempts, claimToken, claimedUntil,
          nextAt, deliveredCount, inflight, nextToken, lastBatchSize>>

IsStale(r, t) == (t - createdAt[r]) > StaleCutoff

\* Actors:
\* 1. Post() immediate deliver on a fresh row (explicit ids: does NOT run stale expiry)
PostImmediateDeliver(r) ==
  /\ status[r] = "pending"
  /\ createdAt[r] >= 0
  /\ (claimedUntil[r] = -1 \/ claimedUntil[r] <= now)
  /\ \E tok \in {nextToken}:
       /\ claimToken' = [claimToken EXCEPT ![r] = tok]
       /\ claimedUntil' = [claimedUntil EXCEPT ![r] = now + 1]
       /\ inflight' = inflight \cup {[row |-> r, token |-> tok, fromSweep |-> FALSE, startedAt |-> now]}
       /\ nextToken' = nextToken + 1
  /\ UNCHANGED <<now, createdAt, status, lastError, attempts, nextAt, deliveredCount, lastBatchSize>>

\* 2. */5 cron sweep: first expires pending rows older than STALE_OUTBOX_MS (if unheld),
\*    then claims at most SweepLimit due non-stale pending rows.
CronSweep ==
  LET expirable == {r \in Rows :
        /\ status[r] = "pending"
        /\ IsStale(r, now)
        /\ (claimedUntil[r] = -1 \/ claimedUntil[r] <= now)}
      due == {r \in (Rows \ expirable) :
        /\ status[r] = "pending"
        /\ ~IsStale(r, now)
        /\ nextAt[r] <= now
        /\ (claimedUntil[r] = -1 \/ claimedUntil[r] <= now)}
  IN \E batch \in SUBSET due:
       /\ Cardinality(batch) <= SweepLimit
       /\ (expirable /= {} \/ batch /= {})
       /\ status' = [r \in Rows |-> IF r \in expirable THEN "failed" ELSE status[r]]
       /\ lastError' = [r \in Rows |-> IF r \in expirable THEN "expired_stale" ELSE lastError[r]]
       /\ claimToken' = [r \in Rows |->
            IF r \in expirable THEN 0
            ELSE IF r \in batch THEN nextToken
            ELSE claimToken[r]]
       /\ claimedUntil' = [r \in Rows |->
            IF r \in expirable THEN -1
            ELSE IF r \in batch THEN now + 1
            ELSE claimedUntil[r]]
       /\ inflight' = inflight \cup {[row |-> r, token |-> nextToken, fromSweep |-> TRUE, startedAt |-> now] : r \in batch}
       /\ nextToken' = nextToken + 1
       /\ lastBatchSize' = Cardinality(batch)
       /\ UNCHANGED <<now, createdAt, attempts, nextAt, deliveredCount>>

\* 3. Fenced completion (0017): only succeeds if row is still pending and claim_token matches.
CompleteOk(a) ==
  /\ a \in inflight
  /\ LET r == a.row IN
     IF status[r] = "pending" /\ claimToken[r] = a.token THEN
       /\ status' = [status EXCEPT ![r] = "delivered"]
       /\ lastError' = [lastError EXCEPT ![r] = "none"]
       /\ attempts' = [attempts EXCEPT ![r] = attempts[r] + 1]
       /\ deliveredCount' = [deliveredCount EXCEPT ![r] = deliveredCount[r] + 1]
       /\ claimToken' = [claimToken EXCEPT ![r] = 0]
       /\ claimedUntil' = [claimedUntil EXCEPT ![r] = -1]
     ELSE
       /\ UNCHANGED <<status, lastError, attempts, deliveredCount, claimToken, claimedUntil>>
  /\ inflight' = inflight \ {a}
  /\ UNCHANGED <<now, createdAt, nextAt, nextToken, lastBatchSize>>

CompleteErr(a) ==
  /\ a \in inflight
  /\ LET r == a.row IN
     IF status[r] = "pending" /\ claimToken[r] = a.token THEN
       /\ LET nextAtt == attempts[r] + 1 IN
          /\ attempts' = [attempts EXCEPT ![r] = nextAtt]
          /\ status' = [status EXCEPT ![r] = IF nextAtt >= MaxAttempts THEN "failed" ELSE "pending"]
          /\ lastError' = [lastError EXCEPT ![r] = "http_err"]
          /\ nextAt' = [nextAt EXCEPT ![r] = now + 1]
          /\ claimToken' = [claimToken EXCEPT ![r] = 0]
          /\ claimedUntil' = [claimedUntil EXCEPT ![r] = -1]
     ELSE
       /\ UNCHANGED <<status, lastError, attempts, nextAt, claimToken, claimedUntil>>
  /\ inflight' = inflight \ {a}
  /\ UNCHANGED <<now, createdAt, deliveredCount, nextToken, lastBatchSize>>

\* 4. Webhook removal marks pending rows failed and prevents late claim completion.
WebhookRemove(r) ==
  /\ status[r] = "pending"
  /\ status' = [status EXCEPT ![r] = "failed"]
  /\ lastError' = [lastError EXCEPT ![r] = "webhook_removed"]
  /\ UNCHANGED <<now, createdAt, attempts, claimToken, claimedUntil, nextAt,
                 deliveredCount, inflight, nextToken, lastBatchSize>>

\* 5. Discrete clock tick (models lease expiry and crossing 1h stale threshold).
Tick ==
  /\ now < 2
  /\ now' = now + 1
  /\ UNCHANGED <<createdAt, status, lastError, attempts, claimToken, claimedUntil,
                 nextAt, deliveredCount, inflight, nextToken, lastBatchSize>>

Done ==
  /\ \A r \in Rows : status[r] /= "pending"
  /\ inflight = {}
  /\ UNCHANGED vars

Init ==
  /\ now = 0
  /\ createdAt = [r \in Rows |-> IF r = "stale1" THEN -2 ELSE 0]
  /\ status = [r \in Rows |-> "pending"]
  /\ lastError = [r \in Rows |-> "none"]
  /\ attempts = [r \in Rows |-> 0]
  /\ claimToken = [r \in Rows |-> 0]
  /\ claimedUntil = [r \in Rows |-> -1]
  /\ nextAt = [r \in Rows |-> 0]
  /\ deliveredCount = [r \in Rows |-> 0]
  /\ inflight = {}
  /\ nextToken = 1
  /\ lastBatchSize = 0

Next ==
  \/ (\E r \in Rows : PostImmediateDeliver(r))
  \/ CronSweep
  \/ (\E a \in inflight : CompleteOk(a) \/ CompleteErr(a))
  \/ (\E r \in Rows : WebhookRemove(r))
  \/ Tick
  \/ Done

\* Invariants required for cutover safety:
InvDeliveredAtMostOnce ==
  \A r \in Rows : deliveredCount[r] <= 1

InvNoStaleSweepDelivery ==
  \A a \in inflight : a.fromSweep => ~IsStale(a.row, a.startedAt)

InvBatchBound ==
  lastBatchSize <= SweepLimit

InvFreshNotExpiredEarly ==
  \A r \in Rows : lastError[r] = "expired_stale" => IsStale(r, now)

InvRetryCap ==
  \A r \in Rows : attempts[r] <= MaxAttempts
=============================================================================
