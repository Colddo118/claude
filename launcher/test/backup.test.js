'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createBackup, listBackups, restoreBackup } = require('../../tools/lib/backup')

function write (root, rel, content, mtime) {
  const p = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
  if (mtime) fs.utimesSync(p, mtime, mtime)
}
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8')
const objectCount = root => fs.readdirSync(path.join(root, 'objects')).filter(d => d !== 'tmp')
  .reduce((n, d) => n + fs.readdirSync(path.join(root, 'objects', d)).length, 0)

test('월드 백업: 처음만 전체, 다음부터 바뀐 파일만 · 오래된 백업 정리 · 되돌리기', async () => {
  const srv = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-'))
  const t0 = new Date('2026-01-01T00:00:00Z')
  try {
    write(srv, 'server.properties', 'level-name=mundo\nmotd=hi\n')
    write(srv, 'mundo/level.dat', 'level-1', t0)
    write(srv, 'mundo/region/r.0.0.mca', 'region-a-1', t0)
    write(srv, 'mundo/region/r.0.1.mca', 'region-b-1', t0)
    write(srv, 'mundo/region/r.9.9.mca', 'region-b-1', t0) // 같은 내용은 한 번만 저장
    write(srv, 'mundo/session.lock', 'locked')              // 건너뜀
    write(srv, 'kubejs/data/rpg/ledger.json', '{"gold":1}', t0)
    write(srv, 'mods/big.jar', 'not backed up')              // 패치로 다시 받을 수 있는 건 제외
    const cfg = { dir: 'backups', keep: 2 }
    const root = path.join(srv, 'backups')

    const b1 = await createBackup({ serverDir: srv, config: cfg, now: new Date('2026-09-27T10:00:00') })
    assert.equal(b1.name, '2026-09-27_10-00-00')
    assert.equal(b1.fileCount, 6) // server.properties + level.dat + 3 region + ledger
    assert.equal(b1.storedFiles, 5)
    const snap = JSON.parse(fs.readFileSync(path.join(root, 'snapshots', `${b1.name}.json`), 'utf8'))
    assert.ok(!Object.keys(snap.files).some(p => p.includes('session.lock') || p.startsWith('mods/')))

    // 한 지역만 바뀜 → 그 파일만 새로 저장
    write(srv, 'mundo/region/r.0.0.mca', 'region-a-2')
    const b2 = await createBackup({ serverDir: srv, config: cfg, now: new Date('2026-09-27T11:00:00') })
    assert.equal(b2.storedFiles, 1)
    assert.equal(b2.fileCount, 6)

    // 아무것도 안 바뀜 → 새로 저장 없음. keep=2 라 첫 백업은 정리되고, 거기만 쓰던 내용도 지워짐
    const b3 = await createBackup({ serverDir: srv, config: cfg, now: new Date('2026-09-27T12:00:00') })
    assert.equal(b3.storedFiles, 0)
    assert.deepEqual(b3.pruned, [b1.name])
    assert.deepEqual((await listBackups(srv, cfg)).map(b => b.name), [b3.name, b2.name])
    assert.equal(objectCount(root), 5) // 6가지 내용 중 region-a-1 은 더 이상 어떤 백업에도 없어서 지워짐

    // 망가진 뒤 되돌리기: 지금 월드는 옆에 남기고, 백업 시점 그대로 복원
    write(srv, 'mundo/region/r.0.0.mca', 'CORRUPTED')
    write(srv, 'mundo/region/r.5.5.mca', 'new after backup')
    write(srv, 'kubejs/data/rpg/ledger.json', '{"gold":999}')
    const r = await restoreBackup({ serverDir: srv, config: cfg, name: b2.name, now: new Date('2026-09-27T13:00:00') })
    assert.equal(r.fileCount, 6)
    assert.equal(read(srv, 'mundo/region/r.0.0.mca'), 'region-a-2')
    assert.equal(read(srv, 'kubejs/data/rpg/ledger.json'), '{"gold":1}')
    assert.equal(fs.existsSync(path.join(srv, 'mundo', 'region', 'r.5.5.mca')), false)
    assert.equal(read(srv, 'mundo.before-restore-2026-09-27_13-00-00/region/r.0.0.mca'), 'CORRUPTED')
    assert.equal(read(srv, 'mods/big.jar'), 'not backed up') // 백업 대상이 아닌 건 그대로

    // 끄기
    assert.equal(await createBackup({ serverDir: srv, config: { enabled: false } }), null)
  } finally {
    fs.rmSync(srv, { recursive: true, force: true })
  }
})
