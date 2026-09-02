"""批量扫描 API：发现候选项目 + 批量导入（后台任务 + 进度查询）。

扫描大根目录、批量解析导入都是重磁盘 IO，同步执行会让请求长时间无响应：
对齐「全部重新解析」的既有模式——立即启动后台任务并返回，前端轮询
/progress 接口拿实时进度与最终结果。
"""
import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from fastapi import APIRouter, HTTPException

from app.config import STATUS_VALUES
from app.db import get_db
from app.models import ScanImportRequest, ScanRequest
from app.services import parser
from app.services.paths import PathError, basename, dir_not_exists_hint, normalize_input_path
from app.services.scanner import scan_root

router = APIRouter(prefix="/api/scan", tags=["scanner"])

# 单用户桌面场景：全局一份任务状态即可；锁保证同一时刻只启动一个任务
_SCAN_LOCK = threading.Lock()
_SCAN_JOB = {"running": False, "finished": True, "root": "", "max_depth": 0,
             "scanned_dirs": 0, "truncated": False, "candidates": [], "error": None}
_IMPORT_LOCK = threading.Lock()
_IMPORT_JOB = {"running": False, "finished": True, "done": 0, "total": 0,
               "imported": 0, "skipped": 0, "failed": [], "created_ids": []}


def _scan_worker(root: str, max_depth: int) -> None:
    try:
        result = scan_root(root, max_depth=max_depth, progress=_SCAN_JOB)
        # 标记已在档案库中的候选，前端据此灰显并默认不勾选，避免重复导入
        with get_db() as conn:
            existing = {r["path"].lower() for r in
                        conn.execute("SELECT path FROM projects").fetchall()}
        for c in result["candidates"]:
            c["imported"] = c["path"].lower() in existing
        _SCAN_JOB["candidates"] = result["candidates"]
        _SCAN_JOB["truncated"] = result["truncated"]
    except Exception as exc:  # 后台线程兜底：异常进 error 字段而不是默默消失
        _SCAN_JOB["error"] = f"扫描失败：{exc}"
    finally:
        _SCAN_JOB["running"] = False
        _SCAN_JOB["finished"] = True


@router.post("")
def scan(body: ScanRequest):
    """启动后台扫描：立即返回，进度与结果走 GET /api/scan/progress。"""
    try:
        root = normalize_input_path(body.root)
    except PathError as exc:
        raise HTTPException(400, str(exc))
    if not os.path.isdir(root):
        raise HTTPException(400, dir_not_exists_hint(root) if not os.path.exists(root)
                            else f"路径不是文件夹：{root}")
    with _SCAN_LOCK:
        if _SCAN_JOB["running"]:
            return {"started": False, "reason": "已有扫描任务在进行中", **_SCAN_JOB}
        _SCAN_JOB.update(running=True, finished=False, root=root,
                         max_depth=body.max_depth, scanned_dirs=0,
                         truncated=False, candidates=[], error=None)
    threading.Thread(target=_scan_worker, args=(root, body.max_depth),
                     daemon=True).start()
    return {"started": True, "root": root, "max_depth": body.max_depth}


@router.get("/progress")
def scan_progress():
    """扫描任务进度与结果快照（running/finished/scanned_dirs/candidates…）。"""
    return dict(_SCAN_JOB)


def _import_worker(paths: list[str], category: str, status: str, tags: list[str]) -> None:
    job = _IMPORT_JOB
    try:
        # 先做快的校验与规范化（串行），无效路径直接记账
        valid: list[str] = []
        for raw in paths:
            try:
                path = normalize_input_path(raw)
            except PathError as exc:
                job["failed"].append({"path": raw, "reason": str(exc)})
                job["done"] += 1
                continue
            if not os.path.isdir(path):
                job["failed"].append({"path": path,
                                      "reason": dir_not_exists_hint(path)})
                job["done"] += 1
            else:
                valid.append(path)

        with get_db() as conn:
            existing = {r["path"].lower() for r in
                        conn.execute("SELECT path FROM projects").fetchall()}
        to_parse: list[str] = []
        for path in valid:
            if path.lower() in existing:
                job["skipped"] += 1
                job["done"] += 1
            else:
                to_parse.append(path)

        # 解析（磁盘 IO + git 命令，重）4 路并发；写库留在消费线程串行做
        def parse_one(p: str):
            try:
                return p, parser.parse_project(p), None
            except OSError as exc:
                return p, None, f"解析失败：{exc}"

        now = datetime.now().astimezone().isoformat()
        with ThreadPoolExecutor(max_workers=4) as pool:
            for path, parsed, error in pool.map(parse_one, to_parse):
                if error:
                    job["failed"].append({"path": path, "reason": error})
                else:
                    # 重新查重：并发解析期间同一路径可能已被其他途径导入
                    with get_db() as conn:
                        dup = conn.execute(
                            "SELECT id FROM projects WHERE path=? COLLATE NOCASE",
                            (path,)).fetchone()
                        if dup:
                            job["skipped"] += 1
                        else:
                            final_tags = [t.strip() for t in tags if t.strip()] \
                                or parsed["auto_meta"]["tech_tags"]
                            cur = conn.execute(
                                "INSERT INTO projects (path, name, alias, category, "
                                "status, tags, auto_meta, fs_created, fs_modified, "
                                "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                                (path, basename(path), "", category.strip(), status,
                                 json.dumps(final_tags, ensure_ascii=False),
                                 json.dumps(parsed["auto_meta"], ensure_ascii=False),
                                 parsed["fs_created"], parsed["fs_modified"], now, now))
                            job["created_ids"].append(cur.lastrowid)
                            job["imported"] += 1
                job["done"] += 1
    except Exception as exc:  # 后台线程兜底：异常进 failed 而不是默默消失
        job["failed"].append({"path": "", "reason": f"导入任务异常：{exc}"})
    finally:
        job["running"] = False
        job["finished"] = True


@router.post("/import")
def import_candidates(body: ScanImportRequest):
    """启动后台批量导入：立即返回，进度与结果走 GET /api/scan/import/progress。"""
    if not body.paths:
        return {"started": True, "total": 0}
    if body.status not in STATUS_VALUES:
        raise HTTPException(400, f"无效的项目状态：{body.status}")
    with _IMPORT_LOCK:
        if _IMPORT_JOB["running"]:
            return {"started": False, "reason": "已有导入任务在进行中", **_IMPORT_JOB}
        _IMPORT_JOB.update(running=True, finished=False, done=0,
                           total=len(body.paths), imported=0, skipped=0,
                           failed=[], created_ids=[])
    threading.Thread(target=_import_worker,
                     args=(body.paths, body.category, body.status, body.tags),
                     daemon=True).start()
    return {"started": True, "total": len(body.paths)}


@router.get("/import/progress")
def import_progress():
    """导入任务进度与结果快照（done/total/imported/skipped/failed…）。"""
    return dict(_IMPORT_JOB)
