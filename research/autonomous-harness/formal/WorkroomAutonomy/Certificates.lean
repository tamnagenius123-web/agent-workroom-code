import Std
import Lean.Elab.Tactic.Omega

namespace WorkroomAutonomy

/-- Exact nonnegative integer edge weights. -/
abbrev Edges := Nat → Nat → Nat → Prop

inductive Walk (edge : Edges) : Nat → Nat → Nat → Prop
  | nil (v : Nat) : Walk edge v v 0
  | cons {u v t w c : Nat} :
      edge u v w → Walk edge v t c → Walk edge u t (w + c)

/-- The edge inequalities telescope along any finite valid path. -/
theorem potential_bound (edge : Edges) (potential : Nat → Nat)
    (feasible : ∀ u v w, edge u v w → potential v ≤ potential u + w)
    {s t cost : Nat} (path : Walk edge s t cost) :
    potential t ≤ potential s + cost := by
  induction path with
  | nil v => simp
  | @cons u v t w c he tail ih =>
    have hop := feasible u v w he
    omega

/-- A returned path meeting a feasible potential proves shortest-path optimality. -/
theorem certified_shortest_path (edge : Edges) (potential : Nat → Nat)
    (feasible : ∀ u v w, edge u v w → potential v ≤ potential u + w)
    {s t returnedCost : Nat}
    (returnedPath : Walk edge s t returnedCost)
    (sourceZero : potential s = 0)
    (tight : returnedCost = potential t) :
    Walk edge s t returnedCost ∧
    ∀ competitorCost, Walk edge s t competitorCost →
      returnedCost ≤ competitorCost := by
  refine ⟨returnedPath, ?_⟩
  intro competitorCost competitor
  have lower := potential_bound edge potential feasible competitor
  rw [sourceZero] at lower
  simpa [tight] using lower

theorem closed_cut_contains_path (edge : Edges) (inside : Nat → Prop)
    (closed : ∀ u v w, edge u v w → inside u → inside v)
    {s t cost : Nat} (path : Walk edge s t cost) (sourceInside : inside s) :
    inside t := by
  induction path with
  | nil v => exact sourceInside
  | @cons u v t w c he tail ih =>
    exact ih (closed u v w he sourceInside)

theorem certified_unreachable (edge : Edges) (inside : Nat → Prop)
    (closed : ∀ u v w, edge u v w → inside u → inside v)
    {s t : Nat} (sourceInside : inside s) (targetOutside : ¬ inside t) :
    ¬ ∃ cost, Walk edge s t cost := by
  intro h
  obtain ⟨cost, path⟩ := h
  exact targetOutside (closed_cut_contains_path edge inside closed path sourceInside)

/-- Development scores alone do not discharge this semantic premise.
    Every step must be a genuine gain on the same target score function. -/
def sumGains (gain : Nat → Nat) : Nat → Nat
  | 0 => 0
  | n + 1 => sumGains gain n + gain n

theorem cumulative_improvement (score gain : Nat → Nat)
    (trueGain : ∀ n, score n + gain n ≤ score (n + 1)) :
    ∀ n, score 0 + sumGains gain n ≤ score n := by
  intro n
  induction n with
  | zero => simp [sumGains]
  | succ n ih =>
    have stepGain := trueGain n
    simp only [sumGains]
    omega

#print axioms potential_bound
#print axioms certified_shortest_path
#print axioms closed_cut_contains_path
#print axioms certified_unreachable
#print axioms cumulative_improvement

end WorkroomAutonomy
