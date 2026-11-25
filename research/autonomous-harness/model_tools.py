"""Bounded, certificate-carrying graph specialists for an agent harness.

This is a standard-library CPU prototype, not a neural network or an MCP server.
The compiler selects a registered, typed algorithm; it does not execute generated
code. A retrieved procedure is a hint, never an authorization or proof.

Public interfaces accept/return JSON-compatible dictionaries:
    compile_specialist(task, catalog=None, envelope=None, procedure_hint=None)
    execute_plan(task, plan, catalog=None, envelope=None)
    verify_certificate(task, certificate)

Nonnegative integer directed graphs only. Certificate checking is independent of
the solver: edge-feasible potentials prove shortest-path optimality; a closed
reachable set proves unreachability. See SOURCE_RESEARCH.ko.md for assumptions.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import heapq
import json
import platform
import random
import statistics
import sys
import time
from collections import deque
from pathlib import Path
from typing import Any, Mapping


SCHEMA_VERSION = "1"
IMPLEMENTATION_VERSION = "0.1.0"
ALGORITHMS = ("bfs", "dijkstra", "bellman_ford", "iterative_bellman_ford")
TOOL_IDS = {a: f"local.graph.{a}.v1" for a in ALGORITHMS}
TASK_FIELDS = {"schema_version", "n", "edges", "source", "target"}
CERTIFICATE_FIELDS = {"schema_version", "task_digest", "kind", "path", "cost",
                      "potentials", "reachable"}
TASK_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object",
    "additionalProperties": False,
    "required": sorted(TASK_FIELDS),
    "properties": {
        "schema_version": {"const": "1"},
        "n": {"type": "integer", "minimum": 1, "maximum": 50_000},
        "edges": {"type": "array", "maxItems": 500_000, "items": {
            "type": "array", "minItems": 3, "maxItems": 3,
            "prefixItems": [{"type": "integer", "minimum": 0}] * 3,
        }},
        "source": {"type": "integer", "minimum": 0},
        "target": {"type": "integer", "minimum": 0},
    },
    "description": "Additional semantic checks: endpoints below n; unique directed endpoint pairs.",
}
CERTIFICATE_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object",
    "additionalProperties": False, "required": sorted(CERTIFICATE_FIELDS),
    "properties": {
        "schema_version": {"const": "1"}, "task_digest": {"type": "string"},
        "kind": {"enum": ["shortest_path", "unreachable"]},
        "path": {"type": "array", "items": {"type": "integer", "minimum": 0}},
        "cost": {"type": ["integer", "null"], "minimum": 0},
        "potentials": {"type": ["array", "null"], "items": {"type": "integer", "minimum": 0}},
        "reachable": {"type": ["array", "null"], "items": {"type": "integer", "minimum": 0}},
    },
    "oneOf": [
        {"properties": {"kind": {"const": "shortest_path"}, "cost": {"type": "integer"},
                        "potentials": {"type": "array"}, "reachable": {"type": "null"}}},
        {"properties": {"kind": {"const": "unreachable"}, "path": {"maxItems": 0},
                        "cost": {"type": "null"}, "potentials": {"type": "null"},
                        "reachable": {"type": "array"}}},
    ],
    "description": "The independent checker additionally checks path optimality or cut closure.",
}


def _digest(value: Any) -> str:
    data = json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, allow_nan=False).encode("utf-8")
    return "sha256:" + hashlib.sha256(data).hexdigest()


# Process-pinned source identity; this does not attest an arbitrary remote server.
IMPLEMENTATION_DIGEST = "sha256:" + hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
INPUT_SCHEMA_DIGEST = _digest(TASK_SCHEMA)
OUTPUT_SCHEMA_DIGEST = _digest(CERTIFICATE_SCHEMA)


class AdmissionError(ValueError):
    """The requested task/tool/resource combination is outside its contract."""


class BudgetExhausted(RuntimeError):
    """Deterministic algorithm work-unit budget was exhausted."""


def _nat(value: Any) -> bool:
    return type(value) is int and value >= 0


def normalize_task(task: Mapping[str, Any]) -> dict[str, Any]:
    """Validate and canonicalize, including semantic independence of edge order."""
    if not isinstance(task, Mapping) or set(task) != TASK_FIELDS:
        raise ValueError("task must have exactly the documented fields")
    if task["schema_version"] != SCHEMA_VERSION:
        raise ValueError("unsupported task schema version")
    n = task["n"]
    if not _nat(n) or n < 1 or n > 50_000:
        raise ValueError("n must be an integer in [1, 50000]")
    for key in ("source", "target"):
        if not _nat(task[key]) or task[key] >= n:
            raise ValueError(f"invalid {key} vertex")
    edges = task["edges"]
    if not isinstance(edges, (list, tuple)) or len(edges) > 500_000:
        raise ValueError("edges must be a bounded array")
    seen = set()
    canonical = []
    for edge in edges:
        if not isinstance(edge, (list, tuple)) or len(edge) != 3:
            raise ValueError("each edge must be a triple")
        u, v, w = edge
        if not _nat(u) or not _nat(v) or u >= n or v >= n or not _nat(w):
            raise ValueError("edge endpoints and weights must be nonnegative integers")
        if (u, v) in seen:
            raise ValueError("parallel edges are not supported")
        seen.add((u, v))
        canonical.append([u, v, w])
    canonical.sort()
    return {"schema_version": "1", "n": n, "edges": canonical,
            "source": task["source"], "target": task["target"]}


def task_digest(task: Mapping[str, Any]) -> str:
    return _digest(normalize_task(task))


def default_catalog() -> dict[str, Any]:
    """Local, pinned allowlist. Metadata is an application contract, not MCP auth."""
    tools = {}
    for algorithm in ALGORITHMS:
        tool_id = TOOL_IDS[algorithm]
        tools[tool_id] = {
            "tool_id": tool_id,
            "version": IMPLEMENTATION_VERSION,
            "algorithm": algorithm,
            "implementation_digest": IMPLEMENTATION_DIGEST,
            "inputSchema": copy.deepcopy(TASK_SCHEMA),
            "outputSchema": copy.deepcopy(CERTIFICATE_SCHEMA),
            "input_schema_digest": INPUT_SCHEMA_DIGEST,
            "output_schema_digest": OUTPUT_SCHEMA_DIGEST,
            "capabilities": ["graph.shortest_path", "graph.unreachable_cut", "certificate.emit"],
            "effect_class": "pure",
            "idempotency": "content_addressed_pure_function",
            "resource_requirements": {"cpu_slots": 1, "gpu_slots": 0,
                                      "minimum_memory_mb": 64},
            "status": "local_prototype_allowlisted",
        }
    return {"schema_version": "1", "tools": tools}


def default_envelope() -> dict[str, Any]:
    return {
        "schema_version": "1", "cpu_slots": 1, "gpu_slots": 0, "memory_mb": 256,
        "max_vertices": 10_000, "max_edges": 100_000,
        "max_algorithm_work_units": 20_000_000,
        "allowed_tool_ids": list(TOOL_IDS.values()), "allowed_effects": ["pure"],
    }


def _envelope(overrides: Mapping[str, Any] | None) -> dict[str, Any]:
    env = default_envelope()
    if overrides is not None:
        if not isinstance(overrides, Mapping) or not set(overrides).issubset(env):
            raise AdmissionError("unknown resource envelope fields")
        env.update(copy.deepcopy(dict(overrides)))
    if env["schema_version"] != "1":
        raise AdmissionError("unsupported resource envelope schema")
    for key in ("cpu_slots", "gpu_slots", "memory_mb", "max_vertices", "max_edges",
                "max_algorithm_work_units"):
        if not _nat(env[key]):
            raise AdmissionError(f"invalid envelope {key}")
    for key in ("allowed_tool_ids", "allowed_effects"):
        if not isinstance(env[key], list) or not all(isinstance(x, str) for x in env[key]):
            raise AdmissionError(f"invalid envelope {key}")
    return env


def _eligible(task: Mapping[str, Any], algorithm: str) -> bool:
    return algorithm in ALGORITHMS and (algorithm != "bfs" or all(w == 1 for _, _, w in task["edges"]))


def _work_bound(task: Mapping[str, Any], algorithm: str) -> int:
    n, m = task["n"], len(task["edges"])
    if algorithm in ("bellman_ford", "iterative_bellman_ford"):
        return (n - 1) * m
    if algorithm == "bfs":
        return m + 2 * n
    if algorithm == "dijkstra":
        return 3 * m + 2
    raise AdmissionError("unsupported local algorithm")


def _manifest(catalog: Mapping[str, Any], tool_id: str) -> dict[str, Any]:
    if not isinstance(catalog, Mapping) or catalog.get("schema_version") != "1":
        raise AdmissionError("unsupported tool catalog schema")
    tool_map = catalog.get("tools")
    if not isinstance(tool_map, Mapping) or tool_id not in tool_map:
        raise AdmissionError("tool missing from current catalog")
    manifest = tool_map[tool_id]
    if not isinstance(manifest, dict):
        raise AdmissionError("invalid tool manifest")
    return manifest


def _admit(task: Mapping[str, Any], algorithm: str, manifest: Mapping[str, Any],
           env: Mapping[str, Any]) -> None:
    if not _eligible(task, algorithm):
        raise AdmissionError("algorithm is not eligible for this graph")
    tool_id = TOOL_IDS[algorithm]
    if manifest.get("tool_id") != tool_id or manifest.get("algorithm") != algorithm:
        raise AdmissionError("manifest does not identify the registered local kernel")
    expected = {
        "version": IMPLEMENTATION_VERSION, "implementation_digest": IMPLEMENTATION_DIGEST,
        "input_schema_digest": INPUT_SCHEMA_DIGEST, "output_schema_digest": OUTPUT_SCHEMA_DIGEST,
        "effect_class": "pure", "idempotency": "content_addressed_pure_function",
        "status": "local_prototype_allowlisted",
    }
    for key, value in expected.items():
        if manifest.get(key) != value:
            raise AdmissionError(f"unadmitted tool {key}")
    if manifest.get("inputSchema") != TASK_SCHEMA or manifest.get("outputSchema") != CERTIFICATE_SCHEMA:
        raise AdmissionError("unadmitted tool schema content")
    if tool_id not in env["allowed_tool_ids"] or "pure" not in env["allowed_effects"]:
        raise AdmissionError("tool/effect is outside the resource capability envelope")
    if task["n"] > env["max_vertices"] or len(task["edges"]) > env["max_edges"]:
        raise AdmissionError("graph exceeds input resource envelope")
    resources = manifest.get("resource_requirements", {})
    if not isinstance(resources, Mapping):
        raise AdmissionError("invalid resource requirement manifest")
    for required, available, minimum in (("cpu_slots", "cpu_slots", 1),
                                          ("gpu_slots", "gpu_slots", 0),
                                          ("minimum_memory_mb", "memory_mb", 64)):
        amount = resources.get(required)
        if not _nat(amount) or amount < minimum or amount > env[available]:
            raise AdmissionError(f"resource unavailable: {required}")
    if _work_bound(task, algorithm) > env["max_algorithm_work_units"]:
        raise AdmissionError("worst-case algorithm work exceeds admitted budget")


def compile_specialist(task: Mapping[str, Any], catalog: Mapping[str, Any] | None = None,
                       envelope: Mapping[str, Any] | None = None,
                       procedure_hint: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """A typed compiler for four known algorithms, not arbitrary code generation.

    The baseline selector is a rule: unit weights -> BFS; otherwise -> Dijkstra.
    A compatible procedure hint can select another allowlisted algorithm. No
    learned model is implemented here. Hints cannot grant resources/capabilities.
    """
    task = normalize_task(task)
    catalog = default_catalog() if catalog is None else catalog
    env = _envelope(envelope)
    algorithm = "bfs" if _eligible(task, "bfs") else "dijkstra"
    selected_by, fallback_reason, evidence = "deterministic_compiler", None, None
    if procedure_hint is not None:
        if not isinstance(procedure_hint, Mapping):
            raise ValueError("procedure_hint must be a mapping")
        preferred = procedure_hint.get("preferred_algorithm")
        if _eligible(task, preferred):
            algorithm = preferred
            selected_by = "procedural_memory_hint"
            evidence = procedure_hint.get("evidence_digest")
            if evidence is not None and not isinstance(evidence, str):
                raise ValueError("evidence_digest must be text or null")
        else:
            fallback_reason = "procedure hint not eligible for current input schema/preconditions"
    tool_id = TOOL_IDS[algorithm]
    manifest = _manifest(catalog, tool_id)
    _admit(task, algorithm, manifest, env)
    plan = {
        "schema_version": "1", "task_digest": _digest(task), "tool_id": tool_id,
        "tool_digest": _digest(manifest), "algorithm": algorithm,
        "selected_by": selected_by, "procedure_evidence_digest": evidence,
        "fallback_reason": fallback_reason,
        "resource_estimate": {
            "worst_case_algorithm_work_units": _work_bound(task, algorithm),
            "work_unit_definition": "one edge scan or one frontier push/pop; not CPU cycles",
            "verification_edge_checks_upper_bound": len(task["edges"]) + max(0, task["n"] - 1),
        },
    }
    plan["plan_id"] = _digest(plan)
    return plan


class _Meter:
    def __init__(self, budget: int, iterative: bool = False):
        self.budget = budget
        self.stats = {"algorithm_work_units": 0, "edge_scans": 0, "frontier_pushes": 0,
                      "frontier_pops": 0, "successful_relaxations": 0, "passes": 0,
                      "modeled_tool_boundary_calls": 1}
        self.iterative = iterative

    def step(self, key: str) -> None:
        if self.stats["algorithm_work_units"] >= self.budget:
            raise BudgetExhausted("algorithm work-unit budget exhausted")
        self.stats["algorithm_work_units"] += 1
        self.stats[key] += 1
        if key == "edge_scans" and self.iterative:
            self.stats["modeled_tool_boundary_calls"] += 1


def _solve(task: Mapping[str, Any], algorithm: str, meter: _Meter):
    n, source = task["n"], task["source"]
    distances: list[int | None] = [None] * n
    predecessors: list[int | None] = [None] * n
    distances[source] = 0
    if algorithm in ("bellman_ford", "iterative_bellman_ford"):
        for _ in range(n - 1):
            meter.stats["passes"] += 1
            changed = False
            for u, v, w in task["edges"]:
                meter.step("edge_scans")
                if distances[u] is not None:
                    candidate = distances[u] + w
                    if distances[v] is None or candidate < distances[v]:
                        distances[v] = candidate
                        predecessors[v] = u
                        meter.stats["successful_relaxations"] += 1
                        changed = True
            if not changed:
                break
        return distances, predecessors

    adjacency = [[] for _ in range(n)]
    for u, v, w in task["edges"]:
        adjacency[u].append((v, w))
    if algorithm == "bfs":
        queue = deque([source])
        meter.step("frontier_pushes")
        while queue:
            u = queue.popleft()
            meter.step("frontier_pops")
            for v, _ in adjacency[u]:
                meter.step("edge_scans")
                if distances[v] is None:
                    distances[v] = distances[u] + 1
                    predecessors[v] = u
                    meter.stats["successful_relaxations"] += 1
                    queue.append(v)
                    meter.step("frontier_pushes")
        return distances, predecessors

    heap = [(0, source)]
    meter.step("frontier_pushes")
    while heap:
        distance, u = heapq.heappop(heap)
        meter.step("frontier_pops")
        if distances[u] != distance:
            continue
        for v, w in adjacency[u]:
            meter.step("edge_scans")
            candidate = distance + w
            if distances[v] is None or candidate < distances[v]:
                distances[v] = candidate
                predecessors[v] = u
                meter.stats["successful_relaxations"] += 1
                heapq.heappush(heap, (candidate, v))
                meter.step("frontier_pushes")
    return distances, predecessors


def _certificate(task: Mapping[str, Any], distances, predecessors) -> dict[str, Any]:
    source, target = task["source"], task["target"]
    cert = {"schema_version": "1", "task_digest": _digest(task), "kind": "unreachable",
            "path": [], "cost": None, "potentials": None,
            "reachable": [v for v, distance in enumerate(distances) if distance is not None]}
    if distances[target] is None:
        return cert
    path, current = [], target
    for _ in range(task["n"]):
        path.append(current)
        if current == source:
            break
        current = predecessors[current]
        if current is None:
            raise ValueError("solver returned a broken predecessor chain")
    if path[-1] != source:
        raise ValueError("solver returned a cyclic predecessor chain")
    path.reverse()
    # No edge can go from a source-reachable vertex to an unreachable one.
    # Assigning the maximum finite distance to other vertices makes every
    # remaining edge feasible because all weights are nonnegative.
    maximum = max(d for d in distances if d is not None)
    potentials = [maximum if d is None else d for d in distances]
    cert.update(kind="shortest_path", path=path, cost=distances[target],
                potentials=potentials, reachable=None)
    return cert


def verify_certificate(task: Mapping[str, Any], certificate: Mapping[str, Any]) -> dict[str, Any]:
    """Check a mathematical witness without running a shortest-path algorithm.

    Potentials p satisfy p(s)=0 and p(v)<=p(u)+w for every edge. Induction along
    any competing walk proves p(t)<=its cost; a valid path of cost p(t) is optimal.
    A source-containing, target-excluding closed set rules out every s->t walk.

    This proves graph-model correctness, not correspondence of an extracted graph
    to a user's real task, CPU speed, MCP identity, or correctness of Python itself.
    """
    checks = 0

    def require(condition: bool, reason: str):
        nonlocal checks
        checks += 1
        if not condition:
            raise ValueError(reason)

    try:
        task = normalize_task(task)
        n, source, target = task["n"], task["source"], task["target"]
        require(isinstance(certificate, Mapping) and set(certificate) == CERTIFICATE_FIELDS,
                "certificate fields do not match the strict schema")
        require(certificate["schema_version"] == "1", "unsupported certificate schema")
        require(certificate["task_digest"] == _digest(task), "task digest mismatch")
        kind = certificate["kind"]
        require(kind in ("shortest_path", "unreachable"), "unknown certificate kind")
        if kind == "unreachable":
            reachable = certificate["reachable"]
            require(certificate["path"] == [] and certificate["cost"] is None
                    and certificate["potentials"] is None, "mixed certificate variants")
            require(isinstance(reachable, list) and len(reachable) <= n,
                    "invalid reachable set representation")
            require(all(_nat(x) and x < n for x in reachable), "invalid cut vertex")
            require(len(set(reachable)) == len(reachable), "duplicate cut vertices")
            reached = set(reachable)
            require(source in reached and target not in reached, "invalid cut endpoints")
            for u, v, _ in task["edges"]:
                require(u not in reached or v in reached, "cut is not closed under edges")
            return {"valid": True, "reason": "unreachable cut verified", "checks": checks}

        require(certificate["reachable"] is None, "mixed certificate variants")
        path, potentials, cost = certificate["path"], certificate["potentials"], certificate["cost"]
        require(isinstance(path, list) and 1 <= len(path) <= n, "invalid path representation")
        require(all(_nat(v) and v < n for v in path), "invalid path vertex")
        require(len(set(path)) == len(path), "path must be simple")
        require(path[0] == source and path[-1] == target, "path endpoints mismatch")
        require(_nat(cost), "cost must be a nonnegative integer")
        require(isinstance(potentials, list) and len(potentials) == n,
                "invalid potential vector length")
        require(all(_nat(p) for p in potentials), "potentials must be nonnegative integers")
        require(potentials[source] == 0, "source potential is not zero")
        edge_map = {}
        for u, v, w in task["edges"]:
            require(potentials[v] <= potentials[u] + w, "infeasible edge potential")
            edge_map[(u, v)] = w
        path_cost = 0
        for u, v in zip(path, path[1:]):
            require((u, v) in edge_map, "path contains an absent edge")
            path_cost += edge_map[(u, v)]
        require(path_cost == cost == potentials[target], "path cost/potential mismatch")
        return {"valid": True, "reason": "optimal shortest path verified", "checks": checks}
    except (ValueError, TypeError, KeyError, OverflowError) as exc:
        return {"valid": False, "reason": str(exc), "checks": checks}


def execute_plan(task: Mapping[str, Any], plan: Mapping[str, Any],
                 catalog: Mapping[str, Any] | None = None,
                 envelope: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Recheck admission, execute a local kernel, and independently verify it.

    Plan hashes identify content; they are not signatures or authorization tokens.
    The executor recomputes budget bounds and permissions from current inputs.
    No network, file mutations, model inference, or GPU work is performed here.
    """
    start = time.perf_counter_ns()
    meter = None
    try:
        task = normalize_task(task)
        catalog = default_catalog() if catalog is None else catalog
        env = _envelope(envelope)
        if not isinstance(plan, Mapping) or plan.get("schema_version") != "1":
            raise AdmissionError("unsupported execution plan schema")
        unsigned_plan = {key: value for key, value in plan.items() if key != "plan_id"}
        if plan.get("plan_id") != _digest(unsigned_plan):
            raise AdmissionError("plan digest changed since compilation")
        if plan.get("task_digest") != _digest(task):
            raise AdmissionError("task digest changed since compilation")
        tool_id, algorithm = plan.get("tool_id"), plan.get("algorithm")
        if algorithm not in ALGORITHMS or tool_id != TOOL_IDS[algorithm]:
            raise AdmissionError("plan algorithm does not match registered tool")
        manifest = _manifest(catalog, tool_id)
        if plan.get("tool_digest") != _digest(manifest):
            raise AdmissionError("tool digest changed since compilation")
        _admit(task, algorithm, manifest, env)
        meter = _Meter(env["max_algorithm_work_units"], algorithm == "iterative_bellman_ford")
        algorithm_start = time.perf_counter_ns()
        distances, predecessors = _solve(task, algorithm, meter)
        algorithm_ns = time.perf_counter_ns() - algorithm_start
        certificate = _certificate(task, distances, predecessors)
        verification_start = time.perf_counter_ns()
        verification = verify_certificate(task, certificate)
        verification_ns = time.perf_counter_ns() - verification_start
        stats = dict(meter.stats)
        stats.update(algorithm_elapsed_ns=algorithm_ns, verification_elapsed_ns=verification_ns,
                     total_elapsed_ns=time.perf_counter_ns() - start,
                     verifier_checks=verification["checks"], verifier_invocations=1,
                     actual_provider_calls=0, gpu_jobs=0)
        return {
            "schema_version": "1", "status": "verified" if verification["valid"] else "rejected",
            "reason": verification["reason"], "algorithm": algorithm,
            "task_digest": _digest(task), "tool_id": tool_id, "tool_digest": _digest(manifest),
            "certificate": certificate, "certificate_digest": _digest(certificate),
            "verification": verification, "stats": stats,
        }
    except (ValueError, TypeError, KeyError, BudgetExhausted) as exc:
        stats = {} if meter is None else dict(meter.stats)
        stats["total_elapsed_ns"] = time.perf_counter_ns() - start
        return {"schema_version": "1", "status": "budget_exhausted" if isinstance(exc, BudgetExhausted)
                else "rejected", "reason": str(exc), "certificate": None, "stats": stats}


