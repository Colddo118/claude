"""
런처 장식 테두리(assets/frame-knot.png, 9-slice)를 참고 이미지에서 그대로 떠 온다.
  python3 make-frames.py <참고 이미지.png>
참고 이미지의 네 모서리(매듭 무늬)와 변 한가운데 단면을 픽셀 그대로 잘라 붙이고,
밝기만 런처 금색 단계로 바꾼다. 창 속 배경색(어두운 부분)은 투명으로.
"""
import sys
from PIL import Image

N = 12                                   # 모서리 크기 (참고 이미지 픽셀 = GUI 픽셀)
DARK, BRIGHT = (104, 86, 58), (232, 196, 124)
OUTLINE = (14, 11, 8, 255)

def recolor(p):
    r, g, b, a = p
    if a == 0: return (0, 0, 0, 0)
    if (r, g, b) == (0, 0, 0): return OUTLINE
    lum = (r + g + b) / 3
    if lum < 56: return (0, 0, 0, 0)       # 창 속 배경
    t = max(0.0, min(1.0, (lum - 58) / (92 - 58)))
    return tuple(round(DARK[i] + (BRIGHT[i] - DARK[i]) * t) for i in range(3)) + (255,)

def main(src, out):
    ref = Image.open(src).convert('RGBA')
    x0, y0, x1, y1 = ref.getbbox()
    W, H = x1 - x0, y1 - y0
    ref = ref.crop((x0, y0, x1, y1))
    S = 2 * N + 1
    nine = Image.new('RGBA', (S, S))
    # 네 모서리는 원본의 각 모서리를 그대로
    nine.paste(ref.crop((0, 0, N, N)), (0, 0))
    nine.paste(ref.crop((W - N, 0, W, N)), (N + 1, 0))
    nine.paste(ref.crop((0, H - N, N, H)), (0, N + 1))
    nine.paste(ref.crop((W - N, H - N, W, H)), (N + 1, N + 1))
    # 변은 한가운데 단면 한 줄
    mx, my = W // 2, H // 2
    nine.paste(ref.crop((mx, 0, mx + 1, N)), (N, 0))
    nine.paste(ref.crop((mx, H - N, mx + 1, H)), (N, N + 1))
    nine.paste(ref.crop((0, my, N, my + 1)), (0, N))
    nine.paste(ref.crop((W - N, my, W, my + 1)), (N + 1, N))
    nine.putdata([recolor(nine.getpixel((x, y))) for y in range(S) for x in range(S)])
    nine.putpixel((N, N), (0, 0, 0, 0))
    nine.save(out)
    return nine

if __name__ == '__main__':
    import os
    here = os.path.dirname(os.path.abspath(__file__))
    img = main(sys.argv[1], os.path.join(here, '..', 'src', 'renderer', 'assets', 'frame-knot.png'))
    print('saved', img.size)
