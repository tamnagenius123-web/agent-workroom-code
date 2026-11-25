"""Scripted Task A -> Task B procedural transfer, with actual synthetic tool calls.

No model is involved. The experiment demonstrates one reusable protocol and its
receipts; it is not a model capability, learned world model, or general RSI claim.
"""

from dataclasses import asdict, dataclass
import json
from pathlib import Path
import tempfile

from procedural_memory import Episode, MemoryStore, ProcedureSpec, RetrievalContext, ToolBinding, digest


TOOL = ToolBinding("inventory.protocol", "1", digest({
    "describe": "() -> schema_handle, semantic_columns",
    "read": "(schema_handle) -> rows", "aggregate": "(rows, semantic_columns) -> total",
    "verify": "(total) -> bool",
}))


@dataclass(frozen=True)
class Task:
    task_id: str
    price_column: str
    quantity_column: str
    # Canonical private-to-evaluator units: price in cents, available count.
    items: tuple[tuple[int, int], ...]


class InventoryEnvironment:
    """A synthetic tool server whose data column names vary between tasks."""

    def __init__(self, task: Task):
        self.task = task
        self.trace: list[dict] = []
        self.handle = digest({"task": task.task_id, "columns": [task.price_column, task.quantity_column]})
        self.context: dict = {}

    def call(self, operation: str) -> None:
        # This fixed allowlist is only a fixture; production uses the tool broker.
        if operation not in {"describe", "read", "aggregate", "verify"}:
            raise ValueError("operation outside synthetic tool protocol")
        event = {"operation": operation, "ok": True}
        if operation == "describe":
            self.context["handle"] = self.handle
            self.context["columns"] = {"price": self.task.price_column, "quantity": self.task.quantity_column}
        elif operation == "read":
            if self.context.get("handle") != self.handle:
                event.update(ok=False, error="SCHEMA_HANDLE_REQUIRED")
            else:
                self.context["rows"] = [{self.task.price_column: price, self.task.quantity_column: quantity}
                                        for price, quantity in self.task.items]
        elif operation == "aggregate":
            if "rows" not in self.context:
                event.update(ok=False, error="ROWS_REQUIRED")
            else:
                cols = self.context["columns"]
                self.context["total"] = sum(row[cols["price"]] * row[cols["quantity"]] for row in self.context["rows"])
        elif operation == "verify":
            # Evaluator uses canonical task values, not the candidate's calculation.
            expected = sum(price * quantity for price, quantity in self.task.items)
            self.context["verified"] = self.context.get("total") == expected
            event["ok"] = self.context["verified"]
        self.trace.append(event)


def execute(task: Task, steps: tuple[str, ...] | None = None) -> dict:
    env = InventoryEnvironment(task)
    if steps is None:
        # Fixed discovery policy: try reading; recover from its real schema error.
        env.call("read")
        if env.trace[-1].get("error") == "SCHEMA_HANDLE_REQUIRED":
            env.call("describe")
            env.call("read")
        env.call("aggregate")
        env.call("verify")
    else:
        for step in steps:
            env.call(step)
    return {"task_id": task.task_id, "success": bool(env.context.get("verified")),
            "tool_calls": len(env.trace), "trace": env.trace,
            "output": env.context.get("total"), "receipt_digest": digest(env.trace)}


def derive_procedure(source_run: dict) -> tuple[str, ...]:
    """One explicit consolidation rule: retain successful protocol steps.

    This rule is intentionally narrow. It cannot discover arbitrary algorithms;
    the validation task must reject harmful removal of a causal failed step.
    """
    return tuple(event["operation"] for event in source_run["trace"] if event["ok"])


