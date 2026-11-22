import Workroom.Verification
namespace Workroom.Reference

def allowedCandidate (b c : Harness) : Prop :=
  b.project = c.project ∧ b.policyModel = c.policyModel ∧
  b.authorityPolicy = c.authorityPolicy ∧ b.evaluator = c.evaluator ∧
  Subset c.capabilities b.capabilities ∧ c.maxSteps ≤ b.maxSteps
instance (b c : Harness) : Decidable (allowedCandidate b c) := by
  unfold allowedCandidate; infer_instance

def admitCandidate (b c : Harness) : Bool := decide (allowedCandidate b c)
theorem H01_proved : H01_AllowedHarnessChange admitCandidate := by
  intro b c h
  exact of_decide_eq_true h

def eligible (f : SelectionManifest) (c : Evaluation) : Prop :=
  c.candidate = f.candidate ∧ c.candidate.author = f.submissionAuthor ∧
  c.suite = f.expectedSuite ∧ c.split = "heldout" ∧
  c.totalMicroUsd ≤ f.maxCostMicroUsd ∧ c.scoreBasisPoints ≤ 10000 ∧
  c.safetyFailures = 0 ∧ f.bestEver ≤ c.scoreBasisPoints + f.tolerance ∧
  Authorized c.verifier ["verification:write"] ∧
  c.verifier.principal ∈ f.allowedVerifiers ∧ c.verifier.principal ≠ f.submissionAuthor
instance (f : SelectionManifest) (e : Evaluation) : Decidable (eligible f e) := by
  unfold eligible; infer_instance

def selectCandidate (f : SelectionManifest) (e : Evaluation) := decide (eligible f e)
theorem H02_proved : H02_SelectionGates selectCandidate := by
  intro f c h
  exact of_decide_eq_true h

-- This has dependence on visible history, and no access to the hidden input.
-- Provenance of visible history is a separate, unresolved implementation contract.
def propose (baseline : Harness) (visibleHistory _hidden : Bytes) : Harness :=
  { baseline with implementation := visibleHistory }
theorem H03_proved (baseline : Harness) : H03_NoHeldoutFeedback (propose baseline) := by
  intro _ _ _
  rfl

def promote (current : Harness) (expected : Nat) (candidate : Harness) : Option Harness :=
  if current.version = expected ∧ candidate.version = current.version + 1 ∧
      allowedCandidate current candidate then some candidate else none

theorem promotionCAS : H04_PromotionCAS promote := by
  constructor
  · intro current expected candidate stale
    simp [promote, stale]
  · intro current expected candidate promoted h
    unfold promote at h
    split at h
    next guards => cases h; exact ⟨rfl, guards.2.1⟩
    · cases h

-- The frozen evaluation and the CAS/allowlist are on the same reference path.
def promoteSelected (frozen : SelectionManifest) (evaluation : Evaluation)
    (current : Harness) (expected : Nat) (candidate : Harness) : Option Harness :=
  if candidate = frozen.candidate ∧ selectCandidate frozen evaluation = true
    then promote current expected candidate else none

theorem H04_proved (f : SelectionManifest) (e : Evaluation) :
    H04_PromotionCAS (promoteSelected f e) := by
  constructor
  · intro current expected candidate stale
    unfold promoteSelected
    split
    · exact promotionCAS.1 _ _ _ stale
    · rfl
  · intro current expected candidate promoted h
    unfold promoteSelected at h
    split at h
    · exact promotionCAS.2 _ _ _ _ h
    · cases h

theorem promotion_composes (f : SelectionManifest) (e : Evaluation)
    (b c result : Harness) (expected : Nat)
    (h : promoteSelected f e b expected c = some result) :
    allowedCandidate b c ∧ eligible f e ∧ c = f.candidate := by
  unfold promoteSelected at h
  split at h
  next gates =>
    have he : eligible f e := of_decide_eq_true gates.2
    unfold promote at h
    split at h
    next guards => exact ⟨guards.2.2, he, gates.1⟩
    · cases h
  · cases h

def resolveRun (pin : RunPin) (_head : Harness) := pin.harness
theorem H05_proved : H05_RunningHarnessPinned resolveRun := by
  intro pin registry
  rfl

def rollback (safe : Bytes → Harness → Prop) [∀ a h, Decidable (safe a h)]
    (authority : Bytes) (_bad previous : Harness) : Option Harness :=
  if safe authority previous then some previous else none

