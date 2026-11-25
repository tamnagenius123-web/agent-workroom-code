"""Fixed-evaluator candidate campaign; no remote execution or active promotion.

The proposal phase knows only validation inputs. After selection is frozen, a
separate evaluator subprocess materializes confirmation tasks from another seed.
This is logical holdout separation, not an adversarial sandbox/access boundary.
All candidates are registered, hand-authored policies; there is no meta-learning.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

import model_tools as mt


EVALUATOR_ROLE = "independent_evaluator_v1"
FAMILIES = ("weighted_sparse", "unit_sparse", "zero_weight", "disconnected", "permuted_chain", "dense")
POLICIES = {"fixed_bellman_ford": "bellman_ford", "fixed_dijkstra": "dijkstra", "typed_compiler": None}
SCORE_VERSION = "verified_success_then_work_units_then_boundary_calls_v1"


def evaluator_digest():
    return mt._digest({"evaluator_source_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                       "kernel_source_digest": mt.IMPLEMENTATION_DIGEST,
                       "score_version": SCORE_VERSION, "envelope": mt.default_envelope()})


def make_candidate(policy, author_role="candidate_author", parent_active_digest=None):
    if policy not in POLICIES:
        raise ValueError("unknown registered policy")
    return {"schema_version": "1", "policy": policy, "author_role": author_role,
            "parent_active_digest": parent_active_digest,
            "implementation_digest": mt.IMPLEMENTATION_DIGEST}


def evaluate_request(request):
    """Frozen worker entry point; source/candidate identity checked before work."""
    start = time.perf_counter_ns()
    candidate = request["candidate"]
    if request["candidate_digest"] != mt._digest(candidate):
        raise ValueError("candidate digest mismatch")
    if request["evaluator_digest"] != evaluator_digest():
        raise ValueError("evaluator digest mismatch")
    if candidate.get("author_role") == EVALUATOR_ROLE or not candidate.get("author_role"):
        raise ValueError("candidate author must differ from evaluator")
    if candidate.get("implementation_digest") != mt.IMPLEMENTATION_DIGEST:
        raise ValueError("candidate implementation is not pinned to this kernel")
    policy = candidate["policy"]
    if policy not in POLICIES or request["split"] not in ("validation", "confirmation"):
        raise ValueError("unknown policy or split")
    if type(request["cases_per_family"]) is not int or not 1 <= request["cases_per_family"] <= 8:
        raise ValueError("unbounded campaign fixture count")
    tasks = [mt._synthetic_task(family, 32 + 16 * i, request["seed"] + 10_000 * family_index + i)
             for family_index, family in enumerate(FAMILIES)
             for i in range(request["cases_per_family"])]
    rows = []
    for task in tasks:
        compile_start = time.perf_counter_ns()
        algorithm = POLICIES[policy]
        hint = None if algorithm is None else {"preferred_algorithm": algorithm}
        plan = mt.compile_specialist(task, procedure_hint=hint)
        compile_ns = time.perf_counter_ns() - compile_start
        result = mt.execute_plan(task, plan)
        # Check again from the original input, not the worker's status flag.
        verify_start = time.perf_counter_ns()
        independent = mt.verify_certificate(task, result.get("certificate"))
        independent_ns = time.perf_counter_ns() - verify_start
        stats = result["stats"]
        rows.append({"task_digest": mt.task_digest(task), "plan_id": plan["plan_id"],
                     "certificate_digest": result.get("certificate_digest"),
                     "verified": independent["valid"], "algorithm": plan["algorithm"],
                     "algorithm_work_units": stats.get("algorithm_work_units", 0),
                     "modeled_tool_boundary_calls": stats.get("modeled_tool_boundary_calls", 0),
                     "specialization_elapsed_ns": compile_ns,
                     "execution_elapsed_ns": stats["total_elapsed_ns"],
                     "independent_verification_elapsed_ns": independent_ns})
    return {"candidate_digest": request["candidate_digest"], "policy": policy,
            "candidate_author": candidate["author_role"], "evaluator_role": EVALUATOR_ROLE,
            "evaluator_digest": request["evaluator_digest"], "split": request["split"],
            "corpus_digest": mt._digest([r["task_digest"] for r in rows]),
            "tasks": len(rows), "verified": sum(r["verified"] for r in rows),
            "algorithm_work_units": sum(r["algorithm_work_units"] for r in rows),
            "modeled_tool_boundary_calls": sum(r["modeled_tool_boundary_calls"] for r in rows),
            "specialization_elapsed_ns": sum(r["specialization_elapsed_ns"] for r in rows),
            "execution_elapsed_ns": sum(r["execution_elapsed_ns"] for r in rows),
            "independent_verification_elapsed_ns": sum(r["independent_verification_elapsed_ns"] for r in rows),
            "full_evaluation_elapsed_ns": time.perf_counter_ns() - start,
            "actual_provider_calls": 0, "training_jobs": 0, "gpu_jobs": 0, "rows": rows}


def _request(candidate, split, seed, cases):
    return {"candidate": candidate, "candidate_digest": mt._digest(candidate),
            "evaluator_digest": evaluator_digest(), "split": split, "seed": seed,
            "cases_per_family": cases}


def _evaluate_isolated(candidate, split, seed, cases, frozen_evaluator=None):
    request = _request(candidate, split, seed, cases)
    if frozen_evaluator is not None:
        request["evaluator_digest"] = frozen_evaluator
    worker = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--worker"],
                            input=json.dumps(request), text=True, capture_output=True,
                            timeout=30, check=True)
    result = json.loads(worker.stdout)
    if result["candidate_digest"] != request["candidate_digest"] or result["evaluator_digest"] != request["evaluator_digest"]:
        raise ValueError("worker result did not bind to the submitted snapshot")
    return result


def _score(result):
    return (result["tasks"] - result["verified"], result["algorithm_work_units"],
            result["modeled_tool_boundary_calls"])


def run_campaign(seed=20261125, cases_per_family=4):
    campaign_start = time.perf_counter_ns()
    generation_start = time.perf_counter_ns()
    active = make_candidate("fixed_bellman_ford", "baseline_maintainer")
    active_digest = mt._digest(active)
    strong = make_candidate("fixed_dijkstra", "baseline_maintainer")
    proposals = [make_candidate("typed_compiler", parent_active_digest=active_digest),
                 make_candidate("fixed_bellman_ford", parent_active_digest=active_digest)]
    generation_ns = time.perf_counter_ns() - generation_start
    fixed_evaluator = evaluator_digest()
    # Every policy in a split receives the same seed, fixtures and resource budget.
    validation = [_evaluate_isolated(c, "validation", seed, cases_per_family, fixed_evaluator)
                  for c in [active, strong, *proposals]]
    selection_start = time.perf_counter_ns()
    candidates = {mt._digest(c): c for c in proposals}
    ranked = sorted((r for r in validation if r["candidate_digest"] in candidates),
                    key=lambda r: (_score(r), r["policy"], r["candidate_digest"]))
    selected_digest = ranked[0]["candidate_digest"]
    selected = candidates[selected_digest]
    selection_ns = time.perf_counter_ns() - selection_start
    if selected_digest == active_digest or evaluator_digest() != fixed_evaluator:
        raise ValueError("candidate must differ from active and evaluator must remain frozen")
    selection_receipt = {"selected_candidate_digest": selected_digest,
                         "evaluator_digest": fixed_evaluator,
                         "validation_corpus_digest": ranked[0]["corpus_digest"],
                         "rule": SCORE_VERSION}
    selection_receipt_digest = mt._digest(selection_receipt)
    # Confirmation data is materialized only now, in evaluator child processes.
    confirmation = [_evaluate_isolated(c, "confirmation", seed + 1_000_000, cases_per_family, fixed_evaluator)
                    for c in [active, strong, selected]]
    if mt._digest(selection_receipt) != selection_receipt_digest:
        raise ValueError("selection changed during confirmation")
    old, reference, challenger = confirmation
    qualified = challenger["verified"] == challenger["tasks"] and _score(challenger) < _score(old)
    gain_over_strong = _score(challenger) < _score(reference)
    all_results = validation + confirmation
    if evaluator_digest() != fixed_evaluator or any(r["evaluator_digest"] != fixed_evaluator for r in all_results):
        raise ValueError("evaluator changed during campaign")
    return {"schema_version": "1", "campaign": "bounded_policy_selection_v1",
            "seed": seed, "cases_per_family": cases_per_family,
            "active_before_digest": active_digest, "active_after_digest": active_digest,
            "evaluator_digest": fixed_evaluator, "resource_envelope": mt.default_envelope(),
            "proposals": proposals, "selection_receipt": selection_receipt,
            "selection_receipt_digest": selection_receipt_digest,
            "selected_policy": selected["policy"], "validation": validation, "confirmation": confirmation,
            "decision": {"qualified_against_active": qualified,
                         "strict_gain_over_strong_baseline": gain_over_strong,
                         "promotion_eligible": qualified and gain_over_strong,
                         "promotion_performed": False,
                         "reason": "no measured gain over strong baseline" if not gain_over_strong
                         else "eligible measurement only; active state left unchanged"},
            "cost_ledger": {
                "proposal_construction_elapsed_ns": generation_ns, "selection_elapsed_ns": selection_ns,
                "specialization_elapsed_ns": sum(r["specialization_elapsed_ns"] for r in all_results),
                "execution_elapsed_ns": sum(r["execution_elapsed_ns"] for r in all_results),
                "independent_verification_elapsed_ns": sum(r["independent_verification_elapsed_ns"] for r in all_results),
                "evaluator_elapsed_ns": sum(r["full_evaluation_elapsed_ns"] for r in all_results),
                "full_local_campaign_elapsed_ns": time.perf_counter_ns() - campaign_start,
                "total_algorithm_work_units": sum(r["algorithm_work_units"] for r in all_results),
                "actual_provider_calls": 0, "training_jobs": 0, "gpu_jobs": 0,
                "development_and_upstream_generation_cost": "not metered; not claimed zero",
                "deployment_and_maintenance_cost": "not executed or measured",
                "cost_summation_note": "timing categories overlap; full_local_campaign includes child startup and orchestration",
            },
            "limitations": ["Policies are hand-authored; no learned/meta improver was evaluated.",
                            "Different role names and child processes are not an adversarial security boundary.",
                            "Confirmation is a logical holdout; its seed is published for reproducibility.",
                            "Provider/GPU dollars, energy and development cost were not measured.",
                            "Active candidate is never changed; no registry promotion or deployment occurs."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--output", type=Path, default=Path("campaign_results.json"))
    args = parser.parse_args()
    if args.worker:
        print(json.dumps(evaluate_request(json.load(sys.stdin))))
        return
    result = run_campaign()
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "selected_policy": result["selected_policy"],
                      "decision": result["decision"], "cost_ledger": result["cost_ledger"]}, indent=2))


if __name__ == "__main__":
    main()
