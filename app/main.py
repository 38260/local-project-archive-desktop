"""FastAPI 应用入口：挂载 API 路由与前端静态页面。

安全约束：
  - 仅监听 127.0.0.1，不对外网暴露；
  - 对本地项目目录只有读取操作，绝不写入/修改/删除原项目文件。
"""
import json
import logging
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import APP_NAME, APP_VERSION, DATA_DIR, STATIC_DIR, STATUS_VALUES, DB_PATH
from app.db import get_db, init_db
from app.models import RenderRequest
from app.routers import projects, scanner, settings
from app.services.render import render_markdown

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")


class _QuietAccessLog(logging.Filter):
    """过滤访问日志噪音。

    304 是 HTTP 缓存协商的正常结果（浏览器用本地缓存，加载更快），
    /static 静态资源请求对本机单用户工具也是纯噪音：这类日志一律不打印，
    控制台只保留 API 调用与页面请求，便于观察真实使用情况。
    """

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            path = record.args[2] if len(record.args or ()) >= 3 else ""
            status = record.args[4] if len(record.args or ()) >= 5 else 0
        except Exception:
            return True
        if str(path).startswith("/static"):
            return False
        if status == 304:
            return False
        return True


logging.getLogger("uvicorn.access").addFilter(_QuietAccessLog())

