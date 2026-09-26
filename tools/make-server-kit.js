#!/usr/bin/env node
'use strict'

// 서버 컴에 한 번 복사할 "서버 키트" 폴더를 만든다.
//   server-update.js   서버 패치 도구 (필요한 코드를 한 파일로 묶음, Node.js 만 있으면 됨)
//   server-update.json 저장소 이름 + 서버 키 + 서버 실행 명령
//   서버시작.bat        패치 받고 서버 켜기 (평소엔 이것만 더블클릭)
//   서버업데이트.bat    패치만 받기
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
    let code = fs.readFileSync(abs, 'utf8').replace(/^#!.*\n/, '')
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
__kit(${entry}).main().catch(e => { console.error('✘ ' + e.message); process.exit(1) })
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

const README = `KubejsRPG 서버 키트
====================

처음 한 번:
 1. 서버 컴에 Node.js (LTS) 를 설치합니다: https://nodejs.org
 2. 이 폴더 안의 파일 4개를 서버 폴더(run.bat 이 있는 곳)에 복사합니다.
    server-update.js / server-update.json / 서버시작.bat / 서버업데이트.bat
 3. 서버를 run.bat 이 아닌 다른 방법으로 켠다면 server-update.json 의 "start" 를 그 명령으로 바꿉니다.

평소:
 - 서버를 끄고(콘솔에 stop) 서버시작.bat 더블클릭 → 최신 패치를 받고 서버가 켜집니다.
 - 패치만 받고 싶으면 서버업데이트.bat.

주의:
 - server-update.json 에는 서버 스크립트를 푸는 키가 들어 있습니다. 다른 사람에게 주지 마세요.
 - 월드, server.properties 등은 건드리지 않습니다. 바뀌거나 지워지는 파일은 .update-backup 에 백업됩니다.
`

function makeKit ({ out, repo, key, start = 'run.bat' }) {
  if (!repo) throw new Error('--repo 가 필요합니다 (예: 아이디/modpack)')
  if (!key) throw new Error('서버 키가 필요합니다 (SERVER_PACK_KEY)')
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'server-update.js'), bundle(path.join(__dirname, 'server-update.js')))
  const cfgPath = path.join(out, 'server-update.json')
  // 서버 쪽에서 start 를 바꿔 둔 게 있으면 유지
  let prevStart
  try { prevStart = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).start } catch {}
  fs.writeFileSync(cfgPath, JSON.stringify({ repo, key, start: prevStart || start }, null, 2))
  fs.writeFileSync(path.join(out, '서버시작.bat'), START_BAT.replace(/\n/g, '\r\n'))
  fs.writeFileSync(path.join(out, '서버업데이트.bat'), UPDATE_BAT.replace(/\n/g, '\r\n'))
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
