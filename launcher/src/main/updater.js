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
const { validateManifest, objectPath } = require('../common/manifest')

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
  for (const dir of manifest.strictDirs || []) {
    for (const p of await walkFiles(instanceDir, dir)) {
      const key = p.toLowerCase()
      if (!manifestPaths.has(key) && !removalSet.has(key)) strays.push(p)
    }
  }

  return {
    fromVersion: state.installedVersion,
    toVersion: manifest.version,
    versionChanged: state.installedVersion !== manifest.version,
    downloads,
    downloadBytes: downloads.reduce((n, f) => n + f.size, 0),
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

  try {
    await runPool(plan.downloads, concurrency, async f => {
      const dest = toLocal(instanceDir, f.path)
      await downloadVerified({
        url: new URL(objectPath(f.sha1), manifestUrl).toString(),
        dest,
        sha1: f.sha1,
        size: f.size,
        signal,
        onBytes: n => {
          doneBytes += n
          report({ phase: 'download', current: doneBytes, total, files: doneFiles, fileTotal: plan.downloads.length })
        }
      })
      doneFiles++
      if ((f.mode || 'overwrite') === 'overwrite') {
        const st = await fsp.stat(dest)
        files[f.path] = { sha1: f.sha1, size: st.size, mtimeMs: st.mtimeMs }
      }
      report({ phase: 'download', current: doneBytes, total, files: doneFiles, fileTotal: plan.downloads.length, text: f.path })
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
