"""全局配置：路径、常量、状态枚举。

路径设计（桌面化改造的核心）：
  只读资源（app/static 等）与可写数据（db / 备份 / 截图 / 日志）必须彻底分离。
  打包成 exe 后代码位于只读的程序目录（onefile 模式下还会每次解压到新的临时目录），
  若把数据写在那里，档案会静默丢失；装在 Program Files 下还会因无写权限直接崩溃。
"""
import os
import socket
import sys
from pathlib import Path

# 用户在「程序与功能」里看到的名字，同时用作数据目录名
APP_TITLE = "Tracelight"


def _is_frozen() -> bool:
    """是否为 PyInstaller 冻结后的运行环境。

    冻结后 sys.frozen 存在，代码实际位于 sys._MEIPASS（onedir 为 _internal，
    onefile 为临时解压目录），此时 __file__ 不再可靠。
    """
    return getattr(sys, "frozen", False)


def _resource_dir() -> Path:
    """只读资源目录：冻结后指向包内目录，开发时指向仓库根。"""
    if _is_frozen():
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent.parent


def _data_dir() -> Path:
    """可写数据目录。

    - 开发模式：**保持原行为**，数据就在仓库的 data/ 下，改动前后完全一致；
    - 冻结模式：数据放用户目录，不随程序重装/升级而丢失；
    - 便携模式：exe 同目录放一个 portable.txt，数据就存 exe 旁边（U 盘场景）。
    """
    if not _is_frozen():
        return Path(__file__).resolve().parent.parent / "data"

    exe_dir = Path(sys.executable).parent
    if (exe_dir / "portable.txt").exists():
        return exe_dir / "data"

    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share"))
    return base / APP_TITLE


# 只读资源（随程序分发）
BASE_DIR = _resource_dir()
STATIC_DIR = BASE_DIR / "app" / "static"

# 可写数据（用户目录，重装不丢）
DATA_DIR = _data_dir()
DB_PATH = DATA_DIR / "projects.db"

# 服务默认监听地址与端口（仅本机回环地址，不对外暴露）
HOST = "127.0.0.1"
DEFAULT_PORT = 8300


def pick_port(host: str = HOST, preferred: int = DEFAULT_PORT, tries: int = 50) -> int:
    """挑一个可用端口：从 preferred 起找第一个能绑定的，全被占用则交给系统分配。

    桌面模式下端口对用户不可见，随机分配可彻底避开冲突，也不怕多开抢端口。
    """
    for port in range(preferred, preferred + tries):
        with socket.socket() as s:
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    with socket.socket() as s:        # 端口 0 = 让系统挑一个空闲的
        s.bind((host, 0))
        return s.getsockname()[1]

# 应用标识（导出 JSON 时使用）
APP_NAME = "tracelight"
APP_VERSION = "1.1.0"

# 项目状态枚举（归档=收尾留档可展示；废弃=不再维护，默认隐藏）
STATUS_VALUES = ["进行中", "已完成", "暂停", "归档", "废弃"]
STATUS_ARCHIVED = "归档"
STATUS_DISCARDED = "废弃"

# 目录树与扫描时跳过的目录名（大小写不敏感）
JUNK_DIRS = {
    "node_modules", ".git", ".svn", ".hg", "__pycache__", ".venv", "venv",
    ".idea", ".vs", ".vscode", ".tox", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", "dist", "build", "target", "out", ".next", ".nuxt",
    ".cache", "site-packages", ".eggs", "*.egg-info", ".gradle", "bin_debug",
    ".terraform", ".serverless", "coverage", ".turbo", ".parcel-cache",
}

# 批量扫描时识别项目的标记文件/目录
PROJECT_MARKERS = {
    ".git": "Git 仓库",
    ".hg": "Mercurial",
    ".svn": "SVN",
    "package.json": "Node.js",
    "pyproject.toml": "Python",
    "requirements.txt": "Python",
    "CMakeLists.txt": "CMake",
    "go.mod": "Go",
    "Cargo.toml": "Rust",
    "pom.xml": "Java Maven",
    "build.gradle": "Gradle",
}

