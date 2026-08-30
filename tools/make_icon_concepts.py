"""渲染图标概念稿：三个方向各出一张 256px + 一张 32px（看小尺寸辨识度）。

纯标准库绘制，与 make_icon.py 同一套像素风格。仅用于选型讨论，
选定方向后再把画法并入 make_icon.py 正式生成 app.ico。

用法：python tools/make_icon_concepts.py
产出：assets/concept-{A,B,C}-256.png、assets/concept-{A,B,C}-32.png
"""
from __future__ import annotations

from pathlib import Path

ACCENT = (9, 105, 218)
ACCENT_HI = (47, 129, 247)   # 渐变亮端 #2f81f7
WHITE = (250, 251, 252)
AMBER = (245, 158, 11)


def in_rounded_rect(x, y, w, h, r):
    if not (0 <= x < w and 0 <= y < h):
        return False
    if r <= x < w - r or r <= y < h - r:
        return True
    cx = min(max(x, r), w - 1 - r)
    cy = min(max(y, r), h - 1 - r)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r


def dist_seg(px, py, x1, y1, x2, y2):
    vx, vy = x2 - x1, y2 - y1
    L = vx * vx + vy * vy or 1.0
    t = max(0.0, min(1.0, ((px - x1) * vx + (py - y1) * vy) / L))
    dx, dy = px - (x1 + t * vx), py - (y1 + t * vy)
    return (dx * dx + dy * dy) ** 0.5


def in_stroke(px, py, pts, width):
    """折线笔画：点到任一线段距离 <= width/2。"""
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        if dist_seg(px, py, x1, y1, x2, y2) <= width / 2:
            return True
    return False


def folder_box(size):
    fw, fh = size * 0.54, size * 0.38
    fx = (size - fw) / 2
    fy = (size - fh) / 2 + size * 0.05
    return fx, fy, fw, fh


def in_folder(x, y, size, fx, fy, fw, fh):
    tab_w, tab_h = fw * 0.44, fh * 0.22
    if fx <= x < fx + fw and fy <= y < fy + fh:
        return True
    return fx <= x < fx + tab_w and fy - tab_h <= y < fy


def tile_color(x, y, size):
    """竖向渐变：上亮下深，模拟光感。"""
    t = y / size
    return tuple(int(ACCENT_HI[i] + (ACCENT[i] - ACCENT_HI[i]) * t) for i in range(3))


def render(size, concept):
    buf = bytearray(size * size * 4)
    radius = max(1, round(size * 0.20))
    fx, fy, fw, fh = folder_box(size)
    sw = max(1.5, size * 0.035)          # 笔画粗细

    for y in range(size):
        for x in range(size):
            i = (y * size + x) * 4
            if not in_rounded_rect(x, y, size, size, radius):
                continue
            r, g, b = tile_color(x, y, size)

            if concept == "A":
                # 文件夹 + 镂空 </>
                if in_folder(x, y, size, fx, fy, fw, fh):
                    left = [(fx + 0.32 * fw, fy + 0.28 * fh), (fx + 0.18 * fw, fy + 0.52 * fh),
                            (fx + 0.32 * fw, fy + 0.76 * fh)]
                    right = [(fx + 0.68 * fw, fy + 0.28 * fh), (fx + 0.82 * fw, fy + 0.52 * fh),
                             (fx + 0.68 * fw, fy + 0.76 * fh)]
                    slash = [(fx + 0.56 * fw, fy + 0.24 * fh), (fx + 0.44 * fw, fy + 0.80 * fh)]
                    if in_stroke(x, y, left, sw) or in_stroke(x, y, right, sw) \
                            or in_stroke(x, y, slash, sw):
                        r, g, b = tile_color(x, y, size)   # 镂空回底色
                    else:
                        r, g, b = WHITE

            elif concept == "B":
                # 文件夹 + 琥珀色标签
                if in_folder(x, y, size, fx, fy, fw, fh):
                    r, g, b = WHITE
                tw, th = size * 0.20, size * 0.13
                tx, ty = size * 0.60, size * 0.60
                if in_rounded_rect(x - tx, y - ty, tw, th, max(1, round(th * 0.3))):
                    hole_cx, hole_cy = tx + th * 0.55, ty + th * 0.5
                    if (x - hole_cx) ** 2 + (y - hole_cy) ** 2 <= (size * 0.018) ** 2:
                        r, g, b = tile_color(x, y, size)
                    else:
                        r, g, b = AMBER

            elif concept == "C":
                # 档案盒 + 探出的文件夹
                bw, bh = size * 0.56, size * 0.26
                bx = (size - bw) / 2
                by = size * 0.52
                lid_h = size * 0.07
                # 盒内探出的文件夹（上半，略小）
                if in_folder(x, y, size * 0.86, fx + fw * 0.07, fy - size * 0.02,
                             fw * 0.86, fh * 0.86) and y < by + lid_h:
                    r, g, b = WHITE
                # 盒盖
                if bx - size * 0.02 <= x < bx + bw + size * 0.02 and by <= y < by + lid_h:
                    r, g, b = WHITE
                # 盒身（盖下留一条底色缝，区分盖/身）
                elif bx <= x < bx + bw and by + lid_h + max(1, size * 0.015) <= y < by + bh + lid_h:
                    r, g, b = WHITE
                    # 盒身中央一条竖向把手槽（镂空）
                    if abs(x - size / 2) <= size * 0.045 and \
                            by + lid_h + size * 0.05 <= y < by + lid_h + size * 0.11:
                        r, g, b = tile_color(x, y, size)

            buf[i:i + 4] = bytes((r, g, b, 255))
    return buf


def encode_png(size, rgba):
    import struct
    import zlib

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


def main():
    root = Path(__file__).resolve().parent.parent
    assets = root / "assets"
    for concept in ("A", "B", "C"):
        for size in (256, 32):
            png = encode_png(size, render(size, concept))
            out = assets / f"concept-{concept}-{size}.png"
            out.write_bytes(png)
            print(f"  已生成: {out}")


if __name__ == "__main__":
    main()
