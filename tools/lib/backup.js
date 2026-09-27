'use strict'

// 서버 월드 증분 백업.
//
// 월드는 512x512 블록 단위 지역 파일(.mca) 수천 개로 되어 있고, 하루에 바뀌는 건 사람들이 돌아다닌 곳뿐이다.
// 그래서 파일 내용(sha1)별로 한 번만 저장하고(objects/), 백업 하나는 "그 시점의 파일 목록"(snapshots/*.json)만 남긴다.
//   - 첫 백업만 전체 복사, 그 뒤로는 바뀐 파일만 복사
//   - 백업 하나하나가 그 시점의 전체 월드로 복원된다
//   - 크기·수정 시각이 이전 백업과 같으면 다시 읽지 않는다 (수백 GB 를 매번 읽지 않음)
//   - 다른 드라이브(D:\ 등)에 둬도 된다
// 서버가 꺼진 상태에서 돈다 (서버시작.bat 이 서버를 켜기 전에 부름).

const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const crypto = require('node:crypto')
const { pipeline } = require('node:stream/promises')
const { Transform } = require('node:stream')

const DEFAULTS = { enabled: true, dir: 'backups', keep: 10 }
// 월드 말고도 서버가 직접 만들고 바꾸는 것들 (관리자 패치로 다시 받을 수 있는 mods/config 등은 제외)
const EXTRA_TARGETS = ['server.properties', 'whitelist.json', 'ops.json', 'banned-players.json', 'banned-ips.json', 'usercache.json', 'kubejs/data']
const SKIP = name => name === 'session.lock' || name.endsWith('.tmp')

function settings (config) {
  return { ...DEFAULTS, ...(config || {}) }
}

function levelName (serverDir) {
  try {
    const m = fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf8').match(/^\s*level-name\s*=\s*(.+?)\s*$/m)
    if (m && m[1]) return m[1]
  } catch {}
  return 'world'
}

function backupRoot (serverDir, config) {
  return path.resolve(serverDir, settings(config).dir)
}

async function walk (abs, rel, out) {
  let entries
  try { entries = await fsp.readdir(abs, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (SKIP(e.name)) continue
    const a = path.join(abs, e.name)
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) await walk(a, r, out)
    else if (e.isFile()) out.push(r)
  }
}

async function collect (serverDir, targets) {
  const files = []
  for (const t of targets) {
    const abs = path.join(serverDir, ...t.split('/'))
    let st
    try { st = await fsp.stat(abs) } catch { continue }
    if (st.isDirectory()) await walk(abs, t, files)
    else if (st.isFile() && !SKIP(path.basename(t))) files.push(t)
  }
  return files
}

async function listSnapshots (root) {
  let names = []
  try { names = (await fsp.readdir(path.join(root, 'snapshots'))).filter(n => n.endsWith('.json')) } catch {}
  return names.map(n => n.slice(0, -5)).sort()
}

async function readSnapshot (root, name) {
  return JSON.parse(await fsp.readFile(path.join(root, 'snapshots', `${name}.json`), 'utf8'))
}

const objectPath = (root, sha1) => path.join(root, 'objects', sha1.slice(0, 2), sha1)

// 파일을 한 번 읽으면서 해시도 구하고 임시 파일로 복사 → 같은 내용이 이미 있으면 임시 파일은 버림
async function storeFile (root, abs) {
  const tmpDir = path.join(root, 'objects', 'tmp')
  await fsp.mkdir(tmpDir, { recursive: true })
  const tmp = path.join(tmpDir, `${process.pid}-${crypto.randomBytes(6).toString('hex')}`)
  const hash = crypto.createHash('sha1')
  const tap = new Transform({ transform (chunk, _e, cb) { hash.update(chunk); cb(null, chunk) } })
  try {
    await pipeline(fs.createReadStream(abs), tap, fs.createWriteStream(tmp))
    const sha1 = hash.digest('hex')
    const dest = objectPath(root, sha1)
    if (fs.existsSync(dest)) {
      await fsp.rm(tmp, { force: true })
      return { sha1, stored: false }
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await fsp.rename(tmp, dest)
    return { sha1, stored: true }
  } catch (e) {
    await fsp.rm(tmp, { force: true })
    throw e
  }
}

function stamp (d) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}

const GB = 1024 ** 3
const size = n => n >= GB ? `${(n / GB).toFixed(1)} GB` : `${(n / 1024 / 1024).toFixed(0)} MB`

/**
 * 백업 하나를 만든다. 서버는 꺼져 있어야 한다.
 * @returns {Promise<null | {name, fileCount, totalBytes, storedFiles, storedBytes, pruned}>}
 */
