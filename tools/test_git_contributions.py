"""个人贡献回归：真实临时 Git 仓库；设置写入仅限临时目录。"""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException
from app.routers.settings import put_settings
from app.services import settings_store


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


if __name__ == "__main__":
    unittest.main()
