#!/usr/bin/env node
'use strict'

// 서버 컴에 한 번 복사할 "서버 키트" 폴더를 만든다.
//   server-update.js   서버 패치 도구 (필요한 코드를 한 파일로 묶음, Node.js 만 있으면 됨)
//   server-update.json 저장소 이름 + 서버 키 + 서버 실행 명령
//   서버시작.bat        패치 받고 서버 켜기 (평소엔 이것만 더블클릭)
//   서버업데이트.bat    패치만 받기
//   맵보내기.bat        서버 월드의 대륙 맵을 관리자 컴으로 보내기 (GitHub 토큰 필요)
//   맵초기화.bat        오버월드 · 네더 · 엔드를 점유 청크만 남기고 초기화 (백업 먼저)
//
//   node tools/make-server-kit.js --out <폴더> --repo 아이디/modpack   (키는 SERVER_PACK_KEY 환경변수)

const fs = require('node:fs')
const path = require('node:path')

// 상대경로 require 를 따라가며 모듈들을 한 파일로 묶는다 (node: 내장 모듈은 그대로)
function bundle (entryAbs) {
  const modules = new Map()
  const add = abs => {
    if (modules.has(abs)) return modules.get(abs).id
    const rec = { id: modules.size, code: '' }
    modules.set(abs, rec)
    let code = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF?#![^\n]*\n/, '') // CRLF·BOM 체크아웃에서도
    code = code.replace(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g, (_m, _q, rel) => {
      let target = path.resolve(path.dirname(abs), rel)
      if (!target.endsWith('.js')) target += '.js'
      return `__kit(${add(target)})`
    })
    rec.code = code
    return rec.id
  }
  const entry = add(entryAbs)
  const defs = [...modules.entries()].map(([abs, { id, code }]) =>
    `  // ${path.relative(path.resolve(__dirname, '..'), abs).split(path.sep).join('/')}\n  ${id}: function (module, exports) {\n${code}\n  }`)
  return `#!/usr/bin/env node
// 자동 생성 파일 (tools/make-server-kit.js). 직접 고치지 마세요.
'use strict'
const __defs = {
${defs.join(',\n')}
}
const __cache = {}
function __kit (id) {
  if (__cache[id]) return __cache[id].exports
  const module = { exports: {} }
  __cache[id] = module
  __defs[id](module, module.exports)
  return module.exports
}
__kit(${entry}).main().catch(e => { console.error('✘ ' + e.message + (e.cause ? ' (' + (e.cause.code || e.cause.message) + ')' : '')); process.exit(1) })
`
}

const START_BAT = `@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install the LTS version from https://nodejs.org & pause & exit /b 1)
node server-update.js --start
pause
`

const UPDATE_BAT = `@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install the LTS version from https://nodejs.org & pause & exit /b 1)
node server-update.js
pause
`

const RESTORE_BAT = `@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install the LTS version from https://nodejs.org & pause & exit /b 1)
node server-update.js --restore
pause
`

const CHECK_BAT = `@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install the LTS version from https://nodejs.org & pause & exit /b 1)
node server-update.js --check
pause
`

const MAPSEND_BAT = `@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install the LTS version from https://nodejs.org & pause & exit /b 1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0map-send.ps1"
pause
`

const RESETMAP_BAT = `@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install the LTS version from https://nodejs.org & pause & exit /b 1)
node server-update.js --reset-map
pause
`

