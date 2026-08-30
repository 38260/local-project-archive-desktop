"""磁盘解析服务：只读取、统计项目信息，严禁写入或修改原项目任何文件。

包含：文件系统时间、git 信息、构建配置解析（package.json / pyproject.toml /
requirements.txt / CMakeLists.txt / go.mod / Cargo.toml）、README 定位与渲染、
文件规模统计、目录树构建。
"""
import json
import logging
import os
import re
import tomllib
from configparser import ConfigParser
from datetime import datetime
from pathlib import Path

from app.config import (
    DEPS_MAX_ITEMS, EXT_LANGUAGE, JUNK_DIRS, NODE_FRAMEWORKS,
    PY_FRAMEWORKS, STATS_MAX_FILES, TREE_MAX_DEPTH, TREE_MAX_NODES,
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
    # 保留版本约束（name@spec），前端据此统计 固定/范围/未标注
    deps = [f"{k}@{v}" for k, v in (data.get("dependencies") or {}).items()]
    dev_deps = [f"{k}@{v}" for k, v in (data.get("devDependencies") or {}).items()]
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


def _parse_setup_cfg(path: Path) -> dict | None:
    """解析 setup.cfg（INI 格式的 Python 打包配置）。"""
    try:
        cp = ConfigParser()
        cp.read(path, encoding="utf-8-sig")
        meta = cp["metadata"] if cp.has_section("metadata") else {}
        return {
            "file": "setup.cfg",
            "kind": "Python",
            "name": meta.get("name"),
            "version": meta.get("version"),
        }
    except Exception as exc:
        logger.debug("setup.cfg 解析失败 %s: %s", path, exc)
        return None


def _parse_pipfile(path: Path) -> dict | None:
    data = _load_toml(path)
    if data is None:
        return None
    deps = list((data.get("packages") or {}).keys())
    return {
        "file": "Pipfile",
        "kind": "Python",
        "dependencies": deps[:DEPS_MAX_ITEMS],
        "dependencies_total": len(deps),
    }


def _parse_environment_yml(path: Path) -> dict | None:
    """Conda 环境文件：仅提取环境名（不引入 yaml 依赖）。"""
    try:
        text = path.read_text(encoding="utf-8-sig", errors="replace")[:4000]
    except OSError:
        return None
    m = re.search(r"^name\s*:\s*(\S+)", text, re.M)
    return {"file": "environment.yml", "kind": "Conda", "name": m.group(1) if m else None}


_CONFIG_PARSERS = {
    "package.json": _parse_package_json,
    "pyproject.toml": _parse_pyproject,
    "requirements.txt": _parse_requirements,
    "CMakeLists.txt": _parse_cmake,
    "go.mod": _parse_go_mod,
    "Cargo.toml": _parse_cargo,
    "setup.cfg": _parse_setup_cfg,
    "Pipfile": _parse_pipfile,
    "environment.yml": _parse_environment_yml,
}

# 额外的"存在即识别"文件：标签提示 + 配置占位
_PRESENCE_CONFIGS = {
    "setup.py": {"kind": "Python", "note": "setuptools 打包"},
    "Dockerfile": {"kind": "Docker", "note": None},
    "docker-compose.yml": {"kind": "Docker", "note": "compose"},
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
    # requirements 的常见变体（requirements-dev.txt 等），最多再收 2 个
    try:
        variants = [p.name for p in root.glob("requirements*.txt")
                    if p.name != "requirements.txt"][:2]
        for name in variants:
            parsed = _parse_requirements(root / name)
            if parsed:
                parsed["file"] = name
                configs.append(parsed)
    except OSError:
        pass
    for filename, info in _PRESENCE_CONFIGS.items():
        if (root / filename).is_file():
            configs.append({"file": filename, "kind": info["kind"],
                            "name": None, "note": info["note"]})
    return configs


def _languages_from_stats(stats: dict) -> list[str]:
    """按文件数量从扩展名分布推断主要语言（过滤低占比噪音）。

    小项目文件很少时，回退取首个可识别的扩展名语言，保证仍有产出。
    """
    counter: dict[str, int] = {}
    fallback = None
    for ext, count in stats.get("top_extensions", []):
        lang = EXT_LANGUAGE.get(ext)
        if not lang:
            continue
        if fallback is None:
            fallback = lang
        if count >= 2:
            counter[lang] = counter.get(lang, 0) + count
    ranked = sorted(counter.items(), key=lambda kv: -kv[1])
    langs = [lang for lang, _ in ranked[:3]]
    if not langs and fallback:
        langs = [fallback]
    return langs


def _frameworks_from_deps(configs: list[dict]) -> list[str]:
    """从依赖清单中识别已知框架（Python / Node 各一套映射）。"""
    found = []
    for c in configs:
        deps = list(c.get("dependencies") or []) + list(c.get("dev_dependencies") or [])
        if c.get("file") == "package.json":
            table = NODE_FRAMEWORKS
        elif c.get("file") in ("requirements.txt", "pyproject.toml",
                               "Pipfile", "setup.cfg") or \
                str(c.get("file", "")).startswith("requirements"):
            table = PY_FRAMEWORKS
        else:
            continue
        for dep in deps:
            low = dep.lower()
            for prefix, label in table.items():
                if low.startswith(prefix) and label not in found:
                    found.append(label)
    return found[:6]


def detect_tech_tags(configs: list[dict], root: str, stats: dict | None = None) -> list[str]:
    """综合配置文件、依赖清单与文件构成，推断技术栈标签（可被用户修改）。"""
    tags: list[str] = []
    for c in configs:
        kind = c.get("kind")
        if kind == "Node.js":
            tags.append("Node.js")
        elif kind and kind not in tags:
            tags.append(kind if kind != "CMake" else "C/C++")
    # 文件构成 → 语言（这是无 requirements/monorepo 子包项目的主要识别手段）
    if stats:
        for lang in _languages_from_stats(stats):
            if lang not in tags:
                tags.append(lang)
    # 依赖 → 框架
    for fw in _frameworks_from_deps(configs):
        if fw not in tags:
            tags.append(fw)
    root_dir = Path(root)
    if (root_dir / "Dockerfile").is_file() and "Docker" not in tags:
        tags.append("Docker")
    return tags[:10]


_BADGE_LINE_RE = re.compile(r"^\s*(\[\!?|\[!\[|<img|<div|<p align|<!--|#)")
_MD_MARKS_RE = re.compile(r"`{1,3}([^`]*)`{1,3}|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]*)\]\([^)]*\)")


def extract_readme_intro(readme_path: str, max_len: int = 120) -> str | None:
    """提取 README 开头的简介纯文本（跳过标题行、徽章、图片、HTML 块）。"""
    try:
        with open(readme_path, encoding="utf-8-sig", errors="replace") as f:
            text = f.read(64 * 1024)
    except OSError:
        return None
    paragraph: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            if paragraph:
                break  # 段落结束
            continue
        if stripped.startswith(("#", "!", "<", "[!", "|", "```", "---", "===")) \
                or _BADGE_LINE_RE.match(stripped):
            continue
        if stripped.startswith(("- ", "* ", "+ ", "1. ")):
            break  # 列表：简介通常在列表之前结束
        paragraph.append(stripped)
    if not paragraph:
        return None
    intro = " ".join(paragraph)
    intro = _MD_MARKS_RE.sub(lambda m: next(g for g in m.groups() if g is not None), intro)
    intro = re.sub(r"\s+", " ", intro).strip()
    if len(intro) > max_len:
        intro = intro[:max_len].rstrip() + "…"
    return intro or None


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
                "html": render_markdown(text, mode="readme"), "raw": text}
    except OSError as exc:
        return {"file": os.path.basename(readme_path), "exists": False,
                "error": f"README 读取失败：{exc}", "html": "", "raw": ""}


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
    """构建只读目录树（深度与节点数受限，跳过依赖/构建目录）。

    每个节点附带 rel（相对项目根的路径），供前端点击复制。
    """
    counter = {"nodes": 0}
    truncated = {"flag": False}

    def walk(dir_path: str, depth: int, prefix: str = "") -> dict:
        name = os.path.basename(dir_path) or dir_path
        rel = f"{prefix}{name}"
        node = {"name": name,
                "type": "dir", "rel": rel, "children": []}
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
            node["children"].append(walk(os.path.join(dir_path, name), depth + 1, rel + "/"))
        for name, size in sorted(files, key=lambda kv: kv[0].lower()):
            if counter["nodes"] >= max_nodes:
                truncated["flag"] = True
                break
            counter["nodes"] += 1
            node["children"].append({"name": name, "type": "file", "size": size, "rel": rel})
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
    stats = collect_stats(path)
    configs = collect_configs(path)
    readme_path = find_readme(path)
    meta = {
        "git": gitinfo.collect_git_info(path),
        "configs": configs,
        "stats": stats,
        "tech_tags": detect_tech_tags(configs, path, stats),
        "readme_file": os.path.basename(readme_path or "") or None,
        "intro": extract_readme_intro(readme_path) if readme_path else None,
        "parsed_at": _to_iso(st.st_mtime),
    }
    return {
        "auto_meta": meta,
        "fs_created": _to_iso(st.st_ctime),
        "fs_modified": _to_iso(st.st_mtime),
    }


def summarize_stack(auto_meta: dict) -> str:
    """从 auto_meta 提炼一行技术栈摘要，供卡片列表展示。

    组合：构建配置类型 + 主要语言 + 框架标签，最多 4 项。
    """
    if not auto_meta:
        return ""
    items: list[str] = []
    for c in auto_meta.get("configs", []):
        kind = c.get("kind")
        if kind and kind not in items and kind != "Docker":
            items.append(kind)
    for lang in _languages_from_stats(auto_meta.get("stats") or {}):
        if len(items) >= 4:
            break
        if lang not in items:
            items.append(lang)
    for tag in auto_meta.get("tech_tags") or []:
        if len(items) >= 4:
            break
        # 框架类标签优先展示（与语言/类型不同名的）
        if tag in ("FastAPI", "Flask", "Django", "React", "Vue", "Next.js",
                   "Nuxt", "Electron", "Svelte", "Angular", "Express", "Qt") \
                and tag not in items:
            items.append(tag)
    if auto_meta.get("git", {}).get("is_repo") and len(items) < 4:
        items.append("Git")
    return " · ".join(items[:4])
