# 生成扩展图标：粉色圆角方块 + 白色「只剩画面」意象（播放框 + 播放三角）。
# 先画 8 倍图再降采样，边缘才平滑。
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
os.makedirs(OUT, exist_ok=True)

PINK_TOP = (253, 137, 170)
PINK_BOTTOM = (233, 82, 128)
WHITE = (255, 255, 255, 255)


def render(size: int) -> Image.Image:
    scale = 8
    s = size * scale
    radius = int(s * 0.22)

    # 背景：竖向渐变 + 圆角遮罩
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

    # 播放框（圆角矩形描边）—— 代表"视频画面本身"
    pad = s * 0.20
    stroke = max(1, int(s * 0.075))
    d.rounded_rectangle([pad, pad, s - pad, s - pad],
                        radius=s * 0.14, outline=WHITE, width=stroke)

    # 中央播放三角
    cx, cy = s / 2, s / 2
    tri = s * 0.19
    d.polygon([(cx - tri * 0.75, cy - tri), (cx - tri * 0.75, cy + tri), (cx + tri, cy)], fill=WHITE)

    return img.resize((size, size), Image.LANCZOS)


for size in (16, 32, 48, 128):
    path = os.path.join(OUT, f"icon{size}.png")
    render(size).save(path, "PNG", optimize=True)
    print(f"{path}  {os.path.getsize(path)} bytes")
