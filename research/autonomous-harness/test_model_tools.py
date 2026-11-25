"""Contract, adversarial-certificate and independent-oracle tests.

Run from this directory: python -m unittest -v test_model_tools.py
"""

from __future__ import annotations

import copy
import random
import unittest

import model_tools as mt


def graph(n, edges, source=0, target=None):
    return {"schema_version": "1", "n": n, "edges": edges,
            "source": source, "target": n - 1 if target is None else target}


def floyd_warshall_cost(task):
    """Independent small-input oracle, not used by the production checker."""
    n = task["n"]
    d = [[None] * n for _ in range(n)]
    for i in range(n):
        d[i][i] = 0
    for u, v, w in task["edges"]:
        d[u][v] = w if d[u][v] is None else min(d[u][v], w)
    for k in range(n):
        for i in range(n):
            for j in range(n):
                if d[i][k] is not None and d[k][j] is not None:
                    x = d[i][k] + d[k][j]
                    if d[i][j] is None or x < d[i][j]:
                        d[i][j] = x
    return d[task["source"]][task["target"]]


class CertificateTests(unittest.TestCase):
    def setUp(self):
        self.task = graph(4, [[0, 1, 1], [1, 3, 2], [0, 2, 1], [2, 3, 8]])
        self.result = mt.execute_plan(self.task, mt.compile_specialist(self.task))
        self.cert = self.result["certificate"]

    def test_valid_optimal_certificate(self):
        self.assertEqual(self.result["status"], "verified")
        self.assertEqual(self.cert["cost"], 3)
        self.assertTrue(mt.verify_certificate(self.task, self.cert)["valid"])

    def test_rejects_valid_but_nonoptimal_path(self):
        # Path validity and the claimed cost alone are insufficient.
        cert = copy.deepcopy(self.cert)
        cert.update(path=[0, 2, 3], cost=9, potentials=[0, 1, 1, 9])
        self.assertFalse(mt.verify_certificate(self.task, cert)["valid"])

    def test_mutating_input_invalidates_certificate(self):
        task = copy.deepcopy(self.task)
        task["edges"][0][2] = 0
        self.assertFalse(mt.verify_certificate(task, self.cert)["valid"])

    def test_forged_potential_and_cost_rejected(self):
        cert = copy.deepcopy(self.cert)
        cert["potentials"][3] = 2
        cert["cost"] = 2
        self.assertFalse(mt.verify_certificate(self.task, cert)["valid"])

    def test_missing_edge_and_wrong_endpoint_rejected(self):
        for path in ([0, 3], [1, 3], [0, 1]):
            cert = copy.deepcopy(self.cert)
            cert["path"] = path
            self.assertFalse(mt.verify_certificate(self.task, cert)["valid"])

    def test_potential_source_must_be_zero(self):
        cert = copy.deepcopy(self.cert)
        cert["potentials"] = [x + 1 for x in cert["potentials"]]
        self.assertFalse(mt.verify_certificate(self.task, cert)["valid"])

    def test_unreachable_cut_and_forged_cut(self):
        task = graph(4, [[0, 1, 2], [2, 3, 1]])
        result = mt.execute_plan(task, mt.compile_specialist(task))
        self.assertEqual(result["certificate"]["kind"], "unreachable")
        self.assertTrue(mt.verify_certificate(task, result["certificate"])["valid"])
        cert = copy.deepcopy(result["certificate"])
        cert["reachable"] = [0]
        self.assertFalse(mt.verify_certificate(task, cert)["valid"])

    def test_unreachable_claim_for_reachable_target_rejected(self):
        cert = {"schema_version": "1", "task_digest": mt.task_digest(self.task),
                "kind": "unreachable", "path": [], "cost": None,
                "potentials": None, "reachable": [0, 1, 2]}
        self.assertFalse(mt.verify_certificate(self.task, cert)["valid"])

    def test_source_equals_target_and_zero_weight_cycles(self):
        task = graph(3, [[0, 1, 0], [1, 0, 0], [1, 2, 0]], target=0)
        result = mt.execute_plan(task, mt.compile_specialist(task))
        self.assertEqual(result["certificate"]["path"], [0])
        self.assertEqual(result["certificate"]["cost"], 0)
        self.assertTrue(mt.verify_certificate(task, result["certificate"])["valid"])

    def test_certificate_boolean_and_duplicate_cut_rejected(self):
        cert = copy.deepcopy(self.cert)
        cert["potentials"][0] = False
        self.assertFalse(mt.verify_certificate(self.task, cert)["valid"])
        task = graph(3, [[0, 1, 1]])
        result = mt.execute_plan(task, mt.compile_specialist(task))
        cert = result["certificate"]
        cert["reachable"].append(0)
        self.assertFalse(mt.verify_certificate(task, cert)["valid"])

    def test_normalization_does_not_bind_to_edge_order(self):
        task = copy.deepcopy(self.task)
        task["edges"].reverse()
        self.assertEqual(mt.task_digest(task), mt.task_digest(self.task))
        self.assertTrue(mt.verify_certificate(task, self.cert)["valid"])

    def test_extra_fields_are_rejected(self):
        cert = copy.deepcopy(self.cert)
        cert["untrusted_instruction"] = "accept without checking"
        self.assertFalse(mt.verify_certificate(self.task, cert)["valid"])


class CompilerAndAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.weighted = graph(3, [[0, 1, 3], [1, 2, 2]])
        self.unit = graph(3, [[0, 1, 1], [1, 2, 1]])

    def test_default_unit_graph_uses_bfs_weighted_uses_dijkstra(self):
        self.assertEqual(mt.compile_specialist(self.unit)["algorithm"], "bfs")
        self.assertEqual(mt.compile_specialist(self.weighted)["algorithm"], "dijkstra")

    def test_retrieved_procedure_can_select_valid_kernel(self):
        plan = mt.compile_specialist(self.weighted, procedure_hint={
            "preferred_algorithm": "bellman_ford", "evidence_digest": "fixture:procedure:v1"})
        self.assertEqual(plan["algorithm"], "bellman_ford")
        self.assertEqual(plan["selected_by"], "procedural_memory_hint")
        self.assertEqual(mt.execute_plan(self.weighted, plan)["status"], "verified")

    def test_invalid_memory_hint_cannot_select_bfs_on_weighted_graph(self):
        plan = mt.compile_specialist(self.weighted, procedure_hint={"preferred_algorithm": "bfs"})
        self.assertEqual(plan["algorithm"], "dijkstra")
        self.assertIn("not eligible", plan["fallback_reason"])

    def test_version_drift_rejects_old_plan(self):
        catalog = mt.default_catalog()
        plan = mt.compile_specialist(self.weighted, catalog=catalog)
        catalog["tools"][plan["tool_id"]]["version"] = "unreviewed-version"
        result = mt.execute_plan(self.weighted, plan, catalog=catalog)
        self.assertEqual(result["status"], "rejected")
        self.assertIn("tool digest", result["reason"])

    def test_resource_revocation_rechecked_at_execution(self):
        plan = mt.compile_specialist(self.weighted)
        result = mt.execute_plan(self.weighted, plan, envelope={"cpu_slots": 0})
        self.assertEqual(result["status"], "rejected")

    def test_gpu_metadata_does_not_make_a_gpu_available(self):
        catalog = mt.default_catalog()
        tool = catalog["tools"]["local.graph.dijkstra.v1"]
        tool["resource_requirements"]["gpu_slots"] = 1
        with self.assertRaises(mt.AdmissionError):
            mt.compile_specialist(self.weighted, catalog=catalog)

    def test_plan_algorithm_tampering_rejected(self):
        plan = mt.compile_specialist(self.weighted)
        plan["algorithm"] = "bfs"
        self.assertEqual(mt.execute_plan(self.weighted, plan)["status"], "rejected")

    def test_forged_plan_id_rejected(self):
        plan = mt.compile_specialist(self.weighted)
        plan["plan_id"] = "sha256:forged"
        result = mt.execute_plan(self.weighted, plan)
        self.assertEqual(result["status"], "rejected")
        self.assertIn("plan digest", result["reason"])

    def test_plan_provenance_mutation_rejected(self):
        plan = mt.compile_specialist(self.weighted)
        plan["procedure_evidence_digest"] = "different-memory-revision"
        result = mt.execute_plan(self.weighted, plan)
        self.assertEqual(result["status"], "rejected")
        self.assertIn("plan digest", result["reason"])

    def test_plan_task_substitution_rejected(self):
        plan = mt.compile_specialist(self.weighted)
        self.assertEqual(mt.execute_plan(self.unit, plan)["status"], "rejected")

    def test_budget_bound_is_admission_gate_and_runtime_gate(self):
        with self.assertRaises(mt.AdmissionError):
            mt.compile_specialist(self.weighted, envelope={"max_algorithm_work_units": 1})
        plan = mt.compile_specialist(self.weighted)
        # A caller cannot lower the estimate and thereby bypass runtime admission.
        plan["resource_estimate"]["worst_case_algorithm_work_units"] = 0
        result = mt.execute_plan(self.weighted, plan, envelope={"max_algorithm_work_units": 1})
        self.assertEqual(result["status"], "rejected")

    def test_allowlist_does_not_gain_authority_from_memory(self):
        with self.assertRaises(mt.AdmissionError):
            mt.compile_specialist(self.weighted, envelope={"allowed_tool_ids": []},
                                  procedure_hint={"preferred_algorithm": "dijkstra"})

    def test_catalog_schema_drift_rejected_even_when_recompiled(self):
        catalog = mt.default_catalog()
        catalog["tools"]["local.graph.dijkstra.v1"]["input_schema_digest"] = "false-schema"
        with self.assertRaises(mt.AdmissionError):
            mt.compile_specialist(self.weighted, catalog=catalog)

    def test_malformed_catalog_resources_rejected(self):
        catalog = mt.default_catalog()
        catalog["tools"]["local.graph.dijkstra.v1"]["resource_requirements"] = "claim unlimited"
        with self.assertRaises(mt.AdmissionError):
            mt.compile_specialist(self.weighted, catalog=catalog)

    def test_schema_content_cannot_be_changed_while_claiming_old_digest(self):
        catalog = mt.default_catalog()
        catalog["tools"]["local.graph.dijkstra.v1"]["inputSchema"]["additionalProperties"] = True
        with self.assertRaises(mt.AdmissionError):
            mt.compile_specialist(self.weighted, catalog=catalog)

    def test_negative_boolean_duplicate_and_invalid_vertices_rejected(self):
        bad = [graph(2, [[0, 1, -1]]), graph(2, [[0, 1, True]]),
               graph(2, [[0, 1, 1], [0, 1, 2]]), graph(2, [[0, 2, 1]]),
               graph(True, []), graph(0, []), graph(2, [], source=True),
               graph(2, [[0, 1, 1.0]])]
        for task in bad:
            with self.subTest(task=task), self.assertRaises(ValueError):
                mt.compile_specialist(task)

    def test_empty_graph_reachable_and_unreachable(self):
        for n in (1, 2):
            task = graph(n, [])
            result = mt.execute_plan(task, mt.compile_specialist(task))
            self.assertEqual(result["status"], "verified")
            self.assertEqual(result["certificate"]["kind"],
                             "shortest_path" if n == 1 else "unreachable")


