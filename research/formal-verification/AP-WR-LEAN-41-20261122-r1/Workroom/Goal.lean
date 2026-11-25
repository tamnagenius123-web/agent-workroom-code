import Workroom.Decidable
namespace Workroom.Reference

def nextFuel : Nat → Option Nat
  | 0 => none
  | n+1 => some n

theorem G01_proved : G01_FuelStrictlyDecreases nextFuel := by
  intro fuel remaining h
  cases fuel with
  | zero => cases h
  | succ n =>
    simp only [nextFuel, Option.some.injEq] at h
    omega

def runnableTasks (dependencies : TaskId → List TaskId)
    (completed candidates : List TaskId) : List TaskId :=
  candidates.filter (fun task => decide (Subset (dependencies task) completed))

theorem G02_proved (dependencies : TaskId → List TaskId) (completed candidates : List TaskId) :
    G02_PrerequisiteClosure dependencies completed (runnableTasks dependencies completed candidates) := by
  intro task ht
  exact of_decide_eq_true (List.mem_filter.mp ht).2

def fixtureDeps (task : TaskId) : List TaskId := if task = "p:parent" then ["p:child"] else []
theorem G01_success : nextFuel 3 = some 2 := rfl
theorem G01_reject : nextFuel 0 = none := rfl
theorem G01_counterexample : ¬ G01_FuelStrictlyDecreases (fun n => some n) := by
  intro h
  have h' := h 1 1 rfl
  omega

theorem G02_success : runnableTasks fixtureDeps ["p:child"] ["p:parent"] = ["p:parent"] := by decide
theorem G02_reject : runnableTasks fixtureDeps ["q:child"] ["p:parent"] = [] := by decide

theorem G02_counterexample : ¬ G02_PrerequisiteClosure fixtureDeps [] ["p:parent"] := by
  intro h
  have hi := h "p:parent" (by simp) "p:child" (by simp [fixtureDeps])
  cases hi

#print axioms G01_proved
#print axioms G02_proved
end Workroom.Reference
