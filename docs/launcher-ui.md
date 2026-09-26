# 런처 화면(UI) 수정 가이드

런처 화면은 `launcher/src/renderer/` 의 세 파일이 전부입니다.

| 파일 | 역할 | 수정 |
| --- | --- | --- |
| `index.html` | 화면 구조 | 자유롭게. 단 아래 **ID 는 유지** |
| `styles.css` | 모양 | 자유롭게. 단 아래 **상태 클래스는 스타일 유지** |
| `renderer.js` | 버튼 동작, 진행률, 패치노트 표시 | 되도록 건드리지 않기 |

`launcher/src/main/`(업데이트·설치·로그인·실행)은 화면과 무관하므로 디자인 작업에서 수정하지 않습니다.

## 반드시 남겨야 하는 요소 ID

`renderer.js` 가 이 ID 로 요소를 찾습니다. 위치·모양·태그는 바꿔도 되지만 ID 가 없어지면 해당 기능이 멈춥니다.

| ID | 용도 |
| --- | --- |
| `app-name` | 런처 이름 (launcher.config.json 의 appName 이 들어감) |
| `pack-meta` | "모드팩 이름 · Minecraft 1.21.1 · neoforge ..." |
| `account-name`, `account-sub`, `login-btn`, `logout-btn` | 계정 이름 / 그 아래 보조 줄 / 로그인 / 로그아웃 |
| `link-discord`, `link-website` | 링크 버튼 (config 에 주소가 없으면 자동으로 숨김) |
| `changelog` | 패치노트 목록이 채워지는 곳 |
| `update-badge` | "새 업데이트" 배지 (지금은 상태 줄과 NEW 표시로 충분해서 띄우지 않음) |
| `status-text` | 상태 문구 (굵은 한 줄, 오류) |
| `status-detail` | 상태 아래 흐린 보조 줄 (파일 수·용량 등, 비면 숨김) |
| `progress-bar` | 진행률 막대 (JS 가 `width` 를 % 로 바꿈) |
| `progress-pct` | 진행 중일 때만 나오는 % |
| `facts`, `version-text`, `server-row`, `server-text` | 버전 (`v1.0.1 → v1.0.2`) · 서버 주소 |
| `play-btn` | 메인 버튼 (설치 후 시작 / 업데이트 후 시작 / 게임 시작 / 실행 중) |
| `settings-btn` | 설정 열기 |
| `settings` | 설정 창 (`<dialog>` 요소여야 함, `<form method="dialog">` 포함) |
| `mem-input`, `mem-value`, `mem-total` | 메모리 슬라이더 / 현재 값 / PC 전체 메모리 |
| `launcher-version` | 설정 창 제목 오른쪽 런처 버전 |
| `autoconnect-input`, `hide-input`, `jvm-input` | 설정 항목 |
| `open-folder-btn`, `open-logs-btn`, `repair-btn` | 게임 폴더 / 로그 폴더 / 파일 검사·복구 |

설정 창의 저장 버튼은 `value="save"`, 취소는 `value="cancel"` 이어야 합니다.

## 상태에 따라 JS 가 붙이는 클래스 (스타일을 꼭 지정)

| 클래스 | 붙는 곳 | 의미 |
| --- | --- | --- |
| `.hidden` | 여러 요소 | 숨김 (`display: none !important` 유지) |
| `#play-btn.update` | 메인 버튼 | 설치·업데이트가 필요한 상태 (지금은 주황색) |
| `#play-btn:disabled` | 메인 버튼 | 확인 중 / 실행 중 |
| `#status-text.error` | 상태 문구 | 오류. **여러 줄로 줄바꿈되게** 유지 (긴 안내문이 잘리면 안 됨) |
| `.entry`, `.entry.new` | 패치노트 항목 | 버전별 항목 / 새 버전 |
| `.entry-head`, `.ver`, `.badge` | 패치노트 항목 머리 | 버전 번호, 날짜, NEW 배지 |
| `.entry h3`, `.entry ul`, `.entry p` | 패치노트 본문 | `#` 제목, `-` 목록, 일반 문장 |
| `.muted`, `.small` | 곳곳 | 흐린 글씨, 작은 글씨 |

## 보안 규칙 (Content-Security-Policy)

`index.html` 머리의 CSP 때문에 **외부 주소에서 아무것도 불러올 수 없습니다** (구글 폰트, CDN 이미지 등).

- 폰트·이미지·아이콘은 `launcher/src/renderer/assets/` 폴더에 파일로 넣고 상대경로로 씁니다.
  예: `url('assets/fonts/MyFont.woff2')`, `<img src="assets/logo.png">`
- 인라인 `<script>` / `onclick="..."` 는 막혀 있습니다. 동작이 필요하면 `renderer.js` 에 추가합니다.
- 모드팩 텍스처(예: `kubejs/assets/.../textures/gui/*.png`)를 쓰려면 `assets/` 로 복사해서 씁니다.
  픽셀아트는 `image-rendering: pixelated;` 를 주면 흐려지지 않습니다.
  9-slice 창 테두리는 `border-image` 로 구현할 수 있습니다.

## 창 크기

`launcher/src/main/main.js` 의 `createWindow` 에서 기본 980×620, 최소 820×540 입니다.
디자인에 맞춰 이 숫자만 바꾸는 건 괜찮습니다.

## 앱 아이콘 (exe, 작업표시줄, 바로가기)

`launcher/build/icon.ico` (256×256 포함) 를 넣으면 electron-builder 가 자동으로 씁니다.
PNG 만 있으면 `launcher/build/icon.png` (512×512 이상) 도 됩니다.

## 미리보기

```powershell
cd launcher
$env:MODPACK_MANIFEST_URL="https://github.com/colddo118/modpack/releases/latest/download/manifest.json"; npm start
```

화면을 고친 뒤 창에서 `Ctrl+R` 을 누르면 다시 불러옵니다 (main 폴더를 고쳤으면 껐다 켜야 함).
여러 상태(업데이트 있음, 오류, 진행 중, 설정 창)를 모두 눈으로 확인하세요.

## 끝나면

```powershell
cd launcher
npm test        # 전부 pass 인지 (화면 수정으로 깨질 일은 거의 없지만 확인)
```

그다음 같은 브랜치(`claude/minecraft-modpack-auto-launcher-ske8f8`)에 커밋·푸시합니다.
