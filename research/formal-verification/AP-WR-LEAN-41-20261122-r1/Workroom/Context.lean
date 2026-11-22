import Workroom.Memory
namespace Workroom.Reference

-- Reference serializer includes policy and retained exact source bytes. Full
-- provider system/tools/cache envelope remains a separate X01 obligation.
def utf8 (s : String) : Bytes := s.toUTF8.data.toList

def frame (bytes : Bytes) : Bytes := utf8 (toString bytes.length ++ ":") ++ bytes

def sourceWire (authority : Bytes) (sources : List SourceRef) : Bytes :=
  frame authority ++ sources.flatMap (fun s =>
    frame (utf8 s.project) ++ frame (utf8 s.id) ++ frame (utf8 (toString s.revision)) ++
    frame s.bytes ++ frame (utf8 (toString s.approved)) ++ frame (utf8 (toString s.tombstoned)))

def compileSources (input : ContextEmission) : Option ContextEmission :=
  if input.required.all (fun s => decide (UsableSource input.project s)) then
    let selected := input.required ++ retrieve input.project input.selected
    some { input with selected := selected, wireRequest := sourceWire input.authorityPolicy selected }
  else none

theorem C01_proved : C01_MandatoryClosure compileSources := by
  intro input emitted h
  unfold compileSources at h
  split at h
  next good =>
    cases h
    refine ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, ?_, ?_⟩
    · intro s hs
      exact List.mem_append_left _ hs
    · intro s hs
      rcases List.mem_append.mp hs with req | opt
      · exact of_decide_eq_true (List.all_eq_true.mp good s req)
      · exact of_decide_eq_true (List.mem_filter.mp opt).2
  · cases h

def compileTokens (count : String → String → Bytes → Option Nat)
    (input : ContextEmission) : Option ContextEmission :=
  match compileSources input with
  | none => none
  | some e => match count e.model e.tokenizer e.wireRequest with
    | none => none
    | some n => if n + e.reservedOutputTokens ≤ e.contextWindow then
        some { e with measuredInputTokens := n } else none

theorem C02_proved (count : String → String → Bytes → Option Nat)
    (input emitted : ContextEmission) (h : compileTokens count input = some emitted) :
    C02_ExactWireTokenBudget count emitted := by
  unfold compileTokens at h
  split at h
  · cases h
  next e he =>
    split at h
    · cases h
    next n hn =>
      split at h
      next hb =>
        cases h
        exact ⟨hn, hb⟩
      · cases h

def preserveEvidence (required optional : List SourceRef) := required ++ optional

theorem C03_proved (required optional : List SourceRef) :
    C03_CompressionEvidencePreserved required (preserveEvidence required optional) := by
  intro source hs
  exact List.mem_append_left _ hs

-- This tokenizer is ONLY a byte-alphabet fixture. It is not an LLM tokenizer.
def fixtureCount (model tokenizer : String) (wire : Bytes) : Option Nat :=
  if model = "fixture-byte-alphabet" ∧ tokenizer = "bytes-v1" then some wire.length else none

def contextA : ContextEmission := {
  project := "p", model := "fixture-byte-alphabet", authorityPolicy := [1],
  tokenizer := "bytes-v1", wireRequest := [], required := [sourceA],
  selected := [sourceDead, sourceOther], measuredInputTokens := 0,
  reservedOutputTokens := 2, contextWindow := 1000 }

theorem C01_success : (compileSources contextA).isSome = true := by decide
theorem C01_reject : compileSources { contextA with required := [sourceDead] } = none := by decide
theorem C02_success : (compileTokens fixtureCount contextA).isSome = true := by decide
theorem C02_reject : compileTokens fixtureCount { contextA with contextWindow := 3 } = none := by decide
theorem C02_unknown_hold : compileTokens fixtureCount { contextA with tokenizer := "unavailable" } = none := by decide
theorem C03_success : sourceA ∈ preserveEvidence [sourceA] [] := by decide
theorem C03_reject : ¬ C03_CompressionEvidencePreserved [sourceA] [] := by
  intro h
  have hh := h sourceA (by simp)
  cases hh

def unsafeCompile (i : ContextEmission) := some { i with required := [], selected := [] }
theorem C01_counterexample : ¬ C01_MandatoryClosure unsafeCompile := by
  intro h
  have hh := (h contextA _ rfl).2.2.2.2.2.2.1
  simp [contextA] at hh

theorem C02_counterexample : ¬ C02_ExactWireTokenBudget fixtureCount
    { contextA with wireRequest := [1,65], measuredInputTokens := 1 } := by
  unfold C02_ExactWireTokenBudget
  decide

#print axioms C01_proved
#print axioms C02_proved
#print axioms C03_proved
end Workroom.Reference
