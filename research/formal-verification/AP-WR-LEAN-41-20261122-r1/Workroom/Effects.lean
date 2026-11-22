import Workroom.Spec

/-! Reference transition system, not a proof about the production provider or
D1. Durability is an atomic storage event here. Its refinement is a separate
obligation. Timestamps below are durable event-order counters, not wall-clock
milliseconds. UNKNOWN/STARTED never become PLANNED on takeover. -/
namespace Workroom.EffectsModel

structure IntakeState where
  clock : Nat
  durable : List InboxItem
  acknowledged : List InboxItem
  persistedAt : InboxItem → Nat
  advancedAt : InboxItem → Nat

def initialIntake : IntakeState := ⟨0, [], [], fun _ => 0, fun _ => 0⟩

def persist (s : IntakeState) (item : InboxItem) : IntakeState :=
  if item ∈ s.durable then s
  else { s with
    clock := s.clock + 1
    durable := item :: s.durable
    persistedAt := fun x => if x = item then s.clock + 1 else s.persistedAt x }

def advance (s : IntakeState) (item : InboxItem) : IntakeState :=
  if item ∈ s.durable ∧ s.persistedAt item < s.clock + 1 then
    { s with
      clock := s.clock + 1
      acknowledged := item :: s.acknowledged
      advancedAt := fun x => if x = item then s.clock + 1 else s.advancedAt x }
  else s

def IntakeInvariant (s : IntakeState) : Prop :=
  E01_DurableIntakeBeforeCursor s.acknowledged s.durable s.persistedAt s.advancedAt

theorem initial_intake_valid : IntakeInvariant initialIntake := by
  constructor
  · intro item h; cases h
  · intro item h; cases h

theorem persist_preserves (s : IntakeState) (item : InboxItem)
    (hinv : IntakeInvariant s) : IntakeInvariant (persist s item) := by
  unfold persist
  split
  next => exact hinv
  next hnew =>
    rcases hinv with ⟨hsub, horder⟩
    constructor
    · intro x hx
      exact List.mem_cons_of_mem item (hsub x hx)
    · intro x hx
      have hne : x ≠ item := by
        intro heq
        subst x
        exact hnew (hsub item hx)
      simpa [hne] using horder x hx

theorem advance_preserves (s : IntakeState) (item : InboxItem)
    (hinv : IntakeInvariant s) : IntakeInvariant (advance s item) := by
  unfold advance
  split
  next hguard =>
    rcases hinv with ⟨hsub, horder⟩
    constructor
    · intro x hx
      rcases List.mem_cons.mp hx with heq | hold
      · simpa [heq] using hguard.1
      · exact hsub x hold
    · intro x hx
      by_cases heq : x = item
      · subst x
        simpa using hguard.2
      · have hold : x ∈ s.acknowledged := by
          rcases List.mem_cons.mp hx with h | h
          · exact False.elim (heq h)
          · exact h
        simpa [heq] using horder x hold
  next => exact hinv

inductive IntakeOp where
  | persist (item : InboxItem)
  | advance (item : InboxItem)

def intakeStep (s : IntakeState) : IntakeOp → IntakeState
  | .persist item => persist s item
  | .advance item => advance s item

def runIntake (s : IntakeState) : List IntakeOp → IntakeState
  | [] => s
  | op :: rest => runIntake (intakeStep s op) rest

theorem run_intake_preserves (ops : List IntakeOp) (s : IntakeState)
    (hinv : IntakeInvariant s) : IntakeInvariant (runIntake s ops) := by
  induction ops generalizing s with
  | nil => exact hinv
  | cons op rest ih =>
    apply ih
    cases op with
    | persist item => exact persist_preserves s item hinv
    | advance item => exact advance_preserves s item hinv

-- Exact original E01 predicate, reached by induction over arbitrary operation
-- histories including advance-before-persist, repeats and interleaved projects.
theorem E01_proved (ops : List IntakeOp) :
    let s := runIntake initialIntake ops
    E01_DurableIntakeBeforeCursor s.acknowledged s.durable s.persistedAt s.advancedAt := by
  exact run_intake_preserves ops initialIntake initial_intake_valid

def maySend (effect : Effect) : Bool := effect.state == .planned

theorem E02_proved : E02_UnknownNeverBlindlyReissued maySend := by
  intro effect h
  simp [maySend, h]

def takeover (effect : Effect) (newEpoch : Nat) : Option Effect :=
  if effect.attemptEpoch < newEpoch then some { effect with attemptEpoch := newEpoch }
  else none

theorem E03_proved : E03_TakeoverPreservesLogicalId takeover := by
  intro effect newEpoch adopted h
  unfold takeover at h
  split at h
  next hepoch =>
    cases h
    exact ⟨hepoch, rfl, ⟨rfl, rfl, rfl, rfl⟩, rfl, rfl, rfl⟩
  next => contradiction

