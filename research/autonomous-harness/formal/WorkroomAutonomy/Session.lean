import Std
import Lean.Elab.Tactic.Omega

namespace WorkroomAutonomy

/-- Counted holds include UNKNOWN liabilities. Actual provider charges are not
    inferred from this bounded reservation model. -/
structure Session where
  cap : Nat
  spent : Nat
  holds : Nat
  maxSteps : Nat
  usedSteps : Nat
  localFuel : Nat
  maxContinuations : Nat
  usedContinuations : Nat
  deadline : Nat
  epoch : Nat
  eventSeq : Nat
  bundle : Nat
  quiescing : Bool
  canceled : Bool
  deriving DecidableEq, Repr

def Session.Valid (s : Session) : Prop :=
  s.spent + s.holds ≤ s.cap ∧
  s.usedSteps + s.localFuel ≤ s.maxSteps ∧
  s.usedContinuations ≤ s.maxContinuations

def reserve (s : Session) (amount : Nat) : Option Session :=
  if s.spent + s.holds + amount ≤ s.cap then
    some { s with holds := s.holds + amount }
  else none

theorem reserve_preserves (s t : Session) (amount : Nat)
    (hs : s.Valid) (h : reserve s amount = some t) : t.Valid := by
  unfold reserve at h
  split at h
  next bound =>
    cases h
    rcases hs with ⟨_, fuel, continuations⟩
    exact ⟨by simpa [Nat.add_assoc] using bound, fuel, continuations⟩
  next => contradiction

def step (s : Session) (now : Nat) : Option Session :=
  if s.canceled = false ∧ s.quiescing = false ∧
      now < s.deadline ∧ 0 < s.localFuel then
    some { s with usedSteps := s.usedSteps + 1,
                  localFuel := s.localFuel - 1, eventSeq := s.eventSeq + 1 }
  else none

theorem step_preserves (s t : Session) (now : Nat)
    (hs : s.Valid) (h : step s now = some t) :
    t.Valid ∧ t.usedSteps = s.usedSteps + 1 ∧ now < s.deadline ∧
      t.maxSteps = s.maxSteps := by
  unfold step at h
  split at h
  next guard =>
    cases h
    rcases hs with ⟨budget, fuel, continuations⟩
    rcases guard with ⟨_, _, beforeDeadline, positiveFuel⟩
    refine ⟨⟨budget, ?_, continuations⟩, rfl, beforeDeadline, rfl⟩
    simp only
    omega
  next => contradiction

structure Continuation where
  expectedEpoch : Nat
  expectedSeq : Nat
  successorBundle : Nat
  successorFuel : Nat
  deriving DecidableEq, Repr

def CanContinue (s : Session) (r : Continuation) (now : Nat) : Prop :=
  s.quiescing = true ∧ s.canceled = false ∧
  s.epoch = r.expectedEpoch ∧ s.eventSeq = r.expectedSeq ∧
  now < s.deadline ∧ s.usedContinuations < s.maxContinuations ∧
  s.usedSteps + 1 + r.successorFuel ≤ s.maxSteps

instance (s : Session) (r : Continuation) (now : Nat) :
    Decidable (CanContinue s r now) := by
  unfold CanContinue
  infer_instance

/-- One atomic reference transition; durable transaction refinement is OPEN. -/
def continueRun (s : Session) (r : Continuation) (now : Nat) : Option Session :=
  if CanContinue s r now then
    some { s with
      usedSteps := s.usedSteps + 1
      localFuel := r.successorFuel
      usedContinuations := s.usedContinuations + 1
      epoch := s.epoch + 1
      eventSeq := s.eventSeq + 1
      bundle := r.successorBundle
      quiescing := false }
  else none

theorem continuation_preserves (s t : Session) (r : Continuation) (now : Nat)
    (hs : s.Valid) (h : continueRun s r now = some t) :
    t.Valid ∧ t.cap = s.cap ∧ t.spent = s.spent ∧
    t.holds = s.holds ∧ t.deadline = s.deadline ∧
    t.maxSteps = s.maxSteps ∧ t.usedSteps = s.usedSteps + 1 ∧
    t.epoch = s.epoch + 1 := by
  unfold continueRun at h
  split at h
  next guard =>
    cases h
    rcases hs with ⟨budget, _, _⟩
    rcases guard with ⟨_, _, _, _, _, continuations, fuel⟩
    refine ⟨⟨budget, fuel, ?_⟩, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩
    simp only
    omega
  next => contradiction

