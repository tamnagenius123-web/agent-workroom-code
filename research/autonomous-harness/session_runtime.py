"""Local reference state machine, not a replacement for Workroom server authority.

SQLite serializes a *single shared ledger*. No multi-host D1/provider refinement
is claimed. Cost units are declared synthetic work reservations, not currency.
All new effects consume task-global fuel before sending; unknown outcomes remain
charged and block continuation. Only trusted local tools are executed by this demo.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import asdict, dataclass
import hashlib
import json
import sqlite3
import time
from typing import Callable


def canonical(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def digest(value) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


class Hold(RuntimeError):
    pass


def natural(value, name: str, *, positive: bool = False):
    if type(value) is not int or value < (1 if positive else 0):
        raise ValueError(name)
    return value


@dataclass(frozen=True)
class ToolSpec:
    name: str
    version: str
    schema_sha256: str
    capability: str
    effect: str
    reservation_units: int
    max_input_bytes: int = 65536

    def __post_init__(self):
        if not all(isinstance(x, str) and x for x in (self.name, self.version, self.schema_sha256, self.capability)):
            raise ValueError("tool_identity")
        if self.effect not in {"pure", "read", "write"}:
            raise ValueError("tool_effect")
        natural(self.reservation_units, "reservation_units")
        natural(self.max_input_bytes, "max_input_bytes", positive=True)

    @property
    def sha256(self):
        return digest(asdict(self))


def bundle(bundle_id: str, tools: list[ToolSpec], *, memory_digest: str = "none", route: str = "typed") -> dict:
    if not bundle_id or route not in {"typed", "baseline"}:
        raise ValueError("bundle")
    manifests = [asdict(t) for t in tools]
    if len({t.name for t in tools}) != len(tools):
        raise ValueError("duplicate_tool")
    return {"schema_version": 1, "bundle_id": bundle_id, "interpreter": "local-reference-v1",
            "tools": manifests, "memory_digest": memory_digest, "route": route}


def parse_bundle(value: dict) -> dict:
    if type(value) is not dict or set(value) != {"schema_version", "bundle_id", "interpreter", "tools", "memory_digest", "route"}:
        raise ValueError("bundle_schema")
    if type(value["schema_version"]) is not int or value["schema_version"] != 1 or value["interpreter"] != "local-reference-v1":
        raise ValueError("bundle_version")
    if type(value["tools"]) is not list or not 1 <= len(value["tools"]) <= 32 or not isinstance(value["memory_digest"], str):
        raise ValueError("bundle_tools")
    return bundle(value["bundle_id"], [ToolSpec(**t) for t in value["tools"]], memory_digest=value["memory_digest"], route=value["route"])


class SessionStore:
    def __init__(self, path: str, now: Callable[[], int] | None = None):
        self.now = now or (lambda: int(time.time() * 1000))
        self.db = sqlite3.connect(path, isolation_level=None, timeout=5)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS tasks(
          id TEXT PRIMARY KEY, project TEXT NOT NULL, contract TEXT NOT NULL,
          tool_grants TEXT NOT NULL, fuel INTEGER NOT NULL, spent_units INTEGER NOT NULL,
          cap_units INTEGER NOT NULL, deadline INTEGER NOT NULL, epoch INTEGER NOT NULL,
          active_run TEXT NOT NULL, state TEXT NOT NULL, seq INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS runs(
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), epoch INTEGER NOT NULL,
          bundle TEXT NOT NULL, bundle_digest TEXT NOT NULL, state TEXT NOT NULL, parent TEXT,
          checkpoint TEXT, checkpoint_digest TEXT, checkpoint_seq INTEGER);
        CREATE TABLE IF NOT EXISTS effects(
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES runs(id),
          tool_digest TEXT NOT NULL, input_digest TEXT NOT NULL, state TEXT NOT NULL,
          reserved_units INTEGER NOT NULL, result TEXT, result_digest TEXT);
        CREATE TABLE IF NOT EXISTS continuations(
          key TEXT PRIMARY KEY, request_digest TEXT NOT NULL, successor TEXT NOT NULL REFERENCES runs(id));
        CREATE TABLE IF NOT EXISTS events(
          task_id TEXT NOT NULL REFERENCES tasks(id), seq INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
          PRIMARY KEY(task_id, seq));
        """)

    def close(self):
        self.db.close()

    @contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def _event(self, task_id: str, kind: str, body: dict):
        self.db.execute("UPDATE tasks SET seq=seq+1 WHERE id=?", (task_id,))
        seq = self.db.execute("SELECT seq FROM tasks WHERE id=?", (task_id,)).fetchone()[0]
        self.db.execute("INSERT INTO events VALUES(?,?,?,?)", (task_id, seq, kind, canonical(body)))

    def _pair(self, run_id: str, epoch: int, *, active: bool = True):
        natural(epoch, "epoch", positive=True)
        run = self.db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        if run is None:
            raise Hold("unknown_run")
        task = self.db.execute("SELECT * FROM tasks WHERE id=?", (run["task_id"],)).fetchone()
        if task["epoch"] != epoch or run["epoch"] != epoch or task["active_run"] != run_id:
            raise Hold("stale_epoch")
        if self.now() >= task["deadline"]:
            raise Hold("task_deadline")
        if active and (task["state"] != "active" or run["state"] != "active"):
            raise Hold("dispatch_disabled")
        if task["state"] == "canceled":
            raise Hold("task_canceled")
        parsed = parse_bundle(json.loads(run["bundle"]))
        if digest(parsed) != run["bundle_digest"]:
            raise Hold("bundle_integrity")
        return task, run

    def create(self, task_id: str, project: str, contract: dict, run_id: str, initial: dict,
               *, fuel: int, cap_units: int, deadline: int, tool_grants: list[str]):
        for val, name in ((fuel, "fuel"), (cap_units, "cap_units"), (deadline, "deadline")):
            natural(val, name, positive=True)
        if not task_id or not project or not run_id or deadline <= self.now() or type(contract) is not dict:
            raise ValueError("task_contract")
        initial = parse_bundle(initial)
        grant = sorted(set(tool_grants))
        if any(ToolSpec(**t).sha256 not in grant for t in initial["tools"]):
            raise Hold("tool_not_granted")
        with self.transaction():
            self.db.execute("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                            (task_id, project, digest(contract), canonical(grant), fuel, 0, cap_units, deadline, 1, run_id, "active", 0))
            self.db.execute("INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?)",
                            (run_id, task_id, 1, canonical(initial), digest(initial), "active", None, None, None, None))
            self._event(task_id, "created", {"run_id": run_id, "bundle": digest(initial)})

    def reserve(self, run_id: str, epoch: int, effect_id: str, spec: ToolSpec, inputs: dict) -> dict:
        if not effect_id or type(inputs) is not dict:
            raise ValueError("effect_input")
        encoded = canonical(inputs)
        if len(encoded.encode()) > spec.max_input_bytes:
            raise Hold("input_size")
        with self.transaction():
            task, run = self._pair(run_id, epoch)
            old = self.db.execute("SELECT * FROM effects WHERE id=?", (effect_id,)).fetchone()
            if old:
                if old["run_id"] != run_id or old["tool_digest"] != spec.sha256 or old["input_digest"] != digest(inputs):
                    raise Hold("effect_key_conflict")
                return dict(old)
            if self.db.execute("SELECT 1 FROM effects WHERE task_id=? AND state IN ('reserved','sending','unknown')", (task["id"],)).fetchone():
                raise Hold("unresolved_effect")
            if not any(ToolSpec(**t).sha256 == spec.sha256 for t in json.loads(run["bundle"])["tools"]):
                raise Hold("tool_not_in_bundle")
            if spec.sha256 not in json.loads(task["tool_grants"]):
                raise Hold("tool_not_granted")
            if task["fuel"] < 1 or task["spent_units"] + spec.reservation_units > task["cap_units"]:
                raise Hold("task_budget")
            self.db.execute("UPDATE tasks SET fuel=fuel-1, spent_units=spent_units+? WHERE id=?", (spec.reservation_units, task["id"]))
            self.db.execute("INSERT INTO effects VALUES(?,?,?,?,?,?,?,?,?)",
                            (effect_id, task["id"], run_id, spec.sha256, digest(inputs), "reserved", spec.reservation_units, None, None))
            self._event(task["id"], "reserved", {"effect_id": effect_id, "tool": spec.sha256, "input": digest(inputs)})
            return dict(self.db.execute("SELECT * FROM effects WHERE id=?", (effect_id,)).fetchone())

    def mark_sending(self, run_id: str, epoch: int, effect_id: str):
        with self.transaction():
            task, _ = self._pair(run_id, epoch)
            changed = self.db.execute("UPDATE effects SET state='sending' WHERE id=? AND run_id=? AND state='reserved'", (effect_id, run_id)).rowcount
            if changed != 1:
                raise Hold("effect_not_reserved")
            self._event(task["id"], "sending", {"effect_id": effect_id})

    def settle(self, effect_id: str, result: dict, *, verified: bool):
        if type(verified) is not bool or type(result) is not dict:
            raise ValueError("result_schema")
        with self.transaction():
            e = self.db.execute("SELECT * FROM effects WHERE id=?", (effect_id,)).fetchone()
            if e is None or e["state"] not in {"sending", "unknown"}:
                raise Hold("effect_not_reconcilable")
            # Observing an already-sent result is permitted after cancellation;
            # it cannot revive a run, create an effect or make a task successful.
            self.db.execute("UPDATE effects SET state=?,result=?,result_digest=? WHERE id=?",
                            ("verified" if verified else "failed", canonical(result), digest(result), effect_id))
            self._event(e["task_id"], "observed", {"effect_id": effect_id, "verified": verified, "result": digest(result)})

    def unknown(self, effect_id: str):
        with self.transaction():
            e = self.db.execute("SELECT * FROM effects WHERE id=?", (effect_id,)).fetchone()
            if e is None or e["state"] != "sending":
                raise Hold("effect_not_sending")
            self.db.execute("UPDATE effects SET state='unknown' WHERE id=?", (effect_id,))
            self._event(e["task_id"], "unknown", {"effect_id": effect_id})

    def execute(self, run_id: str, epoch: int, effect_id: str, spec: ToolSpec, inputs: dict,
                tool: Callable[[dict], dict], checker: Callable[[dict, dict], bool]) -> dict:
        frozen_input = canonical(inputs)
        e = self.reserve(run_id, epoch, effect_id, spec, json.loads(frozen_input))
        if e["state"] in {"verified", "failed"}:
            result = json.loads(e["result"])
            if digest(result) != e["result_digest"]:
                raise Hold("result_integrity")
            return {"status": e["state"], "result": result, "replayed": True}
        if e["state"] != "reserved":
            raise Hold("unresolved_effect")
        self.mark_sending(run_id, epoch, effect_id)
        try:
            result = tool(json.loads(frozen_input))
            if type(result) is not dict:
                raise ValueError("tool_result_schema")
            frozen_result = canonical(result)
            checked = checker(json.loads(frozen_input), json.loads(frozen_result))
            if type(checked) is not bool:
                raise ValueError("checker_must_return_bool")
        except BaseException:
            self.unknown(effect_id)
            raise
        self.settle(effect_id, json.loads(frozen_result), verified=checked)
        return {"status": "verified" if checked else "failed", "result": json.loads(frozen_result), "replayed": False}

    def quiesce(self, run_id: str, epoch: int):
        with self.transaction():
            task, _ = self._pair(run_id, epoch)
            self.db.execute("UPDATE runs SET state='quiescing' WHERE id=?", (run_id,))
            self.db.execute("UPDATE tasks SET state='quiescing' WHERE id=?", (task["id"],))
            self._event(task["id"], "quiescing", {"run_id": run_id})

    def checkpoint(self, run_id: str, epoch: int, state: dict) -> str:
        if type(state) is not dict:
            raise ValueError("checkpoint_state")
        with self.transaction():
            task, run = self._pair(run_id, epoch, active=False)
            if task["state"] != "quiescing" or run["state"] != "quiescing":
                raise Hold("not_quiescing")
            if self.db.execute("SELECT 1 FROM effects WHERE task_id=? AND state IN ('reserved','sending','unknown')", (task["id"],)).fetchone():
                raise Hold("unresolved_effect")
            cp = {"task_id": task["id"], "run_id": run_id, "epoch": epoch, "source_seq": task["seq"],
                  "bundle_digest": run["bundle_digest"], "state": state}
            sha = digest(cp)
            self.db.execute("UPDATE runs SET checkpoint=?,checkpoint_digest=?,checkpoint_seq=? WHERE id=?",
                            (canonical(cp), sha, task["seq"], run_id))
            return sha

    def continue_run(self, predecessor: str, epoch: int, checkpoint_digest: str, successor: str, new_bundle: dict, key: str) -> dict:
        new_bundle = parse_bundle(new_bundle)
        request = {"predecessor": predecessor, "epoch": epoch, "checkpoint_digest": checkpoint_digest,
                   "successor": successor, "bundle": digest(new_bundle)}
        with self.transaction():
            old = self.db.execute("SELECT * FROM continuations WHERE key=?", (key,)).fetchone()
            if old:
                if old["request_digest"] != digest(request):
                    raise Hold("continuation_key_conflict")
                return {"run_id": old["successor"], "replayed": True}
            task, run = self._pair(predecessor, epoch, active=False)
            if task["state"] != "quiescing" or run["state"] != "quiescing" or not run["checkpoint"]:
                raise Hold("continuation_not_ready")
            if run["checkpoint_digest"] != checkpoint_digest or digest(json.loads(run["checkpoint"])) != checkpoint_digest:
                raise Hold("checkpoint_integrity")
            if run["checkpoint_seq"] != task["seq"]:
                raise Hold("checkpoint_stale")
            if self.db.execute("SELECT 1 FROM effects WHERE task_id=? AND state IN ('reserved','sending','unknown')", (task["id"],)).fetchone():
                raise Hold("unresolved_effect")
            if any(ToolSpec(**t).sha256 not in json.loads(task["tool_grants"]) for t in new_bundle["tools"]):
                raise Hold("tool_not_granted")
            if task["fuel"] < 1:
                raise Hold("task_budget")
            self.db.execute("UPDATE runs SET state='continued' WHERE id=?", (predecessor,))
            self.db.execute("INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?)",
                            (successor, task["id"], epoch + 1, canonical(new_bundle), digest(new_bundle), "active", predecessor, None, None, None))
            self.db.execute("UPDATE tasks SET active_run=?,epoch=epoch+1,fuel=fuel-1,state='active' WHERE id=?", (successor, task["id"]))
            self.db.execute("INSERT INTO continuations VALUES(?,?,?)", (key, digest(request), successor))
            self._event(task["id"], "continued", request)
            return {"run_id": successor, "replayed": False}

    def cancel(self, task_id: str):
        with self.transaction():
            if not self.db.execute("SELECT 1 FROM tasks WHERE id=?", (task_id,)).fetchone():
                raise Hold("unknown_task")
            self.db.execute("UPDATE tasks SET state='canceled',epoch=epoch+1 WHERE id=?", (task_id,))
            self._event(task_id, "canceled", {})

    def snapshot(self, task_id: str) -> dict:
        task = self.db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if task is None:
            raise Hold("unknown_task")
        return {"task": dict(task), "runs": [dict(r) for r in self.db.execute("SELECT * FROM runs WHERE task_id=? ORDER BY epoch", (task_id,))],
                "effects": [dict(e) for e in self.db.execute("SELECT * FROM effects WHERE task_id=? ORDER BY id", (task_id,))]}
