# 관리자 가이드: 원클릭 패치

```
 내 컴 (커스포지 인스턴스에서 수정)
   │  patch.bat 더블클릭
   ▼
 GitHub 릴리스 ─────────────┬──────────────────────────────┐
   친구용: 모드팩            │ 서버용: 서버 패키지 (서버 스크립트·데이터는 암호화)
   ▼                         ▼
 친구 컴: 런처 "업데이트 후 시작"   서버 컴: 서버시작.bat (패치 받고 서버 켜기)
```

| 어디서 | 원클릭 | 하는 일 |
| --- | --- | --- |
| 내 컴 | `patch.bat` | 버전(Enter) → 패치노트(메모장) → `y` → 친구용·서버용 패치를 한 번에 업로드 |
| 친구 컴 | 런처 버튼 | 바뀐 파일만 받고 게임 실행 + 서버 자동 접속 |
| 서버 컴 | `서버시작.bat` | 최신 서버 패치를 받아 적용하고 서버 실행 |

**원본은 항상 커스포지 인스턴스**입니다. 모드·설정·KubeJS 스크립트는 인스턴스에서 고치고 테스트한 뒤
patch.bat 으로 내보냅니다. 서버 폴더를 직접 고치면 다음 패치 때 덮일 수 있습니다.

---

## 처음 한 번: 내 컴

1. Node.js LTS 설치 (이미 있으면 생략): https://nodejs.org
2. 저장소 폴더의 **`patch.bat` 더블클릭**
   - 커스포지 인스턴스 경로를 물어봅니다 (Enter = 기본값)
   - **서버 키**를 자동으로 만듭니다 (서버 스크립트 암호화용)
   - 배포 끝에 GitHub 토큰을 물어보고, **이 컴퓨터에 암호화해서 저장할지** 묻습니다.
     저장하면 다음부터 토큰 입력 없이 진짜 원클릭이 됩니다.
3. 끝나면 **`pack-dist-gh\server-kit` 폴더가 열립니다** → 아래 "서버 컴" 으로.

설정은 저장소 폴더의 `patch.local.json` 에 저장됩니다 (깃에 안 올라감).
여기에는 서버 키와 암호화된 토큰이 있으니 **다른 사람에게 주지 마세요.**
이 파일을 지우면 서버 키가 새로 만들어지고, 서버 컴의 키트도 다시 복사해야 합니다.

## 처음 한 번: 서버 컴

1. Node.js LTS 설치: https://nodejs.org
2. 내 컴의 `server-kit` 폴더 안 파일들을 **서버 폴더(run.bat 이 있는 곳)** 에 복사.
   **새 서버라면 빈 폴더**에 넣고 `서버시작.bat` 만 실행하면 됩니다. 자바(없으면), NeoForge 서버,
   모드팩 파일 전부를 알아서 설치하고, 마인크래프트 EULA 동의를 물어본 뒤 메모리를 설정하고 서버를 켭니다.
   (USB, 디스코드 나에게 보내기 등): `server-update.js`, `server-update.json`, `서버시작.bat`, `서버업데이트.bat`, `미리보기.bat`, `CLAUDE.md`
3. 서버를 run.bat 이 아닌 방법으로 켜 왔다면 `server-update.json` 의 `"start"` 를 그 명령으로 바꿈
4. **처음 적용 전에 `미리보기.bat`** 으로 바뀔 파일을 확인합니다. 서버가 직접 기록하는 데이터 파일
   (예: `kubejs/data/rpg/telemetry.json`)이 "받을 파일" 에 있으면 `server-update.json` 의
   `"keep"` 에 추가하세요. 그 파일은 서버에 있으면 절대 덮어쓰지 않습니다.
5. 앞으로 서버는 **`서버시작.bat`** 으로 켭니다.

서버 컴에 Claude Code 가 있다면 키트의 `CLAUDE.md` 가 서버 폴더에서 지켜야 할 규칙
(서버 폴더의 모드·설정은 직접 고치지 않기, 월드 작업 전 백업, 키 비밀 유지 등)을 알려줍니다.

