"""项目档案 API：增删改查、重新解析、README、目录树、系统打开。"""
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, File, HTTPException, Query, UploadFile

from app.config import (
    DATA_DIR, LAUNCHERS_MAX_PER_PROJECT, STATUS_VALUES,
)
from app.db import get_db
from app.models import (
    ChangelogCreate, ChangelogUpdate, LaunchNoteUpdate, LaunchRequest,
    LauncherCreate, LauncherUpdate, NoteCreate, NoteUpdate, OpenRequest,
    ProjectCreate, ProjectUpdate,
)
from app.services import gitinfo, launcher as launcher_service, parser, settings_store
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
        "pinned": bool(row["pinned"]) if "pinned" in row.keys() else False,
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
    """全部项目列表（含实时路径有效性），按置顶与状态优先级排序：
    置顶 → 进行中 → 已完成 → 暂停 → 归档 → 废弃，同组内按更新时间倒序。筛选由前端完成。
    """
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM projects ORDER BY pinned DESC, "
            "CASE status WHEN '进行中' THEN 0 WHEN '已完成' THEN 1 "
            "WHEN '暂停' THEN 2 WHEN '归档' THEN 3 WHEN '废弃' THEN 4 ELSE 5 END ASC, "
            "updated_at DESC"
        ).fetchall()
        # 路径校验并发执行：盘多/含网络盘时逐个 isdir 是首屏瓶颈
        with ThreadPoolExecutor(max_workers=8) as pool:
            items = list(pool.map(lambda r: _row_to_dict(r, live_check=True), rows))
    stats = {
        "total": len(items),
        "active": sum(1 for i in items if i["status"] not in ("归档", "废弃") and not i["is_lost"]),
        "archived": sum(1 for i in items if i["status"] == "归档"),
        "discarded": sum(1 for i in items if i["status"] == "废弃"),
        "lost": sum(1 for i in items if i["is_lost"]),
    }
    return {"projects": items, "stats": stats, "statuses": STATUS_VALUES}


@router.get("/brief")
def list_projects_brief():
    """轻量列表（仅 id/name），详情页左右切换用，不做磁盘校验。"""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, name FROM projects ORDER BY pinned DESC, "
            "CASE status WHEN '进行中' THEN 0 WHEN '已完成' THEN 1 "
            "WHEN '暂停' THEN 2 WHEN '归档' THEN 3 WHEN '废弃' THEN 4 ELSE 5 END ASC, "
            "updated_at DESC"
        ).fetchall()
    return {"projects": [{"id": r["id"], "name": r["name"]} for r in rows]}


@router.delete("/all")
def delete_all_projects():
    """清空全部档案记录（危险操作，前端二次确认）。

    笔记与变更日志经外键级联删除，截图目录一并清理；
    原项目文件夹不受任何影响。
    """
    with get_db() as conn:
        n = conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
        conn.execute("DELETE FROM projects")
    if SHOT_DIR.is_dir():
        shutil.rmtree(SHOT_DIR, ignore_errors=True)
        SHOT_DIR.mkdir(parents=True, exist_ok=True)
    logger.warning("已清空全部档案，共 %d 条记录", n)
    return {"ok": True, "deleted": n,
            "note": "仅删除档案记录与截图，原项目文件未做任何改动"}


@router.post("/{project_id}/pin")
def toggle_pin(project_id: int):
    """切换置顶状态：置顶项目在列表中优先展示。"""
    with get_db() as conn:
        row = _get_row_or_404(conn, project_id)
        new = 0 if row["pinned"] else 1
        conn.execute("UPDATE projects SET pinned=?, updated_at=? WHERE id=?",
                     (new, _now(), project_id))
    return {"ok": True, "pinned": bool(new)}


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


# 「全部重新解析」后台任务状态（单用户场景，一份全局状态足够）
_RESCAN_JOB = {"running": False, "finished": False,
               "done": 0, "total": 0, "ok": 0, "failed": []}


