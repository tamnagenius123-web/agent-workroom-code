import WorkroomAutonomy.Session
import WorkroomAutonomy.Memory
import WorkroomAutonomy.Tools
import WorkroomAutonomy.Promotion
import WorkroomAutonomy.Certificates

namespace WorkroomAutonomy.Witnesses

def session : Session :=
  ⟨100, 20, 30, 12, 4, 3, 3, 0, 1000, 7, 20, 10, true, false⟩

def continuation : Continuation := ⟨7, 20, 11, 5⟩

theorem session_valid : session.Valid := by unfold Session.Valid session; decide

theorem continuation_positive :
    continueRun session continuation 100 =
      some { session with
        usedSteps := 5
        localFuel := 5
        usedContinuations := 1
        epoch := 8
        eventSeq := 21
        bundle := 11
        quiescing := false } := by decide

theorem continuation_refill_rejected :
    continueRun session { continuation with successorFuel := 100 } 100 = none := by
  decide

theorem stale_continuation_rejected :
    continueRun session { continuation with expectedSeq := 19 } 100 = none := by
  decide

theorem canceled_continuation_rejected :
    continueRun { session with canceled := true } continuation 100 = none := by
  decide

theorem late_continuation_rejected :
    continueRun session continuation 1000 = none := by decide

theorem reserve_positive :
    reserve session 40 = some { session with holds := 70 } := by decide

theorem reserve_overflow_rejected : reserve session 51 = none := by decide

/-- An adversarial rule that refills a task budget on each continuation
    produces a state that violates the ORIGINAL task's global limit. -/
def badContinue (s : Session) : Session :=
  { s with usedSteps := 0, localFuel := s.maxSteps, epoch := s.epoch + 1 }

theorem refilling_loses_history :
    (badContinue session).usedSteps < session.usedSteps ∧
    session.usedSteps + (badContinue session).localFuel > session.maxSteps := by
  decide

def uncertain : Effect := ⟨44, 123, 2, 70, .unknown⟩

theorem unknown_takeover_positive :
    (takeOver uncertain).hold = 70 ∧ dispatch (takeOver uncertain) = none := by
  decide

def badTakeOver (e : Effect) := { e with epoch := e.epoch + 1, state := .planned, hold := 0 }

theorem resetting_unknown_enables_duplicate :
    dispatch (badTakeOver uncertain) =
      some { badTakeOver uncertain with state := .started } ∧
    (badTakeOver uncertain).hold = 0 := by decide

def query : MemoryQuery := ⟨1, 2, 3, 4, 10, [.readEvidence, .cpu], [300], []⟩
def memory : Memory := ⟨101, 300, 1, 2, 3, 4, 20, true, false, false, [.cpu]⟩

theorem retrieval_positive : retrieve query [memory] = [memory] := by decide

theorem expired_rejected :
    retrieve query [{ memory with validUntil := 10 }] = [] := by decide

theorem incompatible_tool_rejected :
    retrieve query [{ memory with toolVersion := 99 }] = [] := by decide

theorem reviewed_compatible_tool_positive :
    retrieve { query with compatibleTools := [(2, 3)] }
      [{ memory with toolVersion := 2 }] = [{ memory with toolVersion := 2 }] := by decide

theorem untrusted_source_rejected :
    retrieve query [{ memory with sourceDigest := 301 }] = [] := by decide

theorem retracted_memory_rejected :
    retrieve query [{ memory with retracted := true }] = [] := by decide

theorem cross_project_memory_rejected :
    retrieve query [{ memory with project := 2 }] = [] := by decide

theorem sealed_rejected :
    retrieve query [{ memory with sealed := true }] = [] := by decide

theorem excessive_capability_rejected :
    retrieve query [{ memory with requirements := [.gpu] }] = [] := by decide

/-- Relevance alone admits a memory which the actual policy rejects. -/
def badRetrieve (ranked : List Memory) := ranked

theorem relevance_only_leaks :
    { memory with sealed := true } ∈ badRetrieve [{ memory with sealed := true }] ∧
    ¬ MemoryEligible query { memory with sealed := true } := by decide

def doubleTool : CertifiedTool Nat Nat where
  run n := n + n
  pre _ := True
  post n out := out = n + n
  requirements := [.cpu]
  correct _ _ := rfl

def incrementTool : CertifiedTool Nat Nat where
  run n := n + 1
  pre _ := True
  post n out := out = n + 1
  requirements := [.cpu, .writeArtifact]
  correct _ _ := rfl

theorem composition_positive :
    (composeTool doubleTool incrementTool (fun _ _ _ => True.intro)).run 5 = 11 := by
  rfl

