"""统一刷新入口：后台采集、请求合并、冷却与失败处理。

为什么单独成一层：
  - 自动刷新（进入页面 / 回到前台）与手动「重新解析」可能同时发生，必须共享
    同一把「按项目」的锁，否则两个线程会同时遍历磁盘、重复写库；
  - 连续切换窗口会重复触发，靠 30 秒冷却 + 同项目 in-flight 合并把重复请求压掉；
  - 自动刷新只更新「采集数据」（auto_meta / fs 时间 / 丢失标记），绝不改
    tags（可能含用户手填）、description、笔记、变更日志、启动项与流程图偏好，
    也不改 updated_at——首页「最近更新」排序不该被后台任务搅动；
  - 解析期间项目被改路径或删除时，写回语句带 `AND path=?`，行数为 0 即丢弃结果，
    旧数据不会被"旧路径解析结果"覆盖。

失败语义：读取/解析失败只记录失败项，不写库，上一份有效 auto_meta 原样保留。
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Iterable

from app.db import get_db
from app.services import parser
from app.services.paths import dir_not_exists_hint

logger = logging.getLogger(__name__)

# 同一项目两次自动刷新之间的最小间隔（秒）。手动刷新可跳过。
COOLDOWN_SECONDS = 30
# 单个任务内的解析并发度：磁盘 IO + git 命令，4 路足够且不会打满机械盘
MAX_WORKERS = 4
# 任务表上限与保留时长（前端轮询完就不需要了，留一段便于排查）
MAX_JOBS = 40
JOB_TTL_SECONDS = 900
# 等锁上限：手动刷新遇到正在跑的自动刷新时，等它完成再解析，保证拿到最新结果
LOCK_WAIT_SECONDS = 120

_LOCK = threading.RLock()
_INFLIGHT: dict[int, str] = {}          # project_id -> job_id
_LAST_OK: dict[int, float] = {}         # project_id -> monotonic 时间戳
_PROJECT_LOCKS: dict[int, threading.Lock] = {}
_JOBS: "OrderedDict[str, dict]" = OrderedDict()


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def _project_lock(project_id: int) -> threading.Lock:
    with _LOCK:
        lock = _PROJECT_LOCKS.get(project_id)
        if lock is None:
            lock = threading.Lock()
            _PROJECT_LOCKS[project_id] = lock
        return lock


def _load_row(project_id: int):
    with get_db() as conn:
        return conn.execute(
            "SELECT id, path, name, auto_meta, tags, is_lost FROM projects WHERE id=?",
            (project_id,)).fetchone()


def _merge_tags(old_tags: str, new_tech_tags: list[str]) -> str:
    """手动刷新沿用的标签合并：保留已有（含手填），补充新识别。"""
    old = json.loads(old_tags or "[]")
    merged = list(old) + [t for t in (new_tech_tags or []) if t not in old]
    return json.dumps(merged, ensure_ascii=False)


def _mark_ok(project_id: int) -> None:
    with _LOCK:
        _LAST_OK[project_id] = time.monotonic()


# ---------------------------------------------------------------------------
# 单项目刷新
# ---------------------------------------------------------------------------

def _do_refresh(project_id: int, mode: str) -> dict:
    """解析并写回一个项目；调用方必须已持有该项目锁。

    mode = "auto"   → 只写采集数据（auto_meta / fs 时间 / 丢失标记），不动
                      tags / updated_at；
    mode = "manual" → 额外合并技术栈标签并刷新 updated_at（沿用原「重新解析」语义）。
    """
    row = _load_row(project_id)
    if row is None:
        return {"id": project_id, "ok": False, "reason": "项目已删除，结果已丢弃"}

    path = row["path"]
    auto = mode != "manual"

    # 路径失效：只改丢失标记，保留上一份有效 auto_meta
    if not os.path.isdir(path):
        reason = dir_not_exists_hint(path)
        changed = not bool(row["is_lost"])
        if auto:
            sql = "UPDATE projects SET is_lost=1, lost_reason=? WHERE id=? AND path=?"
            params = (reason, project_id, path)
        else:
            sql = ("UPDATE projects SET is_lost=1, lost_reason=?, updated_at=? "
                   "WHERE id=? AND path=?")
            params = (reason, _now_iso(), project_id, path)
        with get_db() as conn:
            applied = conn.execute(sql, params).rowcount > 0
        if not applied:
            return {"id": project_id, "ok": False, "stale": True,
                    "reason": "刷新期间项目路径已变更或已被删除，结果已丢弃"}
        _mark_ok(project_id)
        return {"id": project_id, "ok": True, "lost": True, "changed": changed,
                "refreshed_at": _now_iso()}

    try:
        parsed = parser.parse_project(path)
    except OSError as exc:
        # 无权限 / IO 错误：不写库，保留上次有效数据
        return {"id": project_id, "ok": False, "reason": f"解析失败：{exc}"}
    except Exception as exc:  # 解析器的意外异常同样不能污染档案
        logger.warning("刷新解析异常（id=%s）：%s", project_id, exc)
        return {"id": project_id, "ok": False, "reason": f"解析异常：{exc}"}

    meta_json = json.dumps(parsed["auto_meta"], ensure_ascii=False)
    changed = (meta_json != (row["auto_meta"] or "{}")) or bool(row["is_lost"])

    if auto:
        sql = ("UPDATE projects SET auto_meta=?, fs_created=?, fs_modified=?, "
               "is_lost=0, lost_reason='' WHERE id=? AND path=?")
        params = (meta_json, parsed["fs_created"], parsed["fs_modified"],
                  project_id, path)
    else:
        sql = ("UPDATE projects SET auto_meta=?, fs_created=?, fs_modified=?, tags=?, "
               "is_lost=0, lost_reason='', updated_at=? WHERE id=? AND path=?")
        params = (meta_json, parsed["fs_created"], parsed["fs_modified"],
                  _merge_tags(row["tags"], parsed["auto_meta"].get("tech_tags") or []),
                  _now_iso(), project_id, path)

    with get_db() as conn:
        applied = conn.execute(sql, params).rowcount > 0
    if not applied:
        # 期间路径被改 / 行被删：本次结果整体丢弃
        return {"id": project_id, "ok": False, "stale": True,
                "reason": "刷新期间项目路径已变更或已被删除，结果已丢弃"}

    _mark_ok(project_id)
    return {"id": project_id, "ok": True, "lost": False, "changed": changed,
            "refreshed_at": _now_iso()}


def _refresh_one(project_id: int, source: str) -> dict:
    """后台任务里的单项目刷新：拿不到锁说明别的任务正在处理它，直接让位。"""
    lock = _project_lock(project_id)
    if not lock.acquire(timeout=LOCK_WAIT_SECONDS):
        return {"id": project_id, "ok": False, "busy": True,
                "reason": "该项目正在被其他刷新任务处理"}
    try:
        return _do_refresh(project_id, "manual" if source == "manual" else "auto")
    finally:
        lock.release()


def refresh_now(project_id: int, *, mode: str = "manual", timeout: float = LOCK_WAIT_SECONDS) -> dict:
    """同步刷新一个项目（供手动「重新解析」复用同一套并发控制与写回逻辑）。"""
    lock = _project_lock(project_id)
    if not lock.acquire(timeout=timeout):
        return {"id": project_id, "ok": False, "busy": True,
                "reason": "该项目正在被其他刷新任务处理，请稍后重试"}
    try:
        return _do_refresh(project_id, mode)
    finally:
        lock.release()


# ---------------------------------------------------------------------------
# 任务表与请求合并
# ---------------------------------------------------------------------------

def _job_dict(job: dict) -> dict:
    items = list(job["items"])
    return {
        "job_id": job["id"],
        "state": job["state"],              # running | done
        "source": job["source"],
        "total": len(job["ids"]),
        "done": job["done"],
        "ok": job["ok"],
        "items": items,
        "failed": [i for i in items if not i.get("ok")],
        "changed_ids": [i["id"] for i in items if i.get("changed")],
        "started_at": job["started_at"],
        "finished_at": job["finished_at"],
        "cooldown_seconds": COOLDOWN_SECONDS,
    }


def _prune_jobs() -> None:
    """清掉过期的已完成任务（调用方需持锁）。"""
    now = time.time()
    for jid, job in list(_JOBS.items()):
        if job["state"] == "done" and now - job.get("finished_ts", now) > JOB_TTL_SECONDS:
            _JOBS.pop(jid, None)
    while len(_JOBS) > MAX_JOBS:
        _JOBS.popitem(last=False)


def _new_job(ids: list[int], source: str) -> dict:
    job = {
        "id": uuid.uuid4().hex[:12],
        "state": "running",
        "source": source,
        "ids": list(ids),
        "items": [],
        "done": 0,
        "ok": 0,
        "started_at": _now_iso(),
        "finished_at": None,
        "finished_ts": None,
    }
    with _LOCK:
        _JOBS[job["id"]] = job
        for pid in ids:
            _INFLIGHT[pid] = job["id"]
        _prune_jobs()
    threading.Thread(target=_worker, args=(job,),
                     name=f"tl-refresh-{job['id']}", daemon=True).start()
    return job


def _worker(job: dict) -> None:
    try:
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            for item in pool.map(lambda pid: _refresh_one(pid, job["source"]), job["ids"]):
                with _LOCK:
                    job["items"].append(item)
                    job["done"] += 1
                    if item.get("ok"):
                        job["ok"] += 1
    except Exception as exc:                       # 兜底：任务线程不能静默死掉
        logger.exception("后台刷新任务异常：%s", exc)
    finally:
        with _LOCK:
            job["state"] = "done"
            job["finished_at"] = _now_iso()
            job["finished_ts"] = time.time()
            for pid in job["ids"]:
                if _INFLIGHT.get(pid) == job["id"]:
                    _INFLIGHT.pop(pid, None)


def request(ids: Iterable[int], *, force: bool = False, source: str = "auto") -> dict:
    """请求刷新一批项目，立即返回任务快照（真正解析在后台线程）。

    合并规则：
      - 同一项目已在刷新 → merged（复用那个 job，前端继续轮询它）；
      - 非 force 且距上次成功不足 COOLDOWN_SECONDS → skipped；
      - force 只跳过冷却，不跳过并发控制（避免同一项目被同时解析两次）。
    """
    clean: list[int] = []
    for pid in ids or []:
        try:
            v = int(pid)
        except (TypeError, ValueError):
            continue
        if v > 0 and v not in clean:
            clean.append(v)

    empty = {"queued": [], "merged": [], "skipped": [], "missing": [],
             "cooldown_seconds": COOLDOWN_SECONDS}
    if not clean:
        return {"job_id": None, "state": "noop", **empty}

    placeholders = ",".join("?" * len(clean))
    with get_db() as conn:
        existing = {r["id"] for r in conn.execute(
            f"SELECT id FROM projects WHERE id IN ({placeholders})", clean).fetchall()}

    queued: list[int] = []
    merged: list[int] = []
    skipped: list[int] = []
    missing: list[int] = []
    now = time.monotonic()
    with _LOCK:
        for pid in clean:
            if pid not in existing:
                missing.append(pid)
                continue
            jid = _INFLIGHT.get(pid)
            if jid:
                merged.append(pid)
                continue
            if not force and now - _LAST_OK.get(pid, 0.0) < COOLDOWN_SECONDS:
                skipped.append(pid)
                continue
            queued.append(pid)

    if not queued:
        jid = _INFLIGHT.get(merged[0]) if merged else None
        return {"job_id": jid, "state": "running" if jid else "done",
                "queued": [], "merged": merged, "skipped": skipped,
                "missing": missing, "cooldown_seconds": COOLDOWN_SECONDS}

    job = _job_dict(_new_job(queued, source))
    job.update({"queued": queued, "merged": merged, "skipped": skipped,
                "missing": missing})
    return job


def job(job_id: str) -> dict | None:
    """任务快照；不存在（或已过期）返回 None。"""
    with _LOCK:
        j = _JOBS.get(job_id)
        return _job_dict(j) if j else None


def status() -> dict:
    """全局快照：in-flight、冷却剩余、最近任务（诊断与验收用）。"""
    now = time.monotonic()
    with _LOCK:
        return {
            "cooldown_seconds": COOLDOWN_SECONDS,
            "inflight": {str(k): v for k, v in _INFLIGHT.items()},
            "cooldown_remaining": {
                str(k): round(max(0.0, COOLDOWN_SECONDS - (now - t)), 1)
                for k, t in _LAST_OK.items()},
            "jobs": [_job_dict(j) for j in list(_JOBS.values())[-5:]],
        }


def reset_state() -> None:
    """清空冷却与任务表（隔离测试用；不对外暴露 HTTP 接口）。"""
    with _LOCK:
        _INFLIGHT.clear()
        _LAST_OK.clear()
        _JOBS.clear()
