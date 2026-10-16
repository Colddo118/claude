'use strict'

// 대륙 맵(싱글 월드 차원의 region · poi)을 관리자 컴 ↔ 서버 컴 사이에 옮기는 공용 코드.
//  - 관리자 → 서버: 서버 패키지에 world/<차원>/<region|poi>/r.x.z.mca 항목으로 실린다 (파일 하나 = 암호화 묶음 하나).
//    서버는 관리자가 바꾼 파일만 덮는다 (mode: update). 관리자가 안 고친 region 은 서버 것 그대로.
//  - 서버 → 관리자: 서버 컴의 맵보내기.bat 이 server-map 릴리스(사전 배포)에 올리고, patch.bat 이 받아 싱글 월드에 덮는다.
//  둘 다 서버 키로 암호화되어 일반 유저(친구 런처)는 맵을 받지 않는다.
//  entities 는 빼고(NPC · 큰 글자는 서버가 설정 파일 보고 다시 세움), data 는 각자 것을 쓴다.

const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const crypto = require('node:crypto')
const { writeZip, readZipEntries, readZipEntry } = require('../../launcher/src/common/zip')
const { sha1File, downloadVerified } = require('../../launcher/src/main/updater')
const secret = require('../../launcher/src/common/secret')
const github = require('./github')

const MAP_PREFIX = 'world/'
const MAP_TAG = 'server-map'
const MAP_MANIFEST = 'server-map.bin'
const SYNC_FILE = 'map-sync.json'
const DEFAULT_PARTS = ['region', 'poi']

// pack.config.json 의 "map": { "world": "saves/새로운 세계", "dims": ["dimensions/kubejs/continent"] }
function mapSettings (userConfig) {
  const m = userConfig && userConfig.map
  if (!m || !m.world || !Array.isArray(m.dims) || !m.dims.length) return null
  const clean = s => String(s).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  return { world: m.world, dims: m.dims.map(clean), parts: (m.parts || DEFAULT_PARTS).map(clean) }
}

const isMapPath = p => p.startsWith(MAP_PREFIX)

// 맵 경로(world/...) → 실제 월드 폴더 안 파일
const mapAbs = (worldAbs, p) => path.join(worldAbs, ...p.slice(MAP_PREFIX.length).split('/'))

