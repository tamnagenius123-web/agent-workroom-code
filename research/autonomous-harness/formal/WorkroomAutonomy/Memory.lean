import WorkroomAutonomy.Tools

namespace WorkroomAutonomy

/-- Metadata is supplied by the trusted catalog/reviewer; digest authenticity,
    content safety and completeness of the catalog are not proved here. -/
structure Memory where
  digest : Nat
  sourceDigest : Nat
  project : Nat
  family : Nat
  toolVersion : Nat
  policyVersion : Nat
  validUntil : Nat
  reviewed : Bool
  retracted : Bool
  sealed : Bool
  requirements : List Capability
  deriving DecidableEq, Repr

structure MemoryQuery where
  project : Nat
  family : Nat
  toolVersion : Nat
  policyVersion : Nat
  now : Nat
  grant : List Capability
  trustedSources : List Nat
  /-- Reviewed directional compatibility pairs (recorded version, current version).
      A semver string or an agent's assertion alone must not populate this list. -/
  compatibleTools : List (Nat × Nat)
  deriving DecidableEq, Repr

def ToolCompatible (q : MemoryQuery) (m : Memory) : Prop :=
  m.toolVersion = q.toolVersion ∨ (m.toolVersion, q.toolVersion) ∈ q.compatibleTools

def MemoryEligible (q : MemoryQuery) (m : Memory) : Prop :=
  m.sourceDigest ∈ q.trustedSources ∧
  m.project = q.project ∧ m.family = q.family ∧
  ToolCompatible q m ∧ m.policyVersion = q.policyVersion ∧
  q.now < m.validUntil ∧ m.reviewed = true ∧
  m.retracted = false ∧ m.sealed = false ∧
  Allows q.grant m.requirements = true

instance (q : MemoryQuery) (m : Memory) : Decidable (MemoryEligible q m) := by
  unfold MemoryEligible ToolCompatible
  infer_instance

/-- Apply policy after any relevance ranking. Scores cannot override admission. -/
def retrieve (q : MemoryQuery) (ranked : List Memory) : List Memory :=
  ranked.filter (fun m => decide (MemoryEligible q m))

theorem retrieval_sound (q : MemoryQuery) (ranked : List Memory) (m : Memory)
    (h : m ∈ retrieve q ranked) : MemoryEligible q m := by
  simp only [retrieve, List.mem_filter] at h
  exact of_decide_eq_true h.2

theorem retrieval_never_sealed (q : MemoryQuery) (ranked : List Memory)
    (m : Memory) (h : m ∈ retrieve q ranked) : m.sealed = false := by
  exact (retrieval_sound q ranked m h).2.2.2.2.2.2.2.2.1

theorem retrieval_compatible_tool (q : MemoryQuery) (ranked : List Memory)
    (m : Memory) (h : m ∈ retrieve q ranked) : ToolCompatible q m := by
  exact (retrieval_sound q ranked m h).2.2.2.1

theorem retrieval_provenance_scope (q : MemoryQuery) (ranked : List Memory)
    (m : Memory) (h : m ∈ retrieve q ranked) :
    m.sourceDigest ∈ q.trustedSources ∧ m.project = q.project ∧ m.family = q.family := by
  have admitted := retrieval_sound q ranked m h
  exact ⟨admitted.1, admitted.2.1, admitted.2.2.1⟩

#print axioms retrieval_sound
#print axioms retrieval_never_sealed
#print axioms retrieval_compatible_tool
#print axioms retrieval_provenance_scope

end WorkroomAutonomy