def run_demo(database: str | Path) -> dict:
    task_a = Task("task-a", "price_cents", "available", ((125, 2), (99, 3)))
    task_c = Task("validation-c", "unit_cost", "on_hand", ((241, 2), (17, 5)))
    source = execute(task_a)
    steps = derive_procedure(source)
    validation = execute(task_c, steps)
    rows = []
    with MemoryStore(database) as memory:
        memory.add_episode(Episode("episode-a", "synthetic-inventory", "inventory-report", task_a.task_id,
            "inventory total available value", "A read failed before schema discovery; the successful sequence discovered schema then read, aggregated and verified.",
            "success", source["receipt_digest"], "synthetic-environment", 1, 1000))
        spec = ProcedureSpec("schema-first-v1", "synthetic-inventory", "inventory-report",
            "inventory total available value", "Discover schema before reading inventory rows and aggregate the available value.",
            steps, ("inventory.read",), (TOOL,), ("episode-a",), "trace-consolidator", 2, 4)
        identity = memory.propose_procedure(spec)
        memory.validate(spec.procedure_id, procedure_digest=identity, reviewer="synthetic-evaluator",
            suite_digest=digest({"protocol_suite": 1, "task_ids": [task_c.task_id]}), evidence_digest=validation["receipt_digest"],
            task_ids=(task_c.task_id,), passed=validation["success"], checked_at=3, expires_at=500)
    # Close and reopen: Task B is a fresh process-context-equivalent episode.
    with MemoryStore(database) as memory:
        for number in range(6):
            task_b = Task(f"task-b-{number}", f"unit_price_{number}", f"stock_{number}",
                          ((31 + 17 * number, 2 + number), (19 + number, 7 - number), (303, number)))
            ctx = RetrievalContext(spec.project, spec.task_family, task_b.task_id, f"run-b-{number}",
                "inventory total available value", ("inventory.read",), (TOOL,), 10 + number, 6, 4096, 1)
            retrieval = memory.retrieve(ctx)
            assert len(retrieval.hits) == 1
            baseline = execute(task_b)
            # Same-sized inert context, but no relevant action recipe consumed.
            # Policy is scripted and has no language parser, so this only rules out
            # accidental shared environment state, not an LLM context-length effect.
            irrelevant_text = "x" * retrieval.context_bytes
            assert len(irrelevant_text.encode("utf-8")) == retrieval.context_bytes
            irrelevant = execute(task_b)
            informed = execute(task_b, retrieval.hits[0].steps)
            memory.record_use(retrieval.retrieval_id, spec.procedure_id, procedure_digest=identity,
                run_id=ctx.run_id, consumed=True, decision_changed=True,
                outcome="success" if informed["success"] else "failure", now=ctx.now,
                outcome_evidence_digest=digest({"task": asdict(task_b), "result": informed}))
            rows.append({"task_id": task_b.task_id,
                "no_memory": {"success": baseline["success"], "tool_calls": baseline["tool_calls"], "context_bytes": 0},
                "irrelevant_equal_bytes": {"success": irrelevant["success"], "tool_calls": irrelevant["tool_calls"], "context_bytes": len(irrelevant_text)},
                "validated_procedure": {"success": informed["success"], "tool_calls": informed["tool_calls"], "context_bytes": retrieval.context_bytes},
                "same_output": baseline["output"] == irrelevant["output"] == informed["output"],
                "retrieval_id": retrieval.retrieval_id, "procedure_digest": identity})
        counts = memory.audit_counts()
    return {"experiment": "scripted_schema_protocol_transfer", "provider_calls": 0,
            "source_task": {"task_id": task_a.task_id, "tool_calls": source["tool_calls"]},
            "consolidated_steps": steps, "validation_task": task_c.task_id,
            "validation_success": validation["success"], "task_b_results": rows,
            "aggregate": {"tasks_per_arm": len(rows), "successes_per_arm": {arm: sum(row[arm]["success"] for row in rows)
                for arm in ("no_memory", "irrelevant_equal_bytes", "validated_procedure")},
                "total_tool_calls": {arm: sum(row[arm]["tool_calls"] for row in rows)
                for arm in ("no_memory", "irrelevant_equal_bytes", "validated_procedure")}},
            "receipt_counts": counts,
            "limits": ["Scripted policy and synthetic API; no LLM capability claim.",
                       "Six deterministic tasks are a mechanism test, not statistical evidence of generalization.",
                       "Byte-matched irrelevant context is inert to the scripted policy.",
                       "Task A and validation cost are additional; break-even depends on future reuse.",
                       "Evidence digests are receipts; trusted integration must verify bytes and evaluator identity."]}


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as temporary:
        print(json.dumps(run_demo(Path(temporary) / "memory.sqlite"), indent=2, ensure_ascii=False))