async function listMapFiles (worldAbs, { dims, parts }) {
  const out = []
  for (const dim of dims) {
    for (const part of parts) {
      let entries
      try {
        entries = await fsp.readdir(path.join(worldAbs, ...dim.split('/'), part), { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (!e.isFile() || !/\.mca$/i.test(e.name)) continue
        const p = `${MAP_PREFIX}${dim}/${part}/${e.name}`
        out.push({ path: p, abs: mapAbs(worldAbs, p) })
      }
    }
  }
  return out.sort((a, b) => a.path < b.path ? -1 : 1)
}

// 게임(싱글 또는 서버)이 월드를 열고 있으면 session.lock 이 잠겨 있어 읽을 수 없다
function worldInUse (worldAbs) {
  try {
    fs.readFileSync(path.join(worldAbs, 'session.lock'))
    return false
  } catch (e) {
    return e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES'
  }
}

// 파일 하나를 zip(경로 = 맵 경로) 으로 싸서 서버 키로 암호화. 같은 내용이면 같은 결과 → 릴리스 재사용
async function sealFile (file, key, tmpDir) {
  const tmp = path.join(tmpDir, `.map-${process.pid}-${crypto.randomBytes(4).toString('hex')}.zip`)
  await writeZip(tmp, [{ name: file.path, file: file.abs }])
  try {
    return secret.encrypt(await fsp.readFile(tmp), key)
  } finally {
    await fsp.rm(tmp, { force: true })
  }
}

function unsealFile (sealed, key, entry) {
  const zip = secret.decrypt(sealed, key)
  const found = readZipEntries(zip).find(e => e.name === entry.path)
  if (!found) throw new Error(`맵 묶음에 ${entry.path} 가 없습니다`)
  const data = readZipEntry(zip, found)
  if (crypto.createHash('sha1').update(data).digest('hex') !== entry.sha1) throw new Error(`${entry.path}: 받은 맵 파일이 목록과 다릅니다`)
  return data
}

const sha1Of = buf => crypto.createHash('sha1').update(buf).digest('hex')

// 관리자 컴 기록: 마지막으로 주고받은(올리기 · 받기) 때 싱글 월드 파일 해시, 마지막으로 받은 서버 맵 시각
async function readSync (outDir) {
  try {
    const s = JSON.parse(await fsp.readFile(path.join(outDir, SYNC_FILE), 'utf8'))
    return { files: s.files || {}, pulledSentAt: s.pulledSentAt || null }
  } catch (e) {
    if (e.code === 'ENOENT') return { files: {}, pulledSentAt: null }
    throw e
  }
}

async function writeSync (outDir, sync) {
  await fsp.mkdir(outDir, { recursive: true })
  await fsp.writeFile(path.join(outDir, SYNC_FILE), JSON.stringify(sync, null, 2))
}

// 싱글 월드에서 마지막으로 주고받은 뒤 바뀐 파일
async function devChanges (worldAbs, map, sync) {
  const changed = []
  const all = []
  for (const f of await listMapFiles(worldAbs, map)) {
    const sha1 = await sha1File(f.abs)
    const st = await fsp.stat(f.abs)
    const rec = { ...f, sha1, size: st.size }
    all.push(rec)
    if (sync.files[f.path] !== sha1) changed.push(rec)
  }
  return { all, changed }
}

/**
 * 관리자 → 서버: 서버 패키지에 맵 항목을 싣는다.
 * push 가 아니면 지난 서버 패키지의 맵 항목을 그대로 이어 간다 (서버 맵 안 건드림).
 * push 면: 마지막으로 주고받은 뒤 싱글 월드에서 바뀐 파일만 새 항목(해시가 바뀜 → 서버가 덮음),
 *          안 바뀐 파일은 지난 항목 그대로(서버가 안 덮음).
 */
async function addMapToServerPackage ({ push, map, sourceDir, outDir, previousServer, files, bundles, releaseDir, addAsset, serverKey }) {
  const prevFiles = ((previousServer && previousServer.files) || []).filter(f => isMapPath(f.path))
  const prevBundles = new Map(((previousServer && previousServer.bundles) || []).map(b => [b.id, b]))
  const carry = f => {
    files.push(f)
    if (f.bundle && prevBundles.has(f.bundle) && !bundles.some(b => b.id === f.bundle)) bundles.push(prevBundles.get(f.bundle))
  }
  if (!push) {
    prevFiles.forEach(carry)
    return { pushed: false, carried: prevFiles.length }
  }
  if (!map) throw new Error('pack.config.json 에 "map" 설정이 없습니다 (world, dims)')
  const worldAbs = path.resolve(sourceDir, map.world)
  if (!fs.existsSync(worldAbs)) throw new Error(`싱글 월드 폴더가 없습니다: ${worldAbs}`)
  if (worldInUse(worldAbs)) throw new Error('싱글 월드가 게임에서 열려 있습니다. 월드에서 나간 뒤 다시 하세요 (열린 채로 복사하면 맵이 깨질 수 있음)')

  const sync = await readSync(outDir)
  const prevByPath = new Map(prevFiles.map(f => [f.path, f]))
  const { all } = await devChanges(worldAbs, map, sync)
  const newSync = { ...sync, files: { ...sync.files } }
  let changed = 0
  let kept = 0
  let uploadBytes = 0
  for (const f of all) {
    newSync.files[f.path] = f.sha1
    const prev = prevByPath.get(f.path)
    if (sync.files[f.path] === f.sha1 || (prev && prev.sha1 === f.sha1)) {
      // 관리자가 안 고친 파일: 지난번 항목 그대로 → 서버 것 유지 (서버에서 받기만 하고 안 올린 파일은 싣지 않음)
      if (prev) {
        carry(prev)
        kept++
      }
      continue
    }
    const sealed = await sealFile(f, serverKey, releaseDir)
    const sha1 = sha1Of(sealed)
    const url = await addAsset(`s:${sha1}`, `s-${sha1}.bin`, sealed.length, dest => fsp.writeFile(dest, sealed))
    const id = `map:${f.path}`
    bundles.push({ id, url, sha1, size: sealed.length, enc: true })
    files.push({ path: f.path, sha1: f.sha1, size: f.size, mode: 'update', bundle: id })
    changed++
    uploadBytes += f.size
  }
  return { pushed: true, changed, kept, uploadBytes, sync: newSync }
}

// ---- 서버 → 관리자 ----

const mapAssetUrl = (repo, name) => `${github.releaseDownloadPrefix(repo)}${MAP_TAG}/${name}`

// 서버 컴: 서버 월드의 맵을 server-map 릴리스에 올린다. 바뀐 파일만 새로 올리고, 목록(server-map.bin)은 마지막에.
async function sendServerMap ({ repo, token, key, worldAbs, map, tmpDir, log = () => {}, now = new Date() }) {
  const local = await listMapFiles(worldAbs, map)
  if (!local.length) throw new Error(`보낼 맵 파일이 없습니다 (${map.dims.join(', ')})`)
  const release = await github.getOrCreatePrerelease({
    repo,
    token,
    tag: MAP_TAG,
    name: '서버 맵 (관리자용)',
    body: '서버 컴이 보낸 대륙 맵입니다. 서버 키로 암호화되어 있습니다. 지우거나 이름을 바꾸지 마세요.'
  })
  const existing = new Map((await github.listAssets({ repo, token, releaseId: release.id })).map(a => [a.name, a]))
  const entries = []
  let uploaded = 0
  let uploadedBytes = 0
  for (const [i, f] of local.entries()) {
    const sealed = await sealFile(f, key, tmpDir)
    const name = `m-${sha1Of(sealed)}.bin`
    if (!existing.has(name)) {
      await github.uploadAsset({ token, release, name, data: sealed })
      uploaded++
      uploadedBytes += sealed.length
    }
    entries.push({ path: f.path, sha1: await sha1File(f.abs), size: (await fsp.stat(f.abs)).size, asset: name, assetSha1: sha1Of(sealed), assetSize: sealed.length })
    log(`  ${i + 1}/${local.length} ${f.path.split('/').pop()}${existing.has(name) ? '' : ' (올림)'}`)
  }
  const manifest = { sentAt: now.toISOString(), dims: map.dims, files: entries }
  // 목록은 이름이 고정이라 예전 것을 지우고 새로 올린다
  const old = existing.get(MAP_MANIFEST)
  if (old) await github.deleteAsset({ repo, token, id: old.id })
  await github.uploadAsset({ token, release, name: MAP_MANIFEST, data: secret.encrypt(Buffer.from(JSON.stringify(manifest)), key) })
  // 더 이상 목록에 없는 예전 파일 정리
  const keep = new Set(entries.map(e => e.asset))
  let removed = 0
  for (const [name, a] of existing) {
    if (/^m-[0-9a-f]+\.bin$/.test(name) && !keep.has(name)) {
      await github.deleteAsset({ repo, token, id: a.id })
      removed++
    }
  }
  return { sentAt: manifest.sentAt, fileCount: entries.length, uploaded, uploadedBytes, removed }
}

// 관리자 컴: 서버가 보낸 맵 목록 (없으면 null)
async function fetchServerMap (repo, key) {
  const url = new URL(mapAssetUrl(repo, MAP_MANIFEST))
  url.searchParams.set('_', Date.now().toString())
  const res = await fetch(url, { cache: 'no-store' })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`서버 맵 목록을 받지 못했습니다 (HTTP ${res.status})`)
  return JSON.parse(secret.decrypt(Buffer.from(await res.arrayBuffer()), key).toString('utf8'))
}

/**
 * 받기 계획: 서버 맵 파일마다
 *  - same:     싱글 월드와 같음
 *  - take:     싱글 월드에서 안 고침(마지막으로 주고받은 그대로) → 서버 것으로
 *  - conflict: 싱글 월드에서도 고쳤고 서버 것도 다름
 */
async function planPull ({ worldAbs, serverMap, sync }) {
  const plan = { same: [], take: [], conflict: [] }
  for (const s of serverMap.files) {
    const abs = mapAbs(worldAbs, s.path)
    const cur = fs.existsSync(abs) ? await sha1File(abs) : null
    if (cur === s.sha1) plan.same.push(s)
    else if (cur === null || cur === sync.files[s.path]) plan.take.push(s)
    else plan.conflict.push(s)
  }
  return plan
}

// 관리자 컴: 서버 맵을 싱글 월드에 덮는다. 덮기 전 파일은 backupDir 에 복사.
// conflict: 'keep' (싱글 월드 것 유지) | 'take' (서버 것으로)
async function pullServerMap ({ repo, key, worldAbs, outDir, serverMap, conflict = 'keep', backupDir, log = () => {} }) {
  if (worldInUse(worldAbs)) throw new Error('싱글 월드가 게임에서 열려 있습니다. 월드에서 나간 뒤 다시 하세요')
  const sync = await readSync(outDir)
  const plan = await planPull({ worldAbs, serverMap, sync })
  const take = conflict === 'take' ? [...plan.take, ...plan.conflict] : plan.take
  const tmpDir = path.join(outDir, '.map-tmp')
  await fsp.mkdir(tmpDir, { recursive: true })
  try {
    for (const [i, s] of take.entries()) {
      const tmp = path.join(tmpDir, s.asset)
      await downloadVerified({ url: mapAssetUrl(repo, s.asset), dest: tmp, sha1: s.assetSha1, size: s.assetSize })
      const data = unsealFile(await fsp.readFile(tmp), key, s)
      await fsp.rm(tmp, { force: true })
      const dest = mapAbs(worldAbs, s.path)
      if (fs.existsSync(dest)) {
        const b = path.join(backupDir, ...s.path.split('/'))
        await fsp.mkdir(path.dirname(b), { recursive: true })
        await fsp.copyFile(dest, b)
      }
      await fsp.mkdir(path.dirname(dest), { recursive: true })
      await fsp.writeFile(dest + '.part', data)
      await fsp.rename(dest + '.part', dest)
      log(`  ${i + 1}/${take.length} ${s.path.split('/').pop()}`)
    }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  }
  // 받은 파일과 이미 같은 파일은 "주고받은 상태" 로 기록. 싱글 월드 것을 유지한 충돌 파일은 기록을 안 바꿔서 다음 올리기에 실린다
  const files = { ...sync.files }
  for (const s of [...plan.same, ...take]) files[s.path] = s.sha1
  await writeSync(outDir, { files, pulledSentAt: serverMap.sentAt })
  return { taken: take.length, same: plan.same.length, keptConflicts: conflict === 'take' ? 0 : plan.conflict.length }
}

module.exports = {
  MAP_PREFIX,
  MAP_TAG,
  mapSettings,
  isMapPath,
  listMapFiles,
  worldInUse,
  readSync,
  writeSync,
  devChanges,
  addMapToServerPackage,
  sendServerMap,
  fetchServerMap,
  planPull,
  pullServerMap
}