// 토큰은 이 윈도우 계정으로만 풀리게 암호화해서 .map-token 에 둔다 (patch.ps1 과 같은 방식)
const MAPSEND_PS1 = `# 맵보내기.bat 에서 실행: 서버 월드의 대륙 맵을 관리자 컴으로 보낸다 (GitHub server-map 릴리스, 서버 키로 암호화)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$TokenFile = Join-Path $PSScriptRoot '.map-token'

function Plain($secure) {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

Write-Host ''
Write-Host '=== 대륙 맵 보내기 (서버는 꺼져 있어야 합니다) ===' -ForegroundColor Cyan
$secure = $null
if (Test-Path $TokenFile) {
  try { $secure = ConvertTo-SecureString ((Get-Content $TokenFile -Raw).Trim()) } catch { $secure = $null }
}
$isNew = $false
if (-not $secure) {
  Write-Host 'GitHub 토큰을 붙여넣습니다: 창에 마우스 오른쪽 클릭 → Enter (Ctrl+V 는 안 됩니다. 화면엔 * 만 보임)' -ForegroundColor Cyan
  $secure = Read-Host 'GitHub 토큰' -AsSecureString
  $isNew = $true
}
$plain = (Plain $secure).Trim()
if ($plain -notmatch '^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$') {
  $plain = $null
  if (-not $isNew) { Remove-Item $TokenFile -Force -ErrorAction SilentlyContinue }
  Write-Host '토큰 모양이 아닙니다. 맵보내기.bat 을 다시 실행해 github_pat_ 로 시작하는 토큰 전체를 붙여넣으세요.' -ForegroundColor Yellow
  exit 1
}
$env:GITHUB_TOKEN = $plain
$plain = $null
try {
  & node server-update.js --send-map
  $code = $LASTEXITCODE
} finally {
  Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
}
if ($code -eq 0 -and $isNew) {
  ConvertFrom-SecureString $secure | Set-Content $TokenFile -Encoding ASCII
  Write-Host '토큰을 이 컴퓨터(이 윈도우 계정)에서만 풀 수 있게 암호화해서 .map-token 에 저장했습니다.' -ForegroundColor DarkGray
}
if ($code -ne 0 -and -not $isNew) {
  Write-Host '토큰이 만료되었으면 .map-token 파일을 지우고 다시 실행하세요.' -ForegroundColor Yellow
}
exit $code
`

