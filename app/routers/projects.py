"""项目档案 API：增删改查、重新解析、README、目录树、系统打开。"""
import json
import logging
import os
import shutil
import subprocess
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from fastapi import APIRouter, File, HTTPException, Query, UploadFile

from app.config import DATA_DIR, STATUS_VALUES
from app.db import get_db
from app.models import (
    ChangelogCreate, ChangelogUpdate, NoteCreate, NoteUpdate, OpenRequest,
    ProjectCreate, ProjectUpdate,
)
from app.services import gitinfo, parser
from app.services.paths import (
    PathError, basename, dir_not_exists_hint, is_wsl_path, normalize_input_path,
)
from app.services.render import render_markdown

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/projects", tags=["projects"])

# 截图存储与限制
SHOT_DIR = DATA_DIR / "screenshots"
SHOT_MAX_SIZE = 5 * 1024 * 1024
SHOT_EXTS = {".png": ".png", ".jpg": ".jpg", ".jpeg": ".jpg", ".webp": ".webp"}


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now().astimezone().isoformat()


def _validate_status(status: str) -> str:
    if status not in STATUS_VALUES:
        raise HTTPException(400, f"无效的项目状态：{status}，可选值：{'、'.join(STATUS_VALUES)}")
    return status


def _get_row_or_404(conn, project_id: int):
    row = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    if row is None:
        raise HTTPException(404, f"项目不存在（id={project_id}），可能已被删除")
    return row


def _row_to_dict(row, *, live_check: bool = True) -> dict:
    """数据库行转响应字典；live_check 时实时校验路径是否仍存在。"""
    record = {
        "id": row["id"],
        "path": row["path"],
        "name": row["name"],
        "alias": row["alias"],
        "category": row["category"],
        "status": row["status"],
        "tags": json.loads(row["tags"] or "[]"),
        "description": row["description"],
        "is_lost": bool(row["is_lost"]),
        "lost_reason": row["lost_reason"],
        "fs_created": row["fs_created"],
        "fs_modified": row["fs_modified"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
    if live_check:
        record["exists_now"] = os.path.isdir(row["path"])
        # 数据库标记与磁盘实际状态不一致时自愈（本地单用户，代价可忽略）
        actual_lost = not record["exists_now"]
        if actual_lost != record["is_lost"]:
            reason = dir_not_exists_hint(row["path"]) if actual_lost else ""
            with get_db() as conn:
                conn.execute("UPDATE projects SET is_lost=?, lost_reason=? WHERE id=?",
                             (1 if actual_lost else 0, reason, row["id"]))
            record["is_lost"] = actual_lost
            record["lost_reason"] = reason
    meta = json.loads(row["auto_meta"] or "{}")
    record["stack_summary"] = parser.summarize_stack(meta)
    record["intro"] = meta.get("intro")
    # 卡片直接展示最近一条提交（摘要）
    record["last_commit"] = (meta.get("git") or {}).get("last_commit")
    return record


def _detail_dict(row) -> dict:
    """详情响应：附带自动解析元数据与描述渲染结果。"""
    record = _row_to_dict(row)
    meta = json.loads(row["auto_meta"] or "{}")
    record["auto_meta"] = meta
    record["description_html"] = render_markdown(record["description"], mode="notes")
    if record["is_lost"]:
        record["lost_reason"] = record["lost_reason"] or dir_not_exists_hint(row["path"])
    return record


def _parse_and_store(conn, project_id: int, path: str) -> None:
    """重新解析磁盘并写回 auto_meta / fs 时间 / 丢失标记。"""
    parsed = parser.parse_project(path)
    conn.execute(
        "UPDATE projects SET auto_meta=?, fs_created=?, fs_modified=?, "
        "is_lost=0, lost_reason='' WHERE id=?",
        (json.dumps(parsed["auto_meta"], ensure_ascii=False),
         parsed["fs_created"], parsed["fs_modified"], project_id),
    )


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------

@router.post("", status_code=201)
def create_project(body: ProjectCreate):
    """手动录入项目：校验路径 → 解析 → 入库。"""
    try:
        path = normalize_input_path(body.path)
    except PathError as exc:
        raise HTTPException(400, str(exc))
    if not os.path.isdir(path):
        raise HTTPException(400, dir_not_exists_hint(path) if not os.path.exists(path)
                            else f"路径不是文件夹：{path}")

    status = _validate_status(body.status)
    with get_db() as conn:
        dup = conn.execute("SELECT id FROM projects WHERE path=? COLLATE NOCASE",
                           (path,)).fetchone()
        if dup:
            raise HTTPException(409, f"该项目已在档案库中（id={dup['id']}）：{path}")

        name = (body.name or "").strip() or basename(path)
        try:
            parsed = parser.parse_project(path)
        except OSError as exc:
            # 无权限等读取异常：不裸 500，友好提示
            raise HTTPException(502, f"解析失败（目录无权限或 IO 错误）：{exc}")
        # 用户未填标签时，用自动识别的技术栈作为初始标签
        tags = [t.strip() for t in body.tags if t.strip()] or parsed["auto_meta"]["tech_tags"]
        cur = conn.execute(
            "INSERT INTO projects (path, name, alias, category, status, tags, "
            "auto_meta, fs_created, fs_modified, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (path, name, body.alias.strip(), body.category.strip(), status,
             json.dumps(tags, ensure_ascii=False),
             json.dumps(parsed["auto_meta"], ensure_ascii=False),
             parsed["fs_created"], parsed["fs_modified"], _now(), _now()),
        )
        row = conn.execute("SELECT * FROM projects WHERE id=?",
                           (cur.lastrowid,)).fetchone()
    return _detail_dict(row)


@router.get("")
def list_projects():
    """全部项目列表（含实时路径有效性），按状态优先级排序：
    进行中 → 已完成 → 暂停 → 归档废弃，同组内按更新时间倒序。筛选由前端完成。
    """
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM projects ORDER BY "
            "CASE status WHEN '进行中' THEN 0 WHEN '已完成' THEN 1 "
            "WHEN '暂停' THEN 2 WHEN '归档废弃' THEN 3 ELSE 4 END ASC, "
            "updated_at DESC"
        ).fetchall()
        items = [_row_to_dict(r, live_check=True) for r in rows]
    stats = {
        "total": len(items),
        "active": sum(1 for i in items if i["status"] != "归档废弃" and not i["is_lost"]),
        "archived": sum(1 for i in items if i["status"] == "归档废弃"),
        "lost": sum(1 for i in items if i["is_lost"]),
    }
    return {"projects": items, "stats": stats, "statuses": STATUS_VALUES}


