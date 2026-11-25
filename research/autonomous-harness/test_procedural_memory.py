"""Behavioral contract tests: evidence, scope, tool binding, lifecycle and use."""

from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest

from procedural_memory import (
    Episode, MemoryContractError, MemoryStore, ProcedureSpec, RetrievalContext,
    ToolBinding, digest,
)


TOOL = ToolBinding("inventory", "1", digest({"operation": "inventory/v1"}))


def episode(**changes):
    value = Episode("episode-a", "demo", "inventory", "task-a", "inventory total",
                    "Inspect the schema before reading rows.", "success", digest("trace-a"),
                    "observer", 1, 1000)
    return replace(value, **changes)


def procedure(**changes):
    value = ProcedureSpec("procedure-a", "demo", "inventory", "inventory total",
                          "Inspect schema before read rows", ("describe", "read", "total"),
                          ("inventory.read",), (TOOL,), ("episode-a",), "learner", 2, 3)
    return replace(value, **changes)


def context(**changes):
    value = RetrievalContext("demo", "inventory", "task-b", "run-b", "inventory total",
                             ("inventory.read",), (TOOL,), 10, 10, 8000, 3)
    return replace(value, **changes)


def seed(store, spec=None, *, checked_at=3, expires_at=900):
    spec = spec or procedure()
    store.add_episode(episode())
    identity = store.propose_procedure(spec)
    store.validate(spec.procedure_id, procedure_digest=identity, reviewer="evaluator",
                   suite_digest=digest("suite-v1"), evidence_digest=digest("validation-trace"),
                   task_ids=("task-c",), passed=True, checked_at=checked_at, expires_at=expires_at)
    return identity


