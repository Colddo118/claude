'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { build, detectFromCurseForge } = require('../../tools/build-manifest')
const updater = require('../src/main/updater')

let tmp, server, baseUrl

function write (root, rel, content) {
  const p = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8')
const exists = (root, rel) => fs.existsSync(path.join(root, ...rel.split('/')))

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'launcher-test-'))
  const outDir = path.join(tmp, 'dist')
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const file = path.join(outDir, rel)
    if (!file.startsWith(outDir) || !fs.existsSync(file)) {
      res.writeHead(404)
      return res.end()
    }
    res.writeHead(200)
    fs.createReadStream(file).pipe(res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}/manifest.json`
})

after(async () => {
  server.close()
  await fsp.rm(tmp, { recursive: true, force: true })
})

async function sync (instanceDir, stateFile) {
  const manifest = await updater.fetchManifest(baseUrl)
  const state = await updater.loadState(stateFile)
  const plan = await updater.planUpdate({ manifest, instanceDir, state })
  if (plan.needsUpdate) {
    await updater.applyUpdate({ manifest, manifestUrl: baseUrl, instanceDir, stateFile, state, plan })
  }
  return plan
}

test('설치 → 업데이트 → 사용자 파일 보존까지 전체 흐름', async () => {
  const src = path.join(tmp, 'curseforge-instance')
  const out = path.join(tmp, 'dist')
  const instance = path.join(tmp, 'user', 'instance')
  const stateFile = path.join(tmp, 'user', 'state.json')

  // 커스포지 인스턴스 흉내
  write(src, 'minecraftinstance.json', JSON.stringify({
    gameVersion: '1.20.1',
    baseModLoader: { name: 'forge-47.2.0', minecraftVersion: '1.20.1' }
  }))
  write(src, 'mods/jei.jar', 'jei-v1')
  write(src, 'mods/create.jar', 'create-v1')
  write(src, 'mods/old-mod.jar', 'old')
  write(src, 'mods/disabled.jar.disabled', 'nope')
  write(src, 'config/create-common.toml', 'speed=1')
  write(src, 'options.txt', 'renderDistance:8')
  write(src, 'logs/latest.log', 'should not be packed')
  write(src, 'saves/world/level.dat', 'should not be packed')

  // v1.0.0 빌드
  const r1 = await build({ source: src, out, version: '1.0.0', notes: '- 첫 배포' })
  assert.equal(r1.manifest.minecraft, '1.20.1')
  assert.deepEqual(r1.manifest.loader, { type: 'forge', version: '47.2.0' })
  assert.deepEqual(r1.manifest.files.map(f => f.path), [
    'config/create-common.toml', 'mods/create.jar', 'mods/jei.jar', 'mods/old-mod.jar', 'options.txt'
  ])
  assert.equal(r1.manifest.files.find(f => f.path === 'options.txt').mode, 'once')

  // 유저 첫 설치
  const p1 = await sync(instance, stateFile)
  assert.equal(p1.downloads.length, 5)
  assert.equal(read(instance, 'mods/jei.jar'), 'jei-v1')
  assert.equal((await updater.loadState(stateFile)).installedVersion, '1.0.0')

  // 두 번째 실행: 할 일 없음
  const p1b = await sync(instance, stateFile)
  assert.equal(p1b.needsUpdate, false)

  // 유저가 게임하면서 생긴 파일들
  write(instance, 'options.txt', 'renderDistance:16')             // 개인 설정 변경
  write(instance, 'journeymap/data/mp/waypoints.json', '{"home":1}') // 미니맵 데이터
  write(instance, 'saves/myworld/level.dat', 'my world')
  write(instance, 'mods/my-own-mod.jar', 'user mod')                // 서버에 없는 모드

  // 관리자: v1.1.0 — jei 업데이트, old-mod 삭제, 새 모드 추가, 설정 변경, 기본 옵션 변경
  write(src, 'mods/jei.jar', 'jei-v2')
  fs.rmSync(path.join(src, 'mods', 'old-mod.jar'))
  write(src, 'mods/new-mod.jar', 'new')
  write(src, 'config/create-common.toml', 'speed=2')
  write(src, 'options.txt', 'renderDistance:6')
  await assert.rejects(build({ source: src, out, version: '1.0.0' }), /이미 1.0.0/)
  const r2 = await build({ source: src, out, version: '1.1.0', notes: '- JEI 업데이트\n- 새 모드 추가' })
  assert.deepEqual(r2.manifest.changelog.map(c => c.version), ['1.1.0', '1.0.0'])

  const manifest = await updater.fetchManifest(baseUrl)
  const plan = await updater.planUpdate({ manifest, instanceDir: instance, state: await updater.loadState(stateFile) })
  assert.equal(plan.versionChanged, true)
  assert.deepEqual(plan.downloads.map(f => f.path).sort(), ['config/create-common.toml', 'mods/jei.jar', 'mods/new-mod.jar'])
  assert.deepEqual(plan.removals, ['mods/old-mod.jar'])
  assert.deepEqual(plan.strays, ['mods/my-own-mod.jar'])

  await sync(instance, stateFile)
  assert.equal(read(instance, 'mods/jei.jar'), 'jei-v2')
  assert.equal(read(instance, 'mods/new-mod.jar'), 'new')
  assert.equal(read(instance, 'config/create-common.toml'), 'speed=2')
  assert.equal(exists(instance, 'mods/old-mod.jar'), false)
  assert.equal(exists(instance, 'mods/my-own-mod.jar'), false)
  // 사용자 데이터는 그대로
  assert.equal(read(instance, 'options.txt'), 'renderDistance:16')
  assert.equal(read(instance, 'journeymap/data/mp/waypoints.json'), '{"home":1}')
  assert.equal(read(instance, 'saves/myworld/level.dat'), 'my world')
  // 치운 모드는 백업 폴더에 있다
  const backups = fs.readdirSync(path.join(instance, '.launcher-backup'))
  assert.equal(read(path.join(instance, '.launcher-backup', backups[0]), 'mods/my-own-mod.jar'), 'user mod')
  assert.equal((await updater.loadState(stateFile)).installedVersion, '1.1.0')

  // 유저가 관리 대상 파일을 망가뜨리면 다음 확인 때 복구된다
  write(instance, 'config/create-common.toml', 'speed=999!')
  const repair = await sync(instance, stateFile)
  assert.equal(repair.versionChanged, false)
  assert.deepEqual(repair.downloads.map(f => f.path), ['config/create-common.toml'])
  assert.equal(read(instance, 'config/create-common.toml'), 'speed=2')
})

test('서버 파일이 손상되면 체크섬 오류로 거부한다', async () => {
  const out = path.join(tmp, 'dist')
  const manifest = await updater.fetchManifest(baseUrl)
  const target = manifest.files.find(f => f.path === 'mods/jei.jar')
  const obj = path.join(out, 'objects', target.sha1.slice(0, 2), target.sha1)
  const original = fs.readFileSync(obj)
  fs.writeFileSync(obj, 'tampered')
  try {
    const instance = path.join(tmp, 'user2', 'instance')
    const stateFile = path.join(tmp, 'user2', 'state.json')
    await assert.rejects(sync(instance, stateFile), /jei\.jar 다운로드 실패/)
    // 실패해도 받은 파일은 기록되고, 버전은 설치되지 않은 상태로 남는다
    const state = await updater.loadState(stateFile)
    assert.equal(state.installedVersion, null)
    assert.equal(exists(instance, 'mods/jei.jar'), false)
  } finally {
    fs.writeFileSync(obj, original)
  }
})

test('커스포지 Fabric 인스턴스 감지', async () => {
  const dir = path.join(tmp, 'fabric-instance')
  write(dir, 'minecraftinstance.json', JSON.stringify({
    gameVersion: '1.21.1',
    baseModLoader: { name: 'fabric-0.16.5-1.21.1' }
  }))
  assert.deepEqual(await detectFromCurseForge(dir), { minecraft: '1.21.1', loader: { type: 'fabric', version: '0.16.5' } })
})

test('커스포지 NeoForge 인스턴스 감지', async () => {
  for (const name of ['neoforge-21.1.77', 'neoforge-1.21.1-21.1.77']) {
    const dir = path.join(tmp, `neo-${name}`)
    write(dir, 'minecraftinstance.json', JSON.stringify({ gameVersion: '1.21.1', baseModLoader: { name } }))
    assert.deepEqual(await detectFromCurseForge(dir), { minecraft: '1.21.1', loader: { type: 'neoforge', version: '21.1.77' } })
  }
})
