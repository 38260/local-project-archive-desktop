"""批量扫描服务：递归发现候选项目目录。

扫描策略：
  - 从根目录按深度限制递归（根目录深度为 0）；
  - 命中项目标记（.git / package.json / pyproject.toml 等）即视为候选，
    且不再向其内部递归（避免把子模块、示例目录重复列出）；
  - 跳过依赖与构建产物目录、隐藏目录；
  - 有目录数 / 候选数上限，防止异常超大目录拖垮服务。
"""
import os

from app.config import PROJECT_MARKERS, SCAN_MAX_CANDIDATES, SCAN_MAX_DIRS
from app.services.parser import is_junk_dir


def _detect_markers(dir_path: str) -> list[str]:
    """检查目录下存在哪些项目标记，返回 ['Git 仓库', 'Node.js', ...]。"""
    found = []
    try:
        entries = set(os.listdir(dir_path))
    except OSError:
        return found
    for marker, label in PROJECT_MARKERS.items():
        if marker in entries:
            found.append(label)
    # 兜底识别 .sln（Visual Studio 解决方案）
    if not found:
        for name in entries:
            if name.lower().endswith(".sln"):
                found.append("Visual Studio")
                break
    return found


def scan_root(root: str, max_depth: int = 3) -> dict:
    """扫描根目录，返回候选项目列表与统计。"""
    candidates = []
    visited = {"count": 0}
    truncated = {"flag": False}

    def walk(dir_path: str, depth: int) -> None:
        if visited["count"] >= SCAN_MAX_DIRS or len(candidates) >= SCAN_MAX_CANDIDATES:
            truncated["flag"] = True
            return
        visited["count"] += 1

        markers = _detect_markers(dir_path)
        if markers:
            candidates.append({"path": dir_path, "name": os.path.basename(dir_path),
                               "markers": markers})
            return  # 命中项目后不再向内递归

        if depth >= max_depth:
            return
        try:
            with os.scandir(dir_path) as it:
                sub_dirs = [e.path for e in it
                            if e.is_dir(follow_symlinks=False)
                            and not e.name.startswith(".")
                            and not is_junk_dir(e.name)]
        except OSError:
            return  # 无权限等异常：跳过该目录，不中断整体扫描
        for sub in sorted(sub_dirs):
            walk(sub, depth + 1)
            if visited["count"] >= SCAN_MAX_DIRS or len(candidates) >= SCAN_MAX_CANDIDATES:
                truncated["flag"] = True
                return

    walk(root, 0)
    return {"root": root, "candidates": candidates,
            "scanned_dirs": visited["count"], "truncated": truncated["flag"]}
