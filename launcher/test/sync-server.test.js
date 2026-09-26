'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { syncServer } = require('../../tools/sync-server')

function write (root, rel, content) {
  const p = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8')
const exists = (root, rel) => fs.existsSync(path.join(root, ...rel.split('/')))

test('서버 폴더 동기화', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-server-'))
  const src = path.join(tmp, 'instance')
  const srv = path.join(tmp, 'server')
  try {
    // 관리자 인스턴스
    write(src, 'pack.config.json', JSON.stringify({ exclude: ['kubejs/dev'], clientOnly: ['mods/mycustomhud*'] }))
    write(src, 'mods/create.jar', 'create-v1')
    write(src, 'mods/rpgcore.jar', 'rpg-v1')
    write(src, 'mods/iris-neoforge-1.8.jar', 'client only')
    write(src, 'mods/MyCustomHUD-1.0.jar', 'client only (pack.config 에서 지정)')
    write(src, 'config/create-common.toml', 'speed=1')
    write(src, 'kubejs/server_scripts/recipes.js', 'recipes v1')
    write(src, 'kubejs/startup_scripts/items.js', 'items v1')
    write(src, 'kubejs/data/rpg/telemetry.json', '{"from":"admin pc"}')
    write(src, 'kubejs/dev/huge.psd', 'dev stuff')
    write(src, 'resourcepacks/pack.zip', 'client resource pack')
    write(src, 'options.txt', 'client options')
    // 기존 서버
    write(srv, 'world/level.dat', 'world')
    write(srv, 'server.properties', 'motd=hi')
    write(srv, 'mods/luckperms.jar', 'server-only mod')
    write(srv, 'mods/Oculus-1.7.jar', 'client-only mod left on server')

    // 미리보기는 아무것도 안 바꾼다
    const dry = await syncServer({ source: src, server: srv, dryRun: true })
    assert.ok(dry.copies.length > 0)
    assert.equal(exists(srv, 'mods/create.jar'), false)
    assert.equal(exists(srv, '.sync-state.json'), false)

    const r1 = await syncServer({ source: src, server: srv })
    assert.deepEqual(r1.copies.map(c => c.rel).sort(), [
      'config/create-common.toml', 'kubejs/data/rpg/telemetry.json', 'kubejs/server_scripts/recipes.js',
      'kubejs/startup_scripts/items.js', 'mods/create.jar', 'mods/rpgcore.jar'
    ])
    assert.deepEqual(r1.skippedClientOnly.sort(), ['mods/MyCustomHUD-1.0.jar', 'mods/iris-neoforge-1.8.jar'])
    assert.deepEqual(r1.removals, ['mods/Oculus-1.7.jar']) // 서버에 있던 클라 전용 모드는 치움
    assert.deepEqual(r1.serverOnlyMods, ['mods/luckperms.jar'])
    // 서버 고유 파일은 그대로
    assert.equal(read(srv, 'world/level.dat'), 'world')
    assert.equal(read(srv, 'server.properties'), 'motd=hi')
    assert.equal(read(srv, 'mods/luckperms.jar'), 'server-only mod')
    // 클라 전용·개발용·클라 파일은 서버에 안 감
    for (const p of ['mods/iris-neoforge-1.8.jar', 'kubejs/dev/huge.psd', 'resourcepacks/pack.zip', 'options.txt']) {
      assert.equal(exists(srv, p), false, p)
    }
    // 치운 파일은 백업에 있음
    assert.equal(read(r1.backupDir, 'mods/Oculus-1.7.jar'), 'client-only mod left on server')

    // 서버가 실행 중에 기록한 데이터는, 관리자가 그 파일을 안 바꿨으면 보존
    write(srv, 'kubejs/data/rpg/telemetry.json', '{"from":"live server"}')
    write(srv, 'mods/create.jar', 'corrupted') // 모드는 항상 인스턴스와 같게 복구
    const r2 = await syncServer({ source: src, server: srv })
    assert.deepEqual(r2.copies.map(c => c.rel), ['mods/create.jar'])
    assert.equal(read(srv, 'kubejs/data/rpg/telemetry.json'), '{"from":"live server"}')
    assert.equal(read(srv, 'mods/create.jar'), 'create-v1')

    // 관리자가 패치: 스크립트 수정, 모드 업데이트, 모드 삭제
    write(src, 'kubejs/server_scripts/recipes.js', 'recipes v2')
    write(src, 'mods/create.jar', 'create-v2')
    fs.rmSync(path.join(src, 'mods', 'rpgcore.jar'))
    const r3 = await syncServer({ source: src, server: srv })
    assert.deepEqual(r3.copies.map(c => c.rel).sort(), ['kubejs/server_scripts/recipes.js', 'mods/create.jar'])
    assert.deepEqual(r3.removals, ['mods/rpgcore.jar'])
    assert.equal(read(srv, 'kubejs/server_scripts/recipes.js'), 'recipes v2')
    assert.equal(exists(srv, 'mods/rpgcore.jar'), false)
    assert.equal(read(r3.backupDir, 'kubejs/server_scripts/recipes.js'), 'recipes v1')
    assert.equal(read(srv, 'kubejs/data/rpg/telemetry.json'), '{"from":"live server"}')

    // 바뀐 게 없으면 아무것도 안 함
    const r4 = await syncServer({ source: src, server: srv })
    assert.equal(r4.copies.length + r4.removals.length, 0)
    assert.equal(r4.backupDir, null)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
