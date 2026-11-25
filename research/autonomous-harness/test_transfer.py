from pathlib import Path
import tempfile
import unittest

from demo_transfer import Task, derive_procedure, execute, run_demo


class TransferTests(unittest.TestCase):
    def test_protocol_transfer_changes_actual_tool_trace(self):
        task = Task("source", "p", "q", ((8, 3), (5, 1)))
        source = execute(task)
        steps = derive_procedure(source)
        self.assertEqual(("describe", "read", "aggregate", "verify"), steps)
        transferred = execute(Task("target", "another_price", "another_count", ((9, 4),)), steps)
        self.assertTrue(transferred["success"])
        self.assertEqual(36, transferred["output"])
        self.assertEqual(4, transferred["tool_calls"])
        self.assertEqual(5, source["tool_calls"])

    def test_invalid_procedure_fails_independent_output_check(self):
        result = execute(Task("target", "price", "qty", ((9, 4),)), ("read", "aggregate", "verify"))
        self.assertFalse(result["success"])

    def test_all_arms_use_new_tasks_and_same_outputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            report = run_demo(Path(temporary) / "memory.sqlite")
        self.assertEqual(0, report["provider_calls"])
        self.assertEqual({"no_memory": 30, "irrelevant_equal_bytes": 30, "validated_procedure": 24}, report["aggregate"]["total_tool_calls"])
        self.assertEqual({"no_memory": 6, "irrelevant_equal_bytes": 6, "validated_procedure": 6}, report["aggregate"]["successes_per_arm"])
        self.assertTrue(all(row["same_output"] for row in report["task_b_results"]))
        self.assertEqual(6, report["receipt_counts"]["uses"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
