"""「最近开发」项目排序：托盘菜单与前端顶部标签栏共用同一口径。

「最近开发」取 git 最近提交时间（解析时已写入 auto_meta 的快照），
没有 git 则退回磁盘最后修改时间、再退回档案更新时间。

刻意**不调用 git**：托盘菜单必须瞬间弹出、页面加载也不该为此等待，
任何外部命令都会造成可见卡顿；快照最多滞后到上次解析，
对「最近在做哪几个项目」这个用途足够。

只读、失败一律降级为空列表，绝不让调用方（托盘 / 接口）因此出错。
"""
from __future__ import annotations

import json
import logging
from datetime import datetime

from app.db import get_db

logger = logging.getLogger(__name__)


def _sort_key(value) -> float:
    """把 ISO 时间串转成时间戳用于排序；无法解析时排到最后。"""
    if not value:
        return 0.0
    try:
        return datetime.fromisoformat(str(value)).timestamp()
    except (TypeError, ValueError):
        return 0.0


def recent_projects(limit: int = 3) -> list[dict]:
    """最近开发的 N 个项目（按最近开发时间倒序）。

    返回 [{id, name, path, stamp}]；已丢失与已废弃的项目不参与排序。
    """
    try:
        with get_db() as conn:
            rows = conn.execute(
                "SELECT id, name, path, status, is_lost, fs_modified, updated_at, "
                "auto_meta FROM projects "
                "WHERE is_lost=0 AND status<>'废弃'").fetchall()
    except Exception as exc:
        logger.debug("读取最近项目失败：%s", exc)
        return []

    items = []
    for r in rows:
        git_date = None
        try:
            meta = json.loads(r["auto_meta"] or "{}")
            git_date = ((meta.get("git") or {}).get("last_commit") or {}).get("date")
        except (ValueError, AttributeError):
            git_date = None
        stamp = _sort_key(git_date) or _sort_key(r["fs_modified"]) \
            or _sort_key(r["updated_at"])
        items.append({"id": r["id"], "name": r["name"], "path": r["path"],
                      "stamp": stamp})
    items.sort(key=lambda x: x["stamp"], reverse=True)
    return items[:max(1, int(limit or 3))]