const CLAUDE_MD = `# 이 폴더: KubejsRPG 마인크래프트 서버 (NeoForge)

이 문서는 이 서버 컴에서 일하는 Claude Code 를 위한 안내입니다. 작업 전에 끝까지 읽으세요.

## 구조
- 이 서버의 mods / config / defaultconfigs / kubejs / scripts 는 **관리자 컴의 커스포지 인스턴스가 원본**입니다.
  관리자가 patch.bat 으로 GitHub 릴리스에 올리면, 이 폴더의 server-update.js 가 받아서 적용합니다.
- 서버 스크립트(kubejs/server_scripts, kubejs/data)는 암호화되어 오고, server-update.json 의 키로 풉니다.
- 평소 운영: 서버를 끄고(콘솔에 stop) \`서버시작.bat\` → 최신 패치 적용 후 서버 실행.
- 빈 폴더에 키트만 넣고 \`서버시작.bat\` 을 실행해도 서버가 만들어집니다: 자바(없으면) → NeoForge 서버 설치
  → 모드팩 파일 전부 → EULA 동의 질문 → 메모리 설정 → 서버 실행.

## 파일
| 파일 | 용도 |
| --- | --- |
| server-update.js | 서버 패치 도구 (자동 생성, 고치지 말 것) |
| server-update.json | repo, key(비밀), start(서버 실행 명령), keep(보존 목록) |
| 서버시작.bat / 서버업데이트.bat / 미리보기.bat | 패치+실행 / 패치만 / 바뀔 내용만 보기 |
| .server-update-state.json | 마지막으로 적용한 버전과 파일 기록 (고치지 말 것) |
| .update-backup/<시각>/ | 패치로 바뀌거나 지워진 파일의 이전 내용 |
| backups/ (server-update.json 의 backup.dir) | 월드 증분 백업. objects/ = 파일 내용, snapshots/ = 백업 시점별 목록. **직접 고치거나 지우지 말 것** |
| 백업복원.bat | 백업 목록에서 골라 월드 되돌리기 |
| 맵보내기.bat / map-send.ps1 | 서버 월드의 대륙 맵을 관리자 컴으로 보내기 (서버 끈 상태에서) |
| 맵초기화.bat | 오버월드 · 네더 · 엔드를 FTB 점유 청크만 남기고 초기화 (서버 끈 상태에서, 백업 먼저) |
| .map-token | 맵보내기용 GitHub 토큰 (이 윈도우 계정으로 암호화, **출력 · 복사 금지**) |

## 서버 데이터 보호 (server-update.js 가 지키는 원칙)
- 월드, 플레이어 데이터, server.properties, 화이트리스트/OP/밴, 로그는 패치 대상이 아니라 절대 안 바뀝니다.
  **예외: 대륙 맵.** 관리자가 패치에 맵을 실으면 world/dimensions/kubejs/continent 의 region · poi 중
  관리자가 싱글 월드에서 고친 파일만 덮습니다 (관리자가 안 고친 region 은 서버 것 그대로, 맵 파일은 지우지 않음).
  덮이는 파일은 .update-backup 에, 월드 전체는 서버시작.bat 의 백업에 남습니다.
- mods / config / defaultconfigs / scripts / kubejs 의 startup_scripts·server_scripts·client_scripts·assets 는
  관리자 관리 영역이라 관리자가 바꾸면 서버도 바뀝니다 (백업 후).
- kubejs/config · kubejs/data(맵 설정 · 퀘스트 · 몹 표 등)도 관리자 관리 영역입니다(2026-10-09). 단 서버가 실행 중에 쓰는
  kubejs/data/rpg(원장 · 시세 · 기록)와 kubejs/config/*.generated.json 은 서버가 한 번이라도 바꿨으면 그대로 둡니다.
  서버에서 운영 명령(/마을 NPC · /배편 선장)으로 바꾼 자리는 다음 관리자 패치에 덮이니, 자리는 관리자 인스턴스에서 정하세요.
- server-update.json 의 "keep" 에 적은 파일은 무조건 서버 것을 유지합니다.

## 규칙
1. **mods / config / defaultconfigs / kubejs / scripts 를 직접 고치지 마세요.** 다음 패치 때 덮이거나,
   관리자 인스턴스와 어긋납니다. 고쳐야 할 게 있으면 "관리자 인스턴스에서 무엇을 바꿔야 하는지" 를 정리해서
   사용자에게 알려주세요. (긴급 임시 조치가 꼭 필요하면 사용자 확인 후, 그리고 반드시 알려줄 것)
2. server.properties, whitelist.json, ops.json, banned-*.json, 서버 실행 스크립트(run.bat, user_jvm_args.txt)는
   서버 고유 설정이라 사용자 확인 후 고쳐도 됩니다.
3. **월드 폴더(world 등)를 건드리는 작업 전에는 반드시 백업**하고, 서버가 꺼져 있는지 확인하세요.
4. server-update.json 의 key 는 비밀입니다. 출력하거나, 채팅에 적거나, 다른 곳에 복사하지 마세요.
5. 서버가 켜져 있는 동안 mods 나 설정 파일을 바꾸지 마세요.

## 자주 하는 일
- **바뀔 내용 미리보기**: \`node server-update.js --check\` (아무것도 안 바꿈)
- **서버가 직접 기록하는 데이터 보존**: 미리보기에 서버 데이터 파일(예: kubejs/data/rpg/telemetry.json)이
  "받을 파일" 로 나오면, server-update.json 의 "keep" 배열에 그 경로를 추가하면 절대 덮어쓰지 않습니다.
- **서버가 안 켜질 때**: logs/latest.log 와 crash-reports/ 최신 파일을 읽고 원인을 찾으세요.
  - \`Attempted to load class net/minecraft/client/... for invalid dist DEDICATED_SERVER\` →
    클라이언트 전용 모드가 서버에 있음. 어떤 모드인지 찾아서, 관리자 인스턴스의 pack.config.json 에
    \`"clientOnly": ["mods/파일이름앞부분*"]\` 를 추가하라고 사용자에게 알려주세요.
  - 모드 버전 불일치, 의존성 누락 → 어느 모드인지 정리해서 알려주세요 (고치는 건 관리자 인스턴스에서).
- **NeoForge 서버 설치/버전 업**: server-update.js 가 자동으로 합니다 (자바가 없으면 서버 폴더 runtime 에 받음,
  공식 설치 파일을 받아 서버 모드로 설치). 자동 설치가 실패하면 출력을 읽고 원인을 보고하세요.
  NeoForge 가 새로 설치되면 user_jvm_args.txt 의 -Xmx 가 남아 있는지 확인하세요.
- **되돌리기**: .update-backup/<시각>/ 의 파일을 제자리로 복사.
- **월드 백업**: 서버시작.bat 이 서버를 켜기 전에 자동으로 한다 (바뀐 파일만 저장, 최근 backup.keep 개 보관).
  월드를 되돌려야 하면 서버를 끄고 백업복원.bat. 백업을 다른 드라이브에 두려면 server-update.json 의
  backup.dir 을 "D:/KubejsRPG-backup" 처럼 바꾼다 (기존 backups 폴더는 통째로 옮겨도 됨).
  backups 폴더를 직접 정리하지 말 것 (오래된 백업은 자동으로 지워짐).
- **대륙 맵 관리자에게 보내기**: 서버를 끄고 \`맵보내기.bat\`. 처음 한 번 GitHub 토큰을 묻는다
  (관리자에게 받은 토큰, modpack 저장소 Contents 읽기·쓰기). 바뀐 region 만 새로 올라간다.
  관리자가 patch.bat 을 실행하면 받을지 묻는다. 토큰 값은 절대 출력하지 말 것.
- **맵 초기화**: 관리자가 시킬 때만. 서버를 끄고 \`맵초기화.bat\` → 미리보기를 보여 주고 '초기화' 를 입력해야 진행.
  FTB 점유 · /forceload · 시련의 탑 수정구 청크만 남기고 오버월드 · 네더 · 엔드의 나머지 청크를 지운다
  (같은 시드로 다시 생김). 대륙 · 던전 차원, 인벤토리 · 레벨 · 돈은 그대로. 진행 전에 백업을 자동으로 받는다.
`

