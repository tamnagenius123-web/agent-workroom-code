import Workroom.Spec
namespace Workroom.Reference
instance subsetDecidable {α : Type} [DecidableEq α] (xs ys : List α) :
    Decidable (Subset xs ys) := by unfold Subset; infer_instance
instance authorizedDecidable (i : Identity) (s : List String) :
    Decidable (Authorized i s) := by unfold Authorized; infer_instance
instance sourceDecidable (p : ProjectId) (s : SourceRef) :
    Decidable (UsableSource p s) := by unfold UsableSource; infer_instance
instance receiptDecidable (m : VerificationManifest) (r : Verification) :
    Decidable (AcceptableReceipt m r) := by unfold AcceptableReceipt; infer_instance
end Workroom.Reference
