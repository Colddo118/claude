'use strict'

// 관리자 빌드 → (가짜) GitHub 릴리스 → 서버 컴에서 서버 키트(한 파일로 묶인 도구) 실행까지 전체 흐름

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { build } = require('../../tools/build-manifest')
const { makeKit, bundle } = require('../../tools/make-server-kit')
const secret = require('../src/common/secret')

let tmp, server, base

function write (root, rel, content) {
  const p = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8')
const exists = (root, rel) => fs.existsSync(path.join(root, ...rel.split('/')))

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'server-pkg-'))
  server = http.createServer((req, res) => {
    const file = path.join(tmp, 'www', decodeURIComponent(new URL(req.url, 'http://x').pathname))
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'Content-Length': fs.statSync(file).size })
    if (req.method === 'HEAD') return res.end()
    fs.createReadStream(file).pipe(res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  process.env.GITHUB_WEB_URL = base
})

after(() => {
  delete process.env.GITHUB_WEB_URL
  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function publishLocally (r) {
  const relDir = path.join(tmp, 'www', 'me', 'modpack', 'releases', 'download', `pack-${r.manifest.version}`)
  fs.mkdirSync(relDir, { recursive: true })
  for (const f of r.newAssets) fs.copyFileSync(f, path.join(relDir, path.basename(f)))
  for (const name of ['manifest.json', 'server-manifest.bin']) {
    write(path.join(tmp, 'www'), `me/modpack/releases/latest/download/${name}`, fs.readFileSync(path.join(relDir, name)))
  }
}

// 서버 컴에서 서버업데이트.bat 이 하는 일: 서버 폴더에서 node server-update.js
function runKit (serverDir, args = []) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, ['server-update.js', ...args], { cwd: serverDir, env: { ...process.env, GITHUB_WEB_URL: base } })
    let out = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { out += d })
    p.on('close', code => resolve({ code, out }))
  })
}

