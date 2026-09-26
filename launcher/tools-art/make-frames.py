from PIL import Image
A = (214, 176, 104, 255)   # 밝은 금 (앞 사각형)
B = (150, 120, 76, 255)    # 중간 금 (뒤 사각형)
L = (110, 92, 64, 255)     # 테두리 선
N = 9                      # 모서리 크기 (GUI 픽셀)

def square(px, x0, y0, x1, y1, col):
    for x in range(x0, x1 + 1):
        px[(x, y0)] = col; px[(x, y1)] = col
    for y in range(y0, y1 + 1):
        px[(x0, y)] = col; px[(x1, y)] = col

def corner():
    px = {}
    # 테두리 선: y=1 (위), x=1 (왼쪽) — 매듭 뒤로 들어감
    for i in range(N):
        px[(i, 1)] = L; px[(1, i)] = L
    square(px, 3, 3, 7, 7, B)       # 뒤 사각형
    square(px, 1, 1, 5, 5, A)       # 앞 사각형 (테두리 선과 겹침)
    px[(5, 3)] = B                  # 엮임: 여기서는 뒤 사각형이 위로
    px[(0, 1)] = (0, 0, 0, 0); px[(1, 0)] = (0, 0, 0, 0)
    im = Image.new('RGBA', (N, N))
    for (x, y), c in px.items():
        if 0 <= x < N and 0 <= y < N: im.putpixel((x, y), c)
    return im

c = corner()
S = 2 * N + 1
nine = Image.new('RGBA', (S, S))
nine.paste(c, (0, 0))
nine.paste(c.transpose(Image.FLIP_LEFT_RIGHT), (N + 1, 0))
nine.paste(c.transpose(Image.FLIP_TOP_BOTTOM), (0, N + 1))
nine.paste(c.transpose(Image.ROTATE_180), (N + 1, N + 1))
for (x, y) in [(N, 1), (N, S - 2), (1, N), (S - 2, N)]:
    nine.putpixel((x, y), L)
nine.save('/home/user/claude/launcher/src/renderer/assets/frame-knot.png')
nine.resize((S * 14, S * 14), Image.NEAREST).save('/tmp/claude-0/-home-user-claude/64bca945-fb9f-50b7-b37b-73b0b22dca04/scratchpad/knot-big.png')
print('size', S)