@router.get("/{project_id}")
def get_project(project_id: int):
    with get_db() as conn:
        row = _get_row_or_404(conn, project_id)
    result = _detail_dict(row)
    # 状态下拉框的选项一并返回，详情页直接可用
    result["statuses"] = STATUS_VALUES
    return result


@router.put("/{project_id}")
def update_project(project_id: int, body: ProjectUpdate):
    """更新档案字段；path 变更时校验新路径并重新解析。"""
    with get_db() as conn:
        row = _get_row_or_404(conn, project_id)
        updates, params = [], []

        new_path = None
        if body.path is not None and body.path.strip():
            try:
                new_path = normalize_input_path(body.path)
            except PathError as exc:
                raise HTTPException(400, str(exc))
            if new_path.lower() != row["path"].lower():
                if not os.path.isdir(new_path):
                    raise HTTPException(400, dir_not_exists_hint(new_path)
                                        if not os.path.exists(new_path)
                                        else f"路径不是文件夹：{new_path}")
                dup = conn.execute(
                    "SELECT id FROM projects WHERE path=? COLLATE NOCASE AND id<>?",
                    (new_path, project_id)).fetchone()
                if dup:
                    raise HTTPException(409, f"该路径已被项目 id={dup['id']} 占用：{new_path}")
            else:
                new_path = None  # 大小写等价，视为未变更

        if new_path:
            updates.append("path=?")
            params.append(new_path)
            # 原名就是旧文件夹名时，跟随新路径自动改名
            if (body.name is None or not body.name.strip()) \
                    and row["name"] == basename(row["path"]):
                updates.append("name=?")
                params.append(basename(new_path))

        if body.name is not None and body.name.strip():
            updates.append("name=?")
            params.append(body.name.strip())
        if body.alias is not None:
            updates.append("alias=?")
            params.append(body.alias.strip())
        if body.category is not None:
            updates.append("category=?")
            params.append(body.category.strip())
        if body.status is not None:
            updates.append("status=?")
            params.append(_validate_status(body.status))
        if body.tags is not None:
            updates.append("tags=?")
            params.append(json.dumps([t.strip() for t in body.tags if t.strip()],
                                     ensure_ascii=False))
        if body.description is not None:
            updates.append("description=?")
            params.append(body.description)

        if updates:
            updates.append("updated_at=?")
            params.append(_now())
            params.append(project_id)
            conn.execute(f"UPDATE projects SET {', '.join(updates)} WHERE id=?", params)

        if new_path:
            # 路径更新后立即重新解析，并清除丢失标记
            try:
                _parse_and_store(conn, project_id, new_path)
            except OSError as exc:
                raise HTTPException(502, f"解析失败（目录无权限或 IO 错误）：{exc}")

        row = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    return _detail_dict(row)


