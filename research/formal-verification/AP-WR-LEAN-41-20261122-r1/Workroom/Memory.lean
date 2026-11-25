import Workroom.Decidable
namespace Workroom.Reference

def retrieve (project : ProjectId) (corpus : List SourceRef) : List SourceRef :=
  corpus.filter (fun s => decide (UsableSource project s))

theorem M01_proved : M01_NoTombstoneResurrection retrieve := by
  intro project corpus source h
  have hs := List.mem_filter.mp h
  have hu : UsableSource project source := of_decide_eq_true hs.2
  exact ⟨hs.1, hu.2⟩

theorem M02_proved : M02_RetrievalScopeIsolation retrieve := by
  intro project corpus source h
  have hu : UsableSource project source := of_decide_eq_true (List.mem_filter.mp h).2
  exact hu.1

def revise (original replacement : SourceRef) : Bool :=
  decide (original.project = replacement.project ∧ original.id = replacement.id ∧
    replacement.revision = original.revision + 1)

theorem M03_proved : M03_ExactSourceLineage revise := by
  intro a b h
  exact of_decide_eq_true h

def sourceA : SourceRef := ⟨"p", "source", 1, [65], true, false⟩
def sourceDead : SourceRef := { sourceA with tombstoned := true }
def sourceOther : SourceRef := { sourceA with project := "q" }

theorem M01_success : retrieve "p" [sourceA] = [sourceA] := by decide
theorem M01_reject : retrieve "p" [sourceDead] = [] := by decide
theorem M02_success : retrieve "p" [sourceOther, sourceA] = [sourceA] := by decide
theorem M02_reject : retrieve "p" [sourceOther] = [] := by decide
theorem M03_success : revise sourceA { sourceA with revision := 2, bytes := [66] } = true := by decide
theorem M03_reject : revise sourceA { sourceA with revision := 0 } = false := by decide

def unsafeRetrieve (_project : ProjectId) (corpus : List SourceRef) := corpus

theorem M01_counterexample : ¬ M01_NoTombstoneResurrection unsafeRetrieve := by
  intro h
  have h' := (h "p" [sourceDead] sourceDead (by simp [unsafeRetrieve])).2.2
  simp [sourceDead] at h'

theorem M02_counterexample : ¬ M02_RetrievalScopeIsolation unsafeRetrieve := by
  intro h
  have h' := h "p" [sourceOther] sourceOther (by simp [unsafeRetrieve])
  simp [sourceOther] at h'

theorem M03_counterexample : ¬ M03_ExactSourceLineage (fun _ _ => true) := by
  intro h
  have h' := (h sourceA sourceA rfl).2.2
  simp [sourceA] at h'

-- A stale authoritative input cannot be repaired by the same filter: this is a
-- concrete, accepted stale-source witness, not a proof about external cache freshness.
theorem M01_stale_snapshot_limitation :
    sourceA ∈ retrieve "p" [sourceA] ∧ sourceDead.tombstoned = true := by decide

#print axioms M01_proved
#print axioms M02_proved
#print axioms M03_proved
end Workroom.Reference