def _rescan_worker(rows) -> None:
    """后台线程：解析并发跑，进度实时写入 _RESCAN_JOB。"""

    def parse_one(row):
        if not os.path.isdir(row["path"]):
            return row, None, "路径丢失"
        try:
            return row, parser.parse_project(row["path"]), None
        except OSError as exc:
            return row, None, f"解析失败：{exc}"

    try:
        with ThreadPoolExecutor(max_workers=4) as pool:
            for row, parsed, error in pool.map(parse_one, rows):
                if error:
                    _RESCAN_JOB["failed"].append(
                        {"id": row["id"], "name": row["name"], "reason": error})
                    if error == "路径丢失":
                        with get_db() as conn:
                            conn.execute("UPDATE projects SET is_lost=1, lost_reason=? "
                                         "WHERE id=?",
                                         (dir_not_exists_hint(row["path"]), row["id"]))
                else:
                    with get_db() as conn:
                        conn.execute(
                            "UPDATE projects SET auto_meta=?, fs_created=?, fs_modified=?, "
                            "tags=?, is_lost=0, lost_reason='', updated_at=? WHERE id=?",
                            (json.dumps(parsed["auto_meta"], ensure_ascii=False),
                             parsed["fs_created"], parsed["fs_modified"],
                             _merge_tags(row["tags"], parsed["auto_meta"]["tech_tags"]),
                             _now(), row["id"]))
                    _RESCAN_JOB["ok"] += 1
                _RESCAN_JOB["done"] += 1
    finally:
        _RESCAN_JOB["running"] = False
        _RESCAN_JOB["finished"] = True


@router.post("/rescan-all")
def rescan_all():
    """批量重新解析全部项目（后台任务，进度见 /rescan-all/progress）。

    解析是磁盘 IO（git 命令、目录遍历），用线程池并发加速；
    标签合并策略：保留已有，补充新识别。
    """
    if _RESCAN_JOB["running"]:
        return {"started": False, "reason": "已有重新解析任务在进行中", **_RESCAN_JOB}
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM projects").fetchall()
    if not rows:
        return {"started": True, "total": 0, "done": 0, "ok": 0, "failed": []}
    _RESCAN_JOB.update(running=True, finished=False, done=0,
                       total=len(rows), ok=0, failed=[])
    threading.Thread(target=_rescan_worker, args=(rows,), daemon=True).start()
    return {"started": True, "total": len(rows)}


@router.get("/rescan-all/progress")
def rescan_all_progress():
    """重新解析任务进度快照。"""
    return dict(_RESCAN_JOB)


def refresh_lost_marks() -> None:
    """后台校验全部项目路径有效性，只更新丢失标记，不重新解析（快）。

    由「启动自动刷新」开关控制，在后台线程运行，不阻塞服务启动。
    """
    with get_db() as conn:
        rows = conn.execute("SELECT id, path, is_lost FROM projects").fetchall()
    changed = 0
    for r in rows:
        try:
            exists = os.path.isdir(r["path"])
        except OSError:
            exists = False
        if bool(r["is_lost"]) != (not exists):
            with get_db() as conn:
                conn.execute("UPDATE projects SET is_lost=?, lost_reason=? WHERE id=?",
                             (0 if exists else 1,
                              "" if exists else dir_not_exists_hint(r["path"]),
                              r["id"]))
            changed += 1
    if changed:
        logger.info("启动路径校验：%d 个项目的丢失状态已更新", changed)


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
        return {"exists": False, "file": None, "html": "", "raw": ""}
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

    # 编辑器：默认 PATH 中的 code 命令，可在设置中改为 cursor / windsurf 等
    from app.services import settings_store
    editor_cmd = str(settings_store.get("editor.command") or "").strip() or "code"
    code_bin = shutil.which(editor_cmd)
    if not code_bin:
        raise HTTPException(
            400, f"未找到命令「{editor_cmd}」。请确认对应编辑器已安装并加入 PATH，"
                 f"或在设置中修改「打开项目的编辑器」（默认 code）。")
    try:
        if os.name == "nt":
            # npm 风格编辑器 CLI 是 .cmd 脚本（如 cursor.cmd / code.cmd），
            # Python 3.12+ 的 subprocess 直接执行会抛 WinError 193；
            # ShellExecuteW 走系统文件关联，与「运行」对话框行为一致。
            import ctypes
            ret = ctypes.windll.shell32.ShellExecuteW(
                None, "open", code_bin, f'"{path}"', None, 1)  # SW_SHOWNORMAL
            if ret <= 32:
                raise OSError(f"ShellExecute 错误码 {ret}")
        else:
            subprocess.Popen([editor_cmd, path], close_fds=True)
    except OSError as exc:
        raise HTTPException(502, f"无法启动「{editor_cmd}」：{exc}")
    return {"ok": True, "target": "editor"}


