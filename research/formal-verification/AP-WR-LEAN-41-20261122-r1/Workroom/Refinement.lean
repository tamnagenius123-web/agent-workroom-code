import Workroom.Concurrency

/-!
X01: a formal countermodel to refining the pinned task-submit guard into the
catalogue's full CanCommit. The guard is a documented manual SQL projection,
cross-checked by actual source-method tests; this is not TS compiler verification.
X02: inductive properties of the explicit reference TaskStep, including an
inhabited bootstrap and claim path. Other system components are not covered.
X03: a conditional fair-fuel lemma. Connecting scheduler events, progress, timeout
and reconciliation of the production supervisor remains an unproved obligation.
-/
namespace Workroom.Refinement
open Workroom.Concurrency

local instance {α : Type} [DecidableEq α] (xs ys : List α) :
    Decidable (Subset xs ys) := by unfold Subset; infer_instance
local instance (i : Identity) (ss : List String) : Decidable (Authorized i ss) := by
  unfold Authorized; infer_instance

structure SourceSnapshot where
  task : Task
  artifactRevisionPresent : Bool
  deriving DecidableEq, Repr

structure SubmitEvent where
  now : Nat
  claim : Claim
  identity : Identity
  deriving DecidableEq, Repr

-- Projection of tasks.ts planAction(submit), lines 229, 240, 244, and access.
-- Intent/watermark metadata is retained in task/claim for the proposed decode,
-- but is absent from the actual SQL predicates and input schema.
def sourceSubmitGuard (s : SourceSnapshot) (e : SubmitEvent) : Prop :=
  s.task.id = e.claim.taskId ∧ s.task.project = e.claim.project ∧
  s.task.version = e.claim.version ∧ s.task.epoch = e.claim.epoch ∧
  s.task.status = .inProgress ∧ s.task.holder = some e.claim.principal ∧
  e.now < s.task.expiresAt ∧ e.identity.principal = e.claim.principal ∧
  Authorized e.identity ["task:write"] ∧ s.artifactRevisionPresent = true

local instance (s : SourceSnapshot) (e : SubmitEvent) : Decidable (sourceSubmitGuard s e) := by
  unfold sourceSubmitGuard; infer_instance

def sourceSubmit (s : SourceSnapshot) (e : SubmitEvent) : Option SourceSnapshot :=
  if sourceSubmitGuard s e then
    some {s with task := {s.task with status := .review, version := s.task.version + 1, expiresAt := 0}}
  else none

def decode (s : SourceSnapshot) : Task := s.task
def sourceStep (a : SourceSnapshot) (e : SubmitEvent) (b : SourceSnapshot) : Prop :=
  sourceSubmit a e = some b
def intendedSubmitStep (a : Task) (e : SubmitEvent) (b : Task) : Prop :=
  CanCommit e.now a e.claim e.identity ∧
  b = {a with status := .review, version := a.version + 1, expiresAt := 0}

def staleWatermarkSnapshot : SourceSnapshot :=
  ⟨{fixtureTask with latestMessage := 43}, true⟩
def submitFixture : SubmitEvent := ⟨50, fixtureClaim, fixtureIdentity⟩
def submittedStale : SourceSnapshot :=
  ⟨{staleWatermarkSnapshot.task with status := .review, version := 4, expiresAt := 0}, true⟩

theorem X01_source_positive : sourceSubmit ⟨fixtureTask, true⟩ submitFixture =
    some ⟨{fixtureTask with status := .review, version := 4, expiresAt := 0}, true⟩ := by decide
theorem X01_source_stale_watermark :
    sourceStep staleWatermarkSnapshot submitFixture submittedStale := by unfold sourceStep; decide
theorem X01_source_projection_refuted :
    ¬ X01_ImplementationRefinement decode sourceStep intendedSubmitStep := by
  intro h
  have hg := (h _ _ _ X01_source_stale_watermark).1.2.2.2.1
  change (42 : Nat) = 43 at hg
  contradiction

theorem X01_source_expiry_rejected :
    sourceSubmit ⟨fixtureTask,true⟩ {submitFixture with now := 100} = none := by decide

def bootstrap (id : TaskId) (project : ProjectId) (specification : Bytes) : Task :=
  ⟨id, project, specification, .open, 1, 0, none, 0, 0, 0, 0, 0⟩

def operationalInvariant (task : Task) : Prop :=
  0 < task.version ∧ (task.status = .inProgress → ∃ p, task.holder = some p)

def anchoredInvariant (anchor task : Task) : Prop :=
  task.specification = anchor.specification ∧ task.id = anchor.id ∧
  task.project = anchor.project ∧ operationalInvariant task

theorem operational_preserved (before after : Task)
    (hinv : operationalInvariant before) (h : TaskStep before after) :
    operationalInvariant after := by
  rcases hinv with ⟨hver, hholder⟩
  cases h with
  | commit now claim identity h =>
    unfold guardedCommit at h
    split at h
    next =>
      cases h
      exact ⟨Nat.zero_lt_succ _, fun hs => by cases hs⟩
    next => contradiction
  | cas expected h =>
    unfold casAdvance at h
    split at h
    next =>
      cases h
      exact ⟨Nat.zero_lt_succ _, hholder⟩
    next => contradiction
  | cancel => exact ⟨Nat.zero_lt_succ _, fun hs => by cases hs⟩
  | intent => exact ⟨Nat.zero_lt_succ _, hholder⟩
  | message => exact ⟨hver, hholder⟩
  | observe => exact ⟨hver, hholder⟩
  | renew now claim identity expiry h =>
    unfold guardedRenew at h
    split at h
    next =>
      cases h
      exact ⟨Nat.zero_lt_succ _, hholder⟩
    next => contradiction
  | claim now expected identity expiry h =>
    unfold guardedClaim at h
    split at h
    next =>
      cases h
      exact ⟨Nat.zero_lt_succ _, fun _ => ⟨identity.principal,rfl⟩⟩
    next => contradiction

