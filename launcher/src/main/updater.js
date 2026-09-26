'use strict'

// 모드팩 업데이트 엔진: 원격 매니페스트와 로컬 인스턴스 폴더를 비교해서
// 바뀐 파일만 받고, 서버에서 빠진 파일은 지운다. 사용자가 만든 파일
// (세이브, 스크린샷, 미니맵 데이터, 개인 설정 등)은 건드리지 않는다.

const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const crypto = require('node:crypto')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { validateManifest, objectPath, fileSource } = require('../common/manifest')

const STATE_VERSION = 1

async function fetchManifest (manifestUrl, { signal } = {}) {
  const url = new URL(manifestUrl)
  // CDN 캐시 때문에 새 버전이 늦게 보이는 일을 막는다.
  url.searchParams.set('_', Date.now().toString())
  const res = await fetch(url, { signal, cache: 'no-store' })
  if (!res.ok) throw new Error(`매니페스트를 받지 못했습니다 (HTTP ${res.status})`)
  return validateManifest(await res.json())
}

function emptyState () {
  return { stateVersion: STATE_VERSION, installedVersion: null, files: {} }
}

async function loadState (stateFile) {
  try {
    const s = JSON.parse(await fsp.readFile(stateFile, 'utf8'))
    if (s.stateVersion !== STATE_VERSION || typeof s.files !== 'object') return emptyState()
    return s
  } catch {
    return emptyState()
  }
}

async function saveState (stateFile, state) {
  await fsp.mkdir(path.dirname(stateFile), { recursive: true })
  const tmp = stateFile + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2))
  await fsp.rename(tmp, stateFile)
}

async function sha1File (file) {
  const hash = crypto.createHash('sha1')
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest('hex')
}

