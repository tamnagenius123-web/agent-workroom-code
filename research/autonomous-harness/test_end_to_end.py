from pathlib import Path
import tempfile
import unittest

from end_to_end import run_demo


class IntegratedDemoTest(unittest.TestCase):
    def test_persisted_memory_real_solver_and_fenced_continuation(self):
        with tempfile.TemporaryDirectory() as path:
            result = run_demo(Path(path))
        task = result['task_b']
        self.assertEqual(task['verified_subgoals'], 2)
        self.assertEqual((task['first_algorithm'], task['second_algorithm']), ('bfs', 'dijkstra'))
        self.assertTrue(task['second_hint_rejected'])
        self.assertTrue(task['stale_predecessor_rejected'])
        self.assertTrue(task['continuation_replay']['replayed'])
        self.assertEqual(task['after']['fuel'], 2)
        self.assertEqual(task['after']['spent_units'], 20000)
        self.assertEqual(task['after']['deadline'], task['before_continuation']['deadline'])
        self.assertTrue(task['strong_baseline_same_first_choice'])
        self.assertEqual(result['provider_calls'], 0)


if __name__ == '__main__':
    unittest.main()