_DASHBOARD = STATIC_DIR / "dashboard.html"
_PROJECT_PAGE = STATIC_DIR / "project.html"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动自检：前端资源齐全才能提供服务，否则立刻报错而不是白屏。"""
    for f in (_DASHBOARD, _PROJECT_PAGE, STATIC_DIR / "js" / "vendor" / "vue.global.prod.js"):
        if not Path(f).is_file():
            raise RuntimeError(f"缺少前端资源文件：{f}")
    # 「启动自动刷新」：后台校验项目路径是否丢失（只更新标记，不重新解析）
    from app.services import settings_store
    if settings_store.get("scan.refresh_on_start"):
        import threading
        threading.Thread(target=projects.refresh_lost_marks, daemon=True).start()
    yield


app = FastAPI(title="归迹拾光", version=APP_VERSION, docs_url="/api/docs",
              lifespan=lifespan)

init_db()
app.include_router(projects.router)
app.include_router(scanner.router)
app.include_router(settings.router)


# ---------------------------------------------------------------------------
# 安全中间件：只接受本机来源的请求
# ---------------------------------------------------------------------------

# 允许携带 Origin 的来源主机（本机回环）。本应用页面自身请求不带 Origin，
# 只有跨站脚本（如恶意网页里的 fetch）才会带上外部 Origin，一律拒绝。
_ALLOWED_ORIGIN_HOSTS = {"127.0.0.1", "localhost", "::1"}


@app.middleware("http")
async def _origin_guard(request, call_next):
    origin = request.headers.get("origin")
    if origin:
        host = urlparse(origin).hostname or ""
        if host not in _ALLOWED_ORIGIN_HOSTS:
            return JSONResponse(status_code=403,
                                content={"detail": "拒绝跨站请求（本服务仅限本机访问）"})
    return await call_next(request)


# ---------------------------------------------------------------------------
# 通用接口
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health(request: Request):
    return {"ok": True, "app": APP_NAME, "version": APP_VERSION,
            "data_path": str(DB_PATH), "port": request.url.port}


@app.post("/api/show-window")
def show_window():
    """唤出桌面主窗口（仅桌面模式有效）。

    二次启动的实例通过此接口把收进托盘/静默隐藏的窗口唤出来，
    避免用户「程序在运行却找不到窗口」。浏览器模式无窗口，返回 ok=False。
    """
    w = getattr(app.state, "main_window", None)
    if w is None:
        return {"ok": False, "reason": "browser-mode"}
    try:
        w.show()
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(500, f"唤出窗口失败：{exc}")


@app.get("/api/heatmap")
def heatmap_all(weeks: int = Query(53, ge=8, le=104)):
    """全部 git 项目的按天提交聚合（首页总热力图）。

    并行收集各仓库，按天累加提交数并记录来源项目名，供悬浮提示展示。
    """
    from concurrent.futures import ThreadPoolExecutor

    from app.services import gitinfo

    with get_db() as conn:
        rows = [dict(r) for r in
                conn.execute("SELECT path, name FROM projects ORDER BY id").fetchall()]

    def collect(row: dict):
        try:
            res = gitinfo.collect_heatmap(row["path"], weeks=weeks)
        except Exception:
            res = {"is_repo": False, "days": {}}
        res["name"] = row["name"]
        return res

    days: dict = {}
    repos = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        for res in pool.map(collect, rows):
            if not res.get("is_repo"):
                continue
            repos += 1
            for day, n in (res.get("days") or {}).items():
                entry = days.setdefault(day, {"count": 0, "names": []})
                entry["count"] += n
                entry["names"].append(res["name"])
    total = sum(e["count"] for e in days.values())
    return {"days": days, "total": total, "repos": repos, "weeks": weeks,
            "project_count": len(rows)}


@app.get("/api/export")
def export_all():
    """导出全部项目档案为 JSON 备份（含自定义笔记与变更日志）。"""
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM projects ORDER BY id").fetchall()
        project_items = []
        for r in rows:
            notes = conn.execute(
                "SELECT * FROM notes WHERE project_id=? ORDER BY id",
                (r["id"],)).fetchall()
            changelogs = conn.execute(
                "SELECT * FROM changelogs WHERE project_id=? ORDER BY entry_date, id",
                (r["id"],)).fetchall()
            project_items.append({
                "id": r["id"], "path": r["path"], "name": r["name"],
                "alias": r["alias"], "category": r["category"], "status": r["status"],
                "tags": json.loads(r["tags"] or "[]"),
                "description": r["description"],
                "auto_meta": json.loads(r["auto_meta"] or "{}"),
                "is_lost": bool(r["is_lost"]), "lost_reason": r["lost_reason"],
                "pinned": bool(r["pinned"]) if "pinned" in r.keys() else False,
                "launch_note": r["launch_note"] if "launch_note" in r.keys() else "",
                "fs_created": r["fs_created"], "fs_modified": r["fs_modified"],
                "created_at": r["created_at"], "updated_at": r["updated_at"],
                "launchers": [
                    {"name": l["name"], "command": l["command"], "cwd": l["cwd"],
                     "mode": l["mode"], "sort": l["sort"], "created_at": l["created_at"],
                     "updated_at": l["updated_at"]}
                    for l in conn.execute(
                        "SELECT * FROM launchers WHERE project_id=? ORDER BY sort, id",
                        (r["id"],)).fetchall()
                ],
                "notes": [
                    {"content": n["content"], "created_at": n["created_at"],
                     "updated_at": n["updated_at"]}
                    for n in notes
                ],
                "changelogs": [
                    {"title": c["title"], "content": c["content"],
                     "entry_date": c["entry_date"], "created_at": c["created_at"],
                     "updated_at": c["updated_at"]}
                    for c in changelogs
                ],
            })
    payload = {
        "app": APP_NAME,
        "version": APP_VERSION,
        "exported_at": datetime.now().astimezone().isoformat(),
        "statuses": STATUS_VALUES,
        "projects": project_items,
    }
    return JSONResponse(
        content=payload,
        headers={"Content-Disposition": 'attachment; filename="project-archive-export.json"'},
    )


@app.post("/api/import")
def import_backup(payload: dict):
    """导入 /api/export 导出的 JSON 备份（换机迁移 / 数据恢复）。

    按路径去重：档案库中已存在的路径跳过，其余项目连同笔记、变更日志一并导入。
    """
    projects = payload.get("projects")
    if not isinstance(projects, list):
        raise HTTPException(400, "不是有效的备份文件：缺少 projects 列表（应来自本系统的导出 JSON）")

    imported, skipped, failed = 0, 0, []
    now = datetime.now().astimezone().isoformat()
    with get_db() as conn:
        existing = {r["path"].lower() for r in
                    conn.execute("SELECT path FROM projects").fetchall()}
        for item in projects:
            if not isinstance(item, dict):
                continue
            path = str(item.get("path") or "").strip()
            name = str(item.get("name") or "").strip() \
                or path.replace("/", "\\").rstrip("\\").split("\\")[-1]
            if not path:
                failed.append({"name": name, "reason": "缺少路径"})
                continue
            if path.lower() in existing:
                skipped += 1
                continue
            # 旧备份里的「归档废弃」迁移为「归档」；其余非法状态兜底"进行中"
            raw_status = item.get("status")
            if raw_status in STATUS_VALUES:
                status = raw_status
            elif raw_status == "归档废弃":
                status = "归档"
            else:
                status = "进行中"
            try:
                cur = conn.execute(
                    "INSERT INTO projects (path, name, alias, category, status, tags, "
                    "description, auto_meta, is_lost, lost_reason, pinned, launch_note, "
                    "fs_created, fs_modified, created_at, updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (path, name,
                     str(item.get("alias") or ""), str(item.get("category") or ""),
                     status,
                     json.dumps(item.get("tags") or [], ensure_ascii=False),
                     str(item.get("description") or ""),
                     json.dumps(item.get("auto_meta") or {}, ensure_ascii=False),
                     1 if item.get("is_lost") else 0,
                     str(item.get("lost_reason") or ""),
                     1 if item.get("pinned") else 0,
                     str(item.get("launch_note") or ""),
                     str(item.get("fs_created") or ""), str(item.get("fs_modified") or ""),
                     str(item.get("created_at") or now), str(item.get("updated_at") or now)),
                )
            except (TypeError, ValueError) as exc:
                failed.append({"name": name, "reason": f"字段异常：{exc}"})
                continue
            pid = cur.lastrowid
            for n in item.get("notes") or []:
                if isinstance(n, dict) and str(n.get("content") or "").strip():
                    conn.execute(
                        "INSERT INTO notes (project_id, content, created_at, updated_at) "
                        "VALUES (?,?,?,?)",
                        (pid, str(n["content"]),
                         str(n.get("created_at") or now), str(n.get("updated_at") or now)))
            for c in item.get("changelogs") or []:
                if isinstance(c, dict) and str(c.get("content") or "").strip():
                    conn.execute(
                        "INSERT INTO changelogs (project_id, title, content, entry_date, "
                        "created_at, updated_at) VALUES (?,?,?,?,?,?)",
                        (pid, str(c.get("title") or ""), c["content"],
                         str(c.get("entry_date") or ""),
                         str(c.get("created_at") or now), str(c.get("updated_at") or now)))
            # 自定义启动项随项目恢复；命令为空或非法 mode 的条目兜底处理
            for l in item.get("launchers") or []:
                if isinstance(l, dict) and str(l.get("command") or "").strip():
                    conn.execute(
                        "INSERT INTO launchers (project_id, name, command, cwd, mode, "
                        "sort, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
                        (pid, str(l.get("name") or "启动"), str(l["command"]).strip(),
                         str(l.get("cwd") or ""),
                         l.get("mode") if l.get("mode") in ("console", "open") else "console",
                         int(l.get("sort") or 0),
                         str(l.get("created_at") or now), str(l.get("updated_at") or now)))
            existing.add(path.lower())
            imported += 1
    return {"imported": imported, "skipped": skipped, "failed": failed}


@app.post("/api/render-md")
def render_md(body: RenderRequest):
    """Markdown 渲染预览（编辑器实时预览用）。"""
    return {"html": render_markdown(body.text, mode=body.mode)}


# ---------------------------------------------------------------------------
# 前端页面
# ---------------------------------------------------------------------------

@app.get("/", include_in_schema=False)
def index():
    return FileResponse(_DASHBOARD)


@app.get("/project/{project_id}", include_in_schema=False)
def project_page(project_id: int):
    return FileResponse(_PROJECT_PAGE)


# 其余静态资源（css / js / vendor）
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# 截图等用户媒体文件（位于 data/screenshots，运行时生成，不入库不入 Git）
MEDIA_DIR = DATA_DIR / "screenshots"
MEDIA_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/media", StaticFiles(directory=MEDIA_DIR), name="media")


@app.middleware("http")
async def _static_no_cache(request, call_next):
    """静态资源使用协商缓存（no-cache）。

    no-cache 表示浏览器可以缓存但每次必须向服务器校验：文件没变返回 304
    （快），文件一变立即拿到新版本（避免升级后浏览器仍用旧 JS/CSS）。
    """
    response = await call_next(request)
    if request.url.path.startswith("/static"):
        response.headers["Cache-Control"] = "no-cache"
    return response