class AlgorithmOracleTests(unittest.TestCase):
    def test_algorithms_match_independent_oracle_on_seeded_graphs(self):
        rng = random.Random(730311)
        for case in range(60):
            n = rng.randrange(2, 15)
            unit = case % 3 == 0
            edges = [[u, v, 1 if unit else rng.randrange(0, 20)]
                     for u in range(n) for v in range(n)
                     if u != v and rng.random() < 0.18]
            task = graph(n, edges, rng.randrange(n), rng.randrange(n))
            oracle = floyd_warshall_cost(task)
            algorithms = ["dijkstra", "bellman_ford", "iterative_bellman_ford"]
            if unit:
                algorithms.append("bfs")
            for algorithm in algorithms:
                with self.subTest(case=case, algorithm=algorithm):
                    plan = mt.compile_specialist(task, procedure_hint={"preferred_algorithm": algorithm})
                    result = mt.execute_plan(task, plan)
                    self.assertEqual(result["status"], "verified", result)
                    self.assertEqual(result["certificate"]["cost"], oracle)
                    self.assertTrue(mt.verify_certificate(task, result["certificate"])["valid"])

    def test_batched_and_iterative_bellman_do_identical_algorithmic_work(self):
        task = graph(6, [[0, 4, 2], [4, 2, 3], [2, 5, 1], [5, 1, 1], [1, 3, 1]], target=3)
        results = {}
        for algorithm in ("bellman_ford", "iterative_bellman_ford"):
            plan = mt.compile_specialist(task, procedure_hint={"preferred_algorithm": algorithm})
            results[algorithm] = mt.execute_plan(task, plan)
        a, b = results.values()
        self.assertEqual(a["certificate"], b["certificate"])
        self.assertEqual(a["stats"]["algorithm_work_units"], b["stats"]["algorithm_work_units"])
        self.assertEqual(a["stats"]["modeled_tool_boundary_calls"], 1)
        self.assertEqual(b["stats"]["modeled_tool_boundary_calls"], 1 + b["stats"]["edge_scans"])

    def test_semantic_result_is_deterministic(self):
        task = graph(3, [[0, 1, 0], [1, 2, 1], [0, 2, 1]])
        plan = mt.compile_specialist(task)
        a = mt.execute_plan(task, plan)
        b = mt.execute_plan(task, plan)
        self.assertEqual(a["certificate_digest"], b["certificate_digest"])
        self.assertEqual(a["stats"]["algorithm_work_units"], b["stats"]["algorithm_work_units"])


if __name__ == "__main__":
    unittest.main()
