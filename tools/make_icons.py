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

# 마스커블: 안드로이드가 가장자리를 잘라낸다. 확실히 보이는 곳은
# 지름 80% 짜리 원 안쪽 — 즉 중심에서 반지름 0.40 안에 다 들어와야 한다.
# 여백을 넉넉히 주면 안전하긴 한데 마이크가 우표만 해진다. 실측해서 맞춘다.
SAFE = 0.38  # 0.40 에 살짝 여유


def max_radius(img):
    """중심에서 잉크까지의 최대 거리 (아이콘 크기 대비 비율)."""
    px = img.convert("RGB").point(lambda v: 255 if v > 60 else 0).convert("L")
    x0, y0, x1, y1 = px.getbbox()
    c = img.width / 2
    dx = max(c - x0, x1 - c)
    dy = max(c - y0, y1 - c)
    return (dx ** 2 + dy ** 2) ** 0.5 / img.width


pad = 0.20
for _ in range(6):  # 몇 번만 돌려도 충분히 수렴한다
    got = max_radius(draw_mic(pad))
    if abs(got - SAFE) < 0.004:
        break
    pad += (got - SAFE) * 0.9

mask = draw_mic(pad)
save(mask, 512, "icon-maskable-512.png")
print(f"  (마스커블 여백 {pad:.3f} → 최대 반지름 {max_radius(mask):.3f}, 한계 0.40)")
print("완료")
