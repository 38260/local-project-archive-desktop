"""FastAPI 应用入口：挂载 API 路由与前端静态页面。

安全约束：
  - 仅监听 127.0.0.1，不对外网暴露；
  - 对本地项目目录只有读取操作，绝不写入/修改/删除原项目文件。
"""
import json
import logging
import webbrowser
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import (APP_AUTHOR, APP_NAME, APP_VERSION, DATA_DIR,
                        STATIC_DIR, STATUS_VALUES, DB_PATH)
from app.db import get_db, init_db
from app.models import OpenUrlRequest, RenderRequest
from app.routers import projects, refresh as refresh_api, scanner, settings
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
    # 退出收尾：终止仍在运行的「捕获运行」进程。这些进程的输出管道随本进程
    # 关闭而失效，留下它们会变成看不见的孤儿进程（占端口且无法再停止）。
    try:
        from app.services import runlog
        runlog.shutdown()
    except Exception as exc:
        logging.getLogger(__name__).warning("收尾捕获进程失败：%s", exc)


app = FastAPI(title="归迹 · tracelight", version=APP_VERSION, docs_url="/api/docs",
              lifespan=lifespan)

init_db()
app.include_router(projects.router)
app.include_router(scanner.router)
app.include_router(settings.router)
app.include_router(refresh_api.router)


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
            "author": APP_AUTHOR,
            "data_path": str(DB_PATH), "port": request.url.port}


@app.post("/api/show-window")
def show_window():
    """唤出桌面主窗口（仅桌面模式有效）。

    二次启动的实例（桌面快捷方式 / 任务栏图标 / 开始菜单）通过此接口把收进
    托盘或最小化的窗口唤出来，避免用户「程序在运行却找不到窗口」。
    浏览器模式无窗口，返回 ok=False。

    唤起逻辑统一走 window_focus.bring_to_front：只调 window.show() 无法把
    最小化的窗口还原出来，见该模块说明。
    """
    w = getattr(app.state, "main_window", None)
    if w is None:
        return {"ok": False, "reason": "browser-mode"}
    try:
        from app.services.window_focus import bring_to_front
        return {"ok": bool(bring_to_front(w))}
    except Exception as exc:
        raise HTTPException(500, f"唤出窗口失败：{exc}")


def _personal_activity(weeks: int = 53, day: str | None = None,
                       window_days: int | None = None,
                       local_dates: bool = False):
    """首页各贡献入口共用身份快照与轻量提交源，保证去重口径相同。"""
    from concurrent.futures import ThreadPoolExecutor

    from app.services import gitinfo, settings_store

    with get_db() as conn:
        rows = [dict(r) for r in
                conn.execute("SELECT id, path, name FROM projects ORDER BY id").fetchall()]
    emails = settings_store.git_author_emails()
    if not emails:
        return rows, [], True

    def collect(row: dict):
        try:
            res = gitinfo.collect_heatmap(
                row["path"], weeks=weeks, author_emails=emails,
                include_commits=True, day=day,
                window_days=window_days, local_dates=local_dates)
        except Exception:
            res = {"is_repo": False, "commits": [], "error": "仓库读取失败"}
        res["project"] = {"id": row["id"], "name": row["name"]}
        return res

    with ThreadPoolExecutor(max_workers=8) as pool:
        return rows, list(pool.map(collect, rows)), False


@app.get("/api/heatmap")
def heatmap_all(weeks: int = Query(53, ge=8, le=104)):
    """本人提交按天聚合，同一完整哈希跨仓库只计一次。"""
    rows, results, identity_required = _personal_activity(weeks=weeks)
    days: dict = {}
    seen = set()
    for res in results:
        for commit in res.get("commits", []):
            day = commit["date"][:10]
            entry = days.setdefault(day, {"count": 0, "names": []})
            if res["project"]["name"] not in entry["names"]:
                entry["names"].append(res["project"]["name"])
            if commit["hash"] not in seen:
                seen.add(commit["hash"])
                entry["count"] += 1
    total = sum(e["count"] for e in days.values())
    return {"days": days, "total": total,
            "repos": sum(bool(r.get("is_repo")) for r in results), "weeks": weeks,
            "project_count": len(rows), "authors": "mine", "identity_required": identity_required,
            "failed_repos": sum(bool(r.get("error")) for r in results)}