@router.delete("/{project_id}")
def delete_project(project_id: int):
    """删除档案记录（仅删除索引数据与本系统内截图，不触碰原项目文件夹）。"""
    with get_db() as conn:
        row = _get_row_or_404(conn, project_id)
        conn.execute("DELETE FROM projects WHERE id=?", (project_id,))
    # 级联清理本系统内保存的截图（位于 data/screenshots，与原项目无关）
    shutil.rmtree(SHOT_DIR / str(project_id), ignore_errors=True)
    return {"ok": True, "deleted": row["name"],
            "note": "仅删除档案记录，原项目文件未做任何改动"}


def _merge_tags(old_tags: str, new_tech_tags: list[str]) -> str:
    """合并旧标签与新自动识别的标签：保留已有（含手动添加），补充新识别。"""
    old = json.loads(old_tags or "[]")
    merged = list(old) + [t for t in new_tech_tags if t not in old]
    return json.dumps(merged, ensure_ascii=False)


@router.post("/rescan-all")
def rescan_all():
    """批量重新解析全部项目（解析器升级后一键刷新；跳过路径丢失的）。

    解析是磁盘 IO（git 命令、目录遍历），用线程池并发加速；
    SQLite 写回在主线程串行完成。标签合并策略：保留已有，补充新识别。
    """
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM projects").fetchall()

    def parse_one(row):
        if not os.path.isdir(row["path"]):
            return row, None, "路径丢失"
        try:
            return row, parser.parse_project(row["path"]), None
        except OSError as exc:
            return row, None, f"解析失败：{exc}"

    ok, failed = 0, []
    with ThreadPoolExecutor(max_workers=4) as pool:
        for row, parsed, error in pool.map(parse_one, rows):
            if error:
                failed.append({"id": row["id"], "name": row["name"], "reason": error})
                if error == "路径丢失":
                    with get_db() as conn:
                        conn.execute("UPDATE projects SET is_lost=1, lost_reason=? "
                                     "WHERE id=?", (dir_not_exists_hint(row["path"]), row["id"]))
                continue
            with get_db() as conn:
                conn.execute(
                    "UPDATE projects SET auto_meta=?, fs_created=?, fs_modified=?, "
                    "tags=?, is_lost=0, lost_reason='', updated_at=? WHERE id=?",
                    (json.dumps(parsed["auto_meta"], ensure_ascii=False),
                     parsed["fs_created"], parsed["fs_modified"],
                     _merge_tags(row["tags"], parsed["auto_meta"]["tech_tags"]),
                     _now(), row["id"]))
            ok += 1
    return {"rescanned": ok, "failed": failed}


@router.post("/{project_id}/rescan")
def rescan_project(project_id: int):
    """重新解析磁盘信息；路径已失效时标记为丢失项目。"""
    with get_db() as conn:
        row = _get_row_or_404(conn, project_id)
        if not os.path.isdir(row["path"]):
            reason = dir_not_exists_hint(row["path"])
            conn.execute("UPDATE projects SET is_lost=1, lost_reason=?, updated_at=? "
                         "WHERE id=?", (reason, _now(), project_id))
            row = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
            result = _detail_dict(row)
            result["parse_ok"] = False
            return result
        try:
            parsed = parser.parse_project(row["path"])
            conn.execute(
                "UPDATE projects SET auto_meta=?, fs_created=?, fs_modified=?, tags=?, "
                "is_lost=0, lost_reason='' WHERE id=?",
                (json.dumps(parsed["auto_meta"], ensure_ascii=False),
                 parsed["fs_created"], parsed["fs_modified"],
                 _merge_tags(row["tags"], parsed["auto_meta"]["tech_tags"]),
                 project_id))
        except OSError as exc:
            # 无权限等读取异常：不中断服务，友好提示
            raise HTTPException(502, f"解析失败（目录无权限或 IO 错误）：{exc}")
        conn.execute("UPDATE projects SET updated_at=? WHERE id=?", (_now(), project_id))
        row = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    result = _detail_dict(row)
    result["parse_ok"] = True
    return result


