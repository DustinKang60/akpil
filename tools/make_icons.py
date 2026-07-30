# 악필 아이콘 생성기 — 다시 만들 일이 생기면 이걸 돌린다.
#   python tools/make_icons.py
from PIL import Image, ImageDraw
import os

BG = (11, 13, 17)       # --bg
NEON = (0, 229, 160)    # --neon
OUT = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(OUT, exist_ok=True)

S = 1024  # 크게 그린 뒤 줄여서 계단 현상을 없앤다


def draw_mic(pad_ratio):
    """가운데 마이크 하나. pad_ratio 만큼 여백을 둔다."""
    img = Image.new("RGBA", (S, S), BG + (255,))
    d = ImageDraw.Draw(img)
    c = S / 2
    r = S * (0.5 - pad_ratio)  # 아이콘이 차지할 반지름

    w = r * 0.42               # 마이크 몸통 너비
    top = c - r * 0.78
    bot = c + r * 0.10
    d.rounded_rectangle([c - w / 2, top, c + w / 2, bot], radius=w / 2, fill=NEON)

    # 아래를 감싸는 반원 아크
    aw = r * 0.155
    ar = r * 0.60
    d.arc([c - ar, c - ar, c + ar, c + ar], start=0, end=180, fill=NEON, width=int(aw))

    # 스탠드
    d.rounded_rectangle(
        [c - aw / 2, c + ar - aw / 2, c + aw / 2, c + r * 0.86],
        radius=aw / 2, fill=NEON,
    )
    # 받침
    bw = r * 0.52
    d.rounded_rectangle(
        [c - bw / 2, c + r * 0.78, c + bw / 2, c + r * 0.90],
        radius=aw / 2, fill=NEON,
    )
    return img


def save(img, size, name):
    img.resize((size, size), Image.LANCZOS).convert("RGB").save(
        os.path.join(OUT, name), "PNG", optimize=True
    )
    print("  icons/" + name)


print("아이콘 생성:")
normal = draw_mic(0.20)
save(normal, 192, "icon-192.png")
save(normal, 512, "icon-512.png")
save(normal, 180, "icon-180.png")   # 아이폰 홈화면
save(normal, 32, "favicon-32.png")

# 마스커블: 안드로이드가 가장자리를 잘라내므로 안전 영역(중앙 80%) 안에 그린다
save(draw_mic(0.30), 512, "icon-maskable-512.png")
print("완료")
