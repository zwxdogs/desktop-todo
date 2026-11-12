# -*- coding: utf-8 -*-
"""拼接 before/after 对比图, 用于 Phase 0 验收。"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = "C:/Windows/Fonts/msyh.ttc"


def label_font(size):
    try:
        return ImageFont.truetype(FONT, size)
    except Exception:
        return ImageFont.load_default()


def compose(name, before, after, out, gap=18, label_h=52, bg="#E9EDF2"):
    a = Image.open(os.path.join(HERE, "before", before)).convert("RGB")
    b = Image.open(os.path.join(HERE, "after", after)).convert("RGB")
    h = max(a.height, b.height) + label_h
    w = a.width + gap + b.width
    canvas = Image.new("RGB", (w, h), bg)
    canvas.paste(a, (0, label_h))
    canvas.paste(b, (a.width + gap, label_h))
    d = ImageDraw.Draw(canvas)
    f = label_font(22)
    d.text((6, 12), "BEFORE  0.2.6", font=f, fill="#5A6472")
    d.text((a.width + gap + 6, 12), "AFTER  0.2.7", font=f, fill="#2F6DB5")
    d.line((a.width + gap // 2, 0, a.width + gap // 2, h), fill="#D5DBE3", width=1)
    canvas.save(os.path.join(HERE, out))
    print(out, canvas.size)


compose("main.png", "main.png", "main.png", "compare_main.png")
compose("panel.png", "panel.png", "panel.png", "compare_panel.png")
