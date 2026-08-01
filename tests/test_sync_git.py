import importlib.util
import subprocess
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


# The production copy imports turso_helper from ~/.hermes/scripts. Git tests do
# not query Turso, so provide the narrow import surface the module expects.
sys.modules.setdefault(
    "turso_helper", types.SimpleNamespace(turso_query=lambda _sql: [])
)

MODULE_PATH = Path(__file__).resolve().parents[1] / "sync_to_dashboard.py"
REPO = MODULE_PATH.parent
SPEC = importlib.util.spec_from_file_location("sync_to_dashboard", MODULE_PATH)
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)


def result(returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess([], returncode, stdout, stderr)


class GitPushTests(unittest.TestCase):
    def test_commits_only_jobs_json_and_pushes_both_branches(self):
        responses = [
            result(stdout=" M data/jobs.json\n"),  # status
            result(),                              # pull --autostash
            result(),                              # no merge conflicts
            result(),                              # add jobs.json
            result(returncode=1),                  # staged diff exists
            result(),                              # commit jobs.json
            result(),                              # push main
            result(),                              # push master
        ]
        with patch.object(sync.subprocess, "run", side_effect=responses) as run:
            self.assertTrue(sync.git_push(Path("/repo"), "daily update"))

        commands = [call.args[0] for call in run.call_args_list]
        self.assertIn(
            ["git", "-C", "/repo", "add", "--", "data/jobs.json"], commands
        )
        self.assertNotIn(["git", "-C", "/repo", "add", "-A"], commands)
        commit = next(command for command in commands if "commit" in command)
        self.assertEqual(commit[-2:], ["--", "data/jobs.json"])
        pull = next(command for command in commands if "pull" in command)
        self.assertIn("--autostash", pull)

    def test_refuses_unrelated_tracked_changes_before_pull_or_commit(self):
        status = result(stdout=" M app.js\n M data/jobs.json\n")
        with patch.object(sync.subprocess, "run", return_value=status) as run:
            self.assertFalse(sync.git_push(Path("/repo"), "daily update"))
        self.assertEqual(run.call_count, 1)

    def test_requires_both_branch_pushes_to_succeed(self):
        responses = [
            result(stdout=" M data/jobs.json\n"),
            result(),
            result(),
            result(),
            result(returncode=0),  # no new commit needed
            result(),              # main push succeeds
            result(returncode=1, stderr="rejected"),
        ]
        with patch.object(sync.subprocess, "run", side_effect=responses):
            self.assertFalse(sync.git_push(Path("/repo"), "daily update"))

    def test_stops_if_autostash_reapply_conflicts(self):
        responses = [
            result(stdout=" M data/jobs.json\n"),
            result(),
            result(stdout="data/jobs.json\n"),
        ]
        with patch.object(sync.subprocess, "run", side_effect=responses) as run:
            self.assertFalse(sync.git_push(Path("/repo"), "daily update"))
        self.assertEqual(run.call_count, 3)


class RunnerSafetyTests(unittest.TestCase):
    def test_interactive_mode_refuses_non_tty_stdin(self):
        completed = subprocess.run(
            ["bash", "scripts/run-phase2.sh"],
            cwd=REPO,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 64)
        self.assertIn("stdin is not a TTY", completed.stderr)
        self.assertNotIn("BASELINE", completed.stdout)


if __name__ == "__main__":
    unittest.main()
