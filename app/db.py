"""SQLite 数据访问层：连接管理与建表。

仅使用标准库 sqlite3，零额外安装；单用户本地场景，按请求开关连接即可。
档案数据全部持久化在 data/projects.db，重启服务不丢失；
每次启动自动备份一份到 data/backups/（保留最近 10 份）。
"""
import logging
import shutil
import sqlite3
from contextlib import contextmanager
from datetime import datetime

from app.config import DATA_DIR, DB_PATH

logger = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    path         TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- 规范化绝对路径（核心字段）
    name         TEXT NOT NULL,                        -- 项目名称
    alias        TEXT NOT NULL DEFAULT '',             -- 别名
    category     TEXT NOT NULL DEFAULT '',             -- 项目分类
    status       TEXT NOT NULL DEFAULT '进行中',        -- 进行中/已完成/暂停/归档废弃
    tags         TEXT NOT NULL DEFAULT '[]',           -- 技术栈标签，JSON 数组
    description  TEXT NOT NULL DEFAULT '',             -- 用户 Markdown 描述（存数据库，不落盘）
    auto_meta    TEXT NOT NULL DEFAULT '{}',           -- 自动解析元数据 JSON
    is_lost      INTEGER NOT NULL DEFAULT 0,           -- 路径失效标记：1=丢失项目
    lost_reason  TEXT NOT NULL DEFAULT '',
    fs_created   TEXT NOT NULL DEFAULT '',             -- 磁盘创建时间
    fs_modified  TEXT NOT NULL DEFAULT '',             -- 磁盘最后修改时间
    created_at   TEXT NOT NULL,                        -- 档案创建时间
    updated_at   TEXT NOT NULL                         -- 档案更新时间
);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

-- 自定义开发笔记（多条，随项目删除级联清理）
CREATE TABLE IF NOT EXISTS notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    content     TEXT NOT NULL DEFAULT '',              -- Markdown 正文
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project_id);

-- 自定义变更日志（用户手写，独立于 git 提交记录）
CREATE TABLE IF NOT EXISTS changelogs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT '',              -- 条目标题
    content     TEXT NOT NULL DEFAULT '',              -- Markdown 正文
    entry_date  TEXT NOT NULL DEFAULT '',              -- 条目日期 YYYY-MM-DD
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changelogs_project ON changelogs(project_id);
"""


def _backup_db() -> None:
    """启动时自动备份数据库，保留最近 10 份，防止意外丢失档案。"""
    if not DB_PATH.exists() or DB_PATH.stat().st_size == 0:
        return
    try:
        backup_dir = DATA_DIR / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        shutil.copy2(DB_PATH, backup_dir / f"projects-{stamp}.db")
        # 轮转：只保留最近 10 份
        backups = sorted(backup_dir.glob("projects-*.db"))
        for old in backups[:-10]:
            old.unlink()
    except OSError as exc:
        # 备份失败不阻塞启动，仅记录告警
        logger.warning("数据库自动备份失败：%s", exc)


def init_db() -> None:
    """初始化数据目录并建表（已有数据库则直接复用，数据不丢失）。"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _backup_db()
    with get_db() as conn:
        conn.executescript(_SCHEMA)


@contextmanager
def get_db():
    """打开一次数据库连接，用完即关。"""
    # timeout：并发写时等待锁而不是立即报 "database is locked"
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    # 启用外键约束，项目删除时级联清理其笔记与变更日志
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
