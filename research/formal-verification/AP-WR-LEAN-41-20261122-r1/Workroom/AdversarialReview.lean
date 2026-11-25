import Workroom.Context
import Workroom.Verification
import Workroom.RSI
import Workroom.Concurrency

/-! Non-author adversarial review. These theorems expose the exact scope of
reference predicates; they do not contradict the correctly scoped theorems. -/
namespace Workroom.IndependentReview
open Workroom.Reference

theorem aggregation_alone_accepts_missing_shard :
    aggregate { receiptA with observedShards := ["compile"] } = true ∧
    approve manifestA { receiptA with observedShards := ["compile"] } = false := by decide

def originalUnframedWire (authority : Bytes) (sources : List SourceRef) : Bytes :=
  authority ++ sources.flatMap (fun s => s.bytes)
theorem original_source_serialization_not_injective :
    originalUnframedWire [1] [sourceA] = originalUnframedWire [] [{ sourceA with bytes := [1,65] }] := by decide
theorem framing_rejects_reviewed_collision :
    sourceWire [1] [sourceA] ≠ sourceWire [] [{ sourceA with bytes := [1,65] }] := by decide

theorem revision_gate_alone_can_clear_tombstone :
    revise sourceDead { sourceA with revision := 2 } = true ∧
    { sourceA with revision := 2 } ∈ retrieve "p" [{ sourceA with revision := 2 }] := by decide

theorem visible_history_contamination_remains_possible :
    (propose harnessA [99] [99]).implementation = [99] := rfl

theorem abstract_safe_predicate_requires_a_real_refinement :
    rollback (fun _ _ => True) [99] harnessB harnessA = some harnessA := by decide

-- A successful H01 guard places no syntactic restriction on implementation
-- bytes. Those bytes must be interpreted as allowlisted configuration only.
theorem allowlist_requires_restricted_byte_interpretation :
    admitCandidate harnessA { harnessB with implementation := [255,255,255] } = true := by decide

open Workroom.Concurrency
theorem unguarded_expiry_replacement_can_revive :
    guardedCommit 100 fixtureTask fixtureClaim fixtureIdentity = none ∧
    (guardedCommit 100 { fixtureTask with expiresAt := 200 } fixtureClaim fixtureIdentity).isSome = true := by decide

#print axioms aggregation_alone_accepts_missing_shard
#print axioms original_source_serialization_not_injective
#print axioms framing_rejects_reviewed_collision
#print axioms revision_gate_alone_can_clear_tombstone
#print axioms visible_history_contamination_remains_possible
#print axioms abstract_safe_predicate_requires_a_real_refinement
#print axioms allowlist_requires_restricted_byte_interpretation
#print axioms unguarded_expiry_replacement_can_revive
end Workroom.IndependentReview
