import Std

namespace WorkroomAutonomy

inductive Verdict | pass | fail | inconclusive | hold
  deriving DecidableEq, Repr

structure Candidate where
  digest : Nat
  parentDigest : Nat
  policyDigest : Nat
  author : Nat
  deriving DecidableEq, Repr

structure Evaluation where
  candidateDigest : Nat
  contractDigest : Nat
  evaluatorDigest : Nat
  environmentDigest : Nat
  policyDigest : Nat
  author : Nat
  reviewer : Nat
  verdict : Verdict
  deriving DecidableEq, Repr

structure ReleaseContract where
  expectedChampion : Nat
  expectedRevision : Nat
  contractDigest : Nat
  evaluatorDigest : Nat
  environmentDigest : Nat
  allowedReviewers : List Nat
  deriving DecidableEq, Repr

structure Registry where
  championDigest : Nat
  revision : Nat
  currentPolicyDigest : Nat
  activeRunPin : Nat
  deriving DecidableEq, Repr

/-- Evidence fields are trusted evaluator outputs. This gate does not prove
    that a PASS came from truthful experiments or that hashes are collision-free. -/
def Promotable (r : Registry) (gate : ReleaseContract)
    (c : Candidate) (e : Evaluation) : Prop :=
  r.championDigest = gate.expectedChampion ∧
  r.revision = gate.expectedRevision ∧
  c.parentDigest = r.championDigest ∧
  c.policyDigest = r.currentPolicyDigest ∧
  e.policyDigest = r.currentPolicyDigest ∧
  e.candidateDigest = c.digest ∧
  e.contractDigest = gate.contractDigest ∧
  e.evaluatorDigest = gate.evaluatorDigest ∧
  e.environmentDigest = gate.environmentDigest ∧
  e.author = c.author ∧ e.reviewer ≠ c.author ∧
  e.reviewer ∈ gate.allowedReviewers ∧ e.verdict = .pass

instance (r : Registry) (gate : ReleaseContract)
    (c : Candidate) (e : Evaluation) : Decidable (Promotable r gate c e) := by
  unfold Promotable
  infer_instance

def promote (r : Registry) (gate : ReleaseContract)
    (c : Candidate) (e : Evaluation) : Option Registry :=
  if Promotable r gate c e then
    some { r with championDigest := c.digest, revision := r.revision + 1 }
  else none

theorem promotion_sound (r r' : Registry) (gate : ReleaseContract)
    (c : Candidate) (e : Evaluation) (h : promote r gate c e = some r') :
    Promotable r gate c e ∧ r'.championDigest = c.digest ∧
    r'.revision = r.revision + 1 ∧ r'.activeRunPin = r.activeRunPin ∧
    r'.currentPolicyDigest = r.currentPolicyDigest := by
  unfold promote at h
  split at h
  next guards => cases h; exact ⟨guards, rfl, rfl, rfl, rfl⟩
  next => contradiction

theorem mismatched_candidate_rejected
    (r : Registry) (gate : ReleaseContract) (c : Candidate) (e : Evaluation)
    (mismatch : e.candidateDigest ≠ c.digest) :
    promote r gate c e = none := by
  unfold promote
  split
  next guards =>
    exact False.elim (mismatch guards.2.2.2.2.2.1)
  next => rfl

theorem author_cannot_self_promote
    (r : Registry) (gate : ReleaseContract) (c : Candidate) (e : Evaluation)
    (sameAuthor : e.reviewer = c.author) :
    promote r gate c e = none := by
  unfold promote
  split
  next guards =>
    exact False.elim (guards.2.2.2.2.2.2.2.2.2.2.1 sameAuthor)
  next => rfl

#print axioms promotion_sound
#print axioms mismatched_candidate_rejected
#print axioms author_cannot_self_promote

end WorkroomAutonomy
