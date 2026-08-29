"""全局配置：路径、常量、状态枚举。"""
from pathlib import Path

# 项目根目录（app/ 的上一级）
BASE_DIR = Path(__file__).resolve().parent.parent

# 数据目录与 SQLite 数据库文件（运行时自动创建）
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "projects.db"

# 前端静态资源目录
STATIC_DIR = BASE_DIR / "app" / "static"

# 服务默认监听地址与端口（仅本机回环地址，不对外暴露）
HOST = "127.0.0.1"
DEFAULT_PORT = 8300

# 应用标识（导出 JSON 时使用）
APP_NAME = "local-project-archive"
APP_VERSION = "1.0.0"

# 项目状态枚举
STATUS_VALUES = ["进行中", "已完成", "暂停", "归档废弃"]
STATUS_ARCHIVED = "归档废弃"

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

# 解析与目录树的规模上限，防止超大目录拖垮服务
STATS_MAX_FILES = 20000      # 文件统计最多遍历文件数
TREE_MAX_DEPTH = 3           # 目录树最大深度
TREE_MAX_NODES = 500         # 目录树最多节点数
SCAN_MAX_DIRS = 20000        # 扫描最多访问目录数
SCAN_MAX_CANDIDATES = 300    # 扫描最多返回候选项目数
DEPS_MAX_ITEMS = 60          # 依赖清单最多记录条数