const README = `KubejsRPG 서버 키트
====================

처음 한 번:
 1. 서버 컴에 Node.js (LTS) 를 설치합니다: https://nodejs.org
 2. 이 폴더 안의 파일을 서버 폴더에 복사합니다.
    새 서버라면 빈 폴더에 넣으면 됩니다. 서버시작.bat 을 실행하면 자바·NeoForge 서버·모드팩을 알아서 설치하고,
    마인크래프트 EULA 동의를 물어본 뒤 서버를 켭니다.
    server-update.js / server-update.json / 서버시작.bat / 서버업데이트.bat / 미리보기.bat / 백업복원.bat / 맵보내기.bat / 맵초기화.bat / map-send.ps1 / CLAUDE.md
 3. 서버를 run.bat 이 아닌 다른 방법으로 켠다면 server-update.json 의 "start" 를 그 명령으로 바꿉니다.

처음 적용 전 (기존 서버에 처음 넣을 때):
 - 미리보기.bat 으로 바뀔 파일 목록을 먼저 확인하세요.
 - 서버가 직접 기록하는 데이터 파일이 목록에 있으면 server-update.json 의 "keep" 에 추가하세요.

평소:
 - 서버를 끄고(콘솔에 stop) 서버시작.bat 더블클릭 → 최신 패치를 받고 서버가 켜집니다.
 - 패치만 받고 싶으면 서버업데이트.bat, 바뀔 내용만 보려면 미리보기.bat.
 - 서버 컴의 Claude Code 는 CLAUDE.md 를 읽고 이 규칙대로 일합니다.

대륙 맵:
 - 관리자가 패치에 맵을 실으면, 서버시작.bat 이 관리자가 고친 region 파일만 덮습니다 (나머지는 서버 것 그대로).
 - 서버 맵을 관리자에게 보내려면: 서버를 끄고 맵보내기.bat (처음 한 번 GitHub 토큰을 물어봅니다).

맵 초기화 (오버월드 · 네더 · 엔드):
 - 서버를 끄고 맵초기화.bat → 남길 청크 · 지울 청크 수를 먼저 보여 주고, '초기화' 를 입력해야 진행합니다.
 - FTB 로 점유한 청크(건물 · 상자 · 상자 안 아이템)는 그대로, 나머지 땅은 같은 시드로 새로 생깁니다.
 - 진행 전에 월드를 자동 백업합니다. 되돌리려면 백업복원.bat.

월드 백업:
 - 서버시작.bat 이 서버를 켜기 전에 월드를 자동 백업합니다 (처음만 오래 걸리고, 그다음부터는 바뀐 부분만).
 - 되돌리려면 서버를 끄고 백업복원.bat → 번호 선택.
 - 백업 위치/개수는 server-update.json 의 "backup" 에서 바꿉니다 ("dir": "D:/KubejsRPG-backup" 처럼 다른 드라이브 추천).

주의:
 - server-update.json 에는 서버 스크립트를 푸는 키가 들어 있습니다. 다른 사람에게 주지 마세요.
 - 월드, server.properties 등은 건드리지 않습니다 (대륙 맵 예외는 위). 바뀌거나 지워지는 파일은 .update-backup 에 백업됩니다.
 - .map-token 은 GitHub 토큰입니다. 다른 사람에게 주지 마세요.
`