@app.get("/api/day-commits")
def day_commits(date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
                tz: str = Query("commit", pattern=r"^(commit|local)$")):
    """本人当日明细按完整哈希去重，每条提交保留全部关联项目。

    tz=commit 保留原有“提交自带时区”口径；本周拾光传 tz=local，
    与面板的本地日历日分桶保持一致。
    """
    from datetime import date as calendar_date
    try:
        calendar_date.fromisoformat(date)
    except ValueError as exc:
        raise HTTPException(422, "日期不合法") from exc
    _, results, identity_required = _personal_activity(
        day=date, local_dates=(tz == "local"))
    unique = {}
    groups = {}
    for res in results:
        project = res["project"]
        for commit in res.get("commits", []):
            key = commit["hash"]
            if key in unique:
                unique[key]["projects"].append(project)
                continue
            commit["projects"] = [project]
            unique[key] = commit
            group = groups.setdefault(project["id"], {**project, "commits": [], "count": 0})
            group["commits"].append(commit)
            group["count"] += 1
    return {"date": date, "total": len(unique), "projects": list(groups.values()),
            "project_count": len({p["id"] for c in unique.values() for p in c["projects"]}),
            "authors": "mine", "identity_required": identity_required,
            "failed_repos": sum(bool(r.get("error")) for r in results)}


@app.get("/api/weekly")
def weekly_all():
    """首页「本周拾光」：近 7 个本地日历日的本人贡献。

    窗口包含今天及之前 6 天（不是自然周）。同一完整哈希跨仓库只计一次，
    按项目 ID 首次归属；明细继续保留每条提交的全部关联项目。
    """
    from app.services import weekly as weekly_service

    start, end, _ = weekly_service.week_window()
    rows, results, identity_required = _personal_activity(
        window_days=weekly_service.WEEK_DAYS, local_dates=True)
    data = weekly_service.aggregate(results, start, end)
    path_by_id = {row["id"]: row["path"] for row in rows}
    data.update({
        "repos": sum(bool(r.get("is_repo")) for r in results),
        "failed_repos": sum(bool(r.get("error")) for r in results),
        "scan_errors": [
            {"project": r["project"]["name"],
             "path": path_by_id.get(r["project"]["id"], ""),
             "reason": r.get("error")}
            for r in results if r.get("error")
        ],
        "project_count_all": len(rows),
        "authors": "mine",
        "identity_required": identity_required,
    })
    return data