서버 컴이 어느 네트워크에 있든 상관없습니다 (인터넷만 되면 GitHub 에서 받음).

## 매번: 패치 (1분)

1. 내 컴: 인스턴스에서 수정·테스트 → **`patch.bat`** → Enter → 패치노트 쓰고 저장·닫기 → `y`
2. 서버 컴: 서버 콘솔에 `stop` → **`서버시작.bat`** 더블클릭
3. 친구들: 런처를 켜면 업데이트가 뜸

patch.bat 이 "서버 키트가 바뀌었습니다" 라고 하면 (도구가 업데이트된 경우, 드묾)
그 폴더의 파일을 서버 컴에 다시 복사하세요.

---

## 무엇이 어디로 가나

| | 친구들 | 서버 |
| --- | --- | --- |
| `mods` | ✅ | ✅ (클라이언트 전용 모드 제외) |
| `config`, `defaultconfigs` | ✅ | ✅ |
| `kubejs/startup_scripts`, `client_scripts`, `assets` | ✅ | ✅ |
| `kubejs/server_scripts`, `kubejs/data` (`serverOnly`) | ❌ | ✅ (암호화해서 전달) |
| `kubejs/dev` 등 `exclude` | ❌ | ❌ |
| 리소스팩, 셰이더팩, `options.txt` | ✅ | ❌ |
| 월드, `server.properties`, 화이트리스트, OP, 서버에만 있는 모드 | — | 건드리지 않음 |

## 서버 데이터는 절대 바뀌지 않게

친구들 쪽은 패치로 통째로 바꿔도 되지만, **서버의 데이터는 패치로 바뀌면 안 됩니다.** 그래서 서버는 이렇게 동작합니다.

| 서버 파일 | 패치 때 |
| --- | --- |
| 월드, 플레이어 데이터, `world/serverconfig`, `server.properties`, 화이트리스트·OP·밴, 로그 | **절대 안 건드림** (패치 대상이 아님) |
| **관리자 관리 영역**: `mods`, `config`, `defaultconfigs`, `scripts`, `kubejs/startup_scripts`, `server_scripts`, `client_scripts`, `assets` | 관리자가 바꾸면 서버도 바꿈 (이전 내용은 백업) |
| **그 밖의 파일**: `kubejs/data`, `kubejs/config` 등 | 서버가 한 번이라도 바꿨으면 **관리자가 바꾸거나 지워도 서버 것을 그대로 둠** ("서버 데이터라 유지" 로 표시). 서버가 안 건드린 파일만 관리자 것으로 갱신 |

그리고 서버가 게임 중에 기록하는 데이터 파일은 **아예 배포하지 않게** 인스턴스의 `pack.config.json` 에 적어 두세요.
관리자 컴에서 테스트하며 생긴 데이터가 새 서버의 초기 데이터로 들어가는 것도 막아 줍니다.

```json
"serverData": ["kubejs/data/rpg/telemetry.json"]
```

