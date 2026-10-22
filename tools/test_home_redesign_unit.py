"""首页改版单元回归：旧库增量迁移（不启动服务、不触碰正式档案库）。"""
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import db


OLD_SCHEMA = db._SCHEMA.replace(
    "    last_opened_at TEXT NOT NULL DEFAULT '',           -- 上次成功进入详情的时间（带时区 ISO）\n",
    "",
)


class LastOpenedMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tl-home-migration-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db_path = self.root / "projects.db"
        conn = sqlite3.connect(self.db_path)
        conn.executescript(OLD_SCHEMA)
        conn.execute(
            "INSERT INTO projects (path, name, status, created_at, updated_at) "
            "VALUES (?,?,?,?,?)",
            (r"D:\samples\old-project", "Old Project", "进行中",
             "2026-01-01T10:00:00+08:00", "2026-01-02T10:00:00+08:00"),
        )
        conn.execute(
            "INSERT INTO projects (path, name, status, created_at, updated_at) "
            "VALUES (?,?,?,?,?)",
            (r"D:\samples\legacy-archived", "Legacy", "归档废弃",
             "2026-01-01T11:00:00+08:00", "2026-01-02T11:00:00+08:00"),
        )
        conn.commit()
        conn.close()

    def _patches(self):
        return (
            patch.object(db, "DATA_DIR", self.root),
            patch.object(db, "DB_PATH", self.db_path),
            patch.object(db, "BACKUP_DIR", self.root / "backups"),
        )

    def test_migration_is_repeatable_and_preserves_existing_values(self):
        p_dir, p_db, p_backup = self._patches()
        with p_dir, p_db, p_backup:
            db.init_db()
            db.init_db()

        conn = sqlite3.connect(self.db_path)
        cols = [r[1] for r in conn.execute("PRAGMA table_info(projects)")]
        self.assertEqual(cols.count("last_opened_at"), 1)
        old = conn.execute(
            "SELECT name, status, last_opened_at, updated_at FROM projects "
            "WHERE path=?", (r"D:\samples\old-project",)).fetchone()
        self.assertEqual(old[0], "Old Project")
        self.assertEqual(old[1], "进行中")
        self.assertEqual(old[2], "")
        self.assertEqual(old[3], "2026-01-02T10:00:00+08:00")
        legacy = conn.execute(
            "SELECT status, last_opened_at FROM projects WHERE path=?",
            (r"D:\samples\legacy-archived",)).fetchone()
        self.assertEqual(legacy[0], "归档")
        self.assertEqual(legacy[1], "")

        conn.execute("UPDATE projects SET last_opened_at=? WHERE path=?",
                     ("2026-10-22T09:30:00+08:00", r"D:\samples\old-project"))
        conn.commit()
        conn.close()

        p_dir, p_db, p_backup = self._patches()
        with p_dir, p_db, p_backup:
            db.init_db()
        conn = sqlite3.connect(self.db_path)
        value = conn.execute(
            "SELECT last_opened_at FROM projects WHERE path=?",
            (r"D:\samples\old-project",)).fetchone()[0]
        conn.close()
        self.assertEqual(value, "2026-10-22T09:30:00+08:00")


if __name__ == "__main__":
    unittest.main()
