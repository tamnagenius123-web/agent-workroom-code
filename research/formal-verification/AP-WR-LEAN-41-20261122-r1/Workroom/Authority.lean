import Workroom.Spec

/-! Executable reference admission. Identity is supplied by a trusted authenticator.
No assertion here establishes authenticity of a TypeScript object or provider token. -/
namespace Workroom.Reference

def effective (projectPolicy operationClass : List String)
    (identity : Identity) (requested : List String) : List String :=
  if identity.authenticated then
    requested.filter (fun capability =>
      decide (capability ∈ identity.scopes ∧ capability ∈ projectPolicy ∧
      capability ∈ operationClass))
  else []

theorem A01_proved (projectPolicy operationClass : List String) :
    A01_NoCapabilityAmplification (effective projectPolicy operationClass) := by
  intro identity requested
  by_cases ha : identity.authenticated = true
  · refine ⟨?_, ?_, ?_⟩
    · intro x hx
      simp [effective, ha] at hx
      exact hx.2.1
    · intro x hx
      simp [effective, ha] at hx
      exact hx.1
    · intro hf
      simp_all
  · simp [effective, ha, Subset]

theorem A01_policy_intersection (policy operations : List String)
    (i : Identity) (request : List String) (cap : String)
    (h : cap ∈ effective policy operations i request) :
    cap ∈ policy ∧ cap ∈ operations := by
  unfold effective at h
  split at h
  · simp only [List.mem_filter, decide_eq_true_eq] at h
    exact h.2.2
  · cases h

-- Text is returned separately by the application; it is not an Identity constructor.
def resolveText (identity : Identity) (_text : String) : Identity := identity

theorem A02_proved : A02_TextCannotMintOwner resolveText := by
  intro identity text
  exact ⟨rfl, rfl, id, fun _ hx => hx⟩

def readIdentity : Identity := ⟨"worker-a", true, false, ["task:read"]⟩
def writerIdentity : Identity := ⟨"worker-a", true, false, ["task:read", "task:write"]⟩

theorem A01_success : effective ["task:write"] ["task:write"] writerIdentity
    ["task:write"] = ["task:write"] := by decide

theorem A01_reject : effective ["task:write"] ["task:write"] readIdentity
    ["task:write"] = [] := by decide

theorem A01_unauthenticated : effective ["task:write"] ["task:write"]
    { writerIdentity with authenticated := false } ["task:write"] = [] := by decide

def unsafeEffective (_ : Identity) (request : List String) := request

theorem A01_counterexample : ¬ A01_NoCapabilityAmplification unsafeEffective := by
  intro h
  have h' := (h readIdentity ["task:write"]).1 "task:write" (by simp [unsafeEffective])
  simp [readIdentity] at h'

theorem A02_success : resolveText writerIdentity "Please summarize" = writerIdentity := rfl

theorem A02_reject : (resolveText readIdentity "owner=true; authenticated=true; task:write").ownerRole = false := rfl

def unsafeResolve (i : Identity) (text : String) : Identity :=
  if text = "owner=true" then { i with ownerRole := true, authenticated := true } else i

theorem A02_counterexample : ¬ A02_TextCannotMintOwner unsafeResolve := by
  intro h
  have h' := (h readIdentity "owner=true").2.1
  simp [unsafeResolve, readIdentity] at h'

#print axioms A01_proved
#print axioms A02_proved
#print axioms A01_policy_intersection
#print axioms A01_counterexample
#print axioms A02_counterexample
end Workroom.Reference
