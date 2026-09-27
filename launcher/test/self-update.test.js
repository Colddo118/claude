'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { checkForUpdate, startUpdate, infoUrlFrom, RETRY_AFTER_MS } = require('../src/main/self-update')

const INFO = 'https://github.com/colddo118/modpack/releases/download/launcher/launcher.json'
const fakeFetch = map => async url => {
  const key = String(url).split('?')[0]
  const v = map[key]
  if (v === undefined) return { ok: false, status: 404 }
  return { ok: true, status: 200, json: async () => v, arrayBuffer: async () => v }
}

test('런처 자동 업데이트: 새 버전이면 설치 파일을 받아 조용히 실행, 같은 버전은 한동안 재시도 안 함', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-update-'))
  const stateFile = path.join(dir, 'state.json')
  try {
    assert.equal(infoUrlFrom({ manifestUrl: 'https://github.com/colddo118/modpack/releases/latest/download/manifest.json' }), INFO)

    const fetchImpl = fakeFetch({ [INFO]: { version: '0.4.0', setup: 'KubejsRPG-Setup.exe' } })
    assert.equal((await checkForUpdate({ infoUrl: INFO, currentVersion: '0.4.0', fetchImpl })).available, false)
    assert.equal((await checkForUpdate({ infoUrl: INFO, currentVersion: '0.10.0', fetchImpl })).available, false) // 숫자 비교
    const u = await checkForUpdate({ infoUrl: INFO, currentVersion: '0.3.0', stateFile, fetchImpl, now: 1000 })
    assert.deepEqual(u, { available: true, version: '0.4.0', setupUrl: 'https://github.com/colddo118/modpack/releases/download/launcher/KubejsRPG-Setup.exe' })

    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4096)])
    const spawned = []
    const spawnImpl = (file, args, opts) => { spawned.push({ file, args, opts }); return { unref () {} } }
    const file = await startUpdate({ ...u, tmpDir: dir, stateFile, now: 1000, fetchImpl: fakeFetch({ [u.setupUrl]: exe }), spawnImpl })
    assert.deepEqual(fs.readFileSync(file), exe)
    assert.deepEqual(spawned[0].args, ['/S', '--updated', '--force-run'])
    assert.equal(spawned[0].opts.detached, true)

    // 설치가 실패해서 여전히 옛 버전이면, 켤 때마다 다시 설치하지 않는다
    assert.equal((await checkForUpdate({ infoUrl: INFO, currentVersion: '0.3.0', stateFile, fetchImpl, now: 2000 })).reason, 'recently-tried')
    assert.equal((await checkForUpdate({ infoUrl: INFO, currentVersion: '0.3.0', stateFile, fetchImpl, now: 1000 + RETRY_AFTER_MS + 1 })).available, true)

    // 설치 파일이 이상하면 실행하지 않는다
    await assert.rejects(startUpdate({ ...u, tmpDir: dir, fetchImpl: fakeFetch({ [u.setupUrl]: Buffer.from('<html>not found</html>') }), spawnImpl }), /올바르지 않습니다/)
    assert.equal(spawned.length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
