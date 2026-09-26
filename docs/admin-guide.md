# 관리자 가이드: 패치 배포하기

```
 커스포지 인스턴스 (내 개발용)
        │  patch.bat 더블클릭
        ├──────────────▶ 서버 폴더      mods / config / kubejs(서버 스크립트 포함) 반영
        └──────────────▶ GitHub 릴리스  친구들 런처가 자동으로 받아감 (서버 스크립트 제외)
```

**인스턴스가 원본**입니다. 모드 추가·삭제, 설정, KubeJS 스크립트는 전부 커스포지 인스턴스에서 고치고
테스트한 뒤, 패치 도구로 서버와 친구들에게 한 번에 내보냅니다. 서버 폴더를 직접 고치지 마세요
(다음 패치 때 인스턴스 내용으로 덮일 수 있습니다).

## 매번: 패치 배포 (5분)

1. 커스포지에서 인스턴스를 수정하고 싱글플레이 등으로 테스트
2. **서버를 끈다**
3. 저장소 폴더의 **`patch.bat` 더블클릭**
   - 새 버전 번호 (Enter 만 누르면 이전 버전 +1)
   - 메모장이 열리면 패치노트 작성 → 저장 → 닫기
   - 서버 폴더에 반영될 내용을 미리 보여줌 → `y`
   - 친구들에게 배포할지 확인 → `y` → GitHub 토큰 붙여넣기 (화면에 안 보이고 저장도 안 됨)
4. "완료!" 가 뜨면 **서버를 다시 켠다**
5. 끝. 친구들은 런처를 켜면 패치노트와 함께 업데이트가 뜹니다.

처음 실행할 때 인스턴스 폴더와 서버 폴더 경로를 한 번 물어보고 `patch.local.json` 에 저장합니다.
(경로를 바꾸려면 그 파일을 지우고 다시 실행)

## 서버 폴더에는 무엇이 반영되나

| | 서버 반영 | 친구들 배포 |
| --- | --- | --- |
| `mods` | ✅ (클라이언트 전용 모드 제외) | ✅ |
| `config`, `defaultconfigs` | ✅ | ✅ |
| `kubejs/startup_scripts`, `client_scripts`, `assets` | ✅ | ✅ |
| `kubejs/server_scripts`, `kubejs/data` | ✅ | ❌ (서버 전용) |
| `kubejs/dev` 등 `exclude` 항목 | ❌ | ❌ |
| 리소스팩, 셰이더팩, `options.txt` | ❌ | ✅ |
| 월드, `server.properties`, 화이트리스트, OP, 로그 | 건드리지 않음 | — |

- **mods** 는 항상 인스턴스와 똑같이 맞춥니다. 인스턴스에서 지운 모드는 서버에서도 지웁니다.
- **나머지 파일**은 인스턴스에서 바뀌었을 때만 덮어씁니다. 서버가 실행 중에 기록하는 파일
  (예: KubeJS 스크립트가 쓰는 데이터)은 관리자가 그 파일을 고치지 않는 한 보존됩니다.
- **서버에만 있는 모드**(권한 플러그인 등, 인스턴스에 없는 것)는 건드리지 않고 목록만 보여줍니다.
- 바뀌거나 지워진 파일의 원래 내용은 `<서버 폴더>\.sync-backup\<날짜시각>\` 에 백업됩니다.

## 서버가 안 켜질 때: 클라이언트 전용 모드

셰이더·렌더링 최적화·UI 모드처럼 **클라이언트에서만 도는 모드**가 서버에 들어가면 서버가 켜지지 않습니다.
Iris, Oculus, Embeddium, Sodium, ImmediatelyFast 등 흔한 것들은 자동으로 빼지만, 목록에 없는 모드가
문제를 일으키면 서버 로그에 보통 이런 줄이 나옵니다.

```
Attempted to load class net/minecraft/client/... for invalid dist DEDICATED_SERVER
```

그 모드의 파일 이름을 인스턴스의 `pack.config.json` 에 추가하고 다시 패치하면 서버에서 빠집니다.

```json
"clientOnly": ["mods/모드파일이름앞부분*"]
```

## 서버와 클라이언트 버전 맞추기

모드나 `startup_scripts` 가 바뀐 패치는 **서버와 친구들이 같은 버전**이어야 접속됩니다.
그래서 순서가 "서버 반영 → GitHub 배포 → 서버 켜기" 입니다. 이미 게임 중이던 친구는
게임을 끄고 런처를 다시 켜면 업데이트를 받습니다.

## 되돌리기

- **서버**: `.sync-backup` 폴더의 파일을 서버 폴더로 다시 복사
- **친구들**: 인스턴스를 이전 상태로 되돌린 뒤 **새 버전 번호로** 다시 배포 (예: 1.0.5 가 문제면
  1.0.4 내용을 1.0.6 으로 배포). 런처는 버전 번호가 달라지면 그 내용으로 맞춥니다.
- GitHub 의 **예전 릴리스는 지우지 마세요.** 바뀌지 않은 파일은 예전 릴리스에서 받습니다.

## GitHub 토큰

- GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token
- Repository access: `modpack` 저장소만 / Permissions: **Contents: Read and write**
- 만료 기간을 정해 두고(예: 1년) 비밀번호 관리자 등에 보관하면 패치 때마다 새로 만들 필요가 없습니다.
- 토큰을 채팅·디스코드·파일에 붙여넣지 마세요. 노출되면 바로 GitHub 에서 Delete.

## 명령으로 직접 하기 (patch.bat 이 하는 일)

```powershell
cd <저장소>\launcher
# 서버 반영 미리보기 → 실제 반영
node ..\tools\sync-server.js --source "<인스턴스>" --server "<서버 폴더>" --dry-run
node ..\tools\sync-server.js --source "<인스턴스>" --server "<서버 폴더>"
# GitHub 배포 (--version 생략 시 이전 버전 +1)
$env:GITHUB_TOKEN="github_pat_..."
node ..\tools\build-manifest.js --source "<인스턴스>" --out ..\pack-dist-gh --notes-file notes.md --publish
```

`pack-dist-gh` 폴더는 지우지 마세요. 이전 버전 정보(패치노트 이력, 재사용할 파일 목록)가 들어 있습니다.