# 扩展名 → 语言（用于按文件构成自动识别技术栈）
EXT_LANGUAGE = {
    ".py": "Python", ".ipynb": "Jupyter",
    ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
    ".ts": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
    ".vue": "Vue", ".svelte": "Svelte",
    ".jsx": "React", ".tsx": "React",
    ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin",
    ".c": "C", ".cpp": "C++", ".cc": "C++", ".cxx": "C++",
    ".hpp": "C++", ".hh": "C++",
    ".cs": "C#", ".php": "PHP", ".rb": "Ruby", ".swift": "Swift",
    ".dart": "Dart", ".lua": "Lua",
    ".sh": "Shell", ".ps1": "PowerShell", ".bat": "Batch",
    ".sql": "SQL",
}

# 依赖名 → 框架标签（前缀匹配，小写）
PY_FRAMEWORKS = {
    "fastapi": "FastAPI", "flask": "Flask", "django": "Django",
    "tornado": "Tornado", "scrapy": "Scrapy", "celery": "Celery",
    "pyqt5": "Qt", "pyqt6": "Qt", "pyside2": "Qt", "pyside6": "Qt",
    "pytest": "pytest", "selenium": "Selenium", "playwright": "Playwright",
}
NODE_FRAMEWORKS = {
    "react": "React", "vue": "Vue", "svelte": "Svelte",
    "@angular/core": "Angular", "next": "Next.js", "nuxt": "Nuxt",
    "express": "Express", "koa": "Koa", "@nestjs/core": "NestJS",
    "electron": "Electron", "tailwindcss": "Tailwind CSS",
    "antd": "Ant Design", "element-plus": "Element Plus",
    "vite": "Vite", "webpack": "Webpack", "esbuild": "esbuild",
}

# 解析与目录树的规模上限，防止超大目录拖垮服务
STATS_MAX_FILES = 20000      # 文件统计最多遍历文件数
TREE_MAX_DEPTH = 3           # 目录树最大深度
TREE_MAX_NODES = 500         # 目录树最多节点数
SCAN_MAX_DIRS = 20000        # 扫描最多访问目录数
SCAN_MAX_CANDIDATES = 300    # 扫描最多返回候选项目数
DEPS_MAX_ITEMS = 60          # 依赖清单最多记录条数

# 快速启动：直接可执行入口的扩展名（用户自备的启动方式，最权威）
LAUNCH_DIRECT_EXTS = {".bat", ".cmd", ".exe", ".ps1"}
# 快速启动：智能推断的 Python 候选入口文件（按常见度排序）
LAUNCH_ENTRY_FILES = ["main.py", "app.py", "run.py", "manage.py", "server.py",
                      "bot.py", "start.py", "wsgi.py", "asgi.py", "cli.py",
                      "__main__.py"]
# 快速启动：单次检测最多返回的入口数（防异常目录刷屏）
LAUNCH_MAX_ITEMS = 8
# 快速启动：自定义启动项每个项目的数量上限
LAUNCHERS_MAX_PER_PROJECT = 20
# 快速启动：Docker 编排/镜像文件（compose 一条命令拉起完整环境）
LAUNCH_COMPOSE_FILES = ["docker-compose.yml", "docker-compose.yaml",
                        "compose.yml", "compose.yaml"]
# 快速启动：monorepo 常见子目录名（一层子目录探测前后端分离项目）
LAUNCH_MONOREPO_DIRS = ["frontend", "client", "web", "backend", "server", "api"]
# 快速启动：命中这些关键词的可执行文件大概率是构建/测试/清理脚本而非启动脚本
LAUNCH_MAINTENANCE_HINTS = ("build", "test", "clean", "setup", "install", "deploy",
                            "uninstall", "pack", "publish", "lint", "format",
                            "release", "ci")
