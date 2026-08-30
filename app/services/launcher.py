"""启动入口检测：漏斗式两级扫描（全程只读，绝不执行任何文件）。

① 直接可执行（较权威）：根目录的 .bat/.cmd/.exe/.ps1、dist 一层内的 .exe。
   文件名明显是 build/test/clean 等维护脚本时不采信为"权威"结果，避免挤掉更靠谱的推断；
② 智能推断：Docker compose / Dockerfile → package.json scripts →
   Python 入口（poetry / pipenv / 项目内 venv 优先于裸 python）→ Cargo/Go；
   一层子目录（frontend/backend 等常见 monorepo 命名）复用同一套推断，附带 cwd。

返回的条目只是候选建议；执行由路由层在用户明确点击按钮后进行。
任何子步骤失败都静默降级为空结果，绝不让检测拖垮详情页。
"""
from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path

from app.config import (
    LAUNCH_COMPOSE_FILES, LAUNCH_DIRECT_EXTS, LAUNCH_ENTRY_FILES,
    LAUNCH_MAINTENANCE_HINTS, LAUNCH_MAX_ITEMS, LAUNCH_MONOREPO_DIRS,
)

logger = logging.getLogger(__name__)

_PREFERRED_SCRIPTS = ["dev", "start", "serve", "preview"]
_LOCKFILE_PM = [("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"), ("bun.lockb", "bun")]
_PRIORITY_PREFIXES = ("start", "run", "dev", "启动")


def _entry(name: str, command: str, mode: str, source: str) -> dict:
    return {"name": name, "command": command, "cwd": "", "mode": mode, "source": source}


def _is_maintenance_name(source: str) -> bool:
    """文件名明显是构建/测试/清理类脚本而非启动脚本时返回 True（漏斗误报缓解）。"""
    stem = Path(source).stem.lower()
    return any(stem == h or stem.startswith(f"{h}_") or stem.startswith(f"{h}-")
               or stem.endswith(f"_{h}") or stem.endswith(f"-{h}")
               for h in LAUNCH_MAINTENANCE_HINTS)


def _scan_direct(root: Path) -> list[dict]:
    """① 直接可执行：根目录脚本/程序 + dist 一层内的 exe。"""
    items: list[dict] = []
    try:
        for it in os.scandir(root):
            if not it.is_file():
                continue
            ext = os.path.splitext(it.name)[1].lower()
            if ext not in LAUNCH_DIRECT_EXTS:
                continue
            if ext == ".ps1":
                items.append(_entry(
                    Path(it.name).stem,
                    f'powershell -NoProfile -ExecutionPolicy Bypass -File "{it.path}"',
                    "console", it.name))
            else:
                items.append(_entry(Path(it.name).stem, it.path, "open", it.name))
    except OSError as exc:
        logger.debug("启动入口扫描失败（根目录）%s: %s", root, exc)
        return []

    dist = root / "dist"
    if dist.is_dir():
        try:
            for d in os.scandir(dist):
                if not d.is_dir():
                    continue
                try:
                    for f in os.scandir(d.path):
                        if f.is_file() and f.name.lower().endswith(".exe"):
                            items.append(_entry(
                                Path(f.name).stem, f.path, "open",
                                f"dist/{d.name}/{f.name}"))
                except OSError:
                    continue
        except OSError as exc:
            logger.debug("启动入口扫描失败（dist）%s: %s", dist, exc)

    seen: set[str] = set()
    uniq: list[dict] = []
    for it in items:
        key = it["command"].lower()
        if key not in seen:
            seen.add(key)
            uniq.append(it)
    uniq.sort(key=lambda it: (
        0 if it["source"].lower().startswith(_PRIORITY_PREFIXES) else 1,
        it["source"].lower()))
    return uniq[:LAUNCH_MAX_ITEMS]


def _find_venv_python(root: Path) -> str | None:
    if os.name != "nt":
        return None
    try:
        for it in os.scandir(root):
            if not it.is_dir():
                continue
            exe = Path(it.path) / "Scripts" / "python.exe"
            if exe.is_file():
                return str(exe)
    except OSError as exc:
        logger.debug("虚拟环境探测失败 %s: %s", root, exc)
    return None


def _uses_poetry(root: Path) -> bool:
    pp = root / "pyproject.toml"
    if not pp.is_file():
        return False
    try:
        return "[tool.poetry]" in pp.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return False


