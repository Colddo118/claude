'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const loc = require('../src/main/data-location')

function write (root, rel, content) {
  const p = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8')
const has = (root, rel) => fs.existsSync(path.join(root, ...rel.split('/')))

function sandbox () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dataloc-'))
  const configBase = path.join(root, 'appdata', 'kubejsrpg-launcher')
  write(configBase, 'settings.json', '{"memoryMB":4096}')
  write(configBase, 'account.json', '{"secret":1}')
  write(configBase, 'state.json', '{"installedVersion":"1.0.0"}')
  write(configBase, 'instance/mods/a.jar', 'jar-a')
  write(configBase, 'instance/saves/w/level.dat', 'level')
  write(configBase, 'runtime/java/bin/java.exe', 'java')
  write(configBase, 'logs/latest.log', 'log')
  return { root, configBase }
}

test('위치 기록: 없으면 기본 위치 · 기본 위치로 되돌리면 기록 파일 지움', async () => {
  const { root, configBase } = sandbox()
  try {
    assert.equal(await loc.resolveDataDir(configBase), configBase)
    const d = path.join(root, 'D', 'kubejsrpg-launcher')
    await loc.writePointer(configBase, d)
    assert.equal(await loc.resolveDataDir(configBase), path.resolve(d))
    await loc.writePointer(configBase, configBase)
    assert.ok(!has(configBase, loc.POINTER_FILE))
    assert.equal(await loc.resolveDataDir(configBase), configBase)
    // 깨진 기록은 무시
    write(configBase, loc.POINTER_FILE, '{"dir":"relative/path"}')
    assert.equal(await loc.resolveDataDir(configBase), configBase)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('고른 폴더 → 게임 파일 폴더: 빈 폴더면 하위 폴더를 붙이고, 이미 게임 폴더면 그대로', () => {
  const { root, configBase } = sandbox()
  try {
    const games = path.join(root, 'Games')
    fs.mkdirSync(games)
    assert.equal(loc.targetFromPicked(games, 'kubejsrpg-launcher'), path.join(games, 'kubejsrpg-launcher'))
    assert.equal(loc.targetFromPicked(path.join(games, 'KubejsRPG-Launcher'), 'kubejsrpg-launcher'), path.join(games, 'KubejsRPG-Launcher'))
    assert.equal(loc.targetFromPicked(configBase, 'other-name'), configBase) // state.json 이 있음
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('바꿀 수 없는 위치: 같은 곳 · 설치 폴더 안 · 지금 폴더 안 · 없는 드라이브', () => {
  const { root, configBase } = sandbox()
  try {
    const installDir = path.join(root, 'Programs', 'KubejsRPG')
    const ok = path.join(root, 'D', 'kubejsrpg-launcher')
    assert.equal(loc.checkTarget({ target: ok, current: configBase, installDir }), null)
    assert.match(loc.checkTarget({ target: configBase, current: configBase, installDir }), /같습니다/)
    assert.match(loc.checkTarget({ target: path.join(installDir, 'data'), current: configBase, installDir }), /설치 폴더/)
    assert.match(loc.checkTarget({ target: installDir, current: configBase, installDir }), /설치 폴더/)
    assert.match(loc.checkTarget({ target: path.join(root, 'Programs'), current: configBase, installDir }), /설치 폴더를 품은/)
    assert.match(loc.checkTarget({ target: path.join(configBase, 'sub'), current: configBase, installDir }), /안으로는/)
    if (process.platform === 'win32') {
      // 쓰지 않는 드라이브 문자 찾기
      const free = 'QRSTUVWXYZ'.split('').find(l => !fs.existsSync(`${l}:\\`))
      if (free) assert.match(loc.checkTarget({ target: `${free}:\\kubejsrpg-launcher`, current: configBase, installDir }), /드라이브/)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('옮기기: 같은 드라이브는 이름 바꾸기 · 설정/계정은 그대로 남음', async () => {
  const { root, configBase } = sandbox()
  try {
    const target = path.join(root, 'D', 'kubejsrpg-launcher')
    assert.equal(loc.planChange({ target, current: configBase }), 'move')
    const r = await loc.moveData({ current: configBase, target })
    assert.deepEqual(r.copied, [])
    assert.equal(read(target, 'instance/mods/a.jar'), 'jar-a')
    assert.equal(read(target, 'state.json'), '{"installedVersion":"1.0.0"}')
    assert.ok(!has(configBase, 'instance'))
    assert.ok(has(configBase, 'settings.json'))
    assert.ok(has(configBase, 'account.json'))
    assert.ok(!has(target, 'settings.json'))
    // 되돌아오기
    assert.equal(loc.planChange({ target: configBase, current: target }), 'move')
    await loc.moveData({ current: target, target: configBase })
    await loc.removeOld({ current: target, copied: [], configBase })
    assert.equal(read(configBase, 'instance/saves/w/level.dat'), 'level')
    assert.ok(!fs.existsSync(target), '비어 버린 옛 폴더는 지움')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('옮기기: 다른 드라이브(EXDEV)는 복사 → 진행률 → 위치 바꾼 뒤 원본 삭제', async () => {
  const { root, configBase } = sandbox()
  try {
    const target = path.join(root, 'D', 'kubejsrpg-launcher')
    const exdev = async () => { const e = new Error('cross-device'); e.code = 'EXDEV'; throw e }
    const events = []
    const r = await loc.moveData({ current: configBase, target, renameImpl: exdev, onProgress: p => events.push(p) })
    assert.deepEqual(r.copied.sort(), ['instance', 'logs', 'runtime', 'state.json'])
    assert.equal(read(target, 'runtime/java/bin/java.exe'), 'java')
    assert.ok(has(configBase, 'instance/mods/a.jar'), '위치 기록을 바꾸기 전엔 원본 유지')
    const last = events.filter(e => e.total).pop()
    assert.equal(last.current, last.total)
    await loc.removeOld({ current: configBase, copied: r.copied, configBase })
    assert.ok(!has(configBase, 'instance'))
    assert.ok(has(configBase, 'settings.json'), '기본 위치 폴더 자체와 설정은 남김')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('옮기기 실패: 옮긴 것을 되돌리고 원본은 그대로', async () => {
  const { root, configBase } = sandbox()
  try {
    const target = path.join(root, 'D', 'kubejsrpg-launcher')
    let n = 0
    const flaky = async (a, b) => {
      if (++n === 2) { const e = new Error('busy'); e.code = 'EBUSY'; throw e }
      return fs.promises.rename(a, b)
    }
    await assert.rejects(loc.moveData({ current: configBase, target, renameImpl: flaky }))
    assert.equal(read(configBase, 'instance/mods/a.jar'), 'jar-a')
    assert.ok(has(configBase, 'runtime/java/bin/java.exe'))
    assert.ok(!has(target, 'instance'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('이미 게임 파일이 있는 폴더를 고르면 옮기지 않고 위치만 바꿈', () => {
  const { root, configBase } = sandbox()
  try {
    const other = path.join(root, 'D', 'kubejsrpg-launcher')
    write(other, 'state.json', '{}')
    assert.equal(loc.planChange({ target: other, current: configBase }), 'switch')
    const empty = path.join(root, 'E', 'kubejsrpg-launcher')
    fs.rmSync(path.join(configBase, 'instance'), { recursive: true })
    for (const e of ['state.json', 'runtime', 'logs']) fs.rmSync(path.join(configBase, e), { recursive: true })
    assert.equal(loc.planChange({ target: empty, current: configBase }), 'empty')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
