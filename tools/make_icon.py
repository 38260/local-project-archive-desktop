"""生成应用图标：纯标准库绘制 PNG，再组装成多尺寸 ICO。

零第三方依赖（不装 Pillow 也能跑），供 PyInstaller 的 icon= 参数使用。
图形为定稿方向 A：渐变蓝圆角方块（#2f81f7→#0969da，与应用强调色呼应）+
白色文件夹，文件夹身镂空 `</>` 代码符（透出底色），表达「开发项目档案」。

用法：
  python tools/make_icon.py             # 生成 assets/app.ico
  python tools/make_icon.py --png-only  # 只导出 PNG，不组装 ICO
"""
from __future__ import annotations

import argparse
import struct
import sys
import zlib
from pathlib import Path

ACCENT = (9, 105, 218)      # --accent #0969da
ACCENT_HI = (47, 129, 247)  # 渐变亮端 #2f81f7
WHITE = (250, 251, 252)
SIZES = (16, 32, 48, 64, 256)


# --------------------------------------------------------------------------
# PNG 编码（标准库手写）
# --------------------------------------------------------------------------
def _chunk(tag: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def encode_png(size: int, rgba: bytearray) -> bytes:
    """把 RGBA 像素缓冲编码为 PNG。每行前置 filter 字节 0（None）。"""
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n"
            + _chunk(b"IHDR", ihdr)
            + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + _chunk(b"IEND", b""))


# --------------------------------------------------------------------------
# 图形绘制
# --------------------------------------------------------------------------
def in_rounded_rect(x: int, y: int, w: int, h: int, r: int) -> bool:
    """点是否落在圆角矩形内（含边界）。"""
    if not (0 <= x < w and 0 <= y < h):
        return False
    if r <= x < w - r or r <= y < h - r:
        return True
    cx = min(max(x, r), w - 1 - r)
    cy = min(max(y, r), h - 1 - r)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r


def _dist_seg(px, py, x1, y1, x2, y2) -> float:
    vx, vy = x2 - x1, y2 - y1
    L = vx * vx + vy * vy or 1.0
    t = max(0.0, min(1.0, ((px - x1) * vx + (py - y1) * vy) / L))
    dx, dy = px - (x1 + t * vx), py - (y1 + t * vy)
    return (dx * dx + dy * dy) ** 0.5


def in_stroke(px, py, pts, width) -> bool:
    """点是否落在折线笔画内（到任一线段距离 <= width/2）。"""
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        if _dist_seg(px, py, x1, y1, x2, y2) <= width / 2:
            return True
    return False


def in_folder(x: int, y: int, size: int) -> bool:
    """点是否落在白色文件夹上：圆角主体 + 左上圆角标签凸起。"""
    fw = size * 0.54
    fh = size * 0.38
    fx = (size - fw) / 2
    fy = (size - fh) / 2 + size * 0.05
    tab_w = fw * 0.44
    tab_h = fh * 0.22
    r = max(1, round(size * 0.03))
    # 主体（圆角）
    if in_rounded_rect(x - fx, y - fy, fw, fh, r):
        return True
    # 标签（圆角，底部伸进主体内隐藏接缝）
    return in_rounded_rect(x - fx, y - (fy - tab_h), tab_w, tab_h + r * 2, r)


def in_code_glyph(x, y, size) -> bool:
    """点是否落在 `</>` 笔画上（相对文件夹主体定位）。"""
    fw = size * 0.54
    fh = size * 0.38
    fx = (size - fw) / 2
    fy = (size - fh) / 2 + size * 0.05
    sw = max(2.0, size * 0.035)
    left = [(fx + 0.32 * fw, fy + 0.28 * fh), (fx + 0.18 * fw, fy + 0.52 * fh),
            (fx + 0.32 * fw, fy + 0.76 * fh)]
    right = [(fx + 0.68 * fw, fy + 0.28 * fh), (fx + 0.82 * fw, fy + 0.52 * fh),
             (fx + 0.68 * fw, fy + 0.76 * fh)]
    slash = [(fx + 0.56 * fw, fy + 0.24 * fh), (fx + 0.44 * fw, fy + 0.80 * fh)]
    return (in_stroke(x, y, left, sw) or in_stroke(x, y, right, sw)
            or in_stroke(x, y, slash, sw))


def tile_color(x: int, y: int, size: int):
    """竖向渐变：上亮下深，模拟顶光。"""
    t = y / size
    return tuple(int(ACCENT_HI[i] + (ACCENT[i] - ACCENT_HI[i]) * t) for i in range(3))


def render(size: int) -> bytearray:
    buf = bytearray(size * size * 4)
    radius = max(1, round(size * 0.20))
    for y in range(size):
        row = y * size * 4
        for x in range(size):
            i = row + x * 4
            if not in_rounded_rect(x, y, size, size, radius):
                continue                       # 圆角外保持透明
            base = tile_color(x, y, size)
            if in_folder(x, y, size) and not in_code_glyph(x, y, size):
                r, g, b = WHITE                # 文件夹；代码符处镂空回底色
            else:
                r, g, b = base
            buf[i:i + 4] = bytes((r, g, b, 255))
    return buf


# --------------------------------------------------------------------------
# ICO 组装
# --------------------------------------------------------------------------
def build_ico(images: list[tuple[int, bytes]]) -> bytes:
    """把若干 PNG 打包成 ICO（Vista+ 支持内嵌 PNG）。"""
    count = len(images)
    out = bytearray(struct.pack("<HHH", 0, 1, count))
    offset = 6 + 16 * count
    entries = bytearray()
    for size, data in images:
        # 256 在单字节字段里记作 0
        entries += struct.pack("<BBBBHHII",
                               size % 256, size % 256, 0, 0, 1, 32,
                               len(data), offset)
        offset += len(data)
    out += entries
    for _, data in images:
        out += data
    return bytes(out)


def main() -> int:
    parser = argparse.ArgumentParser(description="生成应用图标")
    parser.add_argument("--png-only", action="store_true", help="只导出 PNG")
    args = parser.parse_args()

    root = Path(__file__).resolve().parent.parent
    assets = root / "assets"
    assets.mkdir(exist_ok=True)

    images: list[tuple[int, bytes]] = []
    for size in SIZES:
        png = encode_png(size, render(size))
        images.append((size, png))
        if args.png_only:
            (assets / f"icon-{size}.png").write_bytes(png)
            print(f"  已导出 PNG: assets/icon-{size}.png")
        else:
            print(f"  已绘制 {size}x{size}（{len(png)} 字节）")

    if args.png_only:
        return 0

    ico = build_ico(images)
    target = assets / "app.ico"
    target.write_bytes(ico)
    print(f"\n  已生成: {target}（{len(ico)} 字节，含 {len(images)} 个尺寸）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