def _synthetic_task(family: str, n: int, seed: int) -> dict[str, Any]:
    rng = random.Random(seed)
    edges: dict[tuple[int, int], int] = {}
    source, target = 0, n - 1
    if family == "permuted_chain":
        order = list(range(n))
        rng.shuffle(order)
        source, target = order[0], order[-1]
        for u, v in zip(order, order[1:]):
            edges[(u, v)] = rng.randrange(1, 10)
    elif family == "dense":
        for u in range(n):
            for v in range(n):
                if u != v and rng.random() < 0.24:
                    edges[(u, v)] = rng.randrange(1, 21)
    elif family == "disconnected":
        split = n // 2
        for _ in range(5 * n):
            lo, hi = (0, split) if rng.random() < 0.5 else (split, n)
            u, v = rng.randrange(lo, hi), rng.randrange(lo, hi)
            if u != v:
                edges[(u, v)] = rng.randrange(1, 21)
    else:
        unit = family == "unit_sparse"
        zero = family == "zero_weight"
        # All sparse families include a reachability chain, shuffled by vertex ID.
        order = list(range(n))
        rng.shuffle(order)
        source, target = order[0], order[-1]
        for u, v in zip(order, order[1:]):
            edges[(u, v)] = 1 if unit else rng.randrange(0 if zero else 1, 21)
        for _ in range(4 * n):
            u, v = rng.randrange(n), rng.randrange(n)
            if u != v:
                edges[(u, v)] = 1 if unit else rng.randrange(0 if zero else 1, 21)
    return normalize_task({"schema_version": "1", "n": n,
                           "edges": [[u, v, w] for (u, v), w in edges.items()],
                           "source": source, "target": target})