test('서버 패키지: 암호화 배포와 서버 키트 원클릭 업데이트', async () => {
  const key = secret.newKey()
  const src = path.join(tmp, 'instance')
  const out = path.join(tmp, 'pack-dist')
  const srv = path.join(tmp, 'server')

  write(src, 'minecraftinstance.json', JSON.stringify({ gameVersion: '1.21.1', baseModLoader: { name: 'neoforge-21.1.77' } }))
  write(src, 'pack.config.json', JSON.stringify({ github: 'me/modpack', exclude: ['kubejs/dev'] }))
  write(src, 'mods/create.jar', 'create-v1')
  write(src, 'mods/iris-neoforge.jar', 'client only')
  write(src, 'config/create-common.toml', 'speed=1')
  write(src, 'kubejs/startup_scripts/items.js', 'items v1')
  write(src, 'kubejs/server_scripts/recipes.js', 'SECRET_RECIPE_v1')
  write(src, 'kubejs/data/rpg/telemetry.json', '{"from":"admin"}')
  write(src, 'kubejs/config/gear.generated.json', '{"gen":1}')
  write(src, 'kubejs/dev/notes.txt', 'dev only')
  write(src, 'options.txt', 'client options')

  const r1 = await build({ source: src, out, version: '1.0.0', notes: '- 첫 배포', serverKey: key })
  assert.equal(r1.serverPackage.secretCount, 2)
  publishLocally(r1)
  // 공개 릴리스 어디에도 서버 스크립트 원문이 없어야 한다
  for (const f of r1.newAssets) assert.ok(!fs.readFileSync(f).includes('SECRET_RECIPE'), path.basename(f))
  // 친구용 매니페스트에도 서버 전용 파일 경로가 없다
  assert.ok(!r1.manifest.files.some(f => f.path.startsWith('kubejs/server_scripts')))

  // 서버 컴: 기존 서버 폴더에 키트 복사
  write(srv, 'run.bat', 'echo run')
  write(srv, 'server.properties', 'motd=hi')
  write(srv, 'world/level.dat', 'world')
  write(srv, 'mods/Oculus-1.7.jar', 'client-only mod left on server')
  write(srv, 'mods/luckperms.jar', 'server-only mod')
  write(srv, 'libraries/net/neoforged/neoforge/21.1.77/neoforge-21.1.77-server.jar', 'x')
  makeKit({ out: srv, repo: 'me/modpack', key })

  const u1 = await runKit(srv)
  assert.equal(u1.code, 0, u1.out)
  assert.match(u1.out, /패치 적용: v\(처음\) → v1\.0\.0/)
  assert.equal(read(srv, 'kubejs/server_scripts/recipes.js'), 'SECRET_RECIPE_v1') // 복호화되어 들어감
  assert.equal(read(srv, 'mods/create.jar'), 'create-v1')
  assert.equal(exists(srv, 'mods/iris-neoforge.jar'), false) // 클라 전용은 안 받음
  assert.equal(exists(srv, 'mods/Oculus-1.7.jar'), false) // 서버에 있던 클라 전용은 치움
  assert.equal(read(srv, 'mods/luckperms.jar'), 'server-only mod') // 서버 전용 모드 유지
  assert.equal(read(srv, 'world/level.dat'), 'world')
  assert.equal(read(srv, 'server.properties'), 'motd=hi')
  assert.equal(exists(srv, 'options.txt'), false)
  assert.equal(exists(srv, 'kubejs/dev/notes.txt'), false)

  // 서버가 실행 중에 데이터 기록 → 관리자가 서버 스크립트만 패치
  write(srv, 'kubejs/data/rpg/telemetry.json', '{"from":"live server"}')
  write(src, 'kubejs/server_scripts/recipes.js', 'SECRET_RECIPE_v2')
  const r2 = await build({ source: src, out, version: '1.0.1', notes: '- 레시피 수정', serverKey: key })
  publishLocally(r2)
  const u2 = await runKit(srv)
  assert.equal(u2.code, 0, u2.out)
  assert.match(u2.out, /v1\.0\.0 → v1\.0\.1/)
  assert.equal(read(srv, 'kubejs/server_scripts/recipes.js'), 'SECRET_RECIPE_v2')
  assert.equal(read(srv, 'kubejs/data/rpg/telemetry.json'), '{"from":"live server"}') // 서버 데이터 보존
  assert.match(u2.out, /이전 파일 백업/)

  // 바뀐 게 없으면 최신
  const u3 = await runKit(srv)
  assert.match(u3.out, /최신 버전입니다 \(v1\.0\.1\)/)

  // 관리자가 telemetry 까지 바꿔서 배포해도, 서버의 keep 목록에 있으면 서버 것을 유지
  const cfg = JSON.parse(read(srv, 'server-update.json'))
  write(srv, 'server-update.json', JSON.stringify({ ...cfg, keep: ['kubejs/data/rpg/telemetry.json'] }))
  write(src, 'kubejs/data/rpg/telemetry.json', '{"from":"admin v2"}')
  write(src, 'config/create-common.toml', 'speed=2')
  const r3 = await build({ source: src, out, version: '1.0.2', notes: '- 설정', serverKey: key })
  publishLocally(r3)
  // 미리보기는 아무것도 안 바꾼다
  const chk = await runKit(srv, ['--check'])
  assert.equal(chk.code, 0, chk.out)
  assert.match(chk.out, /받을 파일: config\/create-common\.toml/)
  assert.match(chk.out, /보존 \(keep\): kubejs\/data\/rpg\/telemetry\.json/)
  assert.equal(read(srv, 'config/create-common.toml'), 'speed=1')
  const u4 = await runKit(srv)
  assert.equal(u4.code, 0, u4.out)
  assert.equal(read(srv, 'config/create-common.toml'), 'speed=2')
  assert.equal(read(srv, 'kubejs/data/rpg/telemetry.json'), '{"from":"live server"}')
  // 키트를 다시 만들어도 서버에서 정한 keep 은 유지
  makeKit({ out: srv, repo: 'me/modpack', key })
  assert.deepEqual(JSON.parse(read(srv, 'server-update.json')).keep, ['kubejs/data/rpg/telemetry.json'])

  // 서버 데이터 보호: keep 에 없어도, 관리자 관리 영역(mods/config/스크립트/assets)이 아닌 파일은
  // 서버가 바꿨으면 관리자가 바꾸거나 지워도 서버 것을 그대로 둔다
  write(srv, 'kubejs/config/gear.generated.json', '{"gen":"server"}')
  write(srv, 'config/create-common.toml', 'speed=2 # rewritten by mod on server')
  write(src, 'kubejs/config/gear.generated.json', '{"gen":2}')
  write(src, 'config/create-common.toml', 'speed=3')
  const r5 = await build({ source: src, out, version: '1.0.3', notes: '-', serverKey: key })
  publishLocally(r5)
  const u5 = await runKit(srv)
  assert.equal(u5.code, 0, u5.out)
  assert.equal(read(srv, 'kubejs/config/gear.generated.json'), '{"gen":"server"}')
  assert.match(u5.out, /서버에서 바뀐 데이터 파일 1개/)
  assert.equal(read(srv, 'config/create-common.toml'), 'speed=3') // config 는 관리자 관리 영역 → 관리자 것
  fs.rmSync(path.join(src, 'kubejs', 'config', 'gear.generated.json'))
  const r6 = await build({ source: src, out, version: '1.0.4', notes: '-', serverKey: key })
  publishLocally(r6)
  const u6 = await runKit(srv)
  assert.equal(u6.code, 0, u6.out)
  assert.equal(read(srv, 'kubejs/config/gear.generated.json'), '{"gen":"server"}') // 지우지도 않음
  // 월드는 처음부터 끝까지 그대로
  assert.equal(read(srv, 'world/level.dat'), 'world')

  // 키가 틀리면 명확한 오류
  write(srv, 'server-update.json', JSON.stringify({ repo: 'me/modpack', key: secret.newKey() }))
  const bad = await runKit(srv)
  assert.notEqual(bad.code, 0)
  assert.match(bad.out, /서버 키가 맞지 않습니다/)
})

test('암호화: 같은 내용이면 같은 결과, 다른 키로는 못 품', () => {
  const k = secret.newKey()
  const a = secret.encrypt(Buffer.from('hello'), k)
  assert.deepEqual(a, secret.encrypt(Buffer.from('hello'), k))
  assert.equal(secret.decrypt(a, k).toString(), 'hello')
  assert.throws(() => secret.decrypt(a, secret.newKey()), /서버 키가 맞지 않습니다/)
})

test('서버 키트 묶기: 윈도우(CRLF·BOM) 체크아웃에서도 shebang 이 남지 않는다', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'crlf-'))
  fs.writeFileSync(path.join(dir, 'lib.js'), '#!/usr/bin/env node\r\nmodule.exports = 42\r\n')
  fs.writeFileSync(path.join(dir, 'entry.js'), '﻿#!/usr/bin/env node\r\n\'use strict\'\r\nexports.main = async () => { console.log(require(\'./lib\')) }\r\n')
  const out = path.join(dir, 'bundled.js')
  fs.writeFileSync(out, bundle(path.join(dir, 'entry.js')))
  assert.equal(fs.readFileSync(out, 'utf8').split('#!').length, 2) // 맨 앞 한 번만
  const r = require('node:child_process').spawnSync(process.execPath, [out], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), '42')
})
