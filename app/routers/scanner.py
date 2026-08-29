"""批量扫描 API：发现候选项目 + 批量导入。"""
import json
import os
from datetime import datetime

from fastapi import APIRouter, HTTPException

from app.config import STATUS_VALUES
from app.db import get_db
from app.models import ScanImportRequest, ScanRequest
from app.services import parser
from app.services.paths import PathError, basename, dir_not_exists_hint, normalize_input_path
from app.services.scanner import scan_root

router = APIRouter(prefix="/api/scan", tags=["scanner"])


@router.post("")
def scan(body: ScanRequest):
    """扫描根目录，返回候选项目（不做任何写入，只读遍历）。"""
    try:
        root = normalize_input_path(body.root)
    except PathError as exc:
        raise HTTPException(400, str(exc))
    if not os.path.isdir(root):
        raise HTTPException(400, dir_not_exists_hint(root) if not os.path.exists(root)
                            else f"路径不是文件夹：{root}")
    return scan_root(root, max_depth=body.max_depth)


@router.post("/import")
def import_candidates(body: ScanImportRequest):
    """批量导入候选路径：已存在的路径自动跳过。"""
    if not body.paths:
        return {"imported": 0, "skipped": 0, "failed": []}
    status = body.status
    if status not in STATUS_VALUES:
        raise HTTPException(400, f"无效的项目状态：{status}")

    imported, skipped, failed = 0, 0, []
    created_ids = []
    now = datetime.now().astimezone().isoformat()
    with get_db() as conn:
        existing = {r["path"].lower() for r in
                    conn.execute("SELECT path FROM projects").fetchall()}
        for raw in body.paths:
            try:
                path = normalize_input_path(raw)
            except PathError as exc:
                failed.append({"path": raw, "reason": str(exc)})
                continue
            if not os.path.isdir(path):
                failed.append({"path": path, "reason": dir_not_exists_hint(path)})
                continue
            if path.lower() in existing:
                skipped += 1
                continue
            try:
                parsed = parser.parse_project(path)
            except OSError as exc:
                failed.append({"path": path, "reason": f"解析失败：{exc}"})
                continue
            tags = [t.strip() for t in body.tags if t.strip()] \
                or parsed["auto_meta"]["tech_tags"]
            cur = conn.execute(
                "INSERT INTO projects (path, name, alias, category, status, tags, "
                "auto_meta, fs_created, fs_modified, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (path, basename(path), "", body.category.strip(), status,
                 json.dumps(tags, ensure_ascii=False),
                 json.dumps(parsed["auto_meta"], ensure_ascii=False),
                 parsed["fs_created"], parsed["fs_modified"], now, now),
            )
            created_ids.append(cur.lastrowid)
            existing.add(path.lower())
            imported += 1
    return {"imported": imported, "skipped": skipped, "failed": failed,
            "created_ids": created_ids}
