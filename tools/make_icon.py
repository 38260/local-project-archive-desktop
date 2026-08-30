"""生成应用图标：纯标准库绘制 PNG，再组装成多尺寸 ICO。

零第三方依赖（不装 Pillow 也能跑），供 PyInstaller 的 icon= 参数使用。
图形沿用应用的强调色 #0969da 圆角方块 + 白色文件夹，与首页 logo 呼应。

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
WHITE = (255, 255, 255)
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


def in_folder(x: int, y: int, size: int) -> bool:
    """点是否落在白色文件夹上：主体矩形 + 左上角标签凸起。"""
    fw = size * 0.54
    fh = size * 0.38
    fx = (size - fw) / 2
    fy = (size - fh) / 2 + size * 0.05
    tab_w = fw * 0.44
    tab_h = fh * 0.22
    # 主体
    if fx <= x < fx + fw and fy <= y < fy + fh:
        return True
    # 标签
    if fx <= x < fx + tab_w and fy - tab_h <= y < fy:
        return True
    return False


def render(size: int) -> bytearray:
    buf = bytearray(size * size * 4)
    radius = max(1, round(size * 0.20))
    for y in range(size):
        row = y * size * 4
        for x in range(size):
            i = row + x * 4
            if not in_rounded_rect(x, y, size, size, radius):
                continue                       # 圆角外保持透明
            r, g, b = WHITE if in_folder(x, y, size) else ACCENT
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
