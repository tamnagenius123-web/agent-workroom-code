import Workroom.Decidable
namespace Workroom.Reference

-- Explicitly a new reference gate; the frozen manifest is a separate argument.
def approve (manifest : VerificationManifest) (receipt : Verification) : Bool :=
  decide (AcceptableReceipt manifest receipt)

theorem V01_proved : V01_IndependentExactAcceptance approve := by
  intro manifest receipt h
  exact of_decide_eq_true h

def aggregate (receipt : Verification) : Bool :=
  receipt.passed && receipt.failedShards.isEmpty

theorem V02_proved : V02_FailDominatesAggregation aggregate := by
  intro receipt failed
  simp [aggregate, List.isEmpty_eq_false_iff.mpr failed]

def artifactA : Artifact := ⟨"p", "task", 1, [1,2,3], "source-sha-a", "env-a", "suite-a"⟩
def manifestA : VerificationManifest :=
  ⟨artifactA, "builder", ["compile", "tests"], ["reviewer"], [10]⟩
def receiptA : Verification := {
  author := "builder", verifier := ⟨"reviewer", true, false, ["verification:write"]⟩,
  artifact := artifactA, manifest := manifestA,
  observedShards := ["compile", "tests"], failedShards := [], passed := true }

theorem V01_success : approve manifestA receiptA = true := by decide
theorem V01_reject : approve manifestA { receiptA with artifact := { artifactA with content := [4] } } = false := by decide
theorem V01_self_author_reject : approve manifestA
    { receiptA with verifier := { receiptA.verifier with principal := "builder" } } = false := by decide
theorem V01_missing_shard_reject : approve manifestA
    { receiptA with observedShards := ["compile"] } = false := by decide
theorem V01_fabricated_manifest_reject : approve manifestA
    { receiptA with manifest := { manifestA with expectedShards := ["compile"] }, observedShards := ["compile"] } = false := by decide

theorem V02_success : aggregate receiptA = true := by decide
theorem V02_reject : aggregate { receiptA with failedShards := ["tests"] } = false := by decide

def unsafeApprove (_ : VerificationManifest) (receipt : Verification) := receipt.passed

theorem V01_counterexample : ¬ V01_IndependentExactAcceptance unsafeApprove := by
  intro h
  have hi := (h manifestA { receiptA with artifact := { artifactA with content := [4] } } rfl).2.1
  have hc := congrArg Artifact.content hi
  simp [manifestA, artifactA] at hc

theorem V02_counterexample : ¬ V02_FailDominatesAggregation (fun r => r.passed) := by
  intro h
  have hi := h { receiptA with failedShards := ["tests"] } (by decide)
  simp [receiptA] at hi

#print axioms V01_proved
#print axioms V02_proved
end Workroom.Reference