@router.get("/{project_id}/readme")
def get_readme(project_id: int):
    """读取并渲染项目根目录 README.md。"""
    with get_db() as conn:
        row = _get_row_or_404(conn, project_id)
    if not os.path.isdir(row["path"]):
        raise HTTPException(409, dir_not_exists_hint(row["path"]))
    readme_path = parser.find_readme(row["path"])
    if readme_path is None:
        return {"exists": False, "file": None, "html": ""}
    return parser.render_readme_file(readme_path)


@router.get("/{project_id}/tree")
def get_tree(project_id: int):
    """项目目录树只读预览（深度/节点受限，跳过 node_modules 等）。"""
    with get_db() as conn:
        row = _get_row_or_404(conn, project_id)
    if not os.path.isdir(row["path"]):
        raise HTTPException(409, dir_not_exists_hint(row["path"]))
    try:
        return parser.build_tree(row["path"])
    except OSError as exc:
        raise HTTPException(502, f"目录树读取失败（无权限或 IO 错误）：{exc}")


@router.post("/{project_id}/open")
def open_project(project_id: int, body: OpenRequest):
    """在系统层打开项目：资源管理器或 VSCode。只打开，不修改文件。"""
    with get_db() as conn:
        row = _get_row_or_404(conn, project_id)
    path = row["path"]
    if not os.path.isdir(path):
        raise HTTPException(409, dir_not_exists_hint(path))

    if body.target == "explorer":
        try:
            os.startfile(path)  # Windows 资源管理器打开（UNC/WSL 路径同样支持）
        except OSError as exc:
            raise HTTPException(502, f"无法打开资源管理器：{exc}")
        return {"ok": True, "target": "explorer"}

    # VSCode：优先 PATH 中的 code 命令
    code_bin = shutil.which("code")
    if not code_bin:
        raise HTTPException(
            400, "未找到 code 命令。请确认已安装 VS Code 并在安装时勾选"
                 "“添加到 PATH”，或手动将 VS Code 的 bin 目录加入 PATH。")
    try:
        # CREATE_NO_WINDOW 避免弹出多余的命令行窗口
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        subprocess.Popen([code_bin, path], creationflags=flags, close_fds=True)
    except OSError as exc:
        raise HTTPException(502, f"无法启动 VS Code：{exc}")
    return {"ok": True, "target": "vscode"}


# ---------------------------------------------------------------------------
# Git 提交记录（可视化时间线）
# ---------------------------------------------------------------------------

@router.get("/{project_id}/commits")
def get_commits(project_id: int, limit: int = Query(50, ge=1, le=200)):
    """读取最近 git 提交记录，供前端时间线与简易统计展示。"""
    with get_db() as conn:
        row = _get_row_or_404(conn, project_id)
    if not os.path.isdir(row["path"]):
        raise HTTPException(409, dir_not_exists_hint(row["path"]))
    return gitinfo.collect_commit_log(row["path"], limit=limit)


# ---------------------------------------------------------------------------
# 自定义开发笔记（多条，独立于项目描述）
# ---------------------------------------------------------------------------