async function statOrNull (file) {
  try {
    return await fsp.stat(file)
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

async function walkFiles (root, rel = '') {
  const out = []
  let entries
  try {
    entries = await fsp.readdir(rel ? toLocal(root, rel) : root, { withFileTypes: true })
  } catch (e) {
    if (e.code === 'ENOENT') return out
    throw e
  }
  for (const ent of entries) {
    const childRel = rel ? `${rel}/${ent.name}` : ent.name
    if (ent.isDirectory()) out.push(...await walkFiles(root, childRel))
    else if (ent.isFile()) out.push(childRel)
  }
  return out
}

function toLocal (instanceDir, relPath) {
  return path.join(instanceDir, ...relPath.split('/'))
}

/**
 * 무엇을 받고/지우고/옮길지 계산만 한다 (디스크는 바꾸지 않음).
 * - overwrite 파일: 없거나 해시가 다르면 다운로드
 * - once 파일: 없을 때만 다운로드 (이후엔 사용자 소유)
 * - 예전에 런처가 설치했지만 매니페스트에서 빠진 파일: 삭제
 * - strictDirs(기본 mods) 안의 매니페스트에 없는 파일: 백업 폴더로 이동
 */
async function planUpdate ({ manifest, instanceDir, state, onProgress }) {
  const downloads = []
  const records = {}
  const manifestPaths = new Set()
  let checked = 0

  for (const f of manifest.files) {
    manifestPaths.add(f.path.toLowerCase())
    const local = toLocal(instanceDir, f.path)
    const st = await statOrNull(local)
    const mode = f.mode || 'overwrite'

    if (mode === 'once') {
      if (!st) downloads.push(f)
    } else if (!st || !st.isFile() || st.size !== f.size) {
      downloads.push(f)
    } else {
      const rec = state.files[f.path]
      const unchanged = rec && rec.sha1 === f.sha1 && rec.size === st.size && rec.mtimeMs === st.mtimeMs
      if (unchanged || await sha1File(local) === f.sha1) {
        records[f.path] = { sha1: f.sha1, size: st.size, mtimeMs: st.mtimeMs }
      } else {
        downloads.push(f)
      }
    }
    onProgress && onProgress({ phase: 'verify', current: ++checked, total: manifest.files.length })
  }

  const removals = []
  for (const p of Object.keys(state.files)) {
    if (!manifestPaths.has(p.toLowerCase()) && await statOrNull(toLocal(instanceDir, p))) removals.push(p)
  }

  const removalSet = new Set(removals.map(p => p.toLowerCase()))
  const strays = []
  // strictDirs 는 폴더 바로 아래 파일만 정리한다. 하위 폴더(모드 캐시 등)는 모드가 만든 것이라 건드리지 않는다.
  for (const dir of manifest.strictDirs || []) {
    for (const p of (await walkFiles(instanceDir, dir)).filter(p => !p.slice(dir.length + 1).includes('/'))) {
      const key = p.toLowerCase()
      if (!manifestPaths.has(key) && !removalSet.has(key)) strays.push(p)
    }
  }

  // 묶음(zip)에서 꺼낼 파일이 하나라도 있으면 zip 전체를 한 번 받는다.
  const needsBundle = downloads.some(f => fileSource(manifest, f) === 'bundle')
  const downloadBytes = downloads
    .filter(f => fileSource(manifest, f) !== 'bundle')
    .reduce((n, f) => n + f.size, needsBundle ? manifest.bundle.size : 0)

  return {
    fromVersion: state.installedVersion,
    toVersion: manifest.version,
    versionChanged: state.installedVersion !== manifest.version,
    downloads,
    downloadBytes,
    removals,
    strays,
    records,
    get needsUpdate () {
      return this.versionChanged || this.downloads.length > 0 || this.removals.length > 0 || this.strays.length > 0
    }
  }
}

async function downloadVerified ({ url, dest, sha1, size, signal, onBytes, retries = 3 }) {
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  const tmp = dest + '.part'
  let lastError
  for (let attempt = 1; attempt <= retries; attempt++) {
    let received = 0
    try {
      const res = await fetch(url, { signal })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const hash = crypto.createHash('sha1')
      const tap = new Transform({
        transform (chunk, _enc, cb) {
          hash.update(chunk)
          received += chunk.length
          onBytes && onBytes(chunk.length)
          cb(null, chunk)
        }
      })
      await pipeline(Readable.fromWeb(res.body), tap, fs.createWriteStream(tmp), { signal })
      const digest = hash.digest('hex')
      if (digest !== sha1 || received !== size) {
        throw new Error(`체크섬 불일치 (기대 ${sha1}, 받음 ${digest})`)
      }
      await fsp.rename(tmp, dest)
      return
    } catch (e) {
      onBytes && received && onBytes(-received)
      await fsp.rm(tmp, { force: true })
      if (signal && signal.aborted) throw e
      lastError = e
    }
  }
  throw new Error(`${path.basename(dest)} 다운로드 실패: ${lastError.message}`)
}

function openZip (file) {
  const yauzl = require('yauzl')
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => err ? reject(err) : resolve(zip))
  })
}

// zip 에서 wanted(경로 → 파일 정보) 에 있는 항목만 꺼내고, 각각 해시를 검증한 뒤 제자리에 둔다.
async function extractFromBundle (zipFile, wanted, instanceDir, onFile) {
  const zip = await openZip(zipFile)
  const remaining = new Map(wanted.map(f => [f.path, f]))
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject)
      zip.on('end', resolve)
      zip.on('entry', entry => {
        const f = remaining.get(entry.fileName)
        if (!f) return zip.readEntry()
        zip.openReadStream(entry, async (err, stream) => {
          if (err) return reject(err)
          const dest = toLocal(instanceDir, f.path)
          const tmp = dest + '.part'
          try {
            await fsp.mkdir(path.dirname(dest), { recursive: true })
            const hash = crypto.createHash('sha1')
            let size = 0
            const tap = new Transform({
              transform (chunk, _enc, cb) {
                hash.update(chunk)
                size += chunk.length
                cb(null, chunk)
              }
            })
            await pipeline(stream, tap, fs.createWriteStream(tmp))
            if (hash.digest('hex') !== f.sha1 || size !== f.size) throw new Error(`${f.path}: 묶음 안의 파일이 매니페스트와 다릅니다`)
            await fsp.rename(tmp, dest)
            remaining.delete(f.path)
            await onFile(f, dest)
            zip.readEntry()
          } catch (e) {
            await fsp.rm(tmp, { force: true })
            reject(e)
          }
        })
      })
      zip.readEntry()
    })
  } finally {
    zip.close()
  }
  if (remaining.size) throw new Error(`묶음에 없는 파일: ${[...remaining.keys()].slice(0, 3).join(', ')}`)
}

