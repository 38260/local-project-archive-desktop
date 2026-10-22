"""首页改版单元回归：旧库增量迁移与近 7 天聚合（不启动服务、不碰正式档案库）。"""
import sqlite3
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import db
from app.services import weekly


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


class WeeklyAggregateTests(unittest.TestCase):
    def setUp(self):
        self.start = date(2026, 10, 16)
        self.end = date(2026, 10, 22)

    @staticmethod
    def commit(commit_hash, iso, message="feat: demo"):
        return {"hash": commit_hash, "short": commit_hash[:8], "date": iso,
                "message": message, "author": "Me"}

    def test_dedup_owner_and_conservation_regardless_of_input_order(self):
        iso1 = "2026-10-20T10:00:00+08:00"
        iso2 = "2026-10-21T11:00:00+08:00"
        results = [
            {"project": {"id": 2, "name": "B"}, "commits": [
                self.commit("h1", iso1), self.commit("h2", iso2),
            ]},
            {"project": {"id": 1, "name": "A"}, "commits": [
                self.commit("h1", iso1), self.commit("h3", "2026-10-22T09:00:00+08:00"),
            ]},
        ]
        forward = weekly.aggregate(results, self.start, self.end)
        reverse = weekly.aggregate(list(reversed(results)), self.start, self.end)
        for data in (forward, reverse):
            self.assertEqual(data["total"], 3)
            self.assertEqual(sum(p["count"] for p in data["projects"]), data["total"])
            self.assertEqual(sum(d["total"] for d in data["days"]), data["total"])
            self.assertEqual(sum(sum(p["count"] for p in d["projects"])
                                 for d in data["days"]), data["total"])
            self.assertEqual(data["project_count"], 2)
            self.assertEqual(data["active_days"], 3)
            h2 = next(c for d in data["commits_by_day"] for c in d["commits"]
                      if c["hash"] == "h2")
            self.assertEqual(h2["project_id"], 2)
            h1 = next(c for d in data["commits_by_day"] for c in d["commits"]
                      if c["hash"] == "h1")
            self.assertEqual(h1["project_id"], 1, "相同哈希必须稳定归属较小项目 ID")
            self.assertEqual([p["id"] for p in h1["projects"]], [1, 2],
                             "明细仍保留所有关联副本")
            self.assertEqual([p["id"] for p in data["projects"]], [1, 2])

    def test_local_calendar_date_and_invalid_values(self):
        iso = "2026-10-21T23:30:00+00:00"
        expected = datetime.fromisoformat(iso).astimezone().date()
        data = weekly.aggregate([
            {"project": {"id": 7, "name": "Local"}, "commits": [
                self.commit("local", iso),
                self.commit("naive", "2026-10-21T23:30:00"),
                self.commit("bad", "not-a-date"),
            ]},
        ], expected - timedelta(days=3), expected + timedelta(days=3))
        self.assertEqual(data["total"], 1)
        matched = next(d for d in data["days"] if d["date"] == expected.isoformat())
        self.assertEqual(matched["total"], 1)
        self.assertEqual(sum(d["total"] for d in data["days"]), 1)

    def test_empty_and_week_window(self):
        start, end, days = weekly.week_window(today=date(2026, 10, 22))
        self.assertEqual((start, end), (date(2026, 10, 16), date(2026, 10, 22)))
        self.assertEqual(len(days), 7)
        self.assertEqual(days[0], date(2026, 10, 16))
        self.assertEqual(days[-1], date(2026, 10, 22))
        data = weekly.aggregate([], start, end)
        self.assertEqual(data["total"], 0)
        self.assertEqual(len(data["days"]), 7)
        self.assertEqual(data["active_days"], 0)
        self.assertEqual(data["commits_by_day"], [])
        self.assertEqual(weekly.parse_local_date("2026-10-20T08:00:00"), None)


if __name__ == "__main__":
    unittest.main()
