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
  process.env.MODRINTH_API_URL = `${base}/no-modrinth` // 모드린스 조회는 404 → 모두 직접 올림
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

  // 관리자 컴의 배포 폴더(pack-dist-gh)가 통째로 사라져도: GitHub 의 최신 기록을 이어 쓴다
  fs.rmSync(out, { recursive: true, force: true })
  await assert.rejects(build({ source: src, out, version: '1.0.4', notes: '-', serverKey: key, quiet: true }), /이미 1\.0\.4/)
  const r7 = await build({ source: src, out, version: '1.0.5', notes: '- 폴더 복구 후', serverKey: key, quiet: true })
  assert.deepEqual(r7.manifest.changelog.slice(0, 3).map(c => c.version), ['1.0.5', '1.0.4', '1.0.3'])
  assert.deepEqual(r7.newAssets.map(f => path.basename(f)).sort(), ['manifest.json', 'server-manifest.bin']) // 바뀐 게 없으니 전부 재사용
  publishLocally(r7)
  const u7 = await runKit(srv)
  assert.equal(u7.code, 0, u7.out)
  assert.equal(read(srv, 'kubejs/server_scripts/recipes.js'), 'SECRET_RECIPE_v2')

  // 서버 키를 새로 만들었으면 예전 키로 잠근 서버 묶음은 재사용하지 않는다 (새 키로 다시 암호화)
  const r8 = await build({ source: src, out, version: '1.0.6', notes: '-', serverKey: secret.newKey(), quiet: true })
  assert.ok(r8.newAssets.some(f => /^s-[0-9a-f]+\.bin$/.test(path.basename(f))))
  assert.ok(!r8.newAssets.some(f => /^b-/.test(path.basename(f)))) // 친구용 묶음은 그대로 재사용

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
  fs.writeFileSync(path.join(dir, 'entry.js'), '﻿#!/usr/bin/env node\r\n\'use strict\'\r\nexports.main = async () => { process.stdout.write(String(require(\'./lib\'))) }\r\n')
  const out = path.join(dir, 'bundled.js')
  fs.writeFileSync(out, bundle(path.join(dir, 'entry.js')))
  assert.equal(fs.readFileSync(out, 'utf8').split('#!').length, 2) // 맨 앞 한 번만
  // 글자만 비교 (윈도우 터미널에서 테스트하면 숫자에 색 코드가 붙을 수 있음)
  const r = require('node:child_process').spawnSync(process.execPath, [out], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), '42')
})