async function runPool (items, concurrency, worker) {
  let next = 0
  let failed = null
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && next < items.length) {
      const item = items[next++]
      try {
        await worker(item)
      } catch (e) {
        failed = failed || e
      }
    }
  })
  await Promise.all(runners)
  if (failed) throw failed
}

/**
 * planUpdate 결과를 실제로 적용한다. 중간에 실패해도 받은 파일은 state 에
 * 기록되므로 다음 시도에서 이어 받는다.
 */
async function applyUpdate ({ manifest, manifestUrl, instanceDir, stateFile, state, plan, onProgress, signal, concurrency = 6 }) {
  const files = { ...plan.records }
  const report = p => onProgress && onProgress(p)

  if (plan.strays.length) {
    const backupRoot = path.join(instanceDir, '.launcher-backup', new Date().toISOString().replace(/[:.]/g, '-'))
    for (const p of plan.strays) {
      const dest = toLocal(backupRoot, p)
      await fsp.mkdir(path.dirname(dest), { recursive: true })
      await fsp.rename(toLocal(instanceDir, p), dest)
    }
    report({ phase: 'cleanup', text: `목록에 없는 파일 ${plan.strays.length}개를 .launcher-backup 으로 옮김` })
  }

  for (const p of plan.removals) {
    await fsp.rm(toLocal(instanceDir, p), { force: true })
  }

  let doneBytes = 0
  let doneFiles = 0
  const total = plan.downloadBytes
  const failState = async () => {
    await saveState(stateFile, { ...emptyState(), installedVersion: state.installedVersion, files: { ...state.files, ...files } })
  }

  const onBytes = n => {
    doneBytes += n
    report({ phase: 'download', current: doneBytes, total, files: doneFiles, fileTotal: plan.downloads.length })
  }
  const record = async (f, dest) => {
    doneFiles++
    if ((f.mode || 'overwrite') === 'overwrite') {
      const st = await fsp.stat(dest)
      files[f.path] = { sha1: f.sha1, size: st.size, mtimeMs: st.mtimeMs }
    }
    report({ phase: 'download', current: doneBytes, total, files: doneFiles, fileTotal: plan.downloads.length, text: f.path })
  }

  const single = plan.downloads.filter(f => fileSource(manifest, f) !== 'bundle')
  const bundled = plan.downloads.filter(f => fileSource(manifest, f) === 'bundle')

  try {
    if (bundled.length) {
      const b = manifest.bundle
      const zipFile = path.join(instanceDir, '.launcher-tmp', `bundle-${b.sha1}.zip`)
      await downloadVerified({ url: new URL(b.url, manifestUrl).toString(), dest: zipFile, sha1: b.sha1, size: b.size, signal, onBytes })
      try {
        await extractFromBundle(zipFile, bundled, instanceDir, record)
      } finally {
        await fsp.rm(path.dirname(zipFile), { recursive: true, force: true })
      }
    }
    await runPool(single, concurrency, async f => {
      const dest = toLocal(instanceDir, f.path)
      const url = f.url || new URL(objectPath(f.sha1), manifestUrl).toString()
      await downloadVerified({ url, dest, sha1: f.sha1, size: f.size, signal, onBytes })
      await record(f, dest)
    })
  } catch (e) {
    await failState()
    throw e
  }

  const newState = { ...emptyState(), installedVersion: manifest.version, files }
  await saveState(stateFile, newState)
  return newState
}

module.exports = {
  fetchManifest,
  loadState,
  saveState,
  planUpdate,
  applyUpdate,
  sha1File,
  walkFiles
}
