import Workroom.Spec

/-! Executable reference settlement. This file does not certify the TypeScript
or SQL implementation. Amounts are exact natural micro-USD, and receipts are
already authenticated at this abstraction boundary. -/
namespace Workroom.BudgetModel

instance (a b : Settlement) : Decidable (SameSettlement a b) := by
  unfold SameSettlement
  infer_instance

def reserve (before : Budget) (amount : Nat) : Option Budget :=
  if before.spentMicroUsd + before.heldMicroUsd + amount ≤ before.capMicroUsd
  then some { before with heldMicroUsd := before.heldMicroUsd + amount }
  else none

def Conflict (ledger : List Settlement) (receipt : Settlement) : Prop :=
  ∃ old ∈ ledger, SameSettlement old receipt ∧
    old.amountMicroUsd ≠ receipt.amountMicroUsd

instance (ledger : List Settlement) (receipt : Settlement) :
    Decidable (Conflict ledger receipt) := by
  unfold Conflict
  infer_instance

def Seen (ledger : List Settlement) (receipt : Settlement) : Prop :=
  ∃ old ∈ ledger, SameSettlement old receipt

instance (ledger : List Settlement) (receipt : Settlement) :
    Decidable (Seen ledger receipt) := by
  unfold Seen
  infer_instance

-- All conflicts are checked before a same-amount replay. A malformed ledger
-- containing both an exact duplicate and a conflicting amount is rejected.
def applyReceipt (ledger : List Settlement) (receipt : Settlement) :
    Option (List Settlement) :=
  if Conflict ledger receipt then none
  else if Seen ledger receipt then some ledger
  else some (receipt :: ledger)

theorem same_self (r : Settlement) : SameSettlement r r := by
  exact ⟨rfl, rfl, rfl⟩

theorem conflict_cons_self (ledger : List Settlement) (r : Settlement) :
    Conflict (r :: ledger) r ↔ Conflict ledger r := by
  simp [Conflict]

theorem seen_cons_self (ledger : List Settlement) (r : Settlement) :
    Seen (r :: ledger) r := by
  exact ⟨r, by simp, same_self r⟩

theorem B01_proved : B01_ReservePreservesCap reserve := by
  intro before amount after h
  unfold reserve at h
  split at h
  next hcap =>
    cases h
    exact ⟨rfl, rfl, rfl, rfl, by simpa [Nat.add_assoc] using hcap⟩
  next => contradiction

theorem B02_proved : B02_SettlementExactlyOnce applyReceipt := by
  intro ledger receipt once h
  unfold applyReceipt at h
  split at h
  next => contradiction
  next hn =>
    split at h
    next hs =>
      cases h
      simp [applyReceipt, hn, hs]
    next hs =>
      cases h
      simp [applyReceipt, conflict_cons_self, hn, seen_cons_self]

theorem B03_proved : B03_FirstSettlementExact applyReceipt := by
  intro ledger receipt after hfirst h
  have hseen : ¬ Seen ledger receipt := by
    rintro ⟨old, hold, hsame⟩
    exact hfirst old hold hsame
  have hconflict : ¬ Conflict ledger receipt := by
    rintro ⟨old, hold, hsame, _⟩
    exact hfirst old hold hsame
  simp [applyReceipt, hseen, hconflict] at h
  cases h
  simp [ProjectTotal, Nat.add_comm]

theorem B04_proved : B04_ProjectAccountingIsolation applyReceipt := by
  intro ledger receipt other after hother h
  unfold applyReceipt at h
  split at h
  next => contradiction
  next =>
    split at h
    next => cases h; rfl
    next =>
      cases h
      simp [ProjectTotal, Ne.symm hother]

theorem B05_proved : B05_ConflictingReceiptRejected applyReceipt := by
  intro ledger receipt old hold hsame hamount
  have hconflict : Conflict ledger receipt := ⟨old, hold, hsame, hamount⟩
  simp [applyReceipt, hconflict]

/-! Finite executable witnesses; `decide` generates kernel-reduced terms. -/
def budget0 : Budget := ⟨"project-a", 10, 2, 3⟩
def receipt0 : Settlement := ⟨"project-a", "account-a", "generation-1", 7⟩
def conflict0 : Settlement := { receipt0 with amountMicroUsd := 9 }
def other0 : Settlement := ⟨"project-b", "account-a", "generation-1", 11⟩

theorem B01_success : reserve budget0 5 = some ⟨"project-a", 10, 2, 8⟩ := by decide
theorem B01_reject : reserve budget0 6 = none := by decide
theorem B01_counterexample :
    (2 + (3 + 6) : Nat) > budget0.capMicroUsd := by decide