서버 쪽에서도 `server-update.json` 의 `"keep"` 에 적은 파일은 무조건 서버 것을 유지합니다.
서버에서 바뀌거나 지워지는 파일은 `서버폴더\.update-backup\<날짜시각>\` 에 백업됩니다.

## 서버 스크립트 보호

- 서버 전용 파일은 **서버 키로 암호화**해서 올립니다 (AES-256). 키는 내 컴(`patch.local.json`)과
  서버 컴(`server-update.json`)에만 있습니다.
- 친구들이나 다른 사람이 GitHub 에서 파일을 받아도 서버 스크립트 내용은 볼 수 없습니다.
- 파일 목록(경로)도 암호화된 서버 패키지 안에만 있습니다.

## 서버가 안 켜질 때: 클라이언트 전용 모드

셰이더·렌더링·UI 모드처럼 클라이언트에서만 도는 모드가 서버에 들어가면 서버가 켜지지 않습니다.
Iris, Oculus, Embeddium, Sodium, ImmediatelyFast 등은 자동으로 빼지만, 목록에 없는 모드면 서버 로그에:

```
Attempted to load class net/minecraft/client/... for invalid dist DEDICATED_SERVER
```

→ 인스턴스의 `pack.config.json` 에 추가하고 다시 patch.bat.

```json
"clientOnly": ["mods/모드파일이름앞부분*"]
```

## 모드로더(NeoForge) 버전을 올렸을 때

친구들 런처와 서버 모두 자동입니다. 서버시작.bat 이 새 버전이 없는 걸 보고 공식 설치 파일로 서버용 NeoForge 를
설치합니다. 설치 후 `user_jvm_args.txt` 의 메모리 설정(-Xmx)이 남아 있는지만 확인하세요.

## 되돌리기

- 서버: `.update-backup` 폴더의 파일을 서버 폴더로 다시 복사
- 전체: 인스턴스를 이전 상태로 되돌린 뒤 **새 버전 번호로** 다시 patch.bat
  (예: 1.0.5 가 문제면 1.0.4 내용을 1.0.6 으로). 버전 번호가 바뀌면 그 내용으로 맞춰집니다.
- GitHub 의 **예전 릴리스는 지우지 마세요.** 바뀌지 않은 파일은 예전 릴리스에서 받습니다.

## GitHub 토큰

- GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token
- Repository access: `modpack` 만 / Permissions: **Contents: Read and write** / 만료 기간 지정 (예: 1년)
- 저장된 토큰이 만료되면 patch.bat 이 알려주고 다음 실행 때 새로 물어봅니다.
- 토큰을 채팅·디스코드에 붙여넣지 마세요. 노출되면 GitHub 에서 바로 Delete.

## 런처 배포: `launcher.bat`

런처 프로그램 자체를 고쳤을 때(디자인, 기능)만 씁니다. 모드팩 패치와는 상관없습니다.

1. 저장소 폴더의 **`launcher.bat` 더블클릭** → `y`
2. 빌드(몇 분) 후 GitHub `modpack` 저장소의 **`launcher` 릴리스**에 올라갑니다 (토큰은 patch.bat 이 저장한 것 사용).
3. 끝나면 폴더가 열립니다. 그 안의 **`KubejsRPG-Setup.exe`(1MB 남짓)** 를 친구들에게 디스코드로 보내면 됩니다.

- 친구가 설치 파일을 실행하면 GitHub 에서 런처 본체(약 100MB)를 받아 설치합니다.
- 설치 파일 주소는 버전과 상관없이 고정이라, **예전에 나눠 준 설치 파일로도 항상 최신 런처가 깔립니다.**
- `launcher` 릴리스는 "사전 배포" 로 만들어져서 모드팩 업데이트(최신 릴리스)와 섞이지 않습니다. 지우지 마세요.
- 버전 번호는 `launcher/package.json` 의 `version` 입니다 (설정 창 제목 옆에 보임).

## (선택) 같은 네트워크면 서버 폴더에 직접 반영

서버 폴더를 윈도우 네트워크로 공유했다면 `patch.local.json` 의 `"serverDir"` 에
`\\서버PC이름\공유이름` 을 적으면, patch.bat 이 GitHub 배포 전에 서버 폴더에도 바로 반영합니다
(`tools/sync-server.js`). 보통은 필요 없고 서버시작.bat 방식이 더 간단합니다.

## 명령으로 직접 하기

```powershell
cd <저장소>\launcher
$env:GITHUB_TOKEN="github_pat_..."; $env:SERVER_PACK_KEY="<patch.local.json 의 serverKey>"
node ..\tools\build-manifest.js --source "<인스턴스>" --out ..\pack-dist-gh --notes-file notes.md --publish
node ..\tools\make-server-kit.js --out ..\pack-dist-gh\server-kit --repo colddo118/modpack
```

`pack-dist-gh` 폴더는 지우지 마세요. 이전 버전 정보(패치노트 이력, 재사용할 파일 목록)가 들어 있습니다.