theorem stale_checkpoint_rejected (s : Session) (r : Continuation) (now : Nat)
    (stale : s.epoch ≠ r.expectedEpoch ∨ s.eventSeq ≠ r.expectedSeq) :
    continueRun s r now = none := by
  unfold continueRun
  split
  next guard =>
    rcases guard with ⟨_, _, he, hs, _⟩
    rcases stale with bad | bad
    · exact False.elim (bad he)
    · exact False.elim (bad hs)
  next => rfl

/-- A task cannot acquire new global fuel by starting new runs. -/
theorem no_global_fuel_refill (s t : Session) (r : Continuation) (now : Nat)
    (hs : s.Valid) (h : continueRun s r now = some t) :
    t.maxSteps - t.usedSteps ≤ s.maxSteps - s.usedSteps := by
  obtain ⟨_, _, _, _, _, maxEq, usedEq, _⟩ :=
    continuation_preserves s t r now hs h
  rw [maxEq, usedEq]
  omega

/-- Progress actions consume one task-global step. Reservations and external
    waiting are not included; this is not a wall-clock termination theorem. -/
inductive ProgressTransition : Session → Session → Prop
  | step {s t : Session} {now : Nat} (success : step s now = some t) :
      ProgressTransition s t
  | continued {s t : Session} {r : Continuation} {now : Nat}
      (success : continueRun s r now = some t) : ProgressTransition s t

theorem progress_preserves {s t : Session} (hs : s.Valid)
    (transition : ProgressTransition s t) :
    t.Valid ∧ t.usedSteps = s.usedSteps + 1 ∧ t.maxSteps = s.maxSteps := by
  cases transition with
  | step success =>
    obtain ⟨valid, used, _, cap⟩ := step_preserves _ _ _ hs success
    exact ⟨valid, used, cap⟩
  | continued success =>
    obtain ⟨valid, _, _, _, _, cap, used, _⟩ := continuation_preserves _ _ _ _ hs success
    exact ⟨valid, used, cap⟩

inductive ProgressTrace : Nat → Session → Session → Prop
  | nil (s : Session) : ProgressTrace 0 s s
  | cons {s mid t : Session} {n : Nat} :
      ProgressTransition s mid → ProgressTrace n mid t → ProgressTrace (n + 1) s t

theorem trace_preserves {s t : Session} {n : Nat} (hs : s.Valid)
    (trace : ProgressTrace n s t) :
    t.Valid ∧ t.usedSteps = s.usedSteps + n ∧ t.maxSteps = s.maxSteps := by
  induction trace with
  | nil s => exact ⟨hs, by omega, rfl⟩
  | @cons s mid t n transition tail ih =>
    obtain ⟨midValid, midUsed, midCap⟩ := progress_preserves hs transition
    obtain ⟨endValid, endUsed, endCap⟩ := ih midValid
    refine ⟨endValid, ?_, ?_⟩
    · omega
    · exact endCap.trans midCap

theorem trace_length_bounded {s t : Session} {n : Nat} (hs : s.Valid)
    (trace : ProgressTrace n s t) : n ≤ s.maxSteps - s.usedSteps := by
  obtain ⟨valid, used, cap⟩ := trace_preserves hs trace
  obtain ⟨_, fuel, _⟩ := valid
  omega

inductive EffectState
  | planned | started | succeeded | failedNoEffect | partialEffect | unknown
  deriving DecidableEq, Repr

structure Effect where
  logicalId : Nat
  requestDigest : Nat
  epoch : Nat
  hold : Nat
  state : EffectState
  deriving DecidableEq, Repr

def dispatch (e : Effect) : Option Effect :=
  if e.state = .planned then some { e with state := .started } else none

def takeOver (e : Effect) : Effect := { e with epoch := e.epoch + 1 }

theorem unknown_never_reissued (e : Effect) (h : e.state = .unknown) :
    dispatch e = none ∧ dispatch (takeOver e) = none := by
  simp [dispatch, takeOver, h]

theorem takeover_preserves_identity (e : Effect) :
    (takeOver e).logicalId = e.logicalId ∧
    (takeOver e).requestDigest = e.requestDigest ∧
    (takeOver e).hold = e.hold ∧
    (takeOver e).state = e.state := by
  exact ⟨rfl, rfl, rfl, rfl⟩

#print axioms reserve_preserves
#print axioms step_preserves
#print axioms continuation_preserves
#print axioms stale_checkpoint_rejected
#print axioms no_global_fuel_refill
#print axioms progress_preserves
#print axioms trace_preserves
#print axioms trace_length_bounded
#print axioms unknown_never_reissued
#print axioms takeover_preserves_identity

end WorkroomAutonomy