theorem B02_success : applyReceipt [receipt0] receipt0 = some [receipt0] := by decide
theorem B02_reject : applyReceipt [receipt0, conflict0] receipt0 = none := by decide
theorem B02_counterexample :
    ProjectTotal "project-a" [receipt0, receipt0] ≠ ProjectTotal "project-a" [receipt0] := by decide

theorem B03_success : applyReceipt [] receipt0 = some [receipt0] ∧
    ProjectTotal "project-a" [receipt0] = 7 := by decide
theorem B03_reject : applyReceipt [conflict0] receipt0 = none := by decide
theorem B03_counterexample :
    ProjectTotal receipt0.project [] ≠ ProjectTotal receipt0.project [] + receipt0.amountMicroUsd := by decide

theorem B04_success : applyReceipt [other0] receipt0 = some [receipt0, other0] ∧
    ProjectTotal "project-b" [receipt0, other0] = ProjectTotal "project-b" [other0] := by decide
theorem B04_reject : applyReceipt [other0, conflict0] receipt0 = none := by decide
theorem B04_counterexample :
    ProjectTotal "project-b" [other0] ≠ ProjectTotal "project-b" [] := by decide

theorem B05_success : applyReceipt [receipt0] receipt0 = some [receipt0] := by decide
theorem B05_reject : applyReceipt [receipt0] conflict0 = none := by decide
theorem B05_counterexample :
    SameSettlement receipt0 conflict0 ∧ receipt0.amountMicroUsd ≠ conflict0.amountMicroUsd := by decide

/-! Refutations of executable alternate specifications, not only assertions
about the intended guard. These do not alter any original obligation. -/
def uncappedReserve (b : Budget) (n : Nat) : Option Budget :=
  some { b with heldMicroUsd := b.heldMicroUsd + n }
theorem B01_bad_spec : ¬ B01_ReservePreservesCap uncappedReserve := by
  intro h
  have bad := h budget0 6 { budget0 with heldMicroUsd := 9 } rfl
  simp [budget0] at bad

def appendEveryReceipt (xs : List Settlement) (r : Settlement) : Option (List Settlement) := some (r :: xs)
theorem B02_bad_spec : ¬ B02_SettlementExactlyOnce appendEveryReceipt := by
  intro h
  have bad := h [] receipt0 [receipt0] rfl
  simp [appendEveryReceipt] at bad

def ignoreReceipt (xs : List Settlement) (_ : Settlement) : Option (List Settlement) := some xs
theorem B03_bad_spec : ¬ B03_FirstSettlementExact ignoreReceipt := by
  intro h
  have fresh : ∀ old, old ∈ ([] : List Settlement) → ¬ SameSettlement old receipt0 := by simp
  have bad := h [] receipt0 [] fresh rfl
  simp [ProjectTotal, receipt0] at bad

def eraseOtherReceipts (_ : List Settlement) (r : Settlement) : Option (List Settlement) := some [r]
theorem B04_bad_spec : ¬ B04_ProjectAccountingIsolation eraseOtherReceipts := by
  intro h
  have bad := h [other0] receipt0 "project-b" [receipt0] (by decide) rfl
  simp [ProjectTotal, receipt0, other0] at bad

def skipConflictCheck (xs : List Settlement) (r : Settlement) : Option (List Settlement) :=
  if Seen xs r then some xs else some (r :: xs)
theorem B05_bad_spec : ¬ B05_ConflictingReceiptRejected skipConflictCheck := by
  intro h
  have bad := h [receipt0, conflict0] receipt0 conflict0 (by simp) (by decide) (by decide)
  simp [skipConflictCheck, Seen, SameSettlement, receipt0, conflict0] at bad

-- This is NOT a refutation of B01 or B03. Honest incurred-cost accounting can
-- exceed a reservation. A global actual-spend bound requires a provider charge
-- upper bound (including model route and price currency), not a smaller ledger
-- entry or refusal to acknowledge an already-incurred charge.
def overrunReceipt : Settlement := ⟨"project-a", "account-a", "generation-overrun", 11⟩
theorem B01_B03_do_not_imply_global_spend_bound :
    reserve ⟨"project-a", 10, 0, 0⟩ 1 = some ⟨"project-a", 10, 0, 1⟩ ∧
    applyReceipt [] overrunReceipt = some [overrunReceipt] ∧
    ProjectTotal "project-a" [overrunReceipt] = 11 ∧
    10 < ProjectTotal "project-a" [overrunReceipt] := by decide

#print axioms B01_proved
#print axioms B02_proved
#print axioms B03_proved
#print axioms B04_proved
#print axioms B05_proved
#print axioms B01_B03_do_not_imply_global_spend_bound

end Workroom.BudgetModel
