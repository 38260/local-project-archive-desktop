"""启动入口检测：漏斗式两级扫描（全程只读，绝不执行任何文件）。

① 直接可执行（最权威）：根目录的 .bat/.cmd/.exe/.ps1，以及 dist 一层内的 .exe
   （PyInstaller onedir 产物 dist/<名>/<名>.exe）。这些是用户自己准备的启动方式，
   找到即全部推荐，**跳过**智能推断；
② 智能推断（①为空时兜底）：package.json scripts（按 lockfile 选包管理器）、
   Python 入口文件（优先项目内虚拟环境的解释器）、Cargo/Go 工程。

返回的条目只是候选建议；执行由路由层在用户明确点击按钮后进行。
任何子步骤失败都静默降级为空结果，绝不让检测拖垮详情页。
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from app.config import LAUNCH_DIRECT_EXTS, LAUNCH_ENTRY_FILES, LAUNCH_MAX_ITEMS

logger = logging.getLogger(__name__)

# 常见 dev 脚本优先展示，其余脚本排后
_PREFERRED_SCRIPTS = ["dev", "start", "serve", "preview"]
# lockfile → 包管理器（决定 node 类启动命令的前缀）
_LOCKFILE_PM = [("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"), ("bun.lockb", "bun")]
# start/run/dev/启动 开头的入口文件排最前（命名即意图）
_PRIORITY_PREFIXES = ("start", "run", "dev", "启动")


def _entry(name: str, command: str, mode: str, source: str) -> dict:
    """统一建议条目结构：cwd 为相对项目根的子目录（检测到的都在根上）。"""
    return {"name": name, "command": command, "cwd": "", "mode": mode, "source": source}


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
                # PowerShell 脚本绕过执行策略限制，在终端窗口运行
                items.append(_entry(
                    Path(it.name).stem,
                    f'powershell -NoProfile -ExecutionPolicy Bypass -File "{it.path}"',
                    "console", it.name))
            else:
                # bat/cmd/exe 用「直接运行」（双击等效）；名称取文件名去扩展名
                items.append(_entry(Path(it.name).stem, it.path, "open", it.name))
    except OSError as exc:
        logger.debug("启动入口扫描失败（根目录）%s: %s", root, exc)
        return []

    # dist 一层内的 exe（PyInstaller onedir：dist/<工程名>/<名>.exe）
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

    # 去重（同一路径只留一条）+ 意图命名优先 + 截断
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
    """项目内虚拟环境的 python.exe（.venv/venv/env 等任意目录名都认）。"""
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


def _scan_inferred(root: Path) -> list[dict]:
    """② 智能推断：node scripts → Python 入口 → cargo/go。"""
    items: list[dict] = []

    # Node：package.json scripts（lockfile 决定包管理器）
    pkg = root / "package.json"
    if pkg.is_file():
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
        except (OSError, ValueError) as exc:
            logger.debug("package.json 解析失败 %s: %s", pkg, exc)

    # Python：入口文件 + 项目内虚拟环境解释器优先
    if len(items) < LAUNCH_MAX_ITEMS:
        venv_py = _find_venv_python(root)
        py_cmd = f'"{venv_py}"' if venv_py else "python"
        for name in LAUNCH_ENTRY_FILES:
            if (root / name).is_file():
                args = f"{name} runserver" if name == "manage.py" else name
                items.append(_entry(
                    f"启动 {name}", f"{py_cmd} {args}", "console", name))
                if len(items) >= LAUNCH_MAX_ITEMS:
                    break

    # Rust / Go
    if len(items) < LAUNCH_MAX_ITEMS:
        if (root / "Cargo.toml").is_file():
            items.append(_entry("cargo run", "cargo run", "console", "Cargo.toml"))
        if (root / "go.mod").is_file():
            items.append(_entry("go run .", "go run .", "console", "go.mod"))

    return items[:LAUNCH_MAX_ITEMS]


def detect_launchers(path: str) -> dict:
    """漏斗检测入口。返回 {kind, items}：kind = direct | inferred | none。"""
    root = Path(path)
    if not root.is_dir():
        return {"kind": "none", "items": []}
    try:
        direct = _scan_direct(root)
        if direct:
            return {"kind": "direct", "items": direct}
        return {"kind": "inferred", "items": _scan_inferred(root)}
    except Exception as exc:  # 任何意外都不影响详情页
        logger.warning("启动入口检测异常 %s: %s", path, exc)
        return {"kind": "none", "items": []}