def _note_dict(row) -> dict:
    return {
        "id": row["id"],
        "content": row["content"],
        "content_html": render_markdown(row["content"], mode="notes"),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


@router.get("/{project_id}/notes")
def list_notes(project_id: int):
    with get_db() as conn:
        _get_row_or_404(conn, project_id)
        rows = conn.execute(
            "SELECT * FROM notes WHERE project_id=? ORDER BY id DESC",
            (project_id,)).fetchall()
    return {"notes": [_note_dict(r) for r in rows]}


@router.post("/{project_id}/notes", status_code=201)
def create_note(project_id: int, body: NoteCreate):
    now = _now()
    with get_db() as conn:
        _get_row_or_404(conn, project_id)
        cur = conn.execute(
            "INSERT INTO notes (project_id, content, created_at, updated_at) "
            "VALUES (?,?,?,?)",
            (project_id, body.content.strip(), now, now))
        row = conn.execute("SELECT * FROM notes WHERE id=?",
                           (cur.lastrowid,)).fetchone()
    return _note_dict(row)


@router.put("/{project_id}/notes/{note_id}")
def update_note(project_id: int, note_id: int, body: NoteUpdate):
    with get_db() as conn:
        _get_row_or_404(conn, project_id)
        row = conn.execute("SELECT * FROM notes WHERE id=? AND project_id=?",
                           (note_id, project_id)).fetchone()
        if row is None:
            raise HTTPException(404, "笔记不存在或不属于该项目")
        conn.execute("UPDATE notes SET content=?, updated_at=? WHERE id=?",
                     (body.content.strip(), _now(), note_id))
        row = conn.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
    return _note_dict(row)


@router.delete("/{project_id}/notes/{note_id}")
def delete_note(project_id: int, note_id: int):
    with get_db() as conn:
        _get_row_or_404(conn, project_id)
        cur = conn.execute("DELETE FROM notes WHERE id=? AND project_id=?",
                           (note_id, project_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "笔记不存在或不属于该项目")
    return {"ok": True}


# ---------------------------------------------------------------------------
# 自定义变更日志（用户手写，独立于 git 提交记录）
# ---------------------------------------------------------------------------

def _log_dict(row) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "content": row["content"],
        "content_html": render_markdown(row["content"], mode="notes"),
        "entry_date": row["entry_date"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


@router.get("/{project_id}/changelogs")
def list_changelogs(project_id: int):
    with get_db() as conn:
        _get_row_or_404(conn, project_id)
        rows = conn.execute(
            "SELECT * FROM changelogs WHERE project_id=? "
            "ORDER BY entry_date DESC, id DESC",
            (project_id,)).fetchall()
    return {"changelogs": [_log_dict(r) for r in rows]}


@router.post("/{project_id}/changelogs", status_code=201)
def create_changelog(project_id: int, body: ChangelogCreate):
    now = _now()
    entry_date = body.entry_date or now[:10]  # 留空取当天
    with get_db() as conn:
        _get_row_or_404(conn, project_id)
        cur = conn.execute(
            "INSERT INTO changelogs (project_id, title, content, entry_date, "
            "created_at, updated_at) VALUES (?,?,?,?,?,?)",
            (project_id, body.title.strip(), body.content.strip(), entry_date,
             now, now))
        row = conn.execute("SELECT * FROM changelogs WHERE id=?",
                           (cur.lastrowid,)).fetchone()
    return _log_dict(row)


@router.put("/{project_id}/changelogs/{log_id}")
def update_changelog(project_id: int, log_id: int, body: ChangelogUpdate):
    with get_db() as conn:
        _get_row_or_404(conn, project_id)
        row = conn.execute("SELECT * FROM changelogs WHERE id=? AND project_id=?",
                           (log_id, project_id)).fetchone()
        if row is None:
            raise HTTPException(404, "变更日志条目不存在或不属于该项目")
        title = body.title.strip() if body.title is not None else row["title"]
        content = body.content.strip() if body.content is not None else row["content"]
        entry_date = body.entry_date or row["entry_date"]
        conn.execute(
            "UPDATE changelogs SET title=?, content=?, entry_date=?, updated_at=? "
            "WHERE id=?",
            (title, content, entry_date, _now(), log_id))
        row = conn.execute("SELECT * FROM changelogs WHERE id=?", (log_id,)).fetchone()
    return _log_dict(row)


@router.delete("/{project_id}/changelogs/{log_id}")
def delete_changelog(project_id: int, log_id: int):
    with get_db() as conn:
        _get_row_or_404(conn, project_id)
        cur = conn.execute("DELETE FROM changelogs WHERE id=? AND project_id=?",
                           (log_id, project_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "变更日志条目不存在或不属于该项目")
    return {"ok": True}


# ---------------------------------------------------------------------------
# 项目截图（保存在本系统 data/screenshots，与原项目目录无关）
# ---------------------------------------------------------------------------

def _shot_dir(project_id: int):
    d = SHOT_DIR / str(project_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _shot_list(project_id: int) -> list[dict]:
    d = SHOT_DIR / str(project_id)
    items = []
    if d.is_dir():
        for f in sorted(d.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
            if f.is_file() and f.suffix.lower() in SHOT_EXTS:
                items.append({
                    "file": f.name,
                    "url": f"/media/{project_id}/{f.name}",
                    "size": f.stat().st_size,
                    "mtime": datetime.fromtimestamp(f.stat().st_mtime).astimezone().isoformat(),
                })
    return items


@router.get("/{project_id}/screenshots")
def list_screenshots(project_id: int):
    with get_db() as conn:
        _get_row_or_404(conn, project_id)
    return {"screenshots": _shot_list(project_id)}


@router.post("/{project_id}/screenshots", status_code=201)
async def upload_screenshots(project_id: int, files: list[UploadFile] = File(...)):
    """上传项目截图（每张 ≤5MB，png/jpg/webp），存本系统 data 目录。"""
    with get_db() as conn:
        _get_row_or_404(conn, project_id)
    d = _shot_dir(project_id)
    saved, errors = [], []
    for f in files:
        ext = os.path.splitext(f.filename or "")[1].lower()
        if ext not in SHOT_EXTS:
            errors.append({"file": f.filename, "reason": "仅支持 png/jpg/webp"})
            continue
        data = await f.read()
        if len(data) > SHOT_MAX_SIZE:
            errors.append({"file": f.filename, "reason": "超过 5MB 限制"})
            continue
        if not data:
            errors.append({"file": f.filename, "reason": "空文件"})
            continue
        name = uuid.uuid4().hex + SHOT_EXTS[ext]
        (d / name).write_bytes(data)
        saved.append({"file": name, "url": f"/media/{project_id}/{name}"})
    return {"saved": saved, "errors": errors}


@router.delete("/{project_id}/screenshots/{filename}")
def delete_screenshot(project_id: int, filename: str):
    # basename 防路径穿越，只允许删除本项目目录内的图片文件
    safe = os.path.basename(filename)
    target = SHOT_DIR / str(project_id) / safe
    if not target.is_file() or target.suffix.lower() not in SHOT_EXTS:
        raise HTTPException(404, "截图不存在")
    target.unlink()
    return {"ok": True}


# ---------------------------------------------------------------------------
# 导出单个项目为静态 HTML 档案（自包含单文件，可直接浏览器打开/分享）
# ---------------------------------------------------------------------------

@router.get("/{project_id}/export-html")
def export_project_html(project_id: int):
    from fastapi.responses import HTMLResponse
    import html as _html

    with get_db() as conn:
        row = _get_row_or_404(conn, project_id)
        notes = conn.execute("SELECT * FROM notes WHERE project_id=? ORDER BY id DESC",
                             (project_id,)).fetchall()
        logs = conn.execute("SELECT * FROM changelogs WHERE project_id=? "
                            "ORDER BY entry_date DESC, id DESC",
                            (project_id,)).fetchall()
    meta = json.loads(row["auto_meta"] or "{}")
    git = meta.get("git") or {}

    def esc(s):
        return _html.escape(str(s or ""))

    tags_html = "".join(f"<span class='tag'>{esc(t)}</span>"
                        for t in json.loads(row["tags"] or "[]")) or "<span class='tag'>无标签</span>"
    notes_html = "".join(
        f"<div class='card-item'><div class='md'>{render_markdown(n['content'], 'notes')}</div>"
        f"<div class='meta'>创建 {esc(n['created_at'][:16])}</div></div>"
        for n in notes) or "<p class='dim'>暂无笔记</p>"
    logs_html = "".join(
        f"<div class='card-item'><div class='log-head'><b>{esc(c['title'] or '未命名条目')}</b>"
        f"<span class='date'>{esc(c['entry_date'])}</span></div>"
        f"<div class='md'>{render_markdown(c['content'], 'notes')}</div>"
        f"<div class='meta'>记录于 {esc(c['created_at'][:16])}</div></div>"
        for c in logs) or "<p class='dim'>暂无变更日志</p>"
    deps_html = ""
    for c in meta.get("configs", []):
        deps = c.get("dependencies") or []
        scripts = c.get("scripts") or {}
        if not deps and not scripts:
            continue
        dep_chips = "".join(f"<span class='tag'>{esc(dp)}</span>" for dp in deps[:40])
        script_chips = "".join(f"<span class='tag'>{esc(k)}</span>" for k in scripts)
        deps_html += (f"<div class='card-item'><b>{esc(c.get('kind'))}</b> "
                      f"<span class='dim'>{esc(c.get('file'))}</span> "
                      f"<span class='dim'>v{esc(c.get('version'))}</span>"
                      f"<div style='margin-top:6px'>{dep_chips}{script_chips}</div></div>")
    lc = git.get("last_commit") or {}
    git_html = ""
    if git.get("is_repo"):
        git_html = (f"<p>分支 <b>{esc(git.get('branch'))}</b> · 共 "
                    f"<b>{git.get('commit_count') or '?'}</b> 次提交 · 首次提交 "
                    f"{esc(str(git.get('first_commit_date'))[:10])}</p>"
                    f"<p class='dim'>最近：{esc(lc.get('hash'))} {esc(lc.get('message'))}</p>")

    doc = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<title>{esc(row['name'])} · 项目档案</title>
<style>
body {{ font: 15px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: #1f2328; background: #f6f7f9; margin: 0; }}
.wrap {{ max-width: 860px; margin: 0 auto; padding: 32px 24px 64px; }}
h1 {{ font-size: 28px; margin: 0 0 4px; }}
h2 {{ font-size: 17px; border-left: 3px solid #0969da; padding-left: 10px; margin: 28px 0 12px; }}
.meta {{ font-size: 12px; color: #656d76; margin-top: 6px; }}
.dim {{ color: #656d76; }}
.md p {{ margin: 6px 0; }}
.md pre {{ background: #f0f2f4; padding: 10px 12px; border-radius: 6px; overflow-x: auto; }}
.md code {{ font-family: Consolas, monospace; background: #f0f2f4; padding: 1px 5px; border-radius: 4px; }}
.tag {{ display: inline-block; background: rgba(9,105,218,.1); color: #0969da;
      border-radius: 4px; padding: 1px 8px; margin: 2px 4px 2px 0; font-size: 13px; }}
.card-item {{ background: #fff; border: 1px solid #d8dee4; border-radius: 10px;
            padding: 12px 16px; margin-bottom: 10px; }}
.log-head b {{ margin-right: 8px; }} .date {{ color: #0969da; font-size: 13px; }}
table.kv td {{ padding: 3px 12px 3px 0; vertical-align: top; }}
.k {{ color: #656d76; white-space: nowrap; }}
.foot {{ margin-top: 40px; font-size: 12px; color: #8b949e; border-top: 1px solid #d8dee4; padding-top: 12px; }}
</style></head><body><div class="wrap">
<h1>{esc(row['name'])}</h1>
<p class="dim">{esc(row['alias'])} · 状态：{esc(row['status'])} · 分类：{esc(row['category']) or '－'}</p>
<p>{tags_html}</p>
<h2>基础信息</h2>
<table class="kv">
<tr><td class="k">本地路径</td><td>{esc(row['path'])}</td></tr>
<tr><td class="k">README 简介</td><td>{esc(meta.get('intro') or '－')}</td></tr>
<tr><td class="k">磁盘时间</td><td>{esc(str(row['fs_created'])[:16])} → {esc(str(row['fs_modified'])[:16])}</td></tr>
</table>
<h2>Git 信息</h2>
{git_html or "<p class='dim'>非 Git 仓库</p>"}
<h2>依赖与脚本</h2>
{deps_html or "<p class='dim'>未识别到构建配置</p>"}
<h2>项目描述</h2>
<div class="md">{render_markdown(row['description'], 'notes') or "<p class='dim'>暂无描述</p>"}</div>
<h2>开发笔记（{len(notes)}）</h2>
{notes_html}
<h2>变更日志（{len(logs)}）</h2>
{logs_html}
<div class="foot">由 本地项目档案 系统导出于 {esc(datetime.now().astimezone().isoformat()[:16])} ·
数据仅含本机档案索引，原项目文件未做任何改动</div>
</div></body></html>"""

    import re as _re
    safe_name = _re.sub(r'[\\/:*?"<>|]', "_", row["name"]) or "project"
    return HTMLResponse(
        content=doc,
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{safe_name}-archive.html"},
    )
