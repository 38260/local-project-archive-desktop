"""个人贡献回归：真实临时 Git 仓库；设置写入仅限临时目录。"""
from pathlib import Path
from datetime import date
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException
from app.routers.settings import put_settings
from app.services import gitinfo, settings_store


def git(path, *args, **env):
    result = subprocess.run(["git", *args], cwd=path, check=True, capture_output=True,
                            encoding="utf-8", env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull,
                                                   "GIT_CONFIG_NOSYSTEM": "1", **env},
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return result.stdout.strip()


def make_repo(root):
    path = Path(root) / "source"
    path.mkdir()
    git(path, "init", "-b", "main")
    git(path, "config", "user.name", "Same Name")
    git(path, "config", "user.email", "committer@example.com")
    for email in ("upstream@example.com", "me+work@example.com", "old@example.com",
                  "meXwork@example.com", "prefixme+work@example.com"):
        git(path, "commit", "--allow-empty", "-m", f"feat: {email}",
            GIT_AUTHOR_NAME="Same Name", GIT_AUTHOR_EMAIL=email,
            GIT_AUTHOR_DATE=f"{date.today()}T12:00:00+00:00",
            GIT_COMMITTER_DATE=f"{date.today()}T12:00:00+00:00")
    return path


class GitIdentityTests(unittest.TestCase):
    def test_normalize_and_persist_multiple_emails(self):
        with tempfile.TemporaryDirectory(prefix="tl-git-settings-") as root:
            with patch.object(settings_store, "DATA_DIR", Path(root)):
                result = put_settings({"git.author_emails": [" Me+git@Example.com ",
                                                           "old@example.com", "me+git@example.com"]})
                self.assertEqual(result["git.author_emails"], ["me+git@example.com", "old@example.com"])
                self.assertEqual(settings_store.git_author_emails(), result["git.author_emails"])
                self.assertEqual(put_settings({"git.author_emails": []})["git.author_emails"], [])

    def test_invalid_setting_does_not_write(self):
        for value in ("a@b", None, [None], ["name"], ["Name <a@b>"],
                      ["a@b\nother@b"], ["a@b"] * 21):
            with self.subTest(value=value), patch.object(settings_store, "update") as update:
                with self.assertRaises(HTTPException) as caught:
                    put_settings({"git.author_emails": value})
                self.assertEqual(caught.exception.status_code, 400)
                update.assert_not_called()

    def test_invalid_saved_identity_does_not_match_everyone(self):
        with patch.object(settings_store, "get", return_value="bad"):
            self.assertEqual(settings_store.git_author_emails(), [])


class GitContributionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tl-git-contribution-")
        self.addCleanup(self.temp.cleanup)
        self.repo = make_repo(self.temp.name)
        self.emails = ["ME+WORK@example.com", "old@example.com"]

    def test_author_filter_before_limit_and_consistent_counts(self):
        log = gitinfo.collect_commit_log(str(self.repo), limit=1, author_emails=self.emails)
        self.assertIsNone(log["error"])
        self.assertEqual(log["total_count"], 2)
        self.assertEqual([c["email"] for c in log["commits"]], ["old@example.com"])
        self.assertEqual(gitinfo.collect_commit_log(str(self.repo))["total_count"], 5)
        stats = gitinfo.collect_commit_stats(str(self.repo), author_emails=self.emails)
        self.assertEqual(stats["scanned"], 2)
        self.assertEqual(sum(t["count"] for t in stats["types"]), 2)
        self.assertEqual(sum(m["total"] for m in stats["months"]), 2)
        limited = gitinfo.collect_commit_stats(str(self.repo), max_commits=1, author_emails=self.emails)
        self.assertEqual(limited["scanned"], 1)
        self.assertTrue(limited["truncated"])
        heat = gitinfo.collect_heatmap(str(self.repo), author_emails=self.emails, include_commits=True)
        self.assertEqual(heat["total"], 2)
        self.assertEqual(len(heat["commits"]), 2)

    def test_empty_identity_and_other_author_do_not_fall_back(self):
        for emails in ([], ["absent@example.com"], ["committer@example.com"]):
            with self.subTest(emails=emails):
                self.assertEqual(gitinfo.collect_commit_log(str(self.repo), author_emails=emails)["total_count"], 0)
                self.assertEqual(gitinfo.collect_heatmap(str(self.repo), author_emails=emails)["total"], 0)
                self.assertEqual(gitinfo.collect_commit_stats(str(self.repo), author_emails=emails)["scanned"], 0)

    def test_day_uses_commit_timezone(self):
        git(self.repo, "commit", "--allow-empty", "-m", "fix: offset", GIT_AUTHOR_EMAIL="old@example.com",
            GIT_AUTHOR_NAME="Same Name", GIT_AUTHOR_DATE="2025-01-01T00:30:00+14:00",
            GIT_COMMITTER_DATE="2025-01-01T00:30:00+14:00")
        result = gitinfo.collect_heatmap(str(self.repo), author_emails=self.emails,
                                         include_commits=True, day="2025-01-01")
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["commits"][0]["message"], "fix: offset")

    def test_read_only_and_degraded_results(self):
        before = git(self.repo, "status", "--porcelain=v1"), git(self.repo, "rev-parse", "HEAD")
        gitinfo.collect_commit_log(str(self.repo), author_emails=self.emails)
        gitinfo.collect_heatmap(str(self.repo), author_emails=self.emails)
        gitinfo.collect_commit_stats(str(self.repo), author_emails=self.emails)
        self.assertEqual(before, (git(self.repo, "status", "--porcelain=v1"), git(self.repo, "rev-parse", "HEAD")))
        self.assertFalse(gitinfo.collect_heatmap(self.temp.name)["is_repo"])
        with patch.object(gitinfo, "_run_git", return_value=None):
            self.assertTrue(gitinfo.collect_heatmap(str(self.repo), author_emails=self.emails)["error"])
        empty = Path(self.temp.name) / "empty"
        empty.mkdir()
        git(empty, "init")
        self.assertTrue(gitinfo.collect_commit_log(str(empty))["error"])


if __name__ == "__main__":
    unittest.main()
