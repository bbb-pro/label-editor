#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 SEO / 分享所需的静态图片资源（纯标准库，无第三方依赖）。

产物：
  public/favicon.ico            32+64 双尺寸（PNG-in-ICO）
  public/apple-touch-icon.png   180x180（iOS 不透明底）
  public/og-image.png           1200x630（社交分享卡）

原理：全部用 SDF（有向距离场）+ 解析抗锯齿绘制，无需 supersampling，
纯 Python 也能秒级出图。
"""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public")

BLUE = (0x25, 0x63, 0xEB)      # 主色 #2563eb
BLUE_D = (0x1E, 0x40, 0xAF)    # 深蓝 #1e40af
INK = (0x0F, 0x17, 0x2A)       # 近黑 #0f172a
GRAY = (0x94, 0xA3, 0xB8)      # #94a3b8
GRAY_L = (0xCB, 0xD5, 0xE1)    # #cbd5e1
WHITE = (0xFF, 0xFF, 0xFF)


# ---------- PNG 编码 ----------
def _chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def encode_png(w: int, h: int, rgba: bytearray) -> bytes:
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)  # filter: None
        raw += rgba[y * stride:(y + 1) * stride]
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + _chunk(b"IEND", b"")


# ---------- SDF ----------
def sd_rr(px, py, cx, cy, hw, hh, r):
    """圆角矩形 SDF（像素单位，内部为负）"""
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    return math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - r


def cov(d):
    """距离 → 覆盖率（约 1px 过渡的解析抗锯齿）"""
    if d >= 0.5:
        return 0.0
    if d <= -0.5:
        return 1.0
    return 0.5 - d


# ---------- 合成 ----------
def over(dst, r, g, b, a):
    """src over dst，均在 0..1"""
    if a <= 0.0:
        return dst
    dr, dg, db, da = dst
    oa = a + da * (1.0 - a)
    if oa <= 0.0:
        return (0.0, 0.0, 0.0, 0.0)
    k = da * (1.0 - a)
    return ((r * a + dr * k) / oa, (g * a + dg * k) / oa, (b * a + db * k) / oa, oa)


def _c(color):
    return (color[0] / 255.0, color[1] / 255.0, color[2] / 255.0)


# 条码条图案（1=条, 0=空），Code128 观感
BARS = [3, 1, 1, 2, 2, 1, 3, 1, 1, 2, 1, 3, 2, 1, 1, 1, 2, 2, 1, 3]


def draw_bars(px, py, x0, x1, y0, y1, color, out_s):
    """在 [x0,x1]×[y0,y1] 内按 BARS 图案画竖条"""
    if not (x0 - 1 <= px <= x1 + 1 and y0 - 1 <= py <= y1 + 1):
        return out_s
    total = sum(BARS)
    unit = (x1 - x0) / total
    x = x0
    for i, w in enumerate(BARS):
        if i % 2 == 0:  # 条
            hw = w * unit / 2.0
            d = abs(px - (x + w * unit / 2.0)) - hw
            dy = max(y0 - py, py - y1)
            dist = math.hypot(max(d, 0.0), max(dy, 0.0)) + min(max(d, dy), 0.0)
            a = cov(dist)
            if a > 0:
                cr, cg, cb = _c(color)
                out_s = over(out_s, cr, cg, cb, a)
        x += w * unit
    return out_s


# ---------- favicon（透明底） ----------
def paint_favicon(px, py, size):
    s = size / 32.0
    col = (0.0, 0.0, 0.0, 0.0)
    cx, cy = size / 2.0, size / 2.0
    hw, hh, r = 13.0 * s, 9.6 * s, 2.6 * s
    d = sd_rr(px, py, cx, cy, hw, hh, r)
    # 蓝描边
    a = cov(abs(d) - 1.15 * s)
    if a > 0:
        cr, cg, cb = _c(BLUE)
        col = over(col, cr, cg, cb, a)
    # 白底
    a = cov(d + 0.6 * s)
    if a > 0:
        cr, cg, cb = _c(WHITE)
        col = over(col, cr, cg, cb, a)
    # 条码
    col = draw_bars(px, py, 7.0 * s, 18.5 * s, 11.5 * s, 21.0 * s, INK, col)
    # 文字占位线
    for y0, y1, x1, c in (
        (13.4 * s, 15.0 * s, 26.0 * s, GRAY),
        (17.6 * s, 18.8 * s, 26.0 * s, GRAY_L),
        (20.0 * s, 21.2 * s, 23.0 * s, GRAY_L),
    ):
        if 20.0 * s <= px <= x1 + 1 and y0 - 1 <= py <= y1 + 1:
            dd = sd_rr(px, py, (20.0 * s + x1) / 2.0, (y0 + y1) / 2.0,
                       (x1 - 20.0 * s) / 2.0, (y1 - y0) / 2.0, 0.35 * s)
            a = cov(dd)
            if a > 0:
                cr, cg, cb = _c(c)
                col = over(col, cr, cg, cb, a)
    return col


# ---------- apple-touch-icon（不透明蓝底） ----------
def paint_apple(px, py, size):
    s = size / 180.0
    cr, cg, cb = _c(BLUE)
    col = over((0.0, 0.0, 0.0, 0.0), cr, cg, cb, 1.0)
    cx, cy = size / 2.0, size / 2.0
    d = sd_rr(px, py, cx, cy, 58.0 * s, 40.0 * s, 9.0 * s)
    a = cov(d)
    if a > 0:
        wr, wg, wb = _c(WHITE)
        col = over(col, wr, wg, wb, a)
    col = draw_bars(px, py, 46.0 * s, 112.0 * s, 66.0 * s, 114.0 * s, INK, col)
    for y0, y1, x1, c in (
        (72.0 * s, 79.0 * s, 140.0 * s, GRAY),
        (86.0 * s, 91.0 * s, 140.0 * s, GRAY_L),
        (98.0 * s, 103.0 * s, 132.0 * s, GRAY_L),
    ):
        if 120.0 * s <= px <= x1 + 1 and y0 - 1 <= py <= y1 + 1:
            dd = sd_rr(px, py, (120.0 * s + x1) / 2.0, (y0 + y1) / 2.0,
                       (x1 - 120.0 * s) / 2.0, (y1 - y0) / 2.0, 1.6 * s)
            a = cov(dd)
            if a > 0:
                cr2, cg2, cb2 = _c(c)
                col = over(col, cr2, cg2, cb2, a)
    return col


# ---------- OG 分享图 1200x630 ----------
def paint_og(px, py, W, H):
    u = px / W
    v = py / H
    # 对角渐变底
    t = max(0.0, min(1.0, (u * 0.65 + v * 0.35)))
    r0 = (INK[0] + (BLUE_D[0] - INK[0]) * t) / 255.0
    g0 = (INK[1] + (BLUE_D[1] - INK[1]) * t) / 255.0
    b0 = (INK[2] + (BLUE_D[2] - INK[2]) * t) / 255.0
    # 右下角柔光
    gd = math.hypot(px - W * 0.86, py - H * 0.9) / (W * 0.55)
    glow = max(0.0, 1.0 - gd) ** 2 * 0.16
    col = over((0.0, 0.0, 0.0, 0.0), min(1.0, r0 + glow), min(1.0, g0 + glow), min(1.0, b0 + 0.22 * glow), 1.0)

    cx, cy, hw, hh, rr = 600.0, 302.0, 300.0, 170.0, 28.0
    # 投影
    ds = sd_rr(px, py - 16.0, cx, cy, hw, hh, rr)
    if ds > -40:
        a = min(1.0, max(0.0, (1.0 - ds / 46.0))) ** 2 * 0.42
        if a > 0:
            col = over(col, 0.0, 0.0, 0.0, a)
    d = sd_rr(px, py, cx, cy, hw, hh, rr)
    a = cov(d)
    if a > 0:
        wr, wg, wb = _c(WHITE)
        col = over(col, wr, wg, wb, a)
    if a > 0 or abs(d) < 2:
        # 顶部蓝色带：卡片内 ∩ 半平面（上沿自然跟随卡片圆角，下沿为直边）
        top = cy - hh
        ab = cov(max(d, py - (top + 34.0)))
        if ab > 0:
            br, bg, bb = _c(BLUE)
            col = over(col, br, bg, bb, ab)
        # 左侧条码
        col = draw_bars(px, py, 348.0, 588.0, 196.0, 372.0, INK, col)
        # 条码下方小字线
        for x0, x1, y0, y1, c in (
            (348.0, 424.0, 396.0, 408.0, GRAY),
            (432.0, 508.0, 396.0, 408.0, GRAY_L),
            (516.0, 588.0, 396.0, 408.0, GRAY_L),
        ):
            if x0 - 2 <= px <= x1 + 2 and y0 - 2 <= py <= y1 + 2:
                dd = sd_rr(px, py, (x0 + x1) / 2.0, (y0 + y1) / 2.0,
                           (x1 - x0) / 2.0, (y1 - y0) / 2.0, 5.0)
                aa = cov(dd)
                if aa > 0:
                    cr, cg, cb = _c(c)
                    col = over(col, cr, cg, cb, aa)
        # 右侧文字占位线
        for x0, x1, y0, y1, c, rad in (
            (636.0, 856.0, 208.0, 246.0, INK, 7.0),
            (636.0, 856.0, 268.0, 286.0, GRAY, 5.0),
            (636.0, 792.0, 298.0, 316.0, GRAY_L, 5.0),
            (636.0, 748.0, 350.0, 384.0, BLUE, 9.0),
        ):
            if x0 - 2 <= px <= x1 + 2 and y0 - 2 <= py <= y1 + 2:
                dd = sd_rr(px, py, (x0 + x1) / 2.0, (y0 + y1) / 2.0,
                           (x1 - x0) / 2.0, (y1 - y0) / 2.0, rad)
                aa = cov(dd)
                if aa > 0:
                    cr, cg, cb = _c(c)
                    col = over(col, cr, cg, cb, aa)
    return col


def render(w, h, fn):
    buf = bytearray(w * h * 4)
    i = 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = fn(x + 0.5, y + 0.5)
            buf[i] = int(max(0.0, min(1.0, r)) * 255 + 0.5)
            buf[i + 1] = int(max(0.0, min(1.0, g)) * 255 + 0.5)
            buf[i + 2] = int(max(0.0, min(1.0, b)) * 255 + 0.5)
            buf[i + 3] = int(max(0.0, min(1.0, a)) * 255 + 0.5)
            i += 4
    return encode_png(w, h, buf)


def make_ico(sizes):
    """PNG-in-ICO（Vista+ / 所有现代浏览器均支持）"""
    imgs = [render(s, s, lambda px, py, s=s: paint_favicon(px, py, s)) for s in sizes]
    n = len(sizes)
    head = struct.pack("<HHH", 0, 1, n)
    offset = 6 + 16 * n
    entries, body = b"", b""
    for s, data in zip(sizes, imgs):
        entries += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(data), offset)
        body += data
        offset += len(data)
    return head + entries + body


def main():
    os.makedirs(OUT, exist_ok=True)

    ico = make_ico([32, 64])
    with open(os.path.join(OUT, "favicon.ico"), "wb") as f:
        f.write(ico)

    apple = render(180, 180, lambda px, py: paint_apple(px, py, 180))
    with open(os.path.join(OUT, "apple-touch-icon.png"), "wb") as f:
        f.write(apple)

    og = render(1200, 630, lambda px, py: paint_og(px, py, 1200, 630))
    with open(os.path.join(OUT, "og-image.png"), "wb") as f:
        f.write(og)

    for name, blob in (("favicon.ico", ico), ("apple-touch-icon.png", apple), ("og-image.png", og)):
        print(f"{name:26s} {len(blob):>8,d} bytes")


if __name__ == "__main__":
    main()
