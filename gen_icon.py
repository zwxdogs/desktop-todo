# -*- coding: utf-8 -*-
"""生成应用图标 assets/app.ico —— 构建机一次性工具(需 Pillow), 不随包分发。

    py -3.12 gen_icon.py

设计: 圆角方块底(#4A8FE2, 与应用强调色一致) + 白色对勾, 16px 下仍可辨认。
"""
import os

from PIL import Image, ImageDraw

S = 1024                       # 画布尺寸, 缩小出各档抗锯齿
BG = (74, 143, 226, 255)       # C_ACCENT #4A8FE2
FG = (255, 255, 255, 255)
SIZES = [(16, 16), (24, 24), (32, 32), (48, 48),
         (64, 64), (128, 128), (256, 256)]

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=BG)

# 对勾: 两段粗折线, 关节补圆点当圆角笔帽
w = int(S * 0.11)
r = w // 2
pts = [(int(S * 0.28), int(S * 0.54)),
       (int(S * 0.44), int(S * 0.70)),
       (int(S * 0.75), int(S * 0.32))]
d.line([pts[0], pts[1]], fill=FG, width=w)
d.line([pts[1], pts[2]], fill=FG, width=w)
for cx, cy in pts:
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=FG)

os.makedirs("assets", exist_ok=True)
img.save("assets/app.ico", sizes=SIZES)
# 预览图: 改图标后人工目检用(放大看锯齿/描边), .scratch/ 不入库
os.makedirs(".scratch", exist_ok=True)
img.resize((64, 64), Image.LANCZOS).save(".scratch/icon_preview.png")
print("written: assets/app.ico", SIZES)