function makeKit ({ out, repo, key, start = 'run.bat' }) {
  if (!repo) throw new Error('--repo 가 필요합니다 (예: 아이디/modpack)')
  if (!key) throw new Error('서버 키가 필요합니다 (SERVER_PACK_KEY)')
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'server-update.js'), bundle(path.join(__dirname, 'server-update.js')))
  const cfgPath = path.join(out, 'server-update.json')
  // 서버 쪽에서 바꿔 둔 start / keep 은 유지
  let prev = {}
  try { prev = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) } catch {}
  // backup.dir 은 다른 드라이브(예: "D:/KubejsRPG-backup")로 바꿔도 된다
  fs.writeFileSync(cfgPath, JSON.stringify({ repo, key, start: prev.start || start, keep: prev.keep || [], backup: prev.backup || { enabled: true, dir: 'backups', keep: 10 } }, null, 2))
  fs.writeFileSync(path.join(out, '서버시작.bat'), START_BAT.replace(/\n/g, '\r\n'))
  fs.writeFileSync(path.join(out, '서버업데이트.bat'), UPDATE_BAT.replace(/\n/g, '\r\n'))
  fs.writeFileSync(path.join(out, '미리보기.bat'), CHECK_BAT.replace(/\n/g, '\r\n'))
  fs.writeFileSync(path.join(out, '백업복원.bat'), RESTORE_BAT.replace(/\n/g, '\r\n'))
  fs.writeFileSync(path.join(out, '맵보내기.bat'), MAPSEND_BAT.replace(/\n/g, '\r\n'))
  fs.writeFileSync(path.join(out, '맵초기화.bat'), RESETMAP_BAT.replace(/\n/g, '\r\n'))
  // 윈도우 PowerShell 5.1 은 BOM 이 없으면 한글을 깨뜨린다
  fs.writeFileSync(path.join(out, 'map-send.ps1'), '\uFEFF' + MAPSEND_PS1.replace(/\n/g, '\r\n'))
  fs.writeFileSync(path.join(out, 'CLAUDE.md'), CLAUDE_MD)
  fs.writeFileSync(path.join(out, '읽어주세요.txt'), '﻿' + README.replace(/\n/g, '\r\n'))
  return out
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const get = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }
  try {
    const out = makeKit({ out: path.resolve(get('out') || 'server-kit'), repo: get('repo'), key: process.env.SERVER_PACK_KEY })
    console.log(`✔ 서버 키트: ${out}`)
  } catch (e) {
    console.error(`✘ ${e.message}`)
    process.exit(1)
  }
}

module.exports = { makeKit, bundle }
