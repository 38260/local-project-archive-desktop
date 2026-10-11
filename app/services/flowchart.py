"""流程图自动识别：按文件名关键词在项目内查找流程图图片。

设计边界：
  - 只读：绝不向原项目目录写入任何文件（替换用的上传图存在档案数据目录）；
  - 按文件名识别（flowchart / workflow / 流程图 / 工作流 等），不解析绘图工程文件；
  - 只扫根目录与有限深度的子目录，跳过依赖/构建/隐藏目录，遍历条数有上限，
    防止超大仓库拖垮详情页；
  - 不跟随符号链接 / 目录联接：识别结果全部落在项目真实路径内，防止越界读取。
"""
import os
from io import BytesIO
import warnings
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path

from PIL import Image

from app.config import JUNK_DIRS

# 文件名（去扩展名、小写、`-`/`_` 归一为空格）包含这些关键词即视为流程图候选
FLOWCHART_KEYWORDS = ("flowchart", "flow chart", "workflow", "流程图", "工作流")
# 支持的图片格式（扩展名大小写不敏感）；SVG 以 <img> 方式展示，浏览器不执行其内脚本
FLOWCHART_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg"}

# 遍历护栏
MAX_DEPTH = 3      # 子目录深度上限（根目录算第 0 层）
MAX_FILES = 2000   # 最多检查的文件条数，超出停止并如实返回已找到的部分


def _norm_stem(name: str) -> str:
    """文件名（不含扩展名）归一化：小写、`-`/`_` 归一为空格、压缩空白。"""
    stem = os.path.splitext(name)[0].strip().lower()
    stem = stem.replace("_", " ").replace("-", " ")
    return " ".join(stem.split())


def _is_candidate(filename: str) -> bool:
    if os.path.splitext(filename)[1].lower() not in FLOWCHART_IMAGE_EXTS:
        return False
    stem = _norm_stem(filename)
    return any(keyword in stem for keyword in FLOWCHART_KEYWORDS)


def detect_flowcharts(project_path: str) -> list[dict]:
    """在项目内按文件名识别流程图图片，返回排序后的候选列表。

    排序规则：根目录精确命名 → 相关命名 → 路径深度 → 稳定文件名顺序。
    每项含 rel（项目内相对路径，正斜杠）/ name / size / mtime。
    """
    root = Path(project_path).resolve()
    if not root.is_dir():
        return []
    junk = {j.lower() for j in JUNK_DIRS if not j.startswith("*")}
    seen = 0
    out: list[dict] = []

    def walk(dir_path: Path, depth: int, rel_base: str) -> None:
        nonlocal seen
        if seen >= MAX_FILES:
            return
        try:
            entries = sorted(dir_path.iterdir(), key=lambda e: e.name.lower())
        except OSError:
            return   # 无权限等读取失败：该目录跳过，不影响其余部分
        for entry in entries:
            if seen >= MAX_FILES:
                return
            name = entry.name
            if name.startswith("."):
                continue   # 隐藏目录/文件不参与识别
            try:
                if (entry.is_symlink()
                        or os.path.normcase(os.path.realpath(entry))
                        != os.path.normcase(os.path.abspath(entry))):
                    continue   # 同时跳过 Windows junction，避免越界与循环
                if entry.is_dir():
                    if depth >= MAX_DEPTH or name.lower() in junk:
                        continue
                    walk(entry, depth + 1, f"{rel_base}{name}/")
                elif entry.is_file():
                    seen += 1
                    if not _is_candidate(name):
                        continue
                    st = entry.stat()
                    out.append({
                        "rel": f"{rel_base}{name}",
                        "name": name,
                        "size": st.st_size,
                        "mtime": datetime.fromtimestamp(st.st_mtime).astimezone().isoformat(),
                    })
            except OSError:
                continue   # stat/遍历中文件消失或不可读：跳过即可

    walk(root, 0, "")
    # 排序：根目录精确 flowchart 命名 → 根目录其他相关命名 → 子目录候选；
    # 同层内先浅后深、再按稳定文件名顺序。
    def _rank(c: dict) -> tuple:
        stem = _norm_stem(c["name"])
        if c["rel"].count("/") == 0:
            tier = 0 if stem in ("flowchart", "flow chart") else 1
        else:
            tier = 2
        return (tier, c["rel"].count("/"), c["rel"].lower())

    out.sort(key=_rank)
    return out


def sniff_image(data: bytes, ext: str) -> bool:
    """验证图片格式与解码，拒绝损坏数据、伪造类型和像素炸弹。"""
    ext = ext.lower()
    if ext == ".svg":
        try:
            root = ET.fromstring(data)
            return root.tag in ("svg", "{http://www.w3.org/2000/svg}svg")
        except (ET.ParseError, ValueError):
            return False
    expected = {".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG", ".gif": "GIF",
                ".bmp": "BMP", ".webp": "WEBP"}.get(ext)
    if expected is None:
        return False
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as image:
                if image.format != expected:
                    return False
                image.verify()
            with Image.open(BytesIO(data)) as image:
                image.load()
        return True
    except (OSError, SyntaxError, ValueError, EOFError,
            Image.DecompressionBombError, Image.DecompressionBombWarning):
        return False