# ---------------------------------------------------------------------------
# 快速启动：入口检测 / 说明 / 自定义启动项 / 执行
# ---------------------------------------------------------------------------

def _clean_launch_command(cmd: str) -> str:
    """命令串基础防御：非空、无换行（防拼接注入）、长度受限。"""
    cmd = (cmd or "").strip()
    if not cmd:
        raise HTTPException(422, "启动命令不能为空")
    if "\n" in cmd or "\r" in cmd:
        raise HTTPException(422, "启动命令不能包含换行符")
    if len(cmd) > 500:
        raise HTTPException(422, "启动命令过长（上限 500 字符）")
    return cmd


def _resolve_launch_cwd(project_path: str, cwd: str) -> str:
    """启动子目录必须是项目内的相对路径；越界（.. 逃逸/绝对路径）一律拒绝。"""
    cwd = (cwd or "").strip()
    if not cwd:
        return project_path
    if os.path.isabs(cwd) or (len(cwd) > 1 and cwd[1] == ":") or cwd.startswith("~"):
        raise HTTPException(422, "子目录必须是项目内的相对路径")
    full = os.path.normpath(os.path.join(project_path, cwd))
    base = os.path.normpath(project_path)
    if full != base and not full.startswith(base + os.sep):
        raise HTTPException(422, "子目录越出了项目范围")
    if not os.path.isdir(full):
        raise HTTPException(409, f"子目录不存在：{cwd}")
    return full


def _launchers_row_dict(r) -> dict:
    return {"id": r["id"], "name": r["name"], "command": r["command"],
            "cwd": r["cwd"], "mode": r["mode"], "sort": r["sort"],
            "created_at": r["created_at"], "updated_at": r["updated_at"]}


@router.get("/{project_id}/launch")
def get_launch(project_id: int):
    """启动面板数据：说明（服务端渲染 HTML）+ 自动检测建议 + 自定义启动项。

    检测按需进行（打开面板时才扫），漏斗式：先找项目内可执行文件，
    一个没有才做构建配置推断；任何检测失败都降级为空建议。
    """
    with get_db() as conn:
        row = _get_row_or_404(conn, project_id)
        rows = conn.execute(
            "SELECT * FROM launchers WHERE project_id=? ORDER BY sort, id",
            (project_id,)).fetchall()
    path = row["path"]
    if not os.path.isdir(path):
        raise HTTPException(409, dir_not_exists_hint(path))
    # 一键启动依赖 Windows Shell；UNC 形式的 WSL 路径在 Windows 侧跑不了脚本
    supported = os.name == "nt" and not is_wsl_path(path)
    if supported:
        result = launcher_service.detect_launchers(path)
        suggestions, kind = result["items"], result["kind"]
    else:
        suggestions, kind = [], "none"
    return {
        "note": row["launch_note"] or "",
        "note_html": render_markdown(row["launch_note"] or "", mode="notes"),
        "supported": supported,
        "detect_kind": kind,
        "suggestions": suggestions,
        "launchers": [_launchers_row_dict(r) for r in rows],
    }


@router.put("/{project_id}/launch-note")
def update_launch_note(project_id: int, body: LaunchNoteUpdate):
    """保存启动说明（Markdown），返回更新后的渲染 HTML。"""
    with get_db() as conn:
        _get_row_or_404(conn, project_id)
        conn.execute("UPDATE projects SET launch_note=?, updated_at=? WHERE id=?",
                     (body.note, _now(), project_id))
    return {"ok": True, "note": body.note,
            "note_html": render_markdown(body.note, mode="notes")}


def _validate_launcher_payload(body: LauncherCreate, project_path: str) -> str:
    """自定义启动项的保存校验：命令防御 + cwd 越界检查（提前失败，别等执行时）。"""
    command = _clean_launch_command(body.command)
    cwd = (body.cwd or "").strip()
    if not cwd:
        return command
    if os.path.isabs(cwd) or (len(cwd) > 1 and cwd[1] == ":") or cwd.startswith("~"):
        raise HTTPException(422, "子目录必须是项目内的相对路径")
    full = os.path.normpath(os.path.join(project_path, cwd))
    base = os.path.normpath(project_path)
    if full != base and not full.startswith(base + os.sep):
        raise HTTPException(422, "子目录越出了项目范围")
    return command