async function createBackup ({ serverDir, config, log = () => {}, now = new Date() }) {
  const cfg = settings(config)
  if (!cfg.enabled) return null
  const root = backupRoot(serverDir, config)
  const targets = [levelName(serverDir), ...EXTRA_TARGETS]
  const files = await collect(serverDir, targets)

  const names = await listSnapshots(root)
  const prev = names.length ? (await readSnapshot(root, names[names.length - 1])).files : {}

  const snapshot = { created: now.toISOString(), targets, files: {} }
  let totalBytes = 0
  let storedFiles = 0
  let storedBytes = 0
  let lastLog = Date.now()
  for (let i = 0; i < files.length; i++) {
    const rel = files[i]
    const abs = path.join(serverDir, ...rel.split('/'))
    let st
    try { st = await fsp.stat(abs) } catch { continue }
    totalBytes += st.size
    const old = prev[rel]
    let sha1
    if (old && old.size === st.size && old.mtimeMs === st.mtimeMs && fs.existsSync(objectPath(root, old.sha1))) {
      sha1 = old.sha1
    } else {
      try {
        const r = await storeFile(root, abs)
        sha1 = r.sha1
        if (r.stored) { storedFiles++; storedBytes += st.size }
      } catch (e) {
        if (e.code === 'ENOSPC') throw new Error(`백업할 곳의 디스크 공간이 부족합니다 (${root})`)
        if (e.code === 'EBUSY' || e.code === 'EPERM') throw new Error(`파일이 사용 중이라 백업할 수 없습니다: ${rel} (서버가 꺼져 있어야 합니다)`)
        throw e
      }
    }
    snapshot.files[rel] = { sha1, size: st.size, mtimeMs: st.mtimeMs }
    if (Date.now() - lastLog > 5000) {
      lastLog = Date.now()
      log(`  백업 중 ${i + 1} / ${files.length}개 파일 · 새로 저장 ${size(storedBytes)}`)
    }
  }

  let name = stamp(now)
  while (names.includes(name)) name += '_'
  await fsp.mkdir(path.join(root, 'snapshots'), { recursive: true })
  const tmp = path.join(root, 'snapshots', `${name}.json.tmp`)
  await fsp.writeFile(tmp, JSON.stringify(snapshot))
  await fsp.rename(tmp, path.join(root, 'snapshots', `${name}.json`))

  const pruned = await prune(root, cfg.keep)
  return { name, root, fileCount: Object.keys(snapshot.files).length, totalBytes, storedFiles, storedBytes, pruned }
}

// 최근 keep 개만 남기고, 남은 백업 어디에도 안 쓰이는 파일 내용은 지운다
async function prune (root, keep) {
  const names = await listSnapshots(root)
  const drop = names.slice(0, Math.max(0, names.length - Math.max(1, keep)))
  for (const n of drop) await fsp.rm(path.join(root, 'snapshots', `${n}.json`), { force: true })
  if (!drop.length) return []
  const used = new Set()
  for (const n of names.slice(drop.length)) {
    for (const f of Object.values((await readSnapshot(root, n)).files)) used.add(f.sha1)
  }
  const objects = path.join(root, 'objects')
  for (const d of await fsp.readdir(objects).catch(() => [])) {
    if (d === 'tmp') continue
    for (const f of await fsp.readdir(path.join(objects, d)).catch(() => [])) {
      if (!used.has(f)) await fsp.rm(path.join(objects, d, f), { force: true })
    }
  }
  return drop
}

async function listBackups (serverDir, config) {
  const root = backupRoot(serverDir, config)
  const out = []
  for (const name of (await listSnapshots(root)).reverse()) {
    const s = await readSnapshot(root, name)
    const files = Object.values(s.files)
    out.push({ name, created: s.created, fileCount: files.length, totalBytes: files.reduce((n, f) => n + f.size, 0) })
  }
  return out
}

/**
 * 백업 하나로 되돌린다. 서버는 꺼져 있어야 한다.
 * 지금 월드 등은 지우지 않고 이름 뒤에 .before-restore-<시각> 을 붙여 옆에 남긴다 (같은 폴더라 순식간).
 */
async function restoreBackup ({ serverDir, config, name, log = () => {}, now = new Date() }) {
  const root = backupRoot(serverDir, config)
  const snapshot = await readSnapshot(root, name)
  for (const f of Object.values(snapshot.files)) {
    if (!fs.existsSync(objectPath(root, f.sha1))) throw new Error(`백업 ${name} 의 파일 일부가 없습니다. 다른 백업을 고르세요.`)
  }
  const suffix = `.before-restore-${stamp(now)}`
  const moved = []
  for (const t of snapshot.targets) {
    const abs = path.join(serverDir, ...t.split('/'))
    if (!fs.existsSync(abs)) continue
    await fsp.rename(abs, abs + suffix)
    moved.push(t + suffix)
  }
  let done = 0
  for (const [rel, f] of Object.entries(snapshot.files)) {
    const dest = path.join(serverDir, ...rel.split('/'))
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await fsp.copyFile(objectPath(root, f.sha1), dest)
    await fsp.utimes(dest, new Date(), new Date(f.mtimeMs))
    if (++done % 2000 === 0) log(`  복원 중 ${done} / ${Object.keys(snapshot.files).length}`)
  }
  return { name, fileCount: done, moved }
}

module.exports = { createBackup, listBackups, restoreBackup, levelName, DEFAULTS, formatSize: size }