theorem H06_proved (safe : Bytes → Harness → Prop) [∀ a h, Decidable (safe a h)] :
    H06_RollbackPreservesSafety safe (rollback safe) := by
  intro authority bad previous restored h
  unfold rollback at h
  split at h
  next hs => cases h; exact ⟨rfl, hs⟩
  · cases h

def harnessA : Harness := ⟨"p", "builder", "model-a", [1], [10], [20], ["read"], 10, 1⟩
def harnessB : Harness := { harnessA with implementation := [2], version := 2 }
def selectionA : SelectionManifest := ⟨harnessB, "builder", [30], ["reviewer"], 8000, 100, 10⟩
def evaluationA : Evaluation := ⟨harnessB, [30], "heldout", 8000, 5, 0,
  ⟨"reviewer", true, false, ["verification:write"]⟩⟩
def fixtureSafe (a : Bytes) (h : Harness) : Prop := a = h.authorityPolicy
instance (a : Bytes) (h : Harness) : Decidable (fixtureSafe a h) := by unfold fixtureSafe; infer_instance

theorem H01_success : admitCandidate harnessA harnessB = true := by decide
theorem H01_reject : admitCandidate harnessA { harnessB with evaluator := [99] } = false := by decide
theorem H02_success : selectCandidate selectionA evaluationA = true := by decide
theorem H02_reject : selectCandidate selectionA
    { evaluationA with verifier := { evaluationA.verifier with principal := "builder" } } = false := by decide
theorem H02_metric_reject : selectCandidate selectionA
    { evaluationA with scoreBasisPoints := 10001 } = false := by decide
theorem H03_success : (propose harnessA [7] [8]).implementation = [7] := rfl
theorem H03_reject : propose harnessA [7] [8] = propose harnessA [7] [9] := rfl
theorem H04_success : promoteSelected selectionA evaluationA harnessA 1 harnessB = some harnessB := by decide
theorem H04_reject : promoteSelected selectionA evaluationA harnessA 0 harnessB = none := by decide
theorem H05_success : resolveRun ⟨"r", "task", harnessA⟩ harnessB = harnessA := rfl
theorem H05_reject : resolveRun ⟨"r", "task", harnessA⟩ harnessB ≠ harnessB := by decide
theorem H06_success : rollback fixtureSafe [10] harnessB harnessA = some harnessA := by decide
theorem H06_reject : rollback fixtureSafe [99] harnessB harnessA = none := by decide

theorem H01_counterexample : ¬ H01_AllowedHarnessChange (fun _ _ => true) := by
  intro h
  have hi := (h harnessA { harnessB with evaluator := [99] } rfl).2.2.2.1
  simp [harnessA] at hi

theorem H02_counterexample : ¬ H02_SelectionGates (fun _ _ => true) := by
  intro h
  have hi := (h selectionA { evaluationA with scoreBasisPoints := 10001 } rfl).2.2.2.2.2.1
  simp at hi

def leakyPropose (base : Harness) (_visible hidden : Bytes) := { base with implementation := hidden }
theorem H03_counterexample : ¬ H03_NoHeldoutFeedback (leakyPropose harnessA) := by
  intro h
  have hi := congrArg Harness.implementation (h [] [1] [2])
  simp [leakyPropose] at hi

theorem H04_counterexample : ¬ H04_PromotionCAS (fun _ _ c => some c) := by
  intro h
  have hi := h.1 harnessA 0 harnessB (by decide)
  cases hi

theorem H05_counterexample : ¬ H05_RunningHarnessPinned (fun _ current => current) := by
  intro h
  have hi := congrArg Harness.version (h ⟨"r", "task", harnessA⟩ harnessB)
  simp [harnessB, harnessA] at hi

theorem H06_counterexample : ¬ H06_RollbackPreservesSafety fixtureSafe
    (fun _ _ previous => some previous) := by
  intro h
  have hi := (h [99] harnessB harnessA harnessA rfl).2
  simp [fixtureSafe, harnessA] at hi

#print axioms H01_proved
#print axioms H02_proved
#print axioms H03_proved
#print axioms H04_proved
#print axioms H05_proved
#print axioms H06_proved
#print axioms promotion_composes
end Workroom.Reference