def run_benchmark(seed: int = 20261125, cases_per_family: int = 8) -> dict[str, Any]:
    """Mechanism benchmark, not a model-training or general-agent benchmark.

    All four conditions receive exactly the same tasks. The 'iterative' condition
    counts one logical tool boundary per edge scan, in-process, without network or
    LLM latency. The Dijkstra baseline prevents attributing a known algorithmic
    improvement to autonomous harness intelligence.
    """
    families = ("weighted_sparse", "unit_sparse", "zero_weight", "disconnected",
                "permuted_chain", "dense")
    conditions = ("iterative_bellman_ford", "bellman_ford", "dijkstra", "compiler")
    catalog = default_catalog()
    config = {"seed": seed, "cases_per_family": cases_per_family,
              "families": list(families), "conditions": list(conditions),
              "size_rule": "n=64+16*(case_index mod 8)"}
    rows, digests = [], []
    for family_index, family in enumerate(families):
        for case_index in range(cases_per_family):
            task = _synthetic_task(family, 64 + 16 * (case_index % 8),
                                   seed + family_index * 10_000 + case_index)
            digests.append(task_digest(task))
            for condition in conditions:
                hint = None if condition == "compiler" else {"preferred_algorithm": condition}
                compile_start = time.perf_counter_ns()
                plan = compile_specialist(task, catalog=catalog, procedure_hint=hint)
                compile_ns = time.perf_counter_ns() - compile_start
                outcome = execute_plan(task, plan, catalog=catalog)
                if outcome["status"] != "verified":
                    raise RuntimeError(f"benchmark execution failed: {outcome}")
                cert = outcome["certificate"]
                rows.append({"family": family, "case": case_index, "n": task["n"],
                             "m": len(task["edges"]), "task_digest": task_digest(task),
                             "condition": condition, "selected_algorithm": outcome["algorithm"],
                             "status": outcome["status"], "answer_kind": cert["kind"],
                             "answer_cost": cert["cost"], "path_length": len(cert["path"]),
                             "certificate_digest": outcome["certificate_digest"],
                             "compile_elapsed_ns": compile_ns, **outcome["stats"]})
    summaries = {}
    for condition in conditions:
        subset = [r for r in rows if r["condition"] == condition]
        summaries[condition] = {
            "tasks": len(subset), "verified": sum(r["status"] == "verified" for r in subset),
            "algorithm_work_units": sum(r["algorithm_work_units"] for r in subset),
            "edge_scans": sum(r["edge_scans"] for r in subset),
            "modeled_tool_boundary_calls": sum(r["modeled_tool_boundary_calls"] for r in subset),
            "verifier_checks": sum(r["verifier_checks"] for r in subset),
            "actual_provider_calls": 0, "gpu_jobs": 0,
            "total_compile_elapsed_ns": sum(r["compile_elapsed_ns"] for r in subset),
            "total_execution_elapsed_ns": sum(r["total_elapsed_ns"] for r in subset),
            "median_execution_elapsed_ns": int(statistics.median(r["total_elapsed_ns"] for r in subset)),
        }
    deterministic_rows = [{k: v for k, v in r.items() if not k.endswith("elapsed_ns")} for r in rows]
    return {
        "schema_version": "1", "experiment": "certificate_carrying_graph_microkernels_v1",
        "scope": "synthetic nonnegative directed graphs; modeled boundary calls; no model training",
        "config": config, "config_digest": _digest(config), "task_corpus_digest": _digest(digests),
        "deterministic_results_digest": _digest(deterministic_rows),
        "implementation_digest": IMPLEMENTATION_DIGEST,
        "environment": {"python": sys.version.split()[0], "platform": platform.platform(),
                        "machine": platform.machine(), "gpu_available": "not probed"},
        "cost_ledger": {
            "executed": {"training_jobs": 0, "neural_inference_calls": 0,
                         "external_tool_calls": 0, "gpu_jobs": 0},
            "timing_scope": "measured local Python compile/execute/check only; host-specific",
            "generation_cost": "human/assistant development cost not metered",
            "provider_price_assumption": None,
            "amortization": "include generation+training+validation+deployment+maintenance; not estimated here",
        },
        "summaries": summaries, "rows": rows,
        "limitations": [
            "There is no trained Transformer or learned router in this prototype.",
            "All algorithms are exact for the admitted graph class, so no agent accuracy gain is claimed.",
            "Tool-boundary counts are simulated in-process; no MCP network latency is measured.",
            "Operation counts omit initialization, parsing, graph normalization, certificate construction and checking; timings include most of those separately or in total execution.",
            "The input graph's fidelity to a real task is not certified.",
            "Declared memory requirements are admission metadata, not an OS-enforced RAM limit.",
            "No remote execution, GPU availability, energy use, or dollar cost was measured.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo", action="store_true")
    parser.add_argument("--output", type=Path, default=Path("demo_results.json"))
    parser.add_argument("--seed", type=int, default=20261125)
    parser.add_argument("--cases-per-family", type=int, default=8)
    args = parser.parse_args()
    if not args.demo:
        parser.error("use --demo to run the bounded CPU experiment")
    if not 1 <= args.cases_per_family <= 32:
        parser.error("--cases-per-family must be in [1,32]")
    result = run_benchmark(args.seed, args.cases_per_family)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "task_corpus_digest": result["task_corpus_digest"],
                      "deterministic_results_digest": result["deterministic_results_digest"],
                      "summaries": result["summaries"]}, indent=2))


if __name__ == "__main__":
    main()
