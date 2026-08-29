"""磁盘解析服务：只读取、统计项目信息，严禁写入或修改原项目任何文件。

包含：文件系统时间、git 信息、构建配置解析（package.json / pyproject.toml /
requirements.txt / CMakeLists.txt / go.mod / Cargo.toml）、README 定位与渲染、
文件规模统计、目录树构建。
"""
import json
import logging
import os
import re
import stat
import tomllib
from datetime import datetime
from pathlib import Path

from app.config import (
    DEPS_MAX_ITEMS, JUNK_DIRS, STATS_MAX_FILES, TREE_MAX_DEPTH, TREE_MAX_NODES,
)
from app.services import gitinfo
from app.services.render import render_markdown

logger = logging.getLogger(__name__)


def is_junk_dir(name: str) -> bool:
    """目录名是否属于解析/遍历时跳过的构建产物或依赖目录。"""
    if name.lower() in JUNK_DIRS:
        return True
    return name.lower().endswith(".egg-info")


def _to_iso(ts: float) -> str:
    return datetime.fromtimestamp(ts).astimezone().isoformat()


# ---------------------------------------------------------------------------
# 构建配置解析
# ---------------------------------------------------------------------------

def _load_json(path: Path):
    try:
        with open(path, encoding="utf-8-sig") as f:
            return json.load(f)
    except Exception as exc:
        logger.debug("JSON 解析失败 %s: %s", path, exc)
        return None


def _load_toml(path: Path):
    try:
        with open(path, "rb") as f:
            return tomllib.load(f)
    except Exception as exc:
        logger.debug("TOML 解析失败 %s: %s", path, exc)
        return None


def _parse_package_json(path: Path) -> dict | None:
    data = _load_json(path)
    if data is None:
        return None
    deps = list((data.get("dependencies") or {}).keys())
    dev_deps = list((data.get("devDependencies") or {}).keys())
    return {
        "file": "package.json",
        "kind": "Node.js",
        "name": data.get("name"),
        "version": data.get("version"),
        "package_manager": data.get("packageManager"),
        "scripts": dict(list((data.get("scripts") or {}).items())[:20]),
        "dependencies": deps[:DEPS_MAX_ITEMS],
        "dependencies_total": len(deps),
        "dev_dependencies": dev_deps[:DEPS_MAX_ITEMS],
        "dev_dependencies_total": len(dev_deps),
    }


def _parse_pyproject(path: Path) -> dict | None:
    data = _load_toml(path)
    if data is None:
        return None
    project = data.get("project") or {}
    poetry = (data.get("tool") or {}).get("poetry") or {}
    deps = list(project.get("dependencies") or {})
    deps += [k for k in poetry.get("dependencies") or {} if k != "python"]
    scripts = list((project.get("scripts") or {}).keys())
    scripts += list((poetry.get("scripts") or {}).keys())
    return {
        "file": "pyproject.toml",
        "kind": "Python",
        "name": project.get("name") or poetry.get("name"),
        "version": str(project.get("version") or poetry.get("version") or ""),
        "requires_python": project.get("requires-python") or poetry.get("python") or None,
        "dependencies": deps[:DEPS_MAX_ITEMS],
        "dependencies_total": len(deps),
        "scripts": scripts[:20],
    }


_REQ_LINE_RE = re.compile(r"^\s*([A-Za-z0-9_][A-Za-z0-9._-]*)\s*(==|>=|<=|~=|!=|>|<)?\s*([^;#\s]*)")


