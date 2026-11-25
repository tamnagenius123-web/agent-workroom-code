import Workroom.Decidable
namespace Workroom.Reference

/-! Reference byte-emission semantics. This models a canonical ordered sequence
of resolved source chunks. It does not model esbuild, npm resolution, overlay
selection, or a deployed artifact. The resolver-completeness edge is OPEN. -/
inductive EmitChunks : List Bytes → Bytes → Prop where
  | empty : EmitChunks [] []
  | emit (head : Bytes) (rest : List Bytes) (out : Bytes) :
      EmitChunks rest out → EmitChunks (head :: rest) (head ++ out)

theorem emit_unique {chunks : List Bytes} {a b : Bytes}
    (ha : EmitChunks chunks a) (hb : EmitChunks chunks b) : a = b := by
  induction ha generalizing b with
  | empty => cases hb; rfl
  | emit head rest out prev ih =>
    cases hb with
    | emit _ _ other otherProof => rw [ih otherProof]

def canonicalBuild (resolvedInputs : Assembly → List Bytes) (a : Assembly) (bytes : Bytes) :=
  EmitChunks (resolvedInputs a) bytes

theorem R01_proved (inputs : Assembly → List Bytes) :
    R01_AssemblyReproducible (canonicalBuild inputs) := by
  intro recipe a b ha hb
  exact emit_unique ha hb

theorem emit_exists (chunks : List Bytes) : ∃ output, EmitChunks chunks output := by
  induction chunks with
  | nil => exact ⟨[], .empty⟩
  | cons head tail ih =>
    obtain ⟨out, hp⟩ := ih
    exact ⟨head ++ out, .emit head tail out hp⟩

instance providerDecidable (required : List String) (a : Assembly) :
    Decidable (R02_UniqueBoundaryProvider required a) := by
  unfold R02_UniqueBoundaryProvider
  infer_instance

def admitAssembly (required : List String) (a : Assembly) : Option Assembly :=
  if R02_UniqueBoundaryProvider required a then some a else none

theorem R02_proved (required : List String) (a emitted : Assembly)
    (h : admitAssembly required a = some emitted) :
    R02_UniqueBoundaryProvider required emitted := by
  unfold admitAssembly at h
  split at h
  next valid => cases h; exact valid
  · cases h

-- Fixture pins are actual frozen repo heads. A required registry and loader
-- connecting these bindings to production remain missing (R02 production HOLD).
def gateProvider : BoundaryProvider :=
  ⟨"auth/g5", "agent-workroom-gate-mcp/src/auth/g5.ts", "09a9b74a857551f2194a8ed635a11d657b099297"⟩
def stubProvider : BoundaryProvider :=
  ⟨"auth/g5", "agent-workroom-code/src/auth/g5.ts", "b6f8412358920470e9edbe492cde61a693d28bc2"⟩
def recipeA : Assembly :=
  ⟨"b6f8412358920470e9edbe492cde61a693d28bc2", "09a9b74a857551f2194a8ed635a11d657b099297",
   "00a4fbe20a2cbed35c935fe7e0212abcaac6d19b", "lean4:v4.19.0", [gateProvider]⟩

theorem R01_success : EmitChunks [[1,2], [3]] [1,2,3] :=
  .emit [1,2] [[3]] [3] (.emit [3] [] [] .empty)

theorem R01_reject : ¬ EmitChunks [[1,2], [3]] [1,2,4] := by
  intro h
  have hi := emit_unique R01_success h
  cases hi

-- Two permitted environment stamps invalidate reproducibility. This countermodel
-- rejects the claim that repository pins ALONE imply deterministic artifacts.
def unpinnedBuild (_ : Assembly) (out : Bytes) : Prop := out = [0] ∨ out = [1]
theorem R01_counterexample : ¬ R01_AssemblyReproducible unpinnedBuild := by
  intro h
  have hi := h recipeA [0] [1] (Or.inl rfl) (Or.inr rfl)
  cases hi

theorem R02_success : admitAssembly ["auth/g5"] recipeA = some recipeA := by decide
theorem R02_reject : admitAssembly ["auth/g5"]
    { recipeA with boundaryProviders := [gateProvider, stubProvider] } = none := by decide

theorem R02_counterexample : ¬ R02_UniqueBoundaryProvider ["auth/g5"]
    { recipeA with boundaryProviders := [gateProvider, stubProvider] } := by decide

#print axioms R01_proved
#print axioms R02_proved
#print axioms emit_exists
end Workroom.Reference
