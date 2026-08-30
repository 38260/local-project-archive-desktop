"""FastAPI 应用入口：挂载 API 路由与前端静态页面。

安全约束：
  - 仅监听 127.0.0.1，不对外网暴露；
  - 对本地项目目录只有读取操作，绝不写入/修改/删除原项目文件。
"""
import logging
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import APP_NAME, APP_VERSION, DATA_DIR, STATIC_DIR, STATUS_VALUES
from app.db import init_db
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
    yield


app = FastAPI(title="本地项目档案", version=APP_VERSION, docs_url="/api/docs",
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
def health():
    from app.config import DB_PATH
    return {"ok": True, "app": APP_NAME, "version": APP_VERSION,
            "data_path": str(DB_PATH)}


@app.get("/api/export")
def export_all():
    """导出全部项目档案为 JSON 备份（含自定义笔记与变更日志）。"""
    import json

    from app.db import get_db
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
                "fs_created": r["fs_created"], "fs_modified": r["fs_modified"],
                "created_at": r["created_at"], "updated_at": r["updated_at"],
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
