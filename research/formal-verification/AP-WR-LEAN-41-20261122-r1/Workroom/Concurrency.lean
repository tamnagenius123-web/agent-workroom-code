import Workroom.Spec

/-!
Executable guarded reference task transitions. These proofs instantiate the frozen
catalogue, and do not assert a refinement of TypeScript, D1 or deployed workers.
Authority identities and `now` are trusted boundary inputs, not derived from text.
-/
namespace Workroom.Concurrency

local instance {α : Type} [DecidableEq α] (xs ys : List α) :
    Decidable (Subset xs ys) := by unfold Subset; infer_instance
local instance (n : Nat) (t : Task) (c : Claim) : Decidable (ValidLease n t c) := by
  unfold ValidLease; infer_instance
local instance (i : Identity) (ss : List String) : Decidable (Authorized i ss) := by
  unfold Authorized; infer_instance
local instance (n : Nat) (t : Task) (c : Claim) (i : Identity) :
    Decidable (CanCommit n t c i) := by unfold CanCommit; infer_instance

def guardedCommit (now : Nat) (task : Task) (claim : Claim) (identity : Identity) : Option Task :=
  if CanCommit now task claim identity then
    some { task with status := .review, version := task.version + 1 }
  else none

def casAdvance (task : Task) (expectedVersion : Nat) : Option Task :=
  if task.version = expectedVersion then some {task with version := task.version + 1}
  else none

def guardedRenew (now : Nat) (task : Task) (claim : Claim) (identity : Identity)
    (expiry : Nat) : Option Task :=
  if CanCommit now task claim identity ∧ now < expiry then
    some {task with expiresAt := expiry, version := task.version + 1}
  else none

def guardedClaim (now : Nat) (task : Task) (expectedVersion : Nat)
    (identity : Identity) (expiry : Nat) : Option Task :=
  if Authorized identity ["task:write"] ∧ expectedVersion = task.version ∧ now < expiry ∧
      (task.status = .open ∨ task.status = .blocked ∨
        (task.status = .inProgress ∧ task.expiresAt ≤ now)) then
    some {task with status := .inProgress, holder := some identity.principal, expiresAt := expiry, epoch := task.epoch + 1, version := task.version + 1}
  else none

theorem commit_guard {now task claim identity result}
    (h : guardedCommit now task claim identity = some result) :
    CanCommit now task claim identity := by
  unfold guardedCommit at h
  split at h
  next hg => exact hg
  next => contradiction

theorem T01_proved : T01_UniqueCurrentHolder := by
  intro now task a b ha hb
  have h := ha.2.2.2.1.symm.trans hb.2.2.2.1
  exact Option.some.inj h

theorem T02_proved : T02_StaleEpochRejected guardedCommit := by
  intro now task claim identity h
  apply if_neg
  intro hg
  rcases h with hepoch | hguard
  · exact hepoch hg.1.2.2.2.2.2.1.symm
  · exact hguard hg

theorem T03_proved : T03_ExpiredOrCanceledRejected guardedCommit := by
  intro now task claim identity h
  apply if_neg
  intro hg
  rcases h with hexp | hcanceled
  · have hlive := hg.1.2.2.2.2.2.2.2.2
    omega
  · have hstatus := hg.1.2.2.1
    rw [hcanceled] at hstatus
    contradiction

theorem T04_proved : T04_CASRejectsLostUpdate casAdvance := by
  intro task next h
  simp [casAdvance] at h
  subst next
  constructor
  · rfl
  · simp [casAdvance]

-- The transition relation includes useful mutations but has no specification
-- replacement event. A changed task contract requires a separately created Task.
inductive TaskStep : Task → Task → Prop where
  | commit (now claim identity) (h : guardedCommit now before claim identity = some after) :
      TaskStep before after
  | cas (expected) (h : casAdvance before expected = some after) : TaskStep before after
  | cancel : TaskStep task { task with status := .canceled, cancelGeneration := task.cancelGeneration + 1, version := task.version + 1 }
  | intent : TaskStep task { task with intentRevision := task.intentRevision + 1, version := task.version + 1 }
  | message : TaskStep task { task with latestMessage := task.latestMessage + 1 }
  | observe : TaskStep task { task with observedMessage := task.latestMessage }
  | renew (now claim identity expiry)
      (h : guardedRenew now before claim identity expiry = some after) : TaskStep before after
  | claim (now expected identity expiry)
      (h : guardedClaim now before expected identity expiry = some after) : TaskStep before after