theorem X02_proved (id : TaskId) (project : ProjectId) (spec : Bytes) :
    X02_InvariantPreservation
      (fun task => task = bootstrap id project spec)
      (anchoredInvariant (bootstrap id project spec))
      (fun before (_ : Unit) after => TaskStep before after) := by
  constructor
  · intro task h
    subst task
    refine ⟨rfl, rfl, rfl, Nat.zero_lt_succ 0, ?_⟩
    intro hs
    contradiction
  · intro before event after hinv hstep
    have hs := T05_proved before after hstep
    exact ⟨hs.1.symm.trans hinv.1, hs.2.1.symm.trans hinv.2.1,
      hs.2.2.symm.trans hinv.2.2.1, operational_preserved before after hinv.2.2.2 hstep⟩

def initialFixture : Task := bootstrap "task-1" "project-1" [1,2,3]
def claimedFixture : Task := {initialFixture with status := .inProgress, holder := some "worker-A", expiresAt := 100, epoch := 1, version := 2}
theorem X02_nonvacuous_claim : TaskStep initialFixture claimedFixture :=
  .claim 50 1 fixtureIdentity 100 (by decide)
theorem X02_initial_invariant : anchoredInvariant initialFixture initialFixture := by
  exact (X02_proved "task-1" "project-1" [1,2,3]).1 initialFixture rfl
theorem X02_claim_invariant : anchoredInvariant initialFixture claimedFixture :=
  (X02_proved "task-1" "project-1" [1,2,3]).2 _ () _ X02_initial_invariant X02_nonvacuous_claim
theorem X02_bad_bootstrap_countermodel :
    ¬ operationalInvariant {initialFixture with version := 0} := by
  intro h
  exact Nat.lt_irrefl 0 h.1
theorem X02_missing_holder_countermodel :
    ¬ operationalInvariant {initialFixture with status := .inProgress} := by
  intro h
  obtain ⟨p,hp⟩ := h.2 rfl
  contradiction

-- Nonincreasing fuel plus infinitely available scheduled strict decreases.
-- Fairness alone does not imply the strict-decrease premise; that is a separate
-- runner/refinement obligation, explicitly visible in this theorem's type.
theorem fair_fuel_eventually_zero (run : Nat → Nat) (scheduled : Nat → Bool)
    (nonincrease : ∀ t, run (t+1) ≤ run t)
    (onTick : ∀ t, scheduled t = true → 0 < run t → run (t+1) < run t)
    (fair : ∀ t, ∃ u, t ≤ u ∧ scheduled u = true) :
    ∃ t, run t = 0 := by
  have monotone : ∀ t u, t ≤ u → run u ≤ run t := by
    intro t u htu
    obtain ⟨k, rfl⟩ := Nat.exists_eq_add_of_le htu
    induction k with
    | zero => exact Nat.le_refl _
    | succ k ih => exact Nat.le_trans (nonincrease (t+k)) (ih (by omega))
  have descend : ∀ n t, run t = n → ∃ u, t ≤ u ∧ run u = 0 := by
    intro n
    induction n using Nat.strongRecOn with
    | ind n ih =>
      intro t heq
      by_cases hn : n = 0
      · exact ⟨t, Nat.le_refl _, heq.trans hn⟩
      · obtain ⟨u,htu,hs⟩ := fair t
        by_cases hu : run u = 0
        · exact ⟨u,htu,hu⟩
        · have hp : 0 < run u := Nat.pos_of_ne_zero hu
          have hlt : run (u+1) < n := by
            have := onTick u hs hp
            have := monotone t u htu
            omega
          obtain ⟨v,huv,hv⟩ := ih (run (u+1)) hlt (u+1) rfl
          exact ⟨v, by omega, hv⟩
  obtain ⟨t,_,ht⟩ := descend (run 0) 0 rfl
  exact ⟨t,ht⟩

theorem X03_fair_fuel_model (assumptions : ProgressAssumptions Nat)
    (run : Nat → Nat) (scheduled : Nat → Bool)
    (nonincrease : ∀ t, run (t+1) ≤ run t)
    (onTick : ∀ t, scheduled t = true → 0 < run t → run (t+1) < run t)
    (fairRefinement : assumptions.schedulerFair run → ∀ t, ∃ u, t ≤ u ∧ scheduled u = true) :
    X03_ConditionalProgress assumptions (fun fuel => 0 < fuel) (fun fuel => fuel = 0) run := by
  intro hs _hl _hc _hr _hf _ha
  exact fair_fuel_eventually_zero run scheduled nonincrease onTick (fairRefinement hs)

theorem X03_positive_trace : ∃ t, (3 - t : Nat) = 0 := ⟨3, rfl⟩
theorem X03_fairness_without_progress_countermodel :
    (∀ t : Nat, ∃ u, t ≤ u ∧ (true : Bool) = true) ∧
    ¬ (∃ _t : Nat, (1 : Nat) = 0) := by
  constructor
  · intro t; exact ⟨t, Nat.le_refl _,rfl⟩
  · intro ⟨_,h⟩; contradiction

#print axioms X01_source_projection_refuted
#print axioms X02_proved
#print axioms X03_fair_fuel_model
#print axioms X03_fairness_without_progress_countermodel

end Workroom.Refinement