test('맵 패치: 싱글 월드의 차원을 서버 월드로 통째로 교체 (버전이 바뀔 때만, 원래 차원은 백업)', async () => {
  const key = secret.newKey()
  const src = path.join(tmp, 'map-instance')
  const out = path.join(tmp, 'map-dist')
  const srv = path.join(tmp, 'map-server')
  const city = 'saves/CityDev/dimensions/kubejsrpg/city'
  const mapCfg = version => JSON.stringify({ github: 'me/modpack', maps: [{ world: 'CityDev', dimension: 'kubejsrpg:city', version }] })

  write(src, 'minecraftinstance.json', JSON.stringify({ gameVersion: '1.21.1', baseModLoader: { name: 'neoforge-21.1.77' } }))
  write(src, 'pack.config.json', mapCfg(1))
  write(src, 'mods/create.jar', 'create-v1')
  write(src, 'kubejs/data/kubejsrpg/dimension/city.json', '{"type":"minecraft:overworld"}')
  write(src, `${city}/region/r.0.0.mca`, 'CITY_REGION_v1')
  write(src, `${city}/entities/r.0.0.mca`, 'CITY_NPCS_v1')
  write(src, `${city}/poi/r.0.0.mca`, 'CITY_POI_v1')
  write(src, 'saves/CityDev/region/r.0.0.mca', 'DEV_OVERWORLD') // 오버월드는 보내지 않음
  write(src, 'saves/CityDev/level.dat', 'dev level')

  const r1 = await build({ source: src, out, version: '3.0.0', notes: '', serverKey: key })
  assert.deepEqual(r1.serverPackage.maps, [{ dimension: 'kubejsrpg:city', version: 1, fileCount: 3 }])
  assert.ok(!r1.manifest.files.some(f => f.path.startsWith('saves/')))
  for (const f of r1.newAssets) assert.ok(!fs.readFileSync(f).includes('CITY_REGION'), path.basename(f)) // 암호화
  publishLocally(r1)

  write(srv, 'server.properties', 'level-name=world\n')
  write(srv, 'world/region/r.0.0.mca', 'PLAYER_OVERWORLD')
  write(srv, 'world/dimensions/kubejsrpg/city/region/r.0.0.mca', 'OLD_CITY')
  write(srv, 'libraries/net/neoforged/neoforge/21.1.77/neoforge-21.1.77-server.jar', 'x')
  makeKit({ out: srv, repo: 'me/modpack', key })

  const check = await runKit(srv, ['--check'])
  assert.match(check.out, /맵 kubejsrpg:city 을 v1 으로 교체 예정/)
  assert.equal(read(srv, 'world/dimensions/kubejsrpg/city/region/r.0.0.mca'), 'OLD_CITY')

  const run1 = await runKit(srv)
  assert.equal(run1.code, 0, run1.out)
  assert.match(run1.out, /맵 교체: kubejsrpg:city → v1/)
  assert.equal(read(srv, 'world/dimensions/kubejsrpg/city/region/r.0.0.mca'), 'CITY_REGION_v1')
  assert.equal(read(srv, 'world/dimensions/kubejsrpg/city/entities/r.0.0.mca'), 'CITY_NPCS_v1')
  assert.equal(read(srv, 'world/region/r.0.0.mca'), 'PLAYER_OVERWORLD') // 오버월드는 그대로
  const backups = fs.readdirSync(path.join(srv, '.update-backup'))
  const aside = backups.map(b => path.join(srv, '.update-backup', b, 'maps/world/dimensions/kubejsrpg/city/region/r.0.0.mca')).find(p => fs.existsSync(p))
  assert.equal(fs.readFileSync(aside, 'utf8'), 'OLD_CITY')

  // 같은 맵 버전으로 다시 패치: 차원 파일을 다시 올리지도, 서버에서 다시 바꾸지도 않는다
  write(srv, 'world/dimensions/kubejsrpg/city/region/r.0.0.mca', 'PLAYER_CHANGED_CITY')
  write(src, `${city}/region/r.0.0.mca`, 'CITY_REGION_v1_wip') // 관리자가 작업 중 (버전은 안 올림)
  const r2 = await build({ source: src, out, version: '3.0.1', notes: '', serverKey: key })
  assert.deepEqual(r2.newAssets.filter(f => /^s-/.test(path.basename(f))), []) // 암호화 묶음 새로 올린 것 없음 (맵은 3.0.0 것 재사용)
  publishLocally(r2)
  const run2 = await runKit(srv)
  assert.equal(run2.code, 0, run2.out)
  assert.doesNotMatch(run2.out, /맵 교체/)
  assert.equal(read(srv, 'world/dimensions/kubejsrpg/city/region/r.0.0.mca'), 'PLAYER_CHANGED_CITY')

  // 버전을 올리면 교체
  write(src, 'pack.config.json', mapCfg(2))
  write(src, `${city}/region/r.0.0.mca`, 'CITY_REGION_v2')
  const r3 = await build({ source: src, out, version: '3.0.2', notes: '', serverKey: key })
  publishLocally(r3)
  const run3 = await runKit(srv)
  assert.equal(run3.code, 0, run3.out)
  assert.equal(read(srv, 'world/dimensions/kubejsrpg/city/region/r.0.0.mca'), 'CITY_REGION_v2')

  // 오버월드는 지정할 수 없다
  write(src, 'pack.config.json', JSON.stringify({ github: 'me/modpack', maps: [{ world: 'CityDev', dimension: 'minecraft:overworld', version: 1 }] }))
  await assert.rejects(build({ source: src, out, version: '3.0.3', notes: '', serverKey: key }), /오버월드/)
})

