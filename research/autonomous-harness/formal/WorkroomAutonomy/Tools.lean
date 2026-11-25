import Std

namespace WorkroomAutonomy

inductive Capability
  | readEvidence | queryModel | cpu | gpu | writeArtifact | externalWrite
  deriving DecidableEq, BEq, Repr

def Allows (grant requirements : List Capability) : Bool :=
  requirements.all (fun c => grant.contains c)

theorem allows_composition (grant left right : List Capability) :
    Allows grant (left ++ right) = (Allows grant left && Allows grant right) := by
  simp [Allows, List.all_append]

/-- A pure typed tool and its semantic certificate.
    Extraction and external-code refinement are separate proof obligations. -/
structure CertifiedTool (α β : Type) where
  run : α → β
  pre : α → Prop
  post : α → β → Prop
  requirements : List Capability
  correct : ∀ x, pre x → post x (run x)

/-- Composition carries both semantic evidence and the union of requirements. -/
def composeTool (a : CertifiedTool α β) (b : CertifiedTool β γ)
    (bridge : ∀ x y, a.post x y → b.pre y) : CertifiedTool α γ where
  run x := b.run (a.run x)
  pre := a.pre
  post x z := ∃ y, a.post x y ∧ b.post y z
  requirements := a.requirements ++ b.requirements
  correct x hx := by
    have ha := a.correct x hx
    exact ⟨a.run x, ha, b.correct (a.run x) (bridge x (a.run x) ha)⟩

theorem tool_semantic_composition
    (a : CertifiedTool α β) (b : CertifiedTool β γ)
    (bridge : ∀ x y, a.post x y → b.pre y) (x : α) (hx : a.pre x) :
    ∃ y, a.post x y ∧ b.post y ((composeTool a b bridge).run x) :=
  (composeTool a b bridge).correct x hx

theorem tool_capability_composition
    (a : CertifiedTool α β) (b : CertifiedTool β γ)
    (bridge : ∀ x y, a.post x y → b.pre y) (grant : List Capability)
    (ha : Allows grant a.requirements = true)
    (hb : Allows grant b.requirements = true) :
    Allows grant (composeTool a b bridge).requirements = true := by
  simp [composeTool, allows_composition, ha, hb]

#print axioms allows_composition
#print axioms tool_semantic_composition
#print axioms tool_capability_composition

end WorkroomAutonomy