theorem T05_proved : T05_ImmutableTaskSpecification TaskStep := by
  intro before after h
  cases h with
  | commit now claim identity h =>
    unfold guardedCommit at h
    split at h
    next => cases h; exact ⟨rfl, rfl, rfl⟩
    next => contradiction
  | cas expected h =>
    unfold casAdvance at h
    split at h
    next => cases h; exact ⟨rfl, rfl, rfl⟩
    next => contradiction
  | cancel => exact ⟨rfl, rfl, rfl⟩
  | intent => exact ⟨rfl, rfl, rfl⟩
  | message => exact ⟨rfl, rfl, rfl⟩
  | observe => exact ⟨rfl, rfl, rfl⟩
  | renew now claim identity expiry h =>
    unfold guardedRenew at h
    split at h
    next => cases h; exact ⟨rfl, rfl, rfl⟩
    next => contradiction
  | claim now expected identity expiry h =>
    unfold guardedClaim at h
    split at h
    next => cases h; exact ⟨rfl, rfl, rfl⟩
    next => contradiction

theorem T06_proved : T06_MessageWatermarkAtCommit guardedCommit := by
  intro now task claim identity result h
  exact (commit_guard h).2.2.2

theorem T07_proved : T07_IntentRevisionAtCommit guardedCommit := by
  intro now task claim identity result h
  have hg := (commit_guard h).1
  exact ⟨hg.2.2.2.2.2.2.1, hg.2.2.2.2.2.2.2.1⟩

def fixtureTask : Task :=
  ⟨"task-1", "project-1", [1,2,3], .inProgress, 3, 7, some "worker-A", 100, 2, 0, 42, 42⟩
def fixtureClaim : Claim := ⟨"task-1", "project-1", "worker-A", 3, 7, 2, 0, 42⟩
def fixtureIdentity : Identity := ⟨"worker-A", true, false, ["task:write"]⟩

theorem T01_positive : ValidLease 50 fixtureTask fixtureClaim := by decide
theorem T01_other_holder_rejected :
    ¬ ValidLease 50 fixtureTask {fixtureClaim with principal := "worker-B"} := by decide
theorem T01_split_snapshots_countermodel :
    ValidLease 50 fixtureTask fixtureClaim ∧
    ValidLease 50 {fixtureTask with holder := some "worker-B"}
      {fixtureClaim with principal := "worker-B"} ∧
    fixtureClaim.principal ≠ ({fixtureClaim with principal := "worker-B"} : Claim).principal := by decide
theorem T02_positive : guardedCommit 50 fixtureTask fixtureClaim fixtureIdentity =
    some {fixtureTask with status := .review, version := 4} := by decide
theorem T02_stale_epoch_rejected :
    guardedCommit 50 fixtureTask {fixtureClaim with epoch := 6} fixtureIdentity = none := by decide
theorem T02_wrong_principal_rejected :
    guardedCommit 50 fixtureTask fixtureClaim {fixtureIdentity with principal := "worker-B"} = none := by decide
theorem T02_readonly_rejected :
    guardedCommit 50 fixtureTask fixtureClaim {fixtureIdentity with scopes := ["task:read"]} = none := by decide
theorem T02_cross_project_rejected :
    guardedCommit 50 fixtureTask {fixtureClaim with project := "project-2"} fixtureIdentity = none := by decide
theorem T03_expired_rejected : guardedCommit 100 fixtureTask fixtureClaim fixtureIdentity = none := by decide
theorem T03_canceled_rejected :
    guardedCommit 50 {fixtureTask with status := .canceled} fixtureClaim fixtureIdentity = none := by decide
theorem T03_expired_renewal_rejected :
    guardedRenew 100 fixtureTask fixtureClaim fixtureIdentity 200 = none := by decide
theorem T04_positive : casAdvance fixtureTask 3 = some {fixtureTask with version := 4} := by decide
theorem T04_replay_rejected : casAdvance {fixtureTask with version := 4} 3 = none := by decide
theorem T05_positive : TaskStep fixtureTask {fixtureTask with status := .review, version := 4} :=
  .commit 50 fixtureClaim fixtureIdentity T02_positive
theorem T05_rewrite_rejected :
    ¬ TaskStep fixtureTask {fixtureTask with specification := [9]} := by
  intro h
  have hs := (T05_proved _ _ h).1
  change ([1,2,3] : Bytes) = [9] at hs
  contradiction
theorem T06_watermark_rejected :
    guardedCommit 50 fixtureTask {fixtureClaim with observedMessage := 41} fixtureIdentity = none := by decide
theorem T06_unobserved_message_rejected :
    guardedCommit 50 {fixtureTask with latestMessage := 43} fixtureClaim fixtureIdentity = none := by decide
theorem T07_intent_rejected :
    guardedCommit 50 {fixtureTask with intentRevision := 3} fixtureClaim fixtureIdentity = none := by decide
theorem T07_cancel_generation_rejected :
    guardedCommit 50 {fixtureTask with cancelGeneration := 1} fixtureClaim fixtureIdentity = none := by decide