test('맵 패치: 업로드가 중간에 끊긴 뒤 다시 배포해도 서버가 없는 맵 파일을 받으러 가지 않는다', async () => {
  const key = secret.newKey()
  const src = path.join(tmp, 'map2-instance')
  const out = path.join(tmp, 'map2-dist')
  const srv = path.join(tmp, 'map2-server')
  const city = 'saves/CityDev/dimensions/kubejsrpg/town'
  write(src, 'minecraftinstance.json', JSON.stringify({ gameVersion: '1.21.1', baseModLoader: { name: 'neoforge-21.1.77' } }))
  write(src, 'pack.config.json', JSON.stringify({ github: 'me/town', maps: [{ world: 'CityDev', dimension: 'kubejsrpg:town', version: 1 }] }))
  write(src, 'mods/create.jar', 'create-v1')
  write(src, `${city}/region/r.0.0.mca`, 'TOWN_v1')
  write(src, 'saves/CityDev/level.dat', 'dev level')

  // 4.0.0 은 만들어졌지만 업로드 도중 창을 닫음 → GitHub 에 없음
  await build({ source: src, out, version: '4.0.0', notes: '', serverKey: key, quiet: true })
  // 다음 배포 (맵 버전은 그대로)
  const r = await build({ source: src, out, version: '4.0.1', notes: '', serverKey: key, quiet: true })
  const relDir = path.join(tmp, 'www', 'me', 'town', 'releases', 'download', 'pack-4.0.1')
  fs.mkdirSync(relDir, { recursive: true })
  for (const f of r.newAssets) fs.copyFileSync(f, path.join(relDir, path.basename(f)))
  for (const name of ['manifest.json', 'server-manifest.bin']) write(path.join(tmp, 'www'), `me/town/releases/latest/download/${name}`, fs.readFileSync(path.join(relDir, name)))

  write(srv, 'server.properties', 'level-name=world\n')
  write(srv, 'libraries/net/neoforged/neoforge/21.1.77/neoforge-21.1.77-server.jar', 'x')
  makeKit({ out: srv, repo: 'me/town', key })
  const run = await runKit(srv)
  assert.equal(run.code, 0, run.out)
  assert.equal(read(srv, 'world/dimensions/kubejsrpg/town/region/r.0.0.mca'), 'TOWN_v1')
})

test('배포 점검: 서버용 목록이 가리키는 파일이 GitHub 에 없으면 찾아내고, 내 컴에 있으면 다시 올린다', async () => {
  const { checkRelease } = require('../../tools/check-release')
  const key = secret.newKey()
  const src = path.join(tmp, 'chk-instance')
  const out = path.join(tmp, 'chk-dist')
  write(src, 'minecraftinstance.json', JSON.stringify({ gameVersion: '1.21.1', baseModLoader: { name: 'neoforge-21.1.77' } }))
  write(src, 'pack.config.json', JSON.stringify({ github: 'me/chk' }))
  write(src, 'mods/create.jar', 'create-v1')
  write(src, 'kubejs/server_scripts/a.js', 'SECRET')
  const r = await build({ source: src, out, version: '1.0.0', notes: '', serverKey: key, quiet: true })
  const relDir = path.join(tmp, 'www', 'me', 'chk', 'releases', 'download', 'pack-1.0.0')
  fs.mkdirSync(relDir, { recursive: true })
  for (const f of r.newAssets) fs.copyFileSync(f, path.join(relDir, path.basename(f)))
  for (const name of ['manifest.json', 'server-manifest.bin']) write(path.join(tmp, 'www'), `me/chk/releases/latest/download/${name}`, fs.readFileSync(path.join(relDir, name)))

  const quiet = () => {}
  assert.equal((await checkRelease({ repo: 'me/chk', serverKey: key, outDir: out, log: quiet })).missing.length, 0)

  // 서버 전용 암호화 묶음 하나가 GitHub 에서 사라짐
  const lost = fs.readdirSync(relDir).find(n => /^s-.*\.bin$/.test(n))
  fs.rmSync(path.join(relDir, lost))
  const found = await checkRelease({ repo: 'me/chk', serverKey: key, outDir: out, log: quiet })
  assert.equal(found.missing.length, 1)
  assert.match(found.missing[0].what, /서버용 묶음 server:/)

  // 다시 올리기 (가짜 GitHub API)
  const api = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const u = new URL(req.url, 'http://x')
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'GET' && u.pathname === '/repos/me/chk/releases/tags/pack-1.0.0') {
        return res.end(JSON.stringify({ id: 1, assets: [], upload_url: `http://127.0.0.1:${api.address().port}/upload{?name,label}` }))
      }
      if (req.method === 'POST' && u.pathname === '/upload') {
        fs.writeFileSync(path.join(relDir, u.searchParams.get('name')), Buffer.concat(chunks))
        res.statusCode = 201
        return res.end('{}')
      }
      res.statusCode = 404
      res.end('{"message":"nope"}')
    })
  })
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
  process.env.GITHUB_API_URL = `http://127.0.0.1:${api.address().port}`
  try {
    const fixed = await checkRelease({ repo: 'me/chk', serverKey: key, outDir: out, repair: true, token: 't', log: quiet })
    assert.equal(fixed.repaired.length, 1)
  } finally {
    delete process.env.GITHUB_API_URL
    api.close()
  }
  assert.ok(fs.existsSync(path.join(relDir, lost)))
  assert.equal((await checkRelease({ repo: 'me/chk', serverKey: key, outDir: out, log: quiet })).missing.length, 0)
})