def _parse_requirements(path: Path) -> dict | None:
    deps, total = [], 0
    try:
        with open(path, encoding="utf-8-sig", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith(("#", "-r", "-e", "-c", "--")):
                    continue
                total += 1
                m = _REQ_LINE_RE.match(line)
                if m:
                    name, op, ver = m.groups()
                    deps.append(name + ((op or "") + ver if ver else ""))
                if len(deps) >= DEPS_MAX_ITEMS:
                    break
    except OSError as exc:
        logger.debug("requirements.txt 读取失败: %s", exc)
        return None
    return {
        "file": "requirements.txt",
        "kind": "Python",
        "dependencies": deps,
        "dependencies_total": total,
    }


_CMAKE_PROJECT_RE = re.compile(r"project\s*\(\s*([A-Za-z0-9_.-]+)", re.I)


def _parse_cmake(path: Path) -> dict | None:
    try:
        text = path.read_text(encoding="utf-8-sig", errors="replace")[:20000]
    except OSError:
        return None
    m = _CMAKE_PROJECT_RE.search(text)
    if not m:
        return None
    vm = re.search(r"VERSION\s+([0-9][0-9a-zA-Z._-]*)", text, re.I)
    return {
        "file": "CMakeLists.txt",
        "kind": "CMake",
        "name": m.group(1),
        "version": vm.group(1) if vm else None,
    }


def _parse_go_mod(path: Path) -> dict | None:
    try:
        text = path.read_text(encoding="utf-8-sig", errors="replace")[:10000]
    except OSError:
        return None
    m = re.search(r"^module\s+(\S+)", text, re.M)
    if not m:
        return None
    return {"file": "go.mod", "kind": "Go", "name": m.group(1)}


def _parse_cargo(path: Path) -> dict | None:
    data = _load_toml(path)
    if data is None:
        return None
    pkg = data.get("package") or {}
    deps = list((data.get("dependencies") or {}).keys())
    return {
        "file": "Cargo.toml",
        "kind": "Rust",
        "name": pkg.get("name"),
        "version": pkg.get("version"),
        "dependencies": deps[:DEPS_MAX_ITEMS],
        "dependencies_total": len(deps),
    }


_CONFIG_PARSERS = {
    "package.json": _parse_package_json,
    "pyproject.toml": _parse_pyproject,
    "requirements.txt": _parse_requirements,
    "CMakeLists.txt": _parse_cmake,
    "go.mod": _parse_go_mod,
    "Cargo.toml": _parse_cargo,
}


def collect_configs(path: str) -> list[dict]:
    """解析项目根目录下的构建配置文件，返回识别到的配置摘要列表。"""
    configs = []
    root = Path(path)
    for filename, parser in _CONFIG_PARSERS.items():
        f = root / filename
        if f.is_file():
            parsed = parser(f)
            if parsed:
                configs.append(parsed)
    return configs


def detect_tech_tags(configs: list[dict], root: str) -> list[str]:
    """根据配置文件与根目录特征推断技术栈标签（可被用户修改）。"""
    tags = []
    for c in configs:
        kind = c.get("kind")
        if kind == "Node.js":
            tags.append("Node.js")
        elif kind and kind not in tags:
            tags.append(kind if kind != "CMake" else "C/C++")
    # 前端框架细判：仅作提示，不覆盖用户输入
    for c in configs:
        deps = set(c.get("dependencies") or []) | set(c.get("dev_dependencies") or [])
        for fw, name in (("vue", "Vue"), ("react", "React"), ("svelte", "Svelte"),
                         ("next", "Next.js"), ("nuxt", "Nuxt")):
            if any(d.lower().startswith(fw) for d in deps) and name not in tags:
                tags.append(name)
    root_dir = Path(root)
    if (root_dir / "Dockerfile").is_file() and "Docker" not in tags:
        tags.append("Docker")
    return tags[:8]


# ---------------------------------------------------------------------------
# README 定位与渲染
# ---------------------------------------------------------------------------

_README_CANDIDATES = ["README.md", "readme.md", "Readme.md", "README.markdown",
                      "readme.markdown", "README.en.md", "README.zh-CN.md", "README_EN.md"]


def find_readme(path: str) -> str | None:
    """定位项目根目录 README.md（大小写常见变体）。"""
    root = Path(path)
    for name in _README_CANDIDATES:
        f = root / name
        if f.is_file():
            return str(f)
    # 兜底：不区分大小写再找一次 *.md 中以 readme 开头的文件
    try:
        for entry in os.scandir(path):
            if entry.is_file() and entry.name.lower().startswith("readme") \
                    and entry.name.lower().endswith((".md", ".markdown")):
                return entry.path
    except OSError:
        pass
    return None


def render_readme_file(readme_path: str) -> dict:
    """读取并渲染 README 文件。"""
    try:
        with open(readme_path, encoding="utf-8-sig", errors="replace") as f:
            text = f.read(512 * 1024)  # 最大 512KB，避免异常超大文件
        return {"file": os.path.basename(readme_path), "exists": True,
                "html": render_markdown(text, mode="readme")}
    except OSError as exc:
        return {"file": os.path.basename(readme_path), "exists": False,
                "error": f"README 读取失败：{exc}", "html": ""}


# ---------------------------------------------------------------------------
# 文件统计与目录树
# ---------------------------------------------------------------------------

def collect_stats(path: str) -> dict:
    """粗略统计文件数量、总大小与扩展名分布（有上限，防超大项目）。"""
    file_count = dir_count = 0
    total_size = 0
    ext_counter: dict[str, int] = {}
    truncated = False
    stack = [path]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if is_junk_dir(entry.name):
                                continue
                            dir_count += 1
                            stack.append(entry.path)
                        elif entry.is_file(follow_symlinks=False):
                            file_count += 1
                            total_size += entry.stat(follow_symlinks=False).st_size
                            ext = os.path.splitext(entry.name)[1].lower()
                            ext_counter[ext] = ext_counter.get(ext, 0) + 1
                    except OSError:
                        continue  # 单个条目无权限等异常直接跳过
                    if file_count >= STATS_MAX_FILES:
                        truncated = True
                        stack.clear()
                        break
        except OSError as exc:
            logger.debug("目录不可访问 %s: %s", current, exc)
            continue
    top_exts = sorted(ext_counter.items(), key=lambda kv: -kv[1])[:8]
    return {
        "file_count": file_count,
        "dir_count": dir_count,
        "total_size": total_size,
        "top_extensions": [[ext or "(无后缀)", n] for ext, n in top_exts],
        "truncated": truncated,
    }


def build_tree(path: str, max_depth: int = TREE_MAX_DEPTH,
               max_nodes: int = TREE_MAX_NODES) -> dict:
    """构建只读目录树（深度与节点数受限，跳过依赖/构建目录）。"""
    counter = {"nodes": 0}
    truncated = {"flag": False}

    def walk(dir_path: str, depth: int) -> dict:
        node = {"name": os.path.basename(dir_path) or dir_path,
                "type": "dir", "children": []}
        if depth >= max_depth or counter["nodes"] >= max_nodes:
            truncated["flag"] = truncated["flag"] or depth >= max_depth
            return node
        dirs, files = [], []
        try:
            with os.scandir(dir_path) as it:
                for entry in it:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if not is_junk_dir(entry.name):
                                dirs.append(entry.name)
                        elif entry.is_file(follow_symlinks=False):
                            files.append((entry.name, entry.stat(follow_symlinks=False).st_size))
                    except OSError:
                        continue
        except OSError as exc:
            node["error"] = f"无法读取：{exc.strerror or exc}"
            return node
        for name in sorted(dirs, key=str.lower):
            if counter["nodes"] >= max_nodes:
                truncated["flag"] = True
                break
            counter["nodes"] += 1
            node["children"].append(walk(os.path.join(dir_path, name), depth + 1))
        for name, size in sorted(files, key=lambda kv: kv[0].lower()):
            if counter["nodes"] >= max_nodes:
                truncated["flag"] = True
                break
            counter["nodes"] += 1
            node["children"].append({"name": name, "type": "file", "size": size})
        return node

    return walk(path, 0) | {"truncated": truncated["flag"]}


# ---------------------------------------------------------------------------
# 汇总解析入口
# ---------------------------------------------------------------------------

def parse_project(path: str) -> dict:
    """完整解析一个项目目录，返回 auto_meta 与文件系统时间。

    全程只读；任何子步骤失败都不影响整体，只记录 error 信息。
    """
    st = os.stat(path)
    configs = collect_configs(path)
    meta = {
        "git": gitinfo.collect_git_info(path),
        "configs": configs,
        "stats": collect_stats(path),
        "tech_tags": detect_tech_tags(configs, path),
        "readme_file": os.path.basename(find_readme(path) or "") or None,
        "parsed_at": _to_iso(st.st_mtime),
    }
    return {
        "auto_meta": meta,
        "fs_created": _to_iso(st.st_ctime),
        "fs_modified": _to_iso(st.st_mtime),
    }


def summarize_stack(auto_meta: dict) -> str:
    """从 auto_meta 提炼一行技术栈摘要，供卡片列表展示。"""
    if not auto_meta:
        return ""
    kinds = []
    for c in auto_meta.get("configs", []):
        kind = c.get("kind")
        if kind and kind not in kinds:
            kinds.append(kind)
    if auto_meta.get("git", {}).get("is_repo"):
        kinds.append("Git")
    return " · ".join(kinds)
