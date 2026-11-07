import importlib.util
import io
import tarfile
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("auto_update", Path(__file__).with_name("auto-update.py"))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class DeploymentTests(unittest.TestCase):
    def run_record(self, **overrides):
        return {"head_sha": "a" * 40, "head_branch": "main", "event": "push",
                "head_repository": {"full_name": updater.REPOSITORY}, "status": "completed",
                "conclusion": "success", "run_number": 1, "run_attempt": 1, **overrides}

    def test_only_successful_main_push_from_this_repository_can_deploy(self):
        sha = "a" * 40
        self.assertIsNotNone(updater.verified_run([self.run_record()], sha))
        for changes in [{"event": "pull_request"}, {"head_branch": "feature"},
                        {"head_repository": {"full_name": "someone/fork"}},
                        {"head_sha": "b" * 40}, {"conclusion": "failure"}, {"status": "in_progress"}]:
            self.assertIsNone(updater.verified_run([self.run_record(**changes)], sha))

    def test_latest_rerun_must_succeed_even_if_an_earlier_attempt_passed(self):
        self.assertIsNone(updater.verified_run([
            self.run_record(), self.run_record(run_attempt=2, conclusion="failure")], "a" * 40))

    def archive(self, directory, files):
        archive = directory / "source.tar.gz"
        with tarfile.open(archive, "w:gz") as output:
            for name, link in files:
                member = tarfile.TarInfo("repository/" + name)
                if link:
                    member.type = tarfile.SYMTYPE
                    member.linkname = "/etc/passwd"
                    output.addfile(member)
                else:
                    member.size = 4
                    output.addfile(member, io.BytesIO(b"code"))
        return archive

    def test_extracts_only_source_allowlist(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = self.archive(root, [(name, False) for name in updater.REQUIRED | {".env", "docs/private.pdf"}])
            updater.unpack(archive, root / "stage")
            self.assertTrue((root / "stage/deploy/deploy.sh").is_file())
            self.assertFalse((root / "stage/.env").exists())
            self.assertFalse((root / "stage/docs").exists())

    def test_rejects_traversal_links_and_runtime_data(self):
        for name, link in [("../escape", False), ("deploy/link", True), ("apps/backend/.env", False)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                archive = self.archive(root, [(name, link)])
                with self.assertRaises(ValueError):
                    updater.unpack(archive, root / "stage")


if __name__ == "__main__":
    unittest.main()
