"""Actual local vertical slice: tool -> evidence -> procedure -> restart -> task.

No provider or GPU calls. This verifies wiring, not general model improvement.
The rule compiler is a strong baseline and can choose BFS without memory.
"""
from dataclasses import asdict
import json
from pathlib import Path
import tempfile

from model_tools import INPUT_SCHEMA_DIGEST, compile_specialist, execute_plan, verify_certificate
from procedural_memory import Episode, MemoryStore, ProcedureSpec, RetrievalContext, ToolBinding, digest
from session_runtime import Hold, SessionStore, ToolSpec, bundle


def graph(n: int, *, weighted=False):
    return {'schema_version': '1', 'n': n, 'edges': [[i, i+1, 2 if weighted else 1] for i in range(n-1)]
            + [[0, n-1, n+2 if weighted else 1]], 'source': 0, 'target': n-1}


def checked(task, hint=None):
    plan = compile_specialist(task, procedure_hint=hint)
    result = execute_plan(task, plan)
    assert result['status'] == 'verified'
    assert verify_certificate(task, result['certificate'])['valid']
    return plan, result


def run_demo(directory: Path) -> dict:
    directory.mkdir(parents=True, exist_ok=True)
    memory_path = directory / 'procedures.sqlite'
    task_path = directory / 'tasks.sqlite'
    tool_binding = ToolBinding('graph.specialist', '1', INPUT_SCHEMA_DIGEST.removeprefix('sha256:'))
    spec = ToolSpec('graph.specialist', '1', tool_binding.schema_digest, 'graph.compute', 'pure', 10000)
    task_a = graph(5)
    source_plan, source_result = checked(task_a)
    # One narrow consolidation rule, with a separate validation task. This is
    # not a general program synthesizer or a neural-weight training procedure.
    preferred = source_plan['algorithm']
    validation_task = graph(7)
    _, validation_result = checked(validation_task, {'preferred_algorithm': preferred})
    with MemoryStore(memory_path) as memory:
        memory.add_episode(Episode('episode-a', 'workroom', 'shortest-path', 'task-a',
            'verified shortest path', 'Unit-weight graph solved by the typed CPU solver.',
            'success', digest({'task': task_a, 'certificate': source_result['certificate']}),
            'local-tool-observer', 1, 1000))
        procedure = ProcedureSpec('unit-graph-v1', 'workroom', 'shortest-path', 'verified shortest path',
            'Try BFS for unit-weight graphs; recheck eligibility and fall back on weighted graphs.',
            (f'preferred_algorithm:{preferred}', 'verify:certificate'), ('graph.compute',),
            (tool_binding,), ('episode-a',), 'trace-consolidator', 2, 10000)
        procedure_digest = memory.propose_procedure(procedure)
        memory.validate(procedure.procedure_id, procedure_digest=procedure_digest, reviewer='local-certificate-evaluator',
            suite_digest=digest({'validation_task': validation_task}),
            evidence_digest=digest(validation_result['certificate']), task_ids=('validation-c',), passed=True,
            checked_at=3, expires_at=900)

    # Retrieval occurs after reopening persistent memory. The immutable run pin
    # includes the full selected context digest, not the mutable memory DB head.
    memory = MemoryStore(memory_path)
    query = RetrievalContext('workroom', 'shortest-path', 'task-b', 'run-b1', 'verified shortest path',
        ('graph.compute',), (tool_binding,), 10, 50000, 4096, 1)
    retrieval = memory.retrieve(query)
    assert len(retrieval.hits) == 1
    run_bundle = bundle('bundle-b1', [spec], memory_digest=digest(retrieval.context_text))
    ledger = SessionStore(str(task_path), lambda: 100)
    ledger.create('task-b', 'workroom', {'goal': 'Solve both graphs with checked certificates'}, 'run-b1', run_bundle,
        fuel=5, cap_units=40000, deadline=10000, tool_grants=[spec.sha256])

    def run_graph(task, run_id, epoch, effect_id, hint):
        plan = compile_specialist(task, procedure_hint=hint)
        payload = {'task': task, 'plan': plan}
        out = ledger.execute(run_id, epoch, effect_id, spec, payload,
            lambda x: execute_plan(x['task'], x['plan']),
            lambda x, y: y.get('status') == 'verified' and verify_certificate(x['task'], y['certificate'])['valid'])
        return plan, out

    hint = {'preferred_algorithm': retrieval.hits[0].steps[0].split(':', 1)[1], 'evidence_digest': procedure_digest}
    first_task = graph(11)
    first_plan, first = run_graph(first_task, 'run-b1', 1, 'effect-b1', hint)
    memory.record_use(retrieval.retrieval_id, procedure.procedure_id, procedure_digest=procedure_digest, run_id='run-b1',
        consumed=True, decision_changed=False, outcome='success', now=10,
        outcome_evidence_digest=digest(first['result']['certificate']))
    # The strong compiler baseline already makes this choice. Preserve that fact.
    strong_baseline_same = compile_specialist(first_task)['algorithm'] == first_plan['algorithm']
    ledger.quiesce('run-b1', 1)
    cp = ledger.checkpoint('run-b1', 1, {'completed': ['effect-b1'], 'remaining_task': graph(9, weighted=True)})
    before = ledger.snapshot('task-b')['task']
    next_bundle = bundle('bundle-b2', [spec], memory_digest=digest(retrieval.context_text))
    ledger.continue_run('run-b1', 1, cp, 'run-b2', next_bundle, 'continuation-b')
    # Lost response recovery: the same key names the same successor.
    replay = ledger.continue_run('run-b1', 1, cp, 'run-b2', next_bundle, 'continuation-b')
    ledger.close(); memory.close()

    # Fresh instances recover task and procedure state. The second input changes
    # a semantic precondition; the compiler must reject the inapplicable hint.
    ledger = SessionStore(str(task_path), lambda: 101)
    second_plan, second = run_graph(graph(9, weighted=True), 'run-b2', 2, 'effect-b2', hint)
    assert second_plan['algorithm'] == 'dijkstra' and second_plan['fallback_reason']
    stale_rejected = False
    try:
        ledger.reserve('run-b1', 1, 'stale-effect', spec, {})
    except Hold as exc:
        stale_rejected = str(exc) == 'stale_epoch'
    after = ledger.snapshot('task-b')
    with MemoryStore(memory_path) as memory:
        counts = memory.audit_counts()
    ledger.close()
    return {'experiment': 'local_tool_memory_continuation_vertical_slice', 'provider_calls': 0, 'gpu_jobs': 0,
        'source_task_verified': source_result['status'] == 'verified', 'validation_verified': validation_result['status'] == 'verified',
        'retrieval': {'context_digest': retrieval.context_digest, 'snapshot_digest': digest(retrieval.context_text),
                      'context_bytes': retrieval.context_bytes, 'selected': [asdict(h) for h in retrieval.hits]},
        'task_b': {'verified_subgoals': sum(r['status'] == 'verified' for r in (first, second)), 'subgoals': 2,
                   'first_algorithm': first_plan['algorithm'], 'second_algorithm': second_plan['algorithm'],
                   'second_hint_rejected': bool(second_plan['fallback_reason']), 'strong_baseline_same_first_choice': strong_baseline_same,
                   'run_count': len(after['runs']), 'effect_count': len(after['effects']), 'continuation_replay': replay,
                   'stale_predecessor_rejected': stale_rejected,
                   'before_continuation': {k: before[k] for k in ('fuel', 'spent_units', 'deadline')},
                   'after': {k: after['task'][k] for k in ('fuel', 'spent_units', 'deadline', 'epoch')}},
        'memory_receipts': counts,
        'limits': ['Synthetic reference runtime; no remote Workroom mutation or production adapter claim.',
                   'Two verified subgoals do not independently validate a general task-completion judge.',
                   'Memory is consumed but does not improve on the strong rule compiler in this example.',
                   'Synthetic reserved work units are not measured USD, CPU time or energy.',
                   'SQLite resume is a local shared-ledger property, not a multi-host consensus result.']}


if __name__ == '__main__':
    with tempfile.TemporaryDirectory() as temporary:
        print(json.dumps(run_demo(Path(temporary)), indent=2, ensure_ascii=False))
