'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { matchesPattern, isSafeRelPath, compareVersions, validateManifest } = require('../src/common/manifest')
const { serverArgs } = require('../src/main/game')

test('글롭 매칭', () => {
  assert.ok(matchesPattern('mods/a.jar', 'mods'))
  assert.ok(matchesPattern('mods/sub/a.jar', 'mods/'))
  assert.ok(!matchesPattern('modsextra/a.jar', 'mods'))
  assert.ok(matchesPattern('options.txt', 'options.txt'))
  assert.ok(matchesPattern('mods/a.jar.disabled', '**/*.disabled'))
  assert.ok(matchesPattern('a.disabled', '**/*.disabled'))
  assert.ok(matchesPattern('config/x/y.bak', 'config/**/*.bak'))
  assert.ok(!matchesPattern('config/x/y.toml', 'config/**/*.bak'))
  assert.ok(matchesPattern('config/xaero/a.txt', 'config/xaero*/*'))
})

test('경로 검증', () => {
  assert.ok(isSafeRelPath('mods/a.jar'))
  for (const bad of ['../x', 'mods/../../x', '/etc/passwd', 'C:/x', 'mods\\a.jar', '', 'mods//a', './a']) {
    assert.ok(!isSafeRelPath(bad), bad)
  }
})

test('버전 비교', () => {
  assert.equal(compareVersions('1.2.10', '1.2.9'), 1)
  assert.equal(compareVersions('1.20', '1.20.1'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.12.2', '1.13'), -1)
})

test('매니페스트 검증은 위험한 경로를 거부한다', () => {
  const base = { formatVersion: 1, version: '1', minecraft: '1.20.1', loader: { type: 'forge', version: '47' } }
  const file = { path: 'mods/a.jar', sha1: 'a'.repeat(40), size: 1 }
  assert.doesNotThrow(() => validateManifest({ ...base, files: [file] }))
  assert.throws(() => validateManifest({ ...base, files: [{ ...file, path: '../../evil.exe' }] }), /안전하지 않은/)
  assert.throws(() => validateManifest({ ...base, files: [file, { ...file, path: 'MODS/A.jar' }] }), /중복/)
  assert.throws(() => validateManifest({ ...base, formatVersion: 2, files: [] }), /formatVersion/)
})

test('서버 자동 접속 인자', () => {
  assert.deepEqual(serverArgs({ minecraft: '1.21.1', server: { address: 'play.x.com' } }),
    { quickPlayMultiplayer: 'play.x.com:25565' })
  assert.deepEqual(serverArgs({ minecraft: '1.12.2', server: { address: 'play.x.com', port: 25570 } }),
    { server: { ip: 'play.x.com', port: 25570 } })
  assert.deepEqual(serverArgs({ minecraft: '1.21.1' }), {})
})