@router.post("/{project_id}/launchers")
def create_launcher(project_id: int, body: LauncherCreate):
    """新增自定义启动项（自动检测的建议经「转存」后也走这里落库）。"""
    with get_db() as conn:
        row = _get_row_or_404(conn, project_id)
    command = _validate_launcher_payload(body, row["path"])
    with get_db() as conn:
        n = conn.execute("SELECT COUNT(*) FROM launchers WHERE project_id=?",
                         (project_id,)).fetchone()[0]
        if n >= LAUNCHERS_MAX_PER_PROJECT:
            raise HTTPException(409, f"每个项目最多 {LAUNCHERS_MAX_PER_PROJECT} 个启动项")
        nxt = conn.execute(
            "SELECT COALESCE(MAX(sort), 0) + 1 FROM launchers WHERE project_id=?",
            (project_id,)).fetchone()[0]
        cur = conn.execute(
            "INSERT INTO launchers (project_id, name, command, cwd, mode, sort, "
            "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (project_id, body.name.strip(), command, body.cwd.strip(), body.mode,
             nxt, _now(), _now()))
        row = conn.execute("SELECT * FROM launchers WHERE id=?",
                           (cur.lastrowid,)).fetchone()
    return _launchers_row_dict(row)


@router.put("/{project_id}/launchers/{launcher_id}")
def update_launcher(project_id: int, launcher_id: int, body: LauncherUpdate):
    """编辑自定义启动项。"""
    with get_db() as conn:
        row = _get_row_or_404(conn, project_id)
    command = _validate_launcher_payload(body, row["path"])
    with get_db() as conn:
        row = conn.execute("SELECT id FROM launchers WHERE id=? AND project_id=?",
                           (launcher_id, project_id)).fetchone()
        if row is None:
            raise HTTPException(404, "启动项不存在")
        conn.execute(
            "UPDATE launchers SET name=?, command=?, cwd=?, mode=?, updated_at=? WHERE id=?",
            (body.name.strip(), command, body.cwd.strip(), body.mode, _now(), launcher_id))
        row = conn.execute("SELECT * FROM launchers WHERE id=?",
                           (launcher_id,)).fetchone()
    return _launchers_row_dict(row)