instance (a b : Effect) : Decidable (SameLogicalEffect a b) := by
  unfold SameLogicalEffect
  infer_instance

def replay (recorded requested : Effect) : Bool :=
  decide (SameLogicalEffect recorded requested ∧ recorded.request = requested.request)

theorem E04_proved : E04_ConflictingIdempotencyRejected replay := by
  intro recorded requested h
  exact of_decide_eq_true h

def resume (expected observed : Artifact) : Bool := expected == observed

theorem E05_proved : E05_RecoveryBindsExactCheckpoint resume := by
  intro expected observed h
  exact of_decide_eq_true h

def item0 : InboxItem := ⟨"project-a", "room", "event-1", [7]⟩
def effect0 : Effect := ⟨"project-a", "task-a", 2, "logical-1", 5, [7], .planned, none⟩
def artifact0 : Artifact := ⟨"project-a", "task-a", 2, [7], "commit-a", "env-a", "suite-a"⟩

theorem E01_success :
    (runIntake initialIntake [.persist item0, .advance item0]).acknowledged = [item0] ∧
    (runIntake initialIntake [.persist item0, .advance item0]).persistedAt item0 = 1 ∧
    (runIntake initialIntake [.persist item0, .advance item0]).advancedAt item0 = 2 := by decide
theorem E01_reject : (advance initialIntake item0).acknowledged = [] := by decide
theorem E01_counterexample : ¬ E01_DurableIntakeBeforeCursor [item0] [] (fun _ => 0) (fun _ => 1) := by
  intro h
  have impossible : item0 ∈ ([] : List InboxItem) := h.1 item0 (by simp)
  cases impossible

theorem E02_success : maySend effect0 = true := by decide
theorem E02_reject : maySend { effect0 with state := .unknown } = false ∧
    maySend { effect0 with state := .started } = false := by decide
theorem E02_counterexample :
    ({ effect0 with state := .started }.state != EffectState.unknown) = true := by decide

theorem E03_success : takeover { effect0 with state := .unknown, providerReceipt := some "g1" } 6 =
    some { effect0 with state := .unknown, providerReceipt := some "g1", attemptEpoch := 6 } := by decide
theorem E03_reject : takeover effect0 5 = none ∧ takeover effect0 4 = none := by decide
theorem E03_counterexample :
    ¬ SameLogicalEffect effect0 { effect0 with logicalId := "new-logical-id", attemptEpoch := 6 } := by decide

theorem E04_success : replay effect0 effect0 = true := by decide
theorem E04_reject : replay effect0 { effect0 with request := [8] } = false ∧
    replay effect0 { effect0 with project := "project-b" } = false := by decide
theorem E04_counterexample :
    effect0.logicalId = { effect0 with project := "project-b" }.logicalId ∧
    ¬ SameLogicalEffect effect0 { effect0 with project := "project-b" } := by decide

theorem E05_success : resume artifact0 artifact0 = true := by decide
theorem E05_reject : resume artifact0 { artifact0 with sourceCommit := "commit-b" } = false := by decide
theorem E05_counterexample :
    artifact0.content = { artifact0 with sourceCommit := "commit-b" }.content ∧
    artifact0 ≠ { artifact0 with sourceCommit := "commit-b" } := by decide

def onlyUnknownBlocked (e : Effect) : Bool := e.state != .unknown
theorem E02_bad_spec : ¬ E02_UnknownNeverBlindlyReissued onlyUnknownBlocked := by
  intro h
  have bad := h { effect0 with state := .started } (by decide)
  contradiction

def replanOnTakeover (e : Effect) (epoch : Nat) : Option Effect :=
  if e.attemptEpoch < epoch then some { e with attemptEpoch := epoch, state := .planned }
  else none
theorem E03_bad_spec : ¬ E03_TakeoverPreservesLogicalId replanOnTakeover := by
  intro h
  have bad := h { effect0 with state := .unknown } 6
    { effect0 with attemptEpoch := 6, state := .planned } (by decide)
  simp [effect0] at bad

def logicalIdOnly (a b : Effect) : Bool := a.logicalId == b.logicalId
theorem E04_bad_spec : ¬ E04_ConflictingIdempotencyRejected logicalIdOnly := by
  intro h
  have bad := h effect0 { effect0 with project := "project-b" } (by decide)
  simp [SameLogicalEffect, effect0] at bad

def contentOnly (a b : Artifact) : Bool := a.content == b.content
theorem E05_bad_spec : ¬ E05_RecoveryBindsExactCheckpoint contentOnly := by
  intro h
  have bad := h artifact0 { artifact0 with sourceCommit := "commit-b" } (by decide)
  exact E05_counterexample.2 bad

#print axioms E01_proved
#print axioms E02_proved
#print axioms E03_proved
#print axioms E04_proved
#print axioms E05_proved

end Workroom.EffectsModel
