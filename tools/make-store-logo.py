# 生成 Edge 加载项商店要用的 300×300 商店图标。
# 图形与扩展图标一致（粉底 + 白色播放框 + 播放三角），只是尺寸不同。
import os
from PIL import Image, ImageDraw

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, "store")
os.makedirs(OUT, exist_ok=True)

PINK_TOP = (253, 137, 170)
PINK_BOTTOM = (233, 82, 128)
WHITE = (255, 255, 255, 255)


def render(size: int) -> Image.Image:
    scale = 4
    s = size * scale
    radius = int(s * 0.16)  # 商店图标比扩展图标稍方一些

    grad = Image.new("RGB", (1, s))
    for y in range(s):
        t = y / max(1, s - 1)
        grad.putpixel((0, y), tuple(
            int(PINK_TOP[i] * (1 - t) + PINK_BOTTOM[i] * t) for i in range(3)
        ))
    grad = grad.resize((s, s))

    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=255)

    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)

    pad = s * 0.21
    stroke = max(2, int(s * 0.072))
    d.rounded_rectangle([pad, pad, s - pad, s - pad],
                        radius=s * 0.13, outline=WHITE, width=stroke)

    cx, cy = s / 2, s / 2
    tri = s * 0.18
    d.polygon([(cx - tri * 0.75, cy - tri), (cx - tri * 0.75, cy + tri), (cx + tri, cy)], fill=WHITE)

    return img.resize((size, size), Image.LANCZOS)


for size, name in ((300, "logo-300.png"), (128, "logo-128.png")):
    path = os.path.join(OUT, name)
    render(size).save(path, "PNG", optimize=True)
    print(f"{path}  {os.path.getsize(path)} bytes  {size}x{size}")