-- Deliberately bad alternatives retained as falsification witnesses.
def blindCommit (_ : Nat) (t : Task) (_ : Claim) (_ : Identity) : Option Task := some t
theorem T02_blind_countermodel : ¬ T02_StaleEpochRejected blindCommit := by
  intro h
  have hn := h 50 fixtureTask {fixtureClaim with epoch := 6} fixtureIdentity (Or.inl (by decide))
  contradiction
theorem T03_blind_countermodel : ¬ T03_ExpiredOrCanceledRejected blindCommit := by
  intro h
  have hn := h 100 fixtureTask fixtureClaim fixtureIdentity (Or.inl (by decide))
  contradiction
def blindAdvance (t : Task) (_ : Nat) : Option Task := some {t with version := t.version + 1}
theorem T04_blind_countermodel : ¬ T04_CASRejectsLostUpdate blindAdvance := by
  intro h
  have hn := (h fixtureTask {fixtureTask with version := 4} (by rfl)).2
  contradiction
theorem T06_blind_countermodel : ¬ T06_MessageWatermarkAtCommit blindCommit := by
  intro h
  have hn := (h 50 fixtureTask {fixtureClaim with observedMessage := 41} fixtureIdentity fixtureTask rfl).2
  contradiction
theorem T07_blind_countermodel : ¬ T07_IntentRevisionAtCommit blindCommit := by
  intro h
  have hn := (h 50 fixtureTask {fixtureClaim with intentRevision := 1} fixtureIdentity fixtureTask rfl).1
  contradiction

/-! T00: concrete two-worker histories, with observed return values.
The universally quantified implementation-history theorem remains open.
Both workers invoke CAS(0) on the same canonical task. Success returns new version
1; the second serialized invocation returns failure. IDs identify invocations.
-/
def claimCAS (version : Nat) (expected : Nat) : Nat × Option Nat :=
  if version = expected then (version + 1, some (version + 1)) else (version, none)

def replayObserved (observed : Nat → Option Nat) : Nat → List Nat → Bool
  | _, [] => true
  | version, op :: rest =>
    let transition := claimCAS version 0
    transition.2 == observed op && replayObserved observed transition.1 rest

def invokeTime (id : Nat) : Nat := if id = 0 then 10 else 11
def returnTime (id : Nat) : Nat := if id = 0 then 12 else 13
def successObserved (id : Nat) : Option Nat := if id = 0 then some 1 else none
def splitBrainObserved (_ : Nat) : Option Nat := some 1

theorem T00_positive_history :
    T00_ConcurrentHistoryLinearizable [0,1] invokeTime returnTime
      (fun order => replayObserved successObserved 0 order = true) := by
  refine ⟨by decide, ?_, [0,1], List.Perm.refl _, by decide, ?_⟩
  · intro op hop
    simp only [List.mem_cons, List.not_mem_nil, or_false] at hop
    rcases hop with rfl | rfl <;> decide
  · intro a b ha hb htime
    simp only [List.mem_cons, List.not_mem_nil, or_false] at ha hb
    rcases ha with rfl | rfl <;> rcases hb with rfl | rfl <;>
      simp [invokeTime, returnTime] at htime

theorem permutation_two (order : List Nat) (h : order.Perm [0,1]) :
    order = [0,1] ∨ order = [1,0] := by
  cases order with
  | nil => have hl := h.length_eq; contradiction
  | cons a rest =>
    have hm : a ∈ ([0,1] : List Nat) := h.mem_iff.mp (by simp)
    simp only [List.mem_cons, List.not_mem_nil, or_false] at hm
    rcases hm with rfl | rfl
    · have hr : rest = [1] := List.Perm.eq_singleton ((List.perm_cons 0).mp h)
      subst rest
      exact Or.inl rfl
    · have hs : (1 :: rest).Perm [1,0] := h.trans (List.Perm.swap 1 0 [])
      have hr : rest = [0] := List.Perm.eq_singleton ((List.perm_cons 1).mp hs)
      subst rest
      exact Or.inr rfl

theorem T00_split_brain_refuted :
    ¬ T00_ConcurrentHistoryLinearizable [0,1] invokeTime returnTime
      (fun order => replayObserved splitBrainObserved 0 order = true) := by
  intro h
  rcases h.2.2 with ⟨order, hp, hr, _⟩
  rcases permutation_two order hp with rfl | rfl <;>
    simp [replayObserved, claimCAS, splitBrainObserved] at hr

#print axioms T01_proved
#print axioms T02_proved
#print axioms T03_proved
#print axioms T04_proved
#print axioms T05_proved
#print axioms T06_proved
#print axioms T07_proved
#print axioms T00_positive_history
#print axioms T00_split_brain_refuted

end Workroom.Concurrency