def _clean_last_opened(value) -> str:
    """导入备份里的上次打开时间：只接受带时区的合法 ISO 时间。

    旧备份没有该字段、值损坏或缺少时区时一律留空，不猜测、不伪造历史访问。
    """
    if not isinstance(value, str) or not value.strip():
        return ""
    try:
        dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return ""
    if dt.tzinfo is None:
        return ""
    return dt.astimezone().isoformat()


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
                "launch_prefs": json.loads(r["launch_prefs"] or "{}")
                if "launch_prefs" in r.keys() else {},
                "flowchart_prefs": json.loads(r["flowchart_prefs"] or "{}")
                if "flowchart_prefs" in r.keys() else {},
                "fs_created": r["fs_created"], "fs_modified": r["fs_modified"],
                "last_opened_at": r["last_opened_at"]
                if "last_opened_at" in r.keys() else "",
                "created_at": r["created_at"], "updated_at": r["updated_at"],
                "launchers": [
                    {"id": l["id"], "name": l["name"], "command": l["command"], "cwd": l["cwd"],
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
        "author": APP_AUTHOR,
        "exported_at": datetime.now().astimezone().isoformat(),
        "statuses": STATUS_VALUES,
        "projects": project_items,
    }
    return JSONResponse(
        content=payload,
        headers={"Content-Disposition": 'attachment; filename="tracelight-backup.json"'},
    )


@app.post("/api/import")
def import_backup(payload: dict):
    """导入 /api/export 导出的 JSON 备份（换机迁移 / 数据恢复）。

    按路径去重：档案库中已存在的路径跳过，其余项目连同笔记、变更日志一并导入。
    """
    items = payload.get("projects")
    if not isinstance(items, list):
        raise HTTPException(400, "不是有效的备份文件：缺少 projects 列表（应来自本系统的导出 JSON）")

    imported, skipped, failed, warnings = 0, 0, [], []
    now = datetime.now().astimezone().isoformat()
    with get_db() as conn:
        existing = {r["path"].lower() for r in
                    conn.execute("SELECT path FROM projects").fetchall()}
        for item in items:
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
            # 启动面板偏好（入口顺序 / 顶部默认项）：只认对象，其余一律空偏好
            raw_prefs = item.get("launch_prefs")
            launch_prefs = json.dumps(raw_prefs if isinstance(raw_prefs, dict) else {},
                                      ensure_ascii=False)
            # 流程图选择记录（自动候选 / 上传覆盖）：同口径，只认对象
            raw_flow = item.get("flowchart_prefs")
            flowchart_prefs = json.dumps(raw_flow if isinstance(raw_flow, dict) else {},
                                         ensure_ascii=False)
            source_id = item.get("id")
            if not isinstance(source_id, int) or isinstance(source_id, bool) or source_id <= 0:
                source_id = None
            source_launchers = (conn.execute("SELECT * FROM launchers WHERE project_id=?",
                                            (source_id,)).fetchall() if source_id else [])
            try:
                cur = conn.execute(
                    "INSERT INTO projects (path, name, alias, category, status, tags, "
                    "description, auto_meta, is_lost, lost_reason, pinned, launch_note, "
                    "launch_prefs, flowchart_prefs, fs_created, fs_modified, "
                    "last_opened_at, created_at, updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
                     launch_prefs,
                     flowchart_prefs,
                     str(item.get("fs_created") or ""), str(item.get("fs_modified") or ""),
                     _clean_last_opened(item.get("last_opened_at")),
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
            launcher_keys = {}
            for l in item.get("launchers") or []:
                if isinstance(l, dict) and str(l.get("command") or "").strip():
                    launcher = conn.execute(
                        "INSERT INTO launchers (project_id, name, command, cwd, mode, "
                        "sort, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
                        (pid, str(l.get("name") or "启动"), str(l["command"]).strip(),
                         str(l.get("cwd") or ""),
                         l.get("mode") if l.get("mode") in ("console", "open") else "console",
                         int(l.get("sort") or 0),
                         str(l.get("created_at") or now), str(l.get("updated_at") or now)))
                    old_id = l.get("id")
                    if old_id is None:
                        matches = [old for old in source_launchers if
                            all(str(old[field]) == str(l.get(field) or default)
                                for field, default in (("name", "启动"), ("command", ""),
                                                       ("cwd", ""), ("mode", "console")))]
                        if len(matches) == 1:
                            old_id = matches[0]["id"]
                    if isinstance(old_id, int) and not isinstance(old_id, bool):
                        launcher_keys[f"l:{old_id}"] = f"l:{launcher.lastrowid}"
            prefs = projects._parse_launch_prefs(launch_prefs)
            old_keys = prefs["order"] + ([prefs["primary"]] if prefs["primary"] else [])
            if any(key.startswith("l:") and key not in launcher_keys for key in old_keys):
                warnings.append({"name": name, "reason":
                    "部分启动偏好缺少可映射 ID，入口已保留，请重新选择默认项与排序"})
            prefs["order"] = [launcher_keys.get(key, key) for key in prefs["order"]
                              if not key.startswith("l:") or key in launcher_keys]
            if prefs["primary"] and prefs["primary"].startswith("l:"):
                prefs["primary"] = launcher_keys.get(prefs["primary"])
            flow_prefs = projects._parse_flowchart_prefs(flowchart_prefs)
            if source_id is not None:
                media = projects._copy_flowchart_files(source_id, pid)
                choice = flow_prefs["choice"]
                if choice and choice.get("kind") == "custom":
                    old_file = str(choice.get("file") or "")
                    if old_file in media:
                        choice["file"] = media[old_file]
            if (flow_prefs["choice"] and flow_prefs["choice"].get("kind") == "custom"
                    and projects._flowchart_current(pid, flow_prefs, []) is None):
                warnings.append({"name": name, "reason":
                    "上传流程图文件未找到，跨机恢复需同时迁移媒体目录"})
            conn.execute("UPDATE projects SET launch_prefs=?, flowchart_prefs=? WHERE id=?",
                         (json.dumps(prefs, ensure_ascii=False),
                          json.dumps(flow_prefs, ensure_ascii=False), pid))
            existing.add(path.lower())
            imported += 1
    return {"imported": imported, "skipped": skipped, "failed": failed, "warnings": warnings}


@app.post("/api/render-md")
def render_md(body: RenderRequest):
    """Markdown 渲染预览（编辑器实时预览用）。"""
    return {"html": render_markdown(body.text, mode=body.mode)}


@app.post("/api/open-url")
def open_url(body: OpenUrlRequest):
    """把外部链接交给系统默认浏览器打开（仅 http/https）。

    用途：README / 笔记里出现的 https 链接点击后，在 pywebview(WebView2) 中若直接
    导航会把整个 SPA 带走（白屏且无返回入口），这里改为系统浏览器打开，窗口不受影响。
    """
    try:
        webbrowser.open(body.url, new=2)
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(500, f"打开外部浏览器失败：{exc}")


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

# 用户媒体文件（位于 data 下，运行时生成，不入库不入 Git）。
# 流程图挂载必须写在 /media 之前：Starlette 按注册顺序匹配，
# /media 会把 /media/flowcharts/... 的前缀吃掉导致 404。
FLOWCHART_MEDIA_DIR = DATA_DIR / "flowcharts"
FLOWCHART_MEDIA_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/media/flowcharts", StaticFiles(directory=FLOWCHART_MEDIA_DIR),
          name="media-flowcharts")

# 截图等用户媒体文件（位于 data/screenshots）
MEDIA_DIR = DATA_DIR / "screenshots"
MEDIA_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/media", StaticFiles(directory=MEDIA_DIR), name="media")


@app.middleware("http")
async def _static_no_cache(request, call_next):
    """静态资源协商缓存与 SVG 文档隔离。

    no-cache 表示浏览器可以缓存但每次必须向服务器校验：文件没变返回 304
    （快），文件一变立即拿到新版本（避免升级后浏览器仍用旧 JS/CSS）。

    页面外壳（/ 与 /project/N）一并纳入：前端资源与页面结构是配套的，
    浏览器若拿旧 HTML 配新 JS，会缺少新加的挂载点（如标签栏的 #tabbar-root），
    表现为界面残缺；这类问题排查成本高，不如每次都校验一次。
    """
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/static") or path == "/" or path.startswith("/project/"):
        response.headers["Cache-Control"] = "no-cache"
    # SVG 在新标签页中会作为文档运行，不能只依赖 <img> 的脚本限制。
    if (response.headers.get("content-type", "").startswith("image/svg+xml")
            or (path.startswith("/media/") and path.lower().endswith(".svg"))):
        response.headers["Content-Security-Policy"] = (
            "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'")
        response.headers["X-Content-Type-Options"] = "nosniff"
    return response