def _scan_inferred(root: Path) -> list[dict]:
    """② 智能推断：Docker → node scripts → Python 入口 → cargo/go。"""
    items: list[dict] = []

    # Docker：compose 一条命令拉起完整环境，优先于单文件推断
    compose = next((f for f in LAUNCH_COMPOSE_FILES if (root / f).is_file()), None)
    if compose:
        items.append(_entry("docker compose up", "docker compose up", "console", compose))
    elif (root / "Dockerfile").is_file():
        img = re.sub(r"[^a-z0-9_.-]", "-", root.name.lower()) or "app"
        items.append(_entry(
            "docker run", f"docker build -t {img} . && docker run -it --rm {img}",
            "console", "Dockerfile"))

    # Node：package.json scripts（lockfile 决定包管理器）
    pkg = root / "package.json"
    if pkg.is_file() and len(items) < LAUNCH_MAX_ITEMS:
        try:
            data = json.loads(pkg.read_text(encoding="utf-8-sig", errors="replace"))
            scripts = data.get("scripts") or {}
            pm = next((cmd for marker, cmd in _LOCKFILE_PM
                       if (root / marker).is_file()), "npm")
            names = ([s for s in _PREFERRED_SCRIPTS if s in scripts]
                     + [s for s in scripts if s not in _PREFERRED_SCRIPTS])
            for s in names[:6]:
                items.append(_entry(
                    f"{s}（{pm}）", f"{pm} run {s}", "console",
                    f"package.json · scripts.{s}"))
                if len(items) >= LAUNCH_MAX_ITEMS:
                    break
        except (OSError, ValueError) as exc:
            logger.debug("package.json 解析失败 %s: %s", pkg, exc)

    # Python：入口文件 + 解释器优先级 poetry > pipenv > 项目内 venv > 裸 python
    if len(items) < LAUNCH_MAX_ITEMS:
        if _uses_poetry(root):
            py_prefix = "poetry run python"
        elif (root / "Pipfile").is_file():
            py_prefix = "pipenv run python"
        else:
            venv_py = _find_venv_python(root)
            py_prefix = f'"{venv_py}"' if venv_py else "python"
        for name in LAUNCH_ENTRY_FILES:
            if (root / name).is_file():
                args = f"{name} runserver" if name == "manage.py" else name
                items.append(_entry(
                    f"启动 {name}", f"{py_prefix} {args}", "console", name))
                if len(items) >= LAUNCH_MAX_ITEMS:
                    break

    # Rust / Go
    if len(items) < LAUNCH_MAX_ITEMS:
        if (root / "Cargo.toml").is_file():
            items.append(_entry("cargo run", "cargo run", "console", "Cargo.toml"))
        if (root / "go.mod").is_file():
            items.append(_entry("go run .", "go run .", "console", "go.mod"))

    return items[:LAUNCH_MAX_ITEMS]


def _scan_monorepo(root: Path) -> list[dict]:
    """一层子目录探测：前后端分仓项目，命中常见目录名即复用同一套推断。

    条目带 cwd（相对项目根），执行时后端切到该子目录再跑命令。
    """
    items: list[dict] = []
    try:
        subdirs = {d.name: d.path for d in os.scandir(root) if d.is_dir()}
    except OSError:
        return items
    for name in LAUNCH_MONOREPO_DIRS:
        hit = next((subdirs[k] for k in subdirs if k.lower() == name), None)
        if not hit:
            continue
        sub_items = _scan_inferred(Path(hit))
        for it in sub_items:
            it["cwd"] = os.path.basename(hit)
            it["name"] = f"{it['name']}（{it['cwd']}/）"
        items.extend(sub_items)
        if len(items) >= LAUNCH_MAX_ITEMS:
            break
    return items[:LAUNCH_MAX_ITEMS]


def detect_launchers(path: str) -> dict:
    """漏斗检测入口。返回 {kind, items}：
    kind = direct（可信的直接可执行）
         | direct_weak（只找到疑似构建/测试脚本，不确定是否为启动方式）
         | inferred（构建配置推断，含 monorepo 子目录）
         | none
    """
    root = Path(path)
    if not root.is_dir():
        return {"kind": "none", "items": []}
    try:
        direct = _scan_direct(root)
        strong_direct = [d for d in direct if not _is_maintenance_name(d["source"])]
        if strong_direct:
            return {"kind": "direct", "items": strong_direct}

        inferred = _scan_inferred(root)
        if len(inferred) < LAUNCH_MAX_ITEMS:
            inferred += _scan_monorepo(root)
        if inferred:
            return {"kind": "inferred", "items": inferred[:LAUNCH_MAX_ITEMS]}
        if direct:
            return {"kind": "direct_weak", "items": direct}
        return {"kind": "none", "items": []}
    except Exception as exc:
        logger.warning("启动入口检测异常 %s: %s", path, exc)
        return {"kind": "none", "items": []}
