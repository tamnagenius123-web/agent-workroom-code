import json
from pathlib import Path
import tempfile
from concurrent.futures import ThreadPoolExecutor
import threading
import unittest

from session_runtime import Hold, SessionStore, ToolSpec, bundle, digest


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.tmp.name) / 'session.sqlite')
        self.clock = [100]
        self.tool = ToolSpec('increment', '1', digest({'x': 'integer'}), 'compute', 'pure', 3)
        self.b = bundle('initial', [self.tool])
        self.db = SessionStore(self.path, lambda: self.clock[0])
        self.db.create('task', 'workroom', {'goal': 'increment'}, 'run-1', self.b,
                       fuel=5, cap_units=9, deadline=10000, tool_grants=[self.tool.sha256])

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def execute(self, key='effect-1', run='run-1', epoch=1, checker=None):
        return self.db.execute(run, epoch, key, self.tool, {'x': 2}, lambda x: {'y': x['x'] + 1},
                               checker or (lambda x, y: y == {'y': x['x'] + 1}))

    def checkpoint(self):
        self.db.quiesce('run-1', 1)
        return self.db.checkpoint('run-1', 1, {'remaining': ['next-step']})

    def test_actual_tool_and_verified_receipt(self):
        out = self.execute()
        self.assertEqual(out['status'], 'verified')
        self.assertFalse(out['replayed'])
        state = self.db.snapshot('task')
        self.assertEqual((state['task']['fuel'], state['task']['spent_units']), (4, 3))
        self.assertEqual(state['effects'][0]['result_digest'], digest({'y': 3}))

    def test_restart_replays_same_result_without_reexecuting(self):
        self.execute()
        self.db.close(); self.db = SessionStore(self.path, lambda: self.clock[0])
        def forbidden(_):
            self.fail('a settled effect must not run twice')
        out = self.db.execute('run-1', 1, 'effect-1', self.tool, {'x': 2}, forbidden, lambda *_: True)
        self.assertTrue(out['replayed'])
        self.assertEqual(self.db.snapshot('task')['task']['spent_units'], 3)

    def test_same_key_with_different_input_is_rejected(self):
        self.execute()
        with self.assertRaisesRegex(Hold, 'effect_key_conflict'):
            self.db.reserve('run-1', 1, 'effect-1', self.tool, {'x': 3})

    def test_unknown_survives_restart_and_cannot_reset_wallet(self):
        self.db.reserve('run-1', 1, 'effect-1', self.tool, {'x': 2})
        self.db.mark_sending('run-1', 1, 'effect-1')
        self.db.unknown('effect-1')
        self.db.close(); self.db = SessionStore(self.path, lambda: self.clock[0])
        with self.assertRaisesRegex(Hold, 'unresolved_effect'):
            self.execute('fresh-key')
        with self.assertRaisesRegex(Hold, 'unresolved_effect'):
            self.execute()
        self.assertEqual(self.db.snapshot('task')['task']['spent_units'], 3)
        self.db.quiesce('run-1', 1)
        with self.assertRaisesRegex(Hold, 'unresolved_effect'):
            self.db.checkpoint('run-1', 1, {})

    def test_crash_after_sending_is_not_treated_as_unsent(self):
        self.db.reserve('run-1', 1, 'effect-1', self.tool, {'x': 2})
        self.db.mark_sending('run-1', 1, 'effect-1')
        self.db.close(); self.db = SessionStore(self.path, lambda: self.clock[0])
        with self.assertRaisesRegex(Hold, 'unresolved_effect'):
            self.execute()

    def test_quiescing_stops_new_dispatch_before_checkpoint(self):
        self.db.quiesce('run-1', 1)
        with self.assertRaisesRegex(Hold, 'dispatch_disabled'):
            self.execute()
        self.assertEqual(self.db.snapshot('task')['task']['fuel'], 5)

    def test_continuation_changes_bundle_without_resetting_budget_deadline(self):
        self.execute()
        cp = self.checkpoint()
        new = bundle('next', [self.tool], route='baseline', memory_digest=digest('memory'))
        self.db.continue_run('run-1', 1, cp, 'run-2', new, 'continue-1')
        self.execute('effect-2', 'run-2', 2)
        state = self.db.snapshot('task')
        self.assertEqual((state['task']['fuel'], state['task']['spent_units'], state['task']['deadline']), (2, 6, 10000))
        self.assertEqual(state['runs'][0]['bundle_digest'], digest(self.b))
        self.assertEqual(state['runs'][1]['bundle_digest'], digest(new))
        with self.assertRaisesRegex(Hold, 'stale_epoch'):
            self.execute('stale-effect')

    def test_continuation_response_loss_replays_existing_successor(self):
        cp = self.checkpoint()
        first = self.db.continue_run('run-1', 1, cp, 'run-2', self.b, 'continue-1')
        repeated = self.db.continue_run('run-1', 1, cp, 'run-2', self.b, 'continue-1')
        self.assertFalse(first['replayed']); self.assertTrue(repeated['replayed'])
        self.assertEqual(len(self.db.snapshot('task')['runs']), 2)
        self.assertEqual(self.db.snapshot('task')['task']['fuel'], 4)
        with self.assertRaisesRegex(Hold, 'continuation_key_conflict'):
            self.db.continue_run('run-1', 1, cp, 'different', self.b, 'continue-1')

    def test_new_tool_manifest_cannot_widen_grant(self):
        other = ToolSpec('network', '1', digest('new-schema'), 'network', 'write', 1)
        with self.assertRaisesRegex(Hold, 'tool_not_in_bundle'):
            self.db.reserve('run-1', 1, 'x', other, {})
        cp = self.checkpoint()
        with self.assertRaisesRegex(Hold, 'tool_not_granted'):
            self.db.continue_run('run-1', 1, cp, 'run-2', bundle('bad', [other]), 'continue-1')

    def test_cancel_fences_dispatch_but_allows_observation(self):
        self.db.reserve('run-1', 1, 'effect-1', self.tool, {'x': 2})
        self.db.mark_sending('run-1', 1, 'effect-1')
        self.db.cancel('task')
        self.db.settle('effect-1', {'y': 3}, verified=True)
        self.assertEqual(self.db.snapshot('task')['task']['state'], 'canceled')
        with self.assertRaisesRegex(Hold, 'stale_epoch'):
            self.execute('new')

    def test_failed_checker_is_not_a_verified_result(self):
        self.assertEqual(self.execute(checker=lambda *_: False)['status'], 'failed')

    def test_checker_or_tool_exception_leaves_unknown(self):
        def broken(*_):
            raise RuntimeError('checker failed')
        with self.assertRaisesRegex(RuntimeError, 'checker failed'):
            self.execute(checker=broken)
        self.assertEqual(self.db.snapshot('task')['effects'][0]['state'], 'unknown')

    def test_task_cap_applies_across_new_effect_ids(self):
        for i in range(3):
            self.execute(f'e-{i}')
        with self.assertRaisesRegex(Hold, 'task_budget'):
            self.execute('e-4')
        self.assertEqual(self.db.snapshot('task')['task']['spent_units'], 9)

    def test_expired_task_cannot_dispatch_or_continue(self):
        cp = self.checkpoint(); self.clock[0] = 10000
        with self.assertRaisesRegex(Hold, 'task_deadline'):
            self.db.continue_run('run-1', 1, cp, 'run-2', self.b, 'continue-1')

    def test_mutated_bundle_or_checkpoint_is_rejected(self):
        cp = self.checkpoint()
        self.db.db.execute("UPDATE runs SET checkpoint=? WHERE id='run-1'", (json.dumps({'fake': 1}),))
        with self.assertRaisesRegex(Hold, 'checkpoint_integrity'):
            self.db.continue_run('run-1', 1, cp, 'run-2', self.b, 'continue-1')
        self.db.db.execute("UPDATE runs SET bundle_digest='fake' WHERE id='run-1'")
        with self.assertRaisesRegex(Hold, 'bundle_integrity'):
            self.db.continue_run('run-1', 1, cp, 'run-2', self.b, 'continue-1')

    def test_two_connections_cannot_send_same_effect_twice(self):
        barrier = threading.Barrier(2); lock = threading.Lock(); calls = []
        def worker():
            store = SessionStore(self.path, lambda: 100)
            def work(x):
                with lock:
                    calls.append(x)
                return {'y': 3}
            try:
                barrier.wait()
                return store.execute('run-1', 1, 'shared', self.tool, {'x': 2}, work, lambda *_: True)['status']
            except Hold as exc:
                return str(exc)
            finally:
                store.close()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: worker(), range(2)))
        self.assertEqual(len(calls), 1)
        self.assertTrue(all(r in {'verified', 'unresolved_effect', 'effect_not_reserved'} for r in results), results)

    def test_tool_cannot_change_the_input_seen_by_the_checker(self):
        original = {'x': 1}
        def mutating_tool(copy):
            self.assertEqual(copy['x'], 1)
            original['x'] = 2
            return {'y': 2}
        out = self.db.execute('run-1', 1, 'effect-1', self.tool, original, mutating_tool,
                              lambda x, y: x['x'] == y['y'])
        self.assertEqual(out['status'], 'failed')

    def test_checker_cannot_change_the_result_that_gets_settled(self):
        def mutating_checker(_input, result):
            correct = result == {'y': 3}
            result['y'] = 999
            return correct
        out = self.execute(checker=mutating_checker)
        self.assertEqual(out['result'], {'y': 3})
        self.assertEqual(json.loads(self.db.snapshot('task')['effects'][0]['result']), {'y': 3})


if __name__ == '__main__':
    unittest.main()