@router.delete("/{project_id}/launchers/{launcher_id}")
def delete_launcher(project_id: int, launcher_id: int):
    """删除自定义启动项。"""
    with get_db() as conn:
        cur = conn.execute("DELETE FROM launchers WHERE id=? AND project_id=?",
                           (launcher_id, project_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "启动项不存在")
    return {"ok": True, "deleted": launcher_id}


@router.post("/{project_id}/launch")
def launch_project(project_id: int, body: LaunchRequest):
    """执行启动。两种模式：
    - open：直接运行（os.startfile，双击等效）——命令须指向已存在的文件；
    - console：新开终端窗口运行命令（CREATE_NEW_CONSOLE），日志可见、Ctrl+C 可停。

    安全约束：绝不自动执行（前端确认后才调用）；命令无换行；
    cwd 不得越出项目目录；WSL/UNC 路径项目不支持。
    """
    with get_db() as conn:
        row = _get_row_or_404(conn, project_id)
    path = row["path"]
    if os.name != "nt" or is_wsl_path(path):
        raise HTTPException(400, "当前环境不支持一键启动（仅 Windows 本地路径可用）")
    if not os.path.isdir(path):
        raise HTTPException(409, dir_not_exists_hint(path))

    if body.launcher_id is not None:
        with get_db() as conn:
            l = conn.execute("SELECT * FROM launchers WHERE id=? AND project_id=?",
                             (body.launcher_id, project_id)).fetchone()
        if l is None:
            raise HTTPException(404, "启动项不存在")
        command, mode, cwd = l["command"], l["mode"], l["cwd"]
    else:
        command, mode, cwd = body.command or "", body.mode or "console", body.cwd or ""
    command = _clean_launch_command(command)
    workdir = _resolve_launch_cwd(path, cwd)

    try:
        if mode == "open":
            # 双击等效：目标必须是已存在的文件（bat/cmd/exe 等）
            if not os.path.isabs(command):
                command = os.path.normpath(os.path.join(path, command))
            if not os.path.isfile(command):
                raise HTTPException(
                    400, f"直接运行的目标文件不存在：{command}\n"
                         "「直接运行」需要可执行文件的完整路径。")
            if os.path.normpath(workdir) == os.path.normpath(path):
                os.startfile(command)  # noqa: S606 与资源管理器双击行为一致
            elif sys.version_info >= (3, 13):
                # 3.13 起 startfile 支持 cwd；不少程序靠相对路径读自身配置
                os.startfile(command, cwd=workdir)  # noqa: S606
            else:
                # 旧版 Python：走系统 shell 的 start /D 指定工作目录
                flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
                subprocess.Popen(f'cmd /c start "" /D "{workdir}" "{command}"',
                                 creationflags=flags)
            return {"ok": True, "mode": "open",
                    "note": "已直接运行（与资源管理器双击等效）"}
        # console：新终端窗口跑命令；窗口由用户关闭或 Ctrl+C 停止。
        # 注意：必须传字符串而非列表——列表会经 list2cmdline 把 command 里已有的
        # 引号转义成 \"，触发 cmd /K 的引号启发式规则，命令直接报废。
        proc = subprocess.Popen(  # noqa: S603 本地工具，用户确认后执行
            f"cmd /k {command}", cwd=workdir,
            creationflags=subprocess.CREATE_NEW_CONSOLE)
        logger.info("项目 %s 启动命令已执行（pid=%s）：%s", project_id, proc.pid, command)
        return {"ok": True, "mode": "console", "pid": proc.pid,
                "note": "已在新终端窗口启动；关闭窗口或 Ctrl+C 即停止"}
    except HTTPException:
        raise
    except OSError as exc:
        raise HTTPException(502, f"启动失败：{exc}")


# ---------------------------------------------------------------------------
# Git 提交记录（可视化时间线）
# ---------------------------------------------------------------------------

@router.get("/{project_id}/commits")
def get_commits(project_id: int, limit: int = Query(50, ge=1, le=200),
                date: Optional[str] = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$")):
    """读取最近 git 提交记录，供前端时间线与简易统计展示。

    date 传 "YYYY-MM-DD" 时只返回当天提交（热力图点击查看用）。
    """
    with get_db() as conn:
        row = _get_row_or_404(conn, project_id)
    if not os.path.isdir(row["path"]):
        raise HTTPException(409, dir_not_exists_hint(row["path"]))
    return gitinfo.collect_commit_log(row["path"], limit=limit, date=date)


@router.get("/{project_id}/heatmap")
def get_heatmap(project_id: int, weeks: int = Query(53, ge=8, le=104)):
    """按天聚合最近 N 周提交数，供 GitHub 风格贡献热力图。"""
    with get_db() as conn:
        row = _get_row_or_404(conn, project_id)
    if not os.path.isdir(row["path"]):
        raise HTTPException(409, dir_not_exists_hint(row["path"]))
    return gitinfo.collect_heatmap(row["path"], weeks=weeks)


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
        for f in d.iterdir():
            if not (f.is_file() and f.suffix.lower() in SHOT_EXTS):
                continue
            try:
                st = f.stat()
            except OSError:
                continue  # 列表期间被并发删除，跳过即可
            items.append({
                "file": f.name,
                "url": f"/media/{project_id}/{f.name}",
                "size": st.st_size,
                "mtime": datetime.fromtimestamp(st.st_mtime).astimezone().isoformat(),
            })
    items.sort(key=lambda x: x["mtime"], reverse=True)
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
        # 分块读取，超过大小上限立即终止，避免超大文件整体读入内存
        chunks, total = [], 0
        too_big = False
        while chunk := await f.read(1024 * 1024):
            total += len(chunk)
            if total > SHOT_MAX_SIZE:
                too_big = True
                break
            chunks.append(chunk)
        if too_big:
            errors.append({"file": f.filename, "reason": "超过 5MB 限制"})
            continue
        if total == 0:
            errors.append({"file": f.filename, "reason": "空文件"})
            continue
        name = uuid.uuid4().hex + SHOT_EXTS[ext]
        (d / name).write_bytes(b"".join(chunks))
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
    """导出单项目为自包含 HTML 档案页：离线可开、可打印、可直接分享。

    视觉与主应用同风格（浅色卡片 + 蓝色主色）；是否包含笔记/变更日志
    由设置 export.html_include_notes 控制。
    """
    from fastapi.responses import HTMLResponse
    import html as _html

    with get_db() as conn:
        row = _get_row_or_404(conn, project_id)
        include_notes = settings_store.get("export.html_include_notes", True)
        notes = (conn.execute("SELECT * FROM notes WHERE project_id=? ORDER BY id DESC",
                              (project_id,)).fetchall() if include_notes else [])
        logs = (conn.execute("SELECT * FROM changelogs WHERE project_id=? "
                             "ORDER BY entry_date DESC, id DESC",
                             (project_id,)).fetchall() if include_notes else [])
    meta = json.loads(row["auto_meta"] or "{}")
    git = meta.get("git") or {}

    def esc(s):
        return _html.escape(str(s or ""))

    def first_line(s, n=120):
        return esc((str(s or "")).strip().splitlines()[0][:n] if str(s or "").strip() else "")

    # ---- 状态徽章配色（语义与主应用一致：蓝=进行中 绿=完成 黄=暂停 灰=归档 红=丢失） ----
    status = str(row["status"] or "")
    if "完成" in status:
        st_cls = "st-done"
    elif "暂停" in status:
        st_cls = "st-pause"
    elif "归档" in status:
        st_cls = "st-arch"
    elif "丢失" in status:
        st_cls = "st-lost"
    else:
        st_cls = "st-doing"

    tags_html = "".join(f"<span class='tag'>{esc(t)}</span>"
                        for t in json.loads(row["tags"] or "[]"))

    # ---- 概览键值卡 ----
    overview_html = f"""
      <div class="kv"><span class="k">本地路径</span><code class="path">{esc(row['path'])}</code></div>
      <div class="kv"><span class="k">README 简介</span><span>{esc(meta.get('intro') or '－')}</span></div>
      <div class="kv"><span class="k">磁盘时间</span><span>{esc(str(row['fs_created'])[:16])} → {esc(str(row['fs_modified'])[:16])}</span></div>
      <div class="kv"><span class="k">档案时间</span><span>{esc(str(row['created_at'])[:16])} → {esc(str(row['updated_at'])[:16])}</span></div>"""

    # ---- Git 指标卡 + 最近提交 ----
    git_section = ""
    if git.get("is_repo"):
        lc = git.get("last_commit") or {}
        # 判空用原始值：str(None) 切片后是 "None"，会让 `or 兜底` 永远失效
        lc_raw = lc.get("date")
        lc_date = esc(str(lc_raw)[:10]) if lc_raw else "－"
        fcd_raw = git.get("first_commit_date")
        fcd = esc(str(fcd_raw)[:10]) if fcd_raw else "－"
        git_section = f"""
    <section>
      <h2>Git 信息</h2>
      <div class="minis">
        <div class="mini"><span class="mini-v mono">{esc(git.get('branch') or '－')}</span><span class="mini-k">当前分支</span></div>
        <div class="mini"><span class="mini-v">{esc(git.get('commit_count') if git.get('commit_count') is not None else '?')}</span><span class="mini-k">提交总数</span></div>
        <div class="mini"><span class="mini-v mono">{fcd}</span><span class="mini-k">首次提交</span></div>
        <div class="mini"><span class="mini-v mono">{lc_date}</span><span class="mini-k">最近提交</span></div>
      </div>
      <p class="dim lc-line">最近：<code class="mono">{esc(lc.get('hash') or '－')}</code> {first_line(lc.get('message'))}</p>
    </section>"""

    # ---- 构建配置与依赖 ----
    deps_sections = []
    for c in meta.get("configs", []):
        deps = c.get("dependencies") or []
        scripts = c.get("scripts") or {}
        if not deps and not scripts:
            continue
        dep_chips = "".join(f"<span class='dep mono'>{esc(dp)}</span>" for dp in deps[:48])
        more = f"<span class='dim more'>等共 {len(deps)} 项</span>" if len(deps) > 48 else ""
        script_rows = "".join(
            f"<div class='script'><code class='mono'>{esc(k)}</code><span class='dim'>→</span>"
            f"<code class='mono'>{esc(v)}</code></div>"
            for k, v in list(scripts.items())[:12])
        chips_html = f"<div class='chips'>{dep_chips}{more}</div>" if dep_chips else ""
        scripts_html = f"<div class='scripts'>{script_rows}</div>" if script_rows else ""
        ver = f" · v{esc(c.get('version'))}" if c.get("version") else ""
        deps_sections.append(f"""
      <div class="card">
        <div class="card-head"><b>{esc(c.get('kind'))}</b>
          <span class="dim">{esc(c.get('file'))}{ver}</span></div>
        {chips_html}
        {scripts_html}
      </div>""")
    deps_html = "".join(deps_sections) or "<p class='dim'>未识别到构建配置</p>"

    # ---- 开发笔记卡 ----
    notes_html = "".join(
        f"<div class='card note'><div class='md'>{render_markdown(n['content'], 'notes')}</div>"
        f"<div class='meta'>创建 {esc(n['created_at'][:16])}</div></div>"
        for n in notes) or "<p class='dim'>暂无笔记</p>"

    # ---- 变更日志时间线 ----
    logs_html = "".join(
        f"<div class='tl-item'><div class='tl-dot'></div>"
        f"<div class='tl-body'><div class='tl-head'><b>{esc(c['title'] or '未命名条目')}</b>"
        f"<span class='date mono'>{esc(c['entry_date'])}</span></div>"
        f"<div class='md'>{render_markdown(c['content'], 'notes')}</div></div></div>"
        for c in logs) or "<p class='dim'>暂无变更日志</p>"

    notes_count = f"（{len(notes)}）" if include_notes else ""
    logs_count = f"（{len(logs)}）" if include_notes else ""
    exported_at = esc(datetime.now().astimezone().isoformat()[:16])
    # 预计算可选片段（Python 3.11 及以下 f-string 内不能复用外层引号字符）
    alias_html = f"<span class='alias'>{esc(row['alias'])}</span>" if row["alias"] else ""
    cat_html = f"<span class='badge cat'>{esc(row['category'])}</span>" if row["category"] else ""
    desc_html = render_markdown(row["description"], "notes") or "<p class='dim'>暂无描述</p>"

    css = """
:root { --bd:#d8dee4; --fg:#1f2328; --mut:#656d76; --acc:#0969da; --bg:#f6f8fa; --card:#fff; }
* { box-sizing: border-box; }
body { font: 15px/1.75 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: var(--fg); background: var(--bg); margin: 0; }
.wrap { max-width: 900px; margin: 0 auto; padding: 0 24px 56px; }
.hero { background: linear-gradient(135deg, #0b3d91 0%, #0969da 55%, #3ddc97 130%);
      color: #fff; padding: 40px 0 34px; }
.hero .wrap { padding-top: 0; padding-bottom: 0; }
.crumb { font-size: 12.5px; opacity: .85; letter-spacing: .04em; margin-bottom: 10px; }
.hero h1 { font-size: 30px; margin: 0 0 10px; letter-spacing: -.01em; }
.hero .alias { font-size: 15px; font-weight: 400; opacity: .88; margin-left: 10px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.badge { display: inline-block; padding: 3px 12px; border-radius: 999px;
      font-size: 13px; font-weight: 600; background: rgba(255,255,255,.18); backdrop-filter: blur(4px); }
.badge.cat { background: rgba(255,255,255,.12); font-weight: 400; }
.st-doing { background: #409cff; }
.st-done { background: #2da44e; }
.st-pause { background: #bf8700; }
.st-arch { background: #57606a; }
.st-lost { background: #cf222e; }
section { background: var(--card); border: 1px solid var(--bd); border-radius: 12px;
      padding: 20px 24px; margin-top: 20px; box-shadow: 0 1px 2px rgba(31,35,40,.04); }
h2 { font-size: 16.5px; margin: 0 0 14px; display: flex; align-items: center; gap: 8px; }
h2::before { content: ""; width: 4px; height: 15px; border-radius: 2px; background: var(--acc); }
.tag { display: inline-block; background: rgba(255,255,255,.16); color: #fff;
      border: 1px solid rgba(255,255,255,.35);
      border-radius: 999px; padding: 2px 11px; margin: 2px 6px 2px 0; font-size: 13px; }
.kv { display: flex; gap: 14px; padding: 7px 0; border-bottom: 1px dashed #eaeef2; font-size: 14.5px; }
.kv:last-child { border-bottom: none; }
.k { color: var(--mut); white-space: nowrap; min-width: 92px; }
code, .mono { font-family: Consolas, "JetBrains Mono", monospace; }
code.path { background: #f0f2f4; border: 1px solid var(--bd); border-radius: 6px;
      padding: 2px 8px; font-size: 13px; word-break: break-all; }
.minis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.mini { background: var(--bg); border: 1px solid var(--bd); border-radius: 10px; padding: 12px 16px; }
.mini-v { display: block; font-size: 19px; font-weight: 700; margin-bottom: 2px; }
.mini-k { display: block; font-size: 12px; color: var(--mut); }
.lc-line { margin: 12px 0 0; font-size: 13.5px; }
.lc-line code { background: #f0f2f4; border-radius: 5px; padding: 1px 6px; font-size: 12.5px; }
.card { background: var(--bg); border: 1px solid var(--bd); border-radius: 10px;
      padding: 14px 18px; margin-bottom: 12px; }
.card-head b { margin-right: 8px; }
.chips { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.dep { display: inline-block; background: #fff; border: 1px solid var(--bd);
      border-radius: 6px; padding: 2px 9px; font-size: 12.5px; color: #0550ae; }
.more { font-size: 12.5px; margin-left: 4px; }
.scripts { margin-top: 10px; display: grid; gap: 4px; }
.script { display: flex; gap: 10px; align-items: baseline; font-size: 13px; }
.script code:first-child { background: #ddf4ff; color: #0550ae; border-radius: 5px; padding: 1px 8px; }
.script code:last-child { background: #f0f2f4; border-radius: 5px; padding: 1px 8px; }
.md p { margin: 6px 0; }
.md pre { background: #f0f2f4; padding: 10px 12px; border-radius: 8px; overflow-x: auto; font-size: 13px; }
.md code { background: #f0f2f4; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
.md pre code { background: none; padding: 0; }
.note .meta, .card .meta { margin-top: 8px; font-size: 12px; color: #8b949e; }
.tl-item { position: relative; padding: 0 0 18px 22px; border-left: 2px solid #d8dee4;
      margin-left: 6px; }
.tl-item:last-child { border-left-color: transparent; padding-bottom: 2px; }
.tl-dot { position: absolute; left: -6px; top: 5px; width: 10px; height: 10px;
      border-radius: 50%; background: var(--acc); border: 2px solid #fff;
      box-shadow: 0 0 0 1px var(--acc); }
.tl-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 2px; }
.tl-head .date { color: var(--acc); font-size: 13px; }
.dim { color: var(--mut); }
.dim.more { font-size: 12.5px; }
.foot { margin-top: 32px; font-size: 12.5px; color: #8b949e; text-align: center; }
@media print {
  body { background: #fff; }
  .hero { background: #0969da !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  section { box-shadow: none; break-inside: avoid; }
}
"""

    doc = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(row['name'])} · 项目档案</title>
<style>{css}</style></head><body>
<header class="hero"><div class="wrap">
  <div class="crumb">归迹拾光 · 项目档案导出</div>
  <h1>{esc(row['name'])}{alias_html}</h1>
  <div class="chips">
    <span class="badge {st_cls}">{esc(status) or '未设置'}</span>
    {cat_html}
    {tags_html}
  </div>
</div></header>
<div class="wrap">
  <section><h2>基础信息</h2>{overview_html}</section>
  {git_section}
  <section><h2>依赖与脚本</h2>{deps_html}</section>
  <section><h2>项目描述</h2><div class="md">{desc_html}</div></section>
  <section><h2>开发笔记{notes_count}</h2>{notes_html}</section>
  <section><h2>变更日志{logs_count}</h2>{logs_html}</section>
  <div class="foot">由 归迹拾光 导出于 {exported_at} · 数据仅含本机档案索引，原项目文件未做任何改动</div>
</div></body></html>"""

    import re as _re
    safe_name = _re.sub(r'[\\/:*?"<>|]', "_", row["name"]) or "project"
    return HTMLResponse(
        content=doc,
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{safe_name}-archive.html"},
    )