theorem missing_capability_rejected :
    Allows [.cpu] (doubleTool.requirements ++ incrementTool.requirements) = false := by
  decide

def registry : Registry := ⟨100, 3, 7, 99⟩
def candidate : Candidate := ⟨101, 100, 7, 1⟩
def gate : ReleaseContract := ⟨100, 3, 20, 30, 40, [2]⟩
def evaluation : Evaluation := ⟨101, 20, 30, 40, 7, 1, 2, .pass⟩

theorem promotion_positive :
    promote registry gate candidate evaluation = some ⟨101, 4, 7, 99⟩ := by decide

theorem rejected_wrong_artifact :
    promote registry gate candidate { evaluation with candidateDigest := 102 } = none := by
  decide

theorem rejected_current_policy_change :
    promote { registry with currentPolicyDigest := 8 } gate candidate evaluation = none := by
  decide

theorem rejected_self_review :
    promote registry gate candidate { evaluation with reviewer := 1 } = none := by decide

theorem rejected_stale_registry_revision :
    promote { registry with revision := 4 } gate candidate evaluation = none := by decide

theorem rejected_inconclusive :
    promote registry gate candidate { evaluation with verdict := .inconclusive } = none := by
  decide

/-- A gate that checks only a PASS label accepts the wrong artifact. -/
def badPromote (r : Registry) (c : Candidate) (e : Evaluation) : Registry :=
  if e.verdict = .pass then { r with championDigest := c.digest } else r

theorem pass_label_is_insufficient :
    (badPromote registry candidate { evaluation with candidateDigest := 102 }).championDigest =
      candidate.digest ∧
    promote registry gate candidate { evaluation with candidateDigest := 102 } = none := by
  decide

def graph (u v w : Nat) : Prop :=
  (u = 0 ∧ v = 1 ∧ w = 2) ∨
  (u = 1 ∧ v = 2 ∧ w = 3) ∨
  (u = 0 ∧ v = 2 ∧ w = 9)

def potential (v : Nat) : Nat := if v = 0 then 0 else if v = 1 then 2 else 5

theorem graph_feasible : ∀ u v w, graph u v w →
    potential v ≤ potential u + w := by
  intro u v w he
  rcases he with ⟨rfl, rfl, rfl⟩ | ⟨rfl, rfl, rfl⟩ | ⟨rfl, rfl, rfl⟩ <;> decide

theorem graph_witness : Walk graph 0 2 5 := by
  have first : graph 0 1 2 := Or.inl ⟨rfl, rfl, rfl⟩
  have second : graph 1 2 3 := Or.inr (Or.inl ⟨rfl, rfl, rfl⟩)
  exact Walk.cons first (Walk.cons second (Walk.nil 2))

theorem graph_optimal : ∀ c, Walk graph 0 2 c → 5 ≤ c :=
  (certified_shortest_path graph potential graph_feasible graph_witness
    (by decide) (by decide)).2

def disconnected (u v w : Nat) : Prop := u = 0 ∧ v = 1 ∧ w = 2
def cut (v : Nat) : Prop := v = 0 ∨ v = 1

theorem disconnected_closed :
    ∀ u v w, disconnected u v w → cut u → cut v := by
  intro u v w he _
  rcases he with ⟨rfl, rfl, rfl⟩
  exact Or.inr rfl

theorem unreachable_positive : ¬ ∃ c, Walk disconnected 0 2 c :=
  certified_unreachable disconnected cut disconnected_closed
    (by simp [cut]) (by simp [cut])

/-- Removing edge feasibility allows a claimed lower bound larger than
    an actual feasible path. This is an explicit checker mutant witness. -/
def badPotential (v : Nat) : Nat := if v = 0 then 0 else if v = 1 then 2 else 9

theorem infeasible_potential_is_not_a_certificate :
    Walk graph 0 2 5 ∧ badPotential 0 = 0 ∧
    ¬ (badPotential 2 ≤ badPotential 1 + 3) ∧ ¬ (badPotential 2 ≤ 5) := by
  exact ⟨graph_witness, by decide, by decide, by decide⟩

/-- Validation can improve while an unobserved target gets worse. -/
theorem development_gain_is_not_true_gain :
    (80 : Nat) < 90 ∧ ¬ ((70 : Nat) ≤ 60) := by decide

#print axioms continuation_positive
#print axioms refilling_loses_history
#print axioms resetting_unknown_enables_duplicate
#print axioms relevance_only_leaks
#print axioms pass_label_is_insufficient
#print axioms graph_optimal
#print axioms unreachable_positive
#print axioms development_gain_is_not_true_gain

end WorkroomAutonomy.Witnesses