class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "memory.sqlite"
        self.store = MemoryStore(self.path)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_candidate_cannot_be_retrieved_before_validation(self):
        self.store.add_episode(episode())
        self.store.propose_procedure(procedure())
        result = self.store.retrieve(context())
        self.assertEqual((), result.hits)
        self.assertEqual("not_validated_or_terminal", result.rejections["procedure-a"])

    def test_validation_binds_exact_bytes_and_different_source_tasks(self):
        self.store.add_episode(episode())
        identity = self.store.propose_procedure(procedure())
        args = dict(procedure_digest=identity, reviewer="evaluator", suite_digest=digest("suite"),
                    evidence_digest=digest("receipt"), task_ids=("task-c",), passed=True,
                    checked_at=3, expires_at=100)
        for change in ({"procedure_digest": digest("wrong")}, {"reviewer": "learner"},
                       {"task_ids": ("task-a",)}, {"checked_at": 1}, {"passed": "true"}):
            with self.subTest(change=change), self.assertRaises(MemoryContractError):
                self.store.validate("procedure-a", **{**args, **change})
        self.assertEqual(0, self.store.audit_counts()["validations"])

    def test_failed_validation_is_not_promoted(self):
        self.store.add_episode(episode())
        identity = self.store.propose_procedure(procedure())
        self.store.validate("procedure-a", procedure_digest=identity, reviewer="evaluator",
                            suite_digest=digest("suite"), evidence_digest=digest("failure"),
                            task_ids=("task-c",), passed=False, checked_at=3, expires_at=100)
        self.assertEqual((), self.store.retrieve(context()).hits)

    def test_project_and_task_family_are_hard_filters(self):
        seed(self.store)
        for change in ({"project": "other"}, {"task_family": "payments"}):
            result = self.store.retrieve(context(**change))
            self.assertEqual((), result.hits)
            self.assertEqual("scope_mismatch", result.rejections["procedure-a"])

    def test_tool_schema_and_version_are_hard_filters(self):
        seed(self.store)
        for tool in (replace(TOOL, version="2"), replace(TOOL, schema_digest=digest("drift"))):
            result = self.store.retrieve(context(tools=(tool,)))
            self.assertEqual((), result.hits)
            self.assertEqual("tool_binding_mismatch", result.rejections["procedure-a"])

    def test_capability_and_execution_budget_are_hard_filters(self):
        seed(self.store)
        for change, reason in (({"capabilities": ()}, "capability_mismatch"),
                               ({"budget_units": 2}, "execution_budget")):
            result = self.store.retrieve(context(**change))
            self.assertEqual((), result.hits)
            self.assertEqual(reason, result.rejections["procedure-a"])

    def test_expired_and_future_validation_are_excluded(self):
        seed(self.store, checked_at=3, expires_at=12)
        for now in (2, 12, 13):
            result = self.store.retrieve(context(now=now))
            self.assertEqual((), result.hits)
            self.assertEqual("validation_expired_or_future", result.rejections["procedure-a"])

    def test_source_evidence_expiry_is_separate(self):
        self.store.add_episode(episode(evidence_expires_at=20))
        identity = self.store.propose_procedure(procedure())
        self.store.validate("procedure-a", procedure_digest=identity, reviewer="evaluator",
                            suite_digest=digest("suite"), evidence_digest=digest("validation"),
                            task_ids=("task-c",), passed=True, checked_at=3, expires_at=100)
        self.assertEqual("source_evidence_invalid", self.store.retrieve(context(now=20)).rejections["procedure-a"])

    def test_revoked_source_and_validation_evidence_are_excluded(self):
        seed(self.store)
        self.store.invalidate_evidence(digest("trace-a"), reason="source receipt withdrawn")
        self.assertEqual("source_evidence_invalid", self.store.retrieve(context()).rejections["procedure-a"])
        self.store.invalidate_evidence(digest("validation-trace"), reason="evaluator corrected its result")
        self.assertEqual("validation_evidence_revoked", self.store.retrieve(context()).rejections["procedure-a"])

    def test_retraction_is_immediate_and_cannot_be_revived(self):
        identity = seed(self.store)
        retrieval = self.store.retrieve(context())
        self.store.retract("procedure-a", reason="new counterexample")
        self.assertEqual((), self.store.retrieve(context()).hits)
        with self.assertRaises(MemoryContractError):
            self.store.record_use(retrieval.retrieval_id, "procedure-a", procedure_digest=identity,
                run_id="run-b", consumed=True, decision_changed=True, outcome="unknown", now=11)
        with self.assertRaises(MemoryContractError):
            seed(self.store)

    def test_supersession_requires_valid_replacement_and_preserves_history(self):
        seed(self.store)
        successor = procedure(procedure_id="procedure-b", description="Inspect schema then read and total")
        successor_digest = self.store.propose_procedure(successor)
        with self.assertRaises(MemoryContractError):
            self.store.supersede("procedure-a", "procedure-b", context=context(), reason="candidate")
        self.store.validate("procedure-b", procedure_digest=successor_digest, reviewer="evaluator",
                            suite_digest=digest("suite2"), evidence_digest=digest("validation2"),
                            task_ids=("task-d",), passed=True, checked_at=3, expires_at=100)
        self.store.supersede("procedure-a", "procedure-b", context=context(), reason="validated replacement")
        self.assertEqual(["procedure-b"], [h.procedure_id for h in self.store.retrieve(context()).hits])
        self.assertEqual(2, self.store.audit_counts()["procedures"])

    def test_hidden_evaluation_cannot_enter_memory(self):
        for split in ("sealed", "test", "holdout"):
            with self.subTest(split=split), self.assertRaises(MemoryContractError):
                self.store.add_episode(episode(split=split))
        self.assertEqual(0, self.store.audit_counts()["episodes"])

    def test_identity_idempotency_and_conflict(self):
        identity = self.store.add_episode(episode())
        self.assertEqual(identity, self.store.add_episode(episode()))
        with self.assertRaises(MemoryContractError):
            self.store.add_episode(episode(summary="different"))
        self.store.propose_procedure(procedure())
        with self.assertRaises(MemoryContractError):
            self.store.propose_procedure(procedure(description="different"))
        self.assertEqual(1, self.store.audit_counts()["episodes"])

    def test_source_scope_is_checked_before_proposal(self):
        self.store.add_episode(episode())
        with self.assertRaises(MemoryContractError):
            self.store.propose_procedure(procedure(project="wrong"))

    def test_restart_preserves_procedure_and_receipts(self):
        seed(self.store)
        first = self.store.retrieve(context())
        self.store.close()
        self.store = MemoryStore(self.path)
        second = self.store.retrieve(context())
        self.assertEqual(first.hits, second.hits)
        self.assertEqual(2, self.store.audit_counts()["retrievals"])

    def test_exact_utf8_budget_includes_complete_rendered_context(self):
        seed(self.store, procedure(description="스키마를 먼저 확인하고 inventory total을 계산한다"))
        complete = self.store.retrieve(context()).context_bytes
        self.assertGreater(complete, 0)
        for budget in (0, complete - 1):
            result = self.store.retrieve(context(max_context_bytes=budget))
            self.assertEqual((), result.hits)
            self.assertLessEqual(result.context_bytes, budget)
        exact = self.store.retrieve(context(max_context_bytes=complete))
        self.assertEqual(1, len(exact.hits))
        self.assertEqual(complete, len(exact.context_text.encode("utf-8")))

    def test_diversity_penalty_avoids_near_duplicate_second_result(self):
        seed(self.store, procedure(procedure_id="a", goal="inventory schema total", description="inventory schema total"))
        seed(self.store, procedure(procedure_id="b", goal="inventory schema total", description="inventory schema total"))
        seed(self.store, procedure(procedure_id="c", goal="inventory verify total", description="inventory verify total"))
        result = self.store.retrieve(context(goal="inventory schema total verify", max_results=2))
        self.assertEqual(["a", "c"], [h.procedure_id for h in result.hits])

    def test_irrelevant_memory_does_not_consume_context(self):
        seed(self.store, procedure(goal="paint blue triangles", description="choose watercolor palette"))
        result = self.store.retrieve(context())
        self.assertEqual((), result.hits)
        self.assertEqual(0, result.context_bytes)
        self.assertEqual("no_lexical_relevance", result.rejections["procedure-a"])

    def test_retrieval_usage_outcome_and_causal_claim_are_separate(self):
        identity = seed(self.store)
        result = self.store.retrieve(context())
        self.assertEqual(0, self.store.audit_counts()["uses"])
        self.store.record_use(result.retrieval_id, "procedure-a", procedure_digest=identity,
                             run_id="run-b", consumed=False, decision_changed=False,
                             outcome="unknown", now=10)
        self.store.record_use(result.retrieval_id, "procedure-a", procedure_digest=identity,
                             run_id="run-b", consumed=True, decision_changed=True,
                             outcome="success", now=11, outcome_evidence_digest=digest("independent-output-check"))
        records = self.store.usage_records()
        self.assertFalse(records[0]["consumed"])
        self.assertTrue(records[1]["consumed"])
        self.assertTrue(all(row["causal_claim"] is False for row in records))

    def test_unbound_use_and_unverified_success_are_rejected(self):
        identity = seed(self.store)
        result = self.store.retrieve(context())
        base = dict(procedure_digest=identity, run_id="run-b", consumed=True,
                    decision_changed=True, outcome="unknown", now=11)
        for change in ({"run_id": "other-run"}, {"procedure_digest": digest("wrong")},
                       {"consumed": False}, {"outcome": "success"}, {"now": 9}):
            with self.subTest(change=change), self.assertRaises(MemoryContractError):
                self.store.record_use(result.retrieval_id, "procedure-a", **{**base, **change})

    def test_expired_after_retrieval_is_rejected_on_consumption(self):
        identity = seed(self.store, expires_at=12)
        result = self.store.retrieve(context())
        with self.assertRaises(MemoryContractError):
            self.store.record_use(result.retrieval_id, "procedure-a", procedure_digest=identity,
                                 run_id="run-b", consumed=True, decision_changed=True,
                                 outcome="unknown", now=12)

    def test_revalidation_requires_fresh_retrieval_binding(self):
        identity = seed(self.store)
        previous = self.store.retrieve(context())
        new_validation = self.store.validate("procedure-a", procedure_digest=identity,
            reviewer="evaluator", suite_digest=digest("new-suite"),
            evidence_digest=digest("new-validation"), task_ids=("task-d",),
            passed=True, checked_at=11, expires_at=500)
        with self.assertRaises(MemoryContractError):
            self.store.record_use(previous.retrieval_id, "procedure-a", procedure_digest=identity,
                run_id="run-b", consumed=True, decision_changed=True, outcome="unknown", now=11)
        current = self.store.retrieve(context(now=11))
        self.store.record_use(current.retrieval_id, "procedure-a", procedure_digest=identity,
            run_id="run-b", consumed=True, decision_changed=True, outcome="unknown", now=11)
        self.assertEqual(new_validation, self.store.usage_records()[0]["validation_id"])

    def test_known_revoked_outcome_evidence_cannot_label_use(self):
        identity = seed(self.store)
        result = self.store.retrieve(context())
        withdrawn = digest("withdrawn-outcome")
        self.store.invalidate_evidence(withdrawn, reason="evaluator withdrew outcome")
        for outcome in ("success", "failure", "unknown"):
            with self.subTest(outcome=outcome), self.assertRaises(MemoryContractError):
                self.store.record_use(result.retrieval_id, "procedure-a", procedure_digest=identity,
                    run_id="run-b", consumed=True, decision_changed=True, outcome=outcome,
                    now=11, outcome_evidence_digest=withdrawn)
        self.assertEqual(0, self.store.audit_counts()["uses"])

    def test_delayed_or_tied_validation_cannot_override_newer_failure(self):
        identity = seed(self.store)
        args = dict(procedure_digest=identity, reviewer="evaluator", suite_digest=digest("suite-revalidation"),
                    task_ids=("task-d",), expires_at=500)
        self.store.validate("procedure-a", **args, evidence_digest=digest("failure-at-20"),
                            passed=False, checked_at=20)
        for old_time in (4, 20):
            with self.subTest(old_time=old_time), self.assertRaises(MemoryContractError):
                self.store.validate("procedure-a", **args, evidence_digest=digest("delayed-pass"),
                                    passed=True, checked_at=old_time)
        self.assertEqual(2, self.store.audit_counts()["validations"])
        self.assertEqual((), self.store.retrieve(context(now=21)).hits)
        self.store.validate("procedure-a", **args, evidence_digest=digest("fresh-pass-at-21"),
                            passed=True, checked_at=21)
        self.assertEqual(1, len(self.store.retrieve(context(now=22)).hits))

    def test_corrupt_persisted_procedure_does_not_get_retrieved(self):
        seed(self.store)
        row = self.store.connection.execute("SELECT payload FROM procedures WHERE id='procedure-a'").fetchone()
        payload = json.loads(row[0])
        payload["description"] = "tampered"
        self.store.connection.execute("UPDATE procedures SET payload=? WHERE id='procedure-a'", (json.dumps(payload),))
        with self.assertRaises(MemoryContractError):
            self.store.retrieve(context())

    def test_negative_limits_and_bool_limits_rejected(self):
        for changes in ({"max_results": -1}, {"budget_units": True}, {"max_context_bytes": -1}):
            with self.subTest(changes=changes), self.assertRaises(MemoryContractError):
                context(**changes)


if __name__ == "__main__":
    unittest.main(verbosity=2)
