"""Original, provider-free procedural memory component for the Workroom study.

This module stores declarations and receipts, not authority. A trusted integration
must authenticate the producer/verifier, execute the declared validation suite,
verify evidence bytes and mediate every tool call. Strings naming two reviewers
do not establish independent models. Retrieval is advisory, never tool authority.

Only development episodes enter this database. Keep sealed evaluation data in a
different service/database; a visibility flag cannot discover mislabeled secrets.
No embeddings, provider SDK, network, arbitrary-code execution, or private source
code is included. Exact tool bindings deliberately fail closed on schema drift.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import asdict, dataclass
import hashlib
import json
import re
import sqlite3
from pathlib import Path
from typing import Iterator


class MemoryContractError(ValueError):
    """The caller supplied evidence or a transition outside this component's contract."""


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(value: object) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def _text(value: str, name: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise MemoryContractError(f"{name} must be nonempty text")


def _integer(value: int, name: str, minimum: int = 0) -> None:
    if type(value) is not int or value < minimum:
        raise MemoryContractError(f"{name} must be an integer >= {minimum}")


def _sha(value: str, name: str) -> None:
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise MemoryContractError(f"{name} must be a lowercase SHA-256 digest")


@dataclass(frozen=True)
class ToolBinding:
    name: str
    version: str
    schema_digest: str

    def __post_init__(self) -> None:
        _text(self.name, "tool name")
        _text(self.version, "tool version")
        _sha(self.schema_digest, "tool schema_digest")


@dataclass(frozen=True)
class Episode:
    episode_id: str
    project: str
    task_family: str
    task_id: str
    goal: str
    summary: str
    outcome: str
    evidence_digest: str
    observer: str
    created_at: int
    evidence_expires_at: int
    split: str = "development"

    def __post_init__(self) -> None:
        for key in ("episode_id", "project", "task_family", "task_id", "goal", "summary", "observer"):
            _text(getattr(self, key), key)
        if self.outcome not in {"success", "failure", "unknown"}:
            raise MemoryContractError("invalid episode outcome")
        if self.split != "development":
            raise MemoryContractError("sealed/test episodes cannot enter learner memory")
        _sha(self.evidence_digest, "episode evidence_digest")
        _integer(self.created_at, "created_at")
        _integer(self.evidence_expires_at, "evidence_expires_at", self.created_at + 1)


@dataclass(frozen=True)
class ProcedureSpec:
    procedure_id: str
    project: str
    task_family: str
    goal: str
    description: str
    steps: tuple[str, ...]
    required_capabilities: tuple[str, ...]
    tools: tuple[ToolBinding, ...]
    source_episode_ids: tuple[str, ...]
    proposer: str
    created_at: int
    cost_units: int

    def __post_init__(self) -> None:
        for key in ("procedure_id", "project", "task_family", "goal", "description", "proposer"):
            _text(getattr(self, key), key)
        for key in ("steps", "required_capabilities", "source_episode_ids"):
            values = getattr(self, key)
            if not isinstance(values, tuple) or not values:
                raise MemoryContractError(f"{key} must be a nonempty tuple")
            for value in values:
                _text(value, key)
        if len(set(self.source_episode_ids)) != len(self.source_episode_ids):
            raise MemoryContractError("duplicate source episode")
        if not isinstance(self.tools, tuple) or not self.tools or not all(isinstance(t, ToolBinding) for t in self.tools):
            raise MemoryContractError("tools must be a nonempty ToolBinding tuple")
        if len({t.name for t in self.tools}) != len(self.tools):
            raise MemoryContractError("duplicate tool binding")
        _integer(self.created_at, "created_at")
        _integer(self.cost_units, "cost_units")


@dataclass(frozen=True)
class RetrievalContext:
    project: str
    task_family: str
    task_id: str
    run_id: str
    goal: str
    capabilities: tuple[str, ...]
    tools: tuple[ToolBinding, ...]
    now: int
    budget_units: int
    max_context_bytes: int
    max_results: int = 3

    def __post_init__(self) -> None:
        for key in ("project", "task_family", "task_id", "run_id", "goal"):
            _text(getattr(self, key), key)
        for key in ("now", "budget_units", "max_context_bytes", "max_results"):
            _integer(getattr(self, key), key)
        if not isinstance(self.capabilities, tuple):
            raise MemoryContractError("capabilities must be a tuple")
        for capability in self.capabilities:
            _text(capability, "capability")
        if not isinstance(self.tools, tuple) or not all(isinstance(t, ToolBinding) for t in self.tools):
            raise MemoryContractError("tools must be a ToolBinding tuple")
        if len({t.name for t in self.tools}) != len(self.tools):
            raise MemoryContractError("duplicate available tool name")


@dataclass(frozen=True)
class RetrievalHit:
    procedure_id: str
    procedure_digest: str
    validation_id: int
    relevance: float
    selection_score: float
    snippet: str
    steps: tuple[str, ...]


@dataclass(frozen=True)
class RetrievalResult:
    retrieval_id: int
    context_digest: str
    hits: tuple[RetrievalHit, ...]
    context_text: str
    context_bytes: int
    rejections: dict[str, str]


def _procedure(raw: str) -> ProcedureSpec:
    data = json.loads(raw)
    data["tools"] = tuple(ToolBinding(**item) for item in data["tools"])
    for key in ("steps", "required_capabilities", "source_episode_ids"):
        data[key] = tuple(data[key])
    return ProcedureSpec(**data)


def _context(raw: str) -> RetrievalContext:
    data = json.loads(raw)
    data["tools"] = tuple(ToolBinding(**item) for item in data["tools"])
    data["capabilities"] = tuple(data["capabilities"])
    return RetrievalContext(**data)


def _tokens(value: str) -> set[str]:
    return set(re.findall(r"\w+", value.casefold(), re.UNICODE)) - {
        "the", "a", "an", "and", "or", "to", "of", "for", "in", "on", "with", "from",
    }


def _similarity(left: set[str], right: set[str]) -> float:
    return len(left & right) / len(left | right) if left | right else 0.0


class MemoryStore:
    """Single local SQLite owner, restart-durable receipts and atomic transitions.

    Independent instances can open the same local DB; BEGIN IMMEDIATE serializes
    writers. This is not a distributed consensus or authenticated evidence store.
    SQLite file permissions and backup policy belong to the Workroom deployment.
    """

    def __init__(self, path: str | Path):
        self.connection = sqlite3.connect(str(path), isolation_level=None, timeout=5)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys=ON")
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=FULL")
        self.connection.executescript("""
            CREATE TABLE IF NOT EXISTS episodes (
                id TEXT PRIMARY KEY, payload TEXT NOT NULL, digest TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS procedures (
                id TEXT PRIMARY KEY, payload TEXT NOT NULL, digest TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('candidate','validated','retracted','superseded')),
                replacement TEXT REFERENCES procedures(id));
            CREATE TABLE IF NOT EXISTS validations (
                id INTEGER PRIMARY KEY, procedure_id TEXT NOT NULL REFERENCES procedures(id),
                payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS revoked_evidence (
                digest TEXT PRIMARY KEY, reason TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS retrievals (
                id INTEGER PRIMARY KEY, context TEXT NOT NULL, context_digest TEXT NOT NULL,
                result TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS uses (
                id INTEGER PRIMARY KEY, retrieval_id INTEGER NOT NULL REFERENCES retrievals(id),
                procedure_id TEXT NOT NULL REFERENCES procedures(id), payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, payload TEXT NOT NULL);
        """)

    def close(self) -> None:
        self.connection.close()

    def __enter__(self) -> MemoryStore:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    @contextmanager
    def _transaction(self) -> Iterator[None]:
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            self.connection.execute("ROLLBACK")
            raise
        else:
            self.connection.execute("COMMIT")

    def _event(self, kind: str, subject: str, value: object) -> None:
        self.connection.execute("INSERT INTO events(kind,subject,payload) VALUES(?,?,?)", (kind, subject, canonical(value)))

    def add_episode(self, episode: Episode) -> str:
        if not isinstance(episode, Episode):
            raise MemoryContractError("an Episode instance is required")
        payload = canonical(asdict(episode))
        identity = digest(asdict(episode))
        with self._transaction():
            previous = self.connection.execute("SELECT digest FROM episodes WHERE id=?", (episode.episode_id,)).fetchone()
            if previous:
                if previous["digest"] != identity:
                    raise MemoryContractError("episode id reused with different bytes")
                return identity
            self.connection.execute("INSERT INTO episodes VALUES(?,?,?)", (episode.episode_id, payload, identity))
            self._event("episode_added", episode.episode_id, {"digest": identity})
        return identity

    def _sources(self, spec: ProcedureSpec) -> list[Episode]:
        sources = []
        for episode_id in spec.source_episode_ids:
            row = self.connection.execute("SELECT payload,digest FROM episodes WHERE id=?", (episode_id,)).fetchone()
            if row is None:
                raise MemoryContractError("unknown source episode")
            data = json.loads(row["payload"])
            if digest(data) != row["digest"]:
                raise MemoryContractError("episode bytes changed")
            episode = Episode(**data)
            if (episode.project, episode.task_family) != (spec.project, spec.task_family):
                raise MemoryContractError("source episode outside procedure scope")
            if episode.created_at > spec.created_at:
                raise MemoryContractError("procedure predates source episode")
            sources.append(episode)
        return sources

    def propose_procedure(self, spec: ProcedureSpec) -> str:
        if not isinstance(spec, ProcedureSpec):
            raise MemoryContractError("a ProcedureSpec instance is required")
        payload = canonical(asdict(spec))
        identity = digest(asdict(spec))
        with self._transaction():
            self._sources(spec)
            previous = self.connection.execute("SELECT digest FROM procedures WHERE id=?", (spec.procedure_id,)).fetchone()
            if previous:
                if previous["digest"] != identity:
                    raise MemoryContractError("procedure id reused with different bytes; create a successor")
                return identity
            self.connection.execute("INSERT INTO procedures VALUES(?,?,?,'candidate',NULL)", (spec.procedure_id, payload, identity))
            self._event("procedure_proposed", spec.procedure_id, {"digest": identity})
        return identity

    def _row(self, procedure_id: str) -> sqlite3.Row:
        row = self.connection.execute("SELECT * FROM procedures WHERE id=?", (procedure_id,)).fetchone()
        if row is None:
            raise MemoryContractError("unknown procedure")
        if digest(json.loads(row["payload"])) != row["digest"]:
            raise MemoryContractError("procedure bytes changed")
        return row

    def validate(self, procedure_id: str, *, procedure_digest: str, reviewer: str,
                 suite_digest: str, evidence_digest: str, task_ids: tuple[str, ...],
                 passed: bool, checked_at: int, expires_at: int,
                 basis: str = "synthetic") -> int:
        """Record an exact-version validation supplied by a trusted external evaluator.

        No source episode task may also be a validation task. All tasks passed is
        the caller's attested result; this function does not run those tasks.
        checked_at must strictly increase for a procedure; delayed or tied
        receipts cannot replace a newer result by arriving later in SQLite.
        """
        for key, value in (("procedure_digest", procedure_digest), ("suite_digest", suite_digest), ("evidence_digest", evidence_digest)):
            _sha(value, key)
        _text(reviewer, "reviewer")
        _integer(checked_at, "checked_at")
        _integer(expires_at, "expires_at", checked_at + 1)
        if type(passed) is not bool or basis not in {"synthetic", "execution"}:
            raise MemoryContractError("invalid validation result/basis")
        if not isinstance(task_ids, tuple) or not task_ids or len(set(task_ids)) != len(task_ids):
            raise MemoryContractError("validation needs distinct task ids")
        for task_id in task_ids:
            _text(task_id, "validation task id")
        with self._transaction():
            row = self._row(procedure_id)
            spec = _procedure(row["payload"])
            if row["status"] in {"retracted", "superseded"}:
                raise MemoryContractError("terminal procedure cannot be revived")
            if procedure_digest != row["digest"] or reviewer == spec.proposer:
                raise MemoryContractError("unbound or self validation")
            if checked_at < spec.created_at:
                raise MemoryContractError("validation predates procedure")
            previous = self.connection.execute(
                "SELECT payload FROM validations WHERE procedure_id=? ORDER BY id DESC LIMIT 1",
                (procedure_id,)).fetchone()
            if previous is not None and checked_at <= json.loads(previous["payload"])["checked_at"]:
                raise MemoryContractError("validation time must strictly advance")
            sources = self._sources(spec)
            if {e.task_id for e in sources} & set(task_ids):
                raise MemoryContractError("source/validation task overlap")
            if any(e.evidence_expires_at <= checked_at for e in sources):
                raise MemoryContractError("source evidence expired before validation")
            revoked = {r[0] for r in self.connection.execute("SELECT digest FROM revoked_evidence")}
            if evidence_digest in revoked or any(e.evidence_digest in revoked for e in sources):
                raise MemoryContractError("validation relies on revoked evidence")
            record = {"procedure_digest": procedure_digest, "reviewer": reviewer,
                      "suite_digest": suite_digest, "evidence_digest": evidence_digest,
                      "task_ids": task_ids, "passed": passed, "checked_at": checked_at,
                      "expires_at": expires_at, "basis": basis}
            cursor = self.connection.execute("INSERT INTO validations(procedure_id,payload) VALUES(?,?)", (procedure_id, canonical(record)))
            self.connection.execute("UPDATE procedures SET status=? WHERE id=?", ("validated" if passed else "candidate", procedure_id))
            self._event("validation_recorded", procedure_id, {"validation_id": cursor.lastrowid, **record})
            return int(cursor.lastrowid)

    def _admissible(self, row: sqlite3.Row, ctx: RetrievalContext) -> tuple[str | None, int | None]:
        spec = _procedure(row["payload"])
        if row["status"] != "validated":
            return "not_validated_or_terminal", None
        if (spec.project, spec.task_family) != (ctx.project, ctx.task_family):
            return "scope_mismatch", None
        if not set(spec.required_capabilities) <= set(ctx.capabilities):
            return "capability_mismatch", None
        available = {t.name: t for t in ctx.tools}
        if any(available.get(t.name) != t for t in spec.tools):
            return "tool_binding_mismatch", None
        if spec.cost_units > ctx.budget_units:
            return "execution_budget", None
        validation_row = self.connection.execute("SELECT id,payload FROM validations WHERE procedure_id=? ORDER BY id DESC LIMIT 1", (spec.procedure_id,)).fetchone()
        if validation_row is None:
            return "missing_validation", None
        validation = json.loads(validation_row["payload"])
        if validation["procedure_digest"] != row["digest"] or not validation["passed"]:
            return "unbound_validation", None
        if not validation["checked_at"] <= ctx.now < validation["expires_at"]:
            return "validation_expired_or_future", None
        revoked = {r[0] for r in self.connection.execute("SELECT digest FROM revoked_evidence")}
        if validation["evidence_digest"] in revoked:
            return "validation_evidence_revoked", None
        for episode in self._sources(spec):
            if episode.evidence_digest in revoked or not episode.created_at <= ctx.now < episode.evidence_expires_at:
                return "source_evidence_invalid", None
        return None, int(validation_row["id"])

    def retrieve(self, context: RetrievalContext) -> RetrievalResult:
        if not isinstance(context, RetrievalContext):
            raise MemoryContractError("a RetrievalContext instance is required")
        query = _tokens(context.goal)
        rejected: dict[str, str] = {}
        pool = []
        with self._transaction():
            rows = self.connection.execute("SELECT * FROM procedures ORDER BY id").fetchall()
            for row in rows:
                # Re-hash persisted bytes before considering a result.
                self._row(row["id"])
                reason, validation_id = self._admissible(row, context)
                if reason:
                    rejected[row["id"]] = reason
                    continue
                spec = _procedure(row["payload"])
                tokens = _tokens(spec.goal + " " + spec.description)
                relevance = _similarity(query, tokens)
                if relevance <= 0:
                    rejected[row["id"]] = "no_lexical_relevance"
                    continue
                snippet = canonical({"procedure_id": spec.procedure_id,
                    "procedure_digest": row["digest"], "validation_id": validation_id,
                    "goal": spec.goal, "description": spec.description,
                    "steps": spec.steps, "tools": [asdict(t) for t in spec.tools],
                    "source_episode_ids": spec.source_episode_ids})
                pool.append((spec, row["digest"], validation_id, tokens, relevance, snippet))
            hits: list[RetrievalHit] = []
            selected_tokens: list[set[str]] = []
            snippets: list[str] = []
            # MMR-like diversity. Utility is not inferred from retrieval frequency.
            while pool and len(hits) < context.max_results:
                scored = []
                for item in pool:
                    penalty = max((_similarity(item[3], seen) for seen in selected_tokens), default=0.0)
                    scored.append((item[4] - 0.35 * penalty, item))
                scored.sort(key=lambda pair: (-pair[0], pair[1][0].procedure_id))
                selection_score, item = scored[0]
                pool.remove(item)
                spec, identity, validation_id, tokens, relevance, snippet = item
                proposed_text = "\n".join([*snippets, snippet])
                if len(proposed_text.encode("utf-8")) > context.max_context_bytes:
                    rejected[spec.procedure_id] = "context_budget"
                    continue
                hits.append(RetrievalHit(spec.procedure_id, identity, validation_id, relevance,
                                         selection_score, snippet, spec.steps))
                snippets.append(snippet)
                selected_tokens.append(tokens)
            for item in pool:
                rejected[item[0].procedure_id] = "result_limit"
            context_text = "\n".join(snippets)
            context_payload = canonical(asdict(context))
            context_digest = digest(asdict(context))
            serialized = {"hits": [asdict(h) for h in hits], "context_text": context_text,
                          "context_bytes": len(context_text.encode("utf-8")), "rejections": rejected}
            cursor = self.connection.execute("INSERT INTO retrievals(context,context_digest,result) VALUES(?,?,?)",
                (context_payload, context_digest, canonical(serialized)))
            return RetrievalResult(int(cursor.lastrowid), context_digest, tuple(hits), context_text,
                                   serialized["context_bytes"], rejected)

    def record_use(self, retrieval_id: int, procedure_id: str, *, procedure_digest: str,
                   run_id: str, consumed: bool, decision_changed: bool,
                   outcome: str, now: int, outcome_evidence_digest: str | None = None) -> int:
        """Record observed consumption separately from retrieval and task outcome.

        Even decision_changed + success remains observational. Randomized/pairwise
        counterfactual reports live in the evaluator, never this use counter.
        """
        _integer(retrieval_id, "retrieval_id", 1)
        _integer(now, "now")
        _sha(procedure_digest, "procedure_digest")
        _text(run_id, "run_id")
        if type(consumed) is not bool or type(decision_changed) is not bool:
            raise MemoryContractError("consumption flags must be bool")
        if outcome not in {"success", "failure", "unknown"}:
            raise MemoryContractError("invalid use outcome")
        if decision_changed and not consumed:
            raise MemoryContractError("unused memory cannot change a decision")
        if outcome != "unknown" and outcome_evidence_digest is None:
            raise MemoryContractError("task outcome needs an evaluator evidence digest")
        if outcome_evidence_digest is not None:
            _sha(outcome_evidence_digest, "outcome_evidence_digest")
        with self._transaction():
            retrieval = self.connection.execute("SELECT * FROM retrievals WHERE id=?", (retrieval_id,)).fetchone()
            if retrieval is None:
                raise MemoryContractError("unknown retrieval")
            ctx = _context(retrieval["context"])
            if digest(asdict(ctx)) != retrieval["context_digest"]:
                raise MemoryContractError("retrieval context changed")
            if ctx.run_id != run_id or now < ctx.now:
                raise MemoryContractError("run mismatch or use predates retrieval")
            hits = json.loads(retrieval["result"])["hits"]
            hit = next((h for h in hits if h["procedure_id"] == procedure_id and h["procedure_digest"] == procedure_digest), None)
            if hit is None:
                raise MemoryContractError("procedure was not returned by this retrieval")
            if outcome_evidence_digest is not None and self.connection.execute(
                    "SELECT 1 FROM revoked_evidence WHERE digest=?", (outcome_evidence_digest,)).fetchone():
                raise MemoryContractError("outcome evidence has been revoked")
            if consumed:
                # Retrieval is not a lease: retraction/expiry is checked again on use.
                current = _context(canonical({**asdict(ctx), "now": now}))
                row = self._row(procedure_id)
                reason, validation_id = self._admissible(row, current)
                if reason or row["digest"] != procedure_digest or validation_id != hit["validation_id"]:
                    raise MemoryContractError("procedure is no longer admissible")
            payload = {"procedure_digest": procedure_digest, "run_id": run_id,
                       "validation_id": hit["validation_id"],
                       "consumed": consumed, "decision_changed": decision_changed,
                       "outcome": outcome, "outcome_evidence_digest": outcome_evidence_digest,
                       "observed_at": now, "causal_claim": False}
            cursor = self.connection.execute("INSERT INTO uses(retrieval_id,procedure_id,payload) VALUES(?,?,?)",
                (retrieval_id, procedure_id, canonical(payload)))
            return int(cursor.lastrowid)

    def retract(self, procedure_id: str, *, reason: str) -> None:
        _text(reason, "retraction reason")
        with self._transaction():
            self._row(procedure_id)
            self.connection.execute("UPDATE procedures SET status='retracted' WHERE id=?", (procedure_id,))
            self._event("procedure_retracted", procedure_id, {"reason": reason})

    def invalidate_evidence(self, evidence_digest: str, *, reason: str) -> None:
        _sha(evidence_digest, "evidence_digest")
        _text(reason, "invalidation reason")
        with self._transaction():
            self.connection.execute("INSERT OR IGNORE INTO revoked_evidence VALUES(?,?)", (evidence_digest, reason))
            self._event("evidence_invalidated", evidence_digest, {"reason": reason})

    def supersede(self, procedure_id: str, replacement_id: str, *, context: RetrievalContext, reason: str) -> None:
        _text(reason, "supersession reason")
        with self._transaction():
            old = self._row(procedure_id)
            new = self._row(replacement_id)
            before, after = _procedure(old["payload"]), _procedure(new["payload"])
            if procedure_id == replacement_id or old["status"] in {"retracted", "superseded"}:
                raise MemoryContractError("invalid supersession transition")
            if (before.project, before.task_family) != (after.project, after.task_family):
                raise MemoryContractError("replacement scope differs")
            if self._admissible(new, context)[0]:
                raise MemoryContractError("replacement lacks current admissibility")
            self.connection.execute("UPDATE procedures SET status='superseded', replacement=? WHERE id=?", (replacement_id, procedure_id))
            self._event("procedure_superseded", procedure_id, {"replacement_id": replacement_id, "reason": reason})

    def audit_counts(self) -> dict[str, int]:
        """Operational counts only; not quality, utility, or learning scores."""
        return {table: self.connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in ("episodes", "procedures", "validations", "retrievals", "uses", "events")}

    def usage_records(self) -> list[dict]:
        return [json.loads(row[0]) for row in self.connection.execute("SELECT payload FROM uses ORDER BY id")]
