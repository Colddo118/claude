#!/usr/bin/env node
'use strict'

// 관리자용: 커스포지 인스턴스 폴더를 읽어서 런처가 받아갈 manifest.json 을 만든다.
//
// 모드/리소스팩은 커스포지 CDN 주소를 그대로 쓰고(따로 올릴 필요 없음), 나머지 파일은
//  - GitHub 모드 (pack.config.json 에 "github": "내아이디/저장소"): pack-<버전>.zip 하나로 묶어
//    GitHub Releases 에 올린다. --publish 를 주면 업로드까지 자동.
//  - objects 모드 (기본): objects/ 폴더에 해시 이름으로 복사 → 웹 호스팅에 업로드.
//
//   node tools/build-manifest.js --source "C:/Users/me/curseforge/minecraft/Instances/MyPack" \
//        --out ./pack-dist --version 1.3.0 --notes-file ./notes.md --publish

const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const crypto = require('node:crypto')
const { pipeline } = require('node:stream/promises')
const { writeZip } = require('../launcher/src/common/zip')
const { readCurseForgeFiles, cdnUrlFor, checkUrl } = require('./lib/curseforge')
const modrinth = require('./lib/modrinth')
const { groupFiles } = require('./lib/grouping')
const { SERVER_DIRS, clientOnlyPatterns } = require('./lib/server-files')
const mapSync = require('./lib/map-sync')
const secret = require('../launcher/src/common/secret')
const github = require('./lib/github')
const {
  FORMAT_VERSION,
  matchesAny,
  objectPath,
  validateManifest,
  isSafeRelPath
} = require('../launcher/src/common/manifest')

const DEFAULT_CONFIG = {
  packName: 'My Modpack',
  include: [
    'mods', 'config', 'defaultconfigs', 'kubejs', 'scripts',
    'resourcepacks', 'shaderpacks', 'options.txt', 'servers.dat'
  ],
  // 숨김 폴더(예: mods/.connector 같은 모드 캐시)는 게임이 알아서 다시 만드는 캐시라 배포하지 않는다.
  exclude: ['**/*.disabled', '**/*.bak', '**/.DS_Store', '**/Thumbs.db', '**/.*/**'],
  // 서버에서만 쓰는 파일: 배포하지 않는다 (제작물 보호). 레시피 등 결과는 접속 시 서버가 클라이언트로 보내준다.
  serverOnly: ['kubejs/server_scripts', 'kubejs/data'],
  // 서버가 게임 중에 기록하는 데이터 파일: 친구들에게도, 서버에도 배포하지 않는다 (관리자 테스트 데이터가 서버로 가지 않게)
  serverData: [],
  // 처음 설치할 때만 넣고 이후엔 사용자가 바꾼 값을 유지할 파일들
  once: [
    'options.txt', 'servers.dat',
    // 셰이더/그래픽, JEI 정렬·즐겨찾기, 미니맵 표시 같은 개인 취향 설정 (관리자가 게임하며 바꾼 값이 친구들 설정을 덮지 않게)
    'config/iris.properties', 'config/oculus.properties',
    'config/sodium-options.json', 'config/embeddium-options.json',
    'config/jei', 'config/ftbchunks-client.snbt'
  ],
  // 게임(모드, KubeJS 스크립트)이 실행 중에 스스로 고쳐 쓸 수 있는 파일들: 관리자가 바꿨을 때만 덮어쓴다.
  // 여기 없는 mods / resourcepacks / shaderpacks 는 항상 서버와 똑같이 맞춘다.
  update: ['config', 'defaultconfigs', 'kubejs', 'scripts'],
  // 이 폴더 안에서 매니페스트에 없는 파일은 백업 폴더로 치운다 (서버와 모드 불일치 방지)
  strictDirs: ['mods'],
  changelogLimit: 30
}

const FLAG_OPTIONS = ['force', 'help', 'publish', 'no-cdn', 'no-modrinth', 'no-url-check', 'map', 'reset-notes']
const VALUE_OPTIONS = ['source', 'out', 'version', 'notes', 'notes-file', 'config', 'github']

function parseArgs (argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`알 수 없는 인자: ${a}`)
    const key = a.slice(2)
    // 오타(예: --publishcd)를 조용히 무시하면 업로드가 빠진 채 끝나므로 바로 알려준다
    if (!FLAG_OPTIONS.includes(key) && !VALUE_OPTIONS.includes(key)) throw new Error(`알 수 없는 옵션: ${a} (--help 로 목록 확인)`)
    if (FLAG_OPTIONS.includes(key)) {
      args[key] = true
    } else {
      if (argv[i + 1] === undefined) throw new Error(`${a} 에 값이 필요합니다`)
      args[key] = argv[++i]
    }
  }
  return args
}

const USAGE = `사용법:
  node tools/build-manifest.js --source <모드팩 폴더> --out <출력 폴더> --version <버전>
       [--notes "패치노트" | --notes-file <파일>] [--config <pack.config.json>] [--publish] [--force]

  --source        커스포지 인스턴스 폴더 (mods, config 등이 있는 곳)
  --out           결과물 폴더. 기존 manifest.json 이 있으면 패치노트 이력을 이어 붙인다
  --version       새 모드팩 버전 (예: 1.3.0). 생략하면 이전 버전 +1
  --config        설정 파일. 생략하면 <source>/pack.config.json 을 찾는다
  --publish       GitHub 모드일 때 릴리스까지 자동으로 올린다 (GITHUB_TOKEN 환경변수 필요)
  --no-cdn        커스포지 CDN 을 쓰지 않고 모든 파일을 직접 올린다
  --no-modrinth   커스포지에 없는 모드를 모드린스에서 찾지 않는다
  --no-url-check  CDN 주소 확인(HEAD 요청)을 건너뛴다
  --map           싱글 월드에서 바뀐 대륙 맵(pack.config.json 의 "map")을 서버 패키지에 싣는다.
                  안 주면 서버 맵은 지난 패치 그대로 둔다
  --reset-notes   지금까지의 패치노트 기록을 지우고 이번 패치노트부터 새로 시작
  --force         같은 버전으로 다시 빌드 허용`

// 커스포지 인스턴스의 minecraftinstance.json 에서 MC/로더 버전을 읽는다.
async function detectFromCurseForge (sourceDir) {
  let info
  try {
    info = JSON.parse(await fsp.readFile(path.join(sourceDir, 'minecraftinstance.json'), 'utf8'))
  } catch {
    return {}
  }
  const minecraft = info.gameVersion || (info.baseModLoader && info.baseModLoader.minecraftVersion)
  const name = info.baseModLoader && info.baseModLoader.name // 예: neoforge-21.1.77, forge-47.2.0, fabric-0.15.11-1.20.1
  if (!minecraft) return {}
  if (!name) return { minecraft, loader: { type: 'vanilla' } }
  const dash = name.indexOf('-')
  const type = name.slice(0, dash).toLowerCase()
  let version = name.slice(dash + 1)
  // 이름에 MC 버전이 앞(neoforge-1.21.1-21.1.77)이나 뒤(fabric-0.16.5-1.21.1)에 붙는 경우가 있다.
  if (version.startsWith(`${minecraft}-`)) version = version.slice(minecraft.length + 1)
  if (version.endsWith(`-${minecraft}`)) version = version.slice(0, -(minecraft.length + 1))
  return { minecraft, loader: { type, version } }
}

async function walk (root, rel = '') {
  const out = []
  const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true })
  for (const ent of entries) {
    const childRel = rel ? `${rel}/${ent.name}` : ent.name
    if (ent.isDirectory()) out.push(...await walk(root, childRel))
    else if (ent.isFile()) out.push(childRel)
  }
  return out
}

async function sha1File (file) {
  const hash = crypto.createHash('sha1')
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest('hex')
}

// 해시 기록: 크기·수정 시각이 그대로인 파일은 다시 읽지 않는다 (파일이 수천 개라 매번 전부 읽으면 오래 걸림)
async function openHashCache (outDir) {
  const file = path.join(outDir, '.hash-cache.json')
  let saved = {}
  try { saved = JSON.parse(await fsp.readFile(file, 'utf8')) || {} } catch {}
  const used = new Map()
  return {
    async hash (abs) {
      const st = await fsp.stat(abs)
      const c = saved[abs]
      const sha1 = c && c.size === st.size && c.mtimeMs === st.mtimeMs ? c.sha1 : await sha1File(abs)
      used.set(abs, { size: st.size, mtimeMs: st.mtimeMs, sha1 })
      return { sha1, size: st.size }
    },
    async save () {
      await fsp.mkdir(outDir, { recursive: true })
      await fsp.writeFile(file, JSON.stringify(Object.fromEntries(used)))
    }
  }
}

// 묶음 재사용: 묶음 이름과 안의 파일(경로+해시)이 이전 버전과 똑같으면 다시 압축하지 않고 이전 묶음을 쓴다
function contentKey (id, files) {
  return id + '\n' + files.map(f => `${f.path}:${f.sha1}`).sort().join('\n')
}

function indexBundles (manifest, filter = () => true) {
  const members = new Map()
  for (const f of (manifest && manifest.files) || []) {
    if (!f.bundle) continue
    if (!members.has(f.bundle)) members.set(f.bundle, [])
    members.get(f.bundle).push(f)
  }
  const index = new Map()
  for (const b of (manifest && manifest.bundles) || []) {
    if (filter(b) && members.has(b.id)) index.set(contentKey(b.id, members.get(b.id)), b)
  }
  return index
}

// 이전 릴리스에 실제로 남아 있는 묶음만 (주소 확인은 동시에 여러 개)
function findReusable (groups, idOf, index, skipPrefix) {
  return mapLimit(groups, 8, async g => {
    const prev = index.get(contentKey(idOf(g), g.files))
    if (!prev || prev.url.startsWith(skipPrefix)) return null
    return (await checkUrl(prev.url, prev.size)) ? prev : null
  })
}

async function readJsonIfExists (file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

// 배포 폴더(pack-dist-gh)를 잃어버렸을 때: GitHub 에 올라가 있는 최신 버전 기록을 대신 쓴다.
// (패치노트 기록과 바뀌지 않은 파일 재사용이 끊기지 않게. 못 받으면 처음 배포처럼 진행)
async function fetchLatestAsset (repo, name) {
  try {
    const res = await fetch(`${github.manifestUrl(repo).replace(/manifest\.json$/, '')}${name}`, { signal: AbortSignal.timeout(30000) })
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
}

// 이전 서버 패키지가 지금 서버 키로 만든 것인지 (키가 바뀌었으면 이전 암호화 묶음을 재사용하면 안 됨)
function keyCheck (serverKey) {
  return crypto.createHash('sha256').update(`krp-key-check:${serverKey}`).digest('hex').slice(0, 16)
}

async function remotePrevious ({ repo, outDir, serverKey, log }) {
  let previous = await readJsonIfExists(path.join(outDir, 'manifest.json'))
  let previousServer = await readJsonIfExists(path.join(outDir, 'server-manifest.json'))
  if (!previous) {
    const buf = await fetchLatestAsset(repo, 'manifest.json')
    try { previous = buf && JSON.parse(buf.toString('utf8')) } catch { previous = null }
    if (previous) log(`  (로컬 배포 기록이 없어 GitHub 의 v${previous.version} 기록을 이어서 씁니다)`)
  }
  // 서버 목록은 GitHub 에 실제로 공개된 것을 기준으로 이어 간다. 로컬 기록은 업로드가 중간에 끊긴 배포
  // (GitHub 에 없는 파일을 가리킴)일 수 있어서, 공개본을 못 받을 때만 쓴다.
  if (previous && serverKey) {
    const buf = await fetchLatestAsset(repo, 'server-manifest.bin')
    if (buf) {
      try {
        previousServer = { ...JSON.parse(secret.decrypt(buf, serverKey).toString('utf8')), keyCheck: keyCheck(serverKey) }
      } catch {
        // 키가 바뀌었으면 이전 서버 패키지를 못 연다 → 서버 전용 파일은 새로 올린다 (서버 키트도 다시 복사해야 함)
        log('  ! 이전 서버 패키지를 지금 서버 키로 열 수 없습니다. 서버 전용 파일을 새로 올립니다 (서버 키트 다시 복사 필요).')
        previousServer = null
      }
    }
  }
  return { previous, previousServer }
}

async function mapLimit (items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }))
  return out
}

const LARGE_FILE = 4 * 1024 * 1024 // 이보다 큰 파일은 릴리스에 파일째 올린다
const BUNDLE_LIMIT = 16 * 1024 * 1024 // 작은 파일 묶음(zip) 하나의 목표 크기

/**
 * GitHub 모드: 직접 올릴 파일들을 릴리스 첨부 파일로 만든다.
 * - 큰 파일은 f-<sha1>, 작은 파일은 폴더 단위 묶음 b-<sha1>.zip
 * - 이전 버전 매니페스트에 같은 해시가 있으면 그 주소를 그대로 재사용 (다시 올리지도, 다시 받지도 않음)
 */
async function buildGithubAssets ({ repo, version, sourceDir, outDir, previous, previousServer, selfHosted, bundles, newAssets, largeFile, bundleLimit }) {
  const releaseDir = path.join(outDir, `release-${version}`)
  await fsp.rm(releaseDir, { recursive: true, force: true })
  await fsp.mkdir(releaseDir, { recursive: true })

  const known = new Map()
  const ownPrefix = github.releaseDownloadPrefix(repo)
  for (const f of (previous && previous.files) || []) {
    if (f.url && f.url.startsWith(ownPrefix)) known.set(`f:${f.sha1}`, f.url)
  }
  for (const b of (previous && previous.bundles) || []) known.set(`b:${b.sha1}`, b.url)
  for (const b of (previousServer && previousServer.bundles) || []) if (b.enc) known.set(`s:${b.sha1}`, b.url)

  let reused = 0
  const thisRelease = github.assetUrl(repo, version, '')
  const pending = new Map() // 같은 파일을 동시에 두 번 만들지 않게
  const addAsset = (key, name, size, produce) => {
    if (!pending.has(key)) {
      pending.set(key, (async () => {
        // 이전 릴리스에 같은 파일이 실제로 올라가 있을 때만 재사용한다.
        // (같은 버전을 --force 로 다시 빌드했거나, 빌드만 하고 업로드는 안 한 버전이면 다시 올린다)
        const prev = known.get(key)
        if (prev && !prev.startsWith(thisRelease) && await checkUrl(prev, size)) {
          reused++
          return prev
        }
        const dest = path.join(releaseDir, name)
        await produce(dest)
        newAssets.push(dest)
        return github.assetUrl(repo, version, name)
      })())
    }
    return pending.get(key)
  }

  await mapLimit(selfHosted.filter(f => f.size >= largeFile), 8, async f => {
    f.url = await addAsset(`f:${f.sha1}`, `f-${f.sha1}`, f.size, dest => fsp.copyFile(path.join(sourceDir, ...f.path.split('/')), dest))
  })

  const tmp = path.join(releaseDir, '.building.zip')
  const groups = groupFiles(selfHosted.filter(f => f.size < largeFile), bundleLimit)
  const reusable = await findReusable(groups, g => g.id, indexBundles(previous), thisRelease)
  for (const [i, g] of groups.entries()) {
    const prev = reusable[i]
    if (prev) {
      reused++
      bundles.push({ id: g.id, url: prev.url, sha1: prev.sha1, size: prev.size })
      for (const f of g.files) f.bundle = g.id
      continue
    }
    await writeZip(tmp, g.files.map(f => ({ name: f.path, file: path.join(sourceDir, ...f.path.split('/')) })))
    const sha1 = await sha1File(tmp)
    const size = (await fsp.stat(tmp)).size
    const url = await addAsset(`b:${sha1}`, `b-${sha1}.zip`, size, dest => fsp.rename(tmp, dest))
    await fsp.rm(tmp, { force: true })
    bundles.push({ id: g.id, url, sha1, size })
    for (const f of g.files) f.bundle = g.id
  }
  return { releaseDir, addAsset, reused: () => reused, countReused: () => { reused++ }, thisRelease }
}

/**
 * 서버 패키지: 서버 컴의 서버시작.bat 이 받아가는 목록 (server-manifest.bin, 전체 암호화).
 * - 친구들과 같은 파일(모드, 설정 등)은 같은 주소·묶음을 그대로 쓴다
 * - 서버 전용 파일(서버 스크립트·데이터)은 암호화 묶음(s-<sha1>.bin)으로 올린다
 * - 클라이언트 전용 모드는 뺀다
 */
async function buildServerPackage ({ serverKey, included, clientFiles, clientBundles, sourceDir, outDir, releaseDir, addAsset, countReused = () => {}, thisRelease = '', hashes, bundleLimit, userConfig, base, previousServer, pushMap, log = () => {} }) {
  const hashOf = hashes ? abs => hashes.hash(abs) : async abs => ({ sha1: await sha1File(abs), size: (await fsp.stat(abs)).size })
  const clientOnly = clientOnlyPatterns(userConfig)
  const byPath = new Map(clientFiles.map(f => [f.path, f]))
  const files = []
  const secretFiles = []
  const serverRels = included.filter(rel => matchesAny(rel, SERVER_DIRS) && !matchesAny(rel.toLowerCase(), clientOnly))
  const ownHashes = await mapLimit(serverRels, 8, rel => byPath.has(rel) ? null : hashOf(path.join(sourceDir, ...rel.split('/'))))
  for (const [i, rel] of serverRels.entries()) {
    const shared = byPath.get(rel)
    const entry = shared
      ? { path: rel, sha1: shared.sha1, size: shared.size, ...(shared.url ? { url: shared.url } : {}), ...(shared.bundle ? { bundle: shared.bundle } : {}) }
      : { path: rel, ...ownHashes[i] }
    // 모드는 항상 똑같이, 나머지는 관리자가 바꿨을 때만 (서버가 실행 중에 쓰는 데이터 보존)
    if (!rel.startsWith('mods/')) entry.mode = 'update'
    if (!shared) secretFiles.push(entry)
    files.push(entry)
  }

  const bundles = clientBundles.filter(b => files.some(f => f.bundle === b.id))
  const tmp = path.join(releaseDir, '.building-server.zip')
  const secretGroups = groupFiles(secretFiles, bundleLimit)
  const reusable = await findReusable(secretGroups, g => `server:${g.id}`, indexBundles(previousServer, b => b.enc), thisRelease || '\0')
  for (const [i, g] of secretGroups.entries()) {
    const prev = reusable[i]
    if (prev) {
      countReused()
      bundles.push(prev)
      for (const f of g.files) f.bundle = prev.id
      continue
    }
    await writeZip(tmp, g.files.map(f => ({ name: f.path, file: path.join(sourceDir, ...f.path.split('/')) })))
    const sealed = secret.encrypt(await fsp.readFile(tmp), serverKey)
    await fsp.rm(tmp, { force: true })
    const sha1 = require('node:crypto').createHash('sha1').update(sealed).digest('hex')
    const url = await addAsset(`s:${sha1}`, `s-${sha1}.bin`, sealed.length, dest => fsp.writeFile(dest, sealed))
    const id = `server:${g.id}`
    bundles.push({ id, url, sha1, size: sealed.length, enc: true })
    for (const f of g.files) f.bundle = id
  }

  // 대륙 맵: 서버 패키지에만 실린다 (--map 이 아니면 지난 패키지의 맵 항목을 그대로 이어 감)
  const map = mapSync.mapSettings(userConfig)
  const mapReport = await mapSync.addMapToServerPackage({ push: pushMap, map, sourceDir, outDir, previousServer, files, bundles, releaseDir, addAsset, serverKey, thisRelease, log })

  const serverManifest = { ...base, strictDirs: [], clientOnly, bundles, files, ...(map ? { map: { dims: map.dims, parts: map.parts } } : {}) }
  validateManifest(serverManifest)
  // 다음 빌드에서 재사용 판단용 (로컬에만 보관, 업로드는 암호화본만)
  await fsp.writeFile(path.join(outDir, 'server-manifest.json'), JSON.stringify({ ...serverManifest, keyCheck: keyCheck(serverKey) }, null, 2))
  const binFile = path.join(releaseDir, 'server-manifest.bin')
  await fsp.writeFile(binFile, secret.encrypt(Buffer.from(JSON.stringify(serverManifest)), serverKey))
  return { manifest: serverManifest, binFile, fileCount: files.length, secretCount: secretFiles.length, map: mapReport }
}

/**
 * 배포 전 점검: 친구용·서버용 목록이 가리키는 GitHub 파일이 전부 받을 수 있는 상태인지.
 * - 이번 릴리스 주소면 이번에 올릴 파일 안에 있어야 하고
 * - 예전 릴리스 주소면 지금 실제로 받을 수 있어야 한다
 * 하나라도 아니면 올리지 않고 멈춘다 (서버·친구가 404 를 받는 일이 없게).
 */
async function verifyReferences ({ manifests, thisRelease, newAssets }) {
  const names = new Set(newAssets.map(f => path.basename(f)))
  const refs = new Map()
  for (const m of manifests) {
    for (const b of m.bundles || []) refs.set(b.url, { url: b.url, size: b.size, what: `묶음 ${b.id}` })
    for (const f of m.files || []) if (f.url && !f.bundle && f.url.startsWith(thisRelease.replace(/[^/]+\/$/, ''))) refs.set(f.url, { url: f.url, size: f.size, what: f.path })
  }
  const list = [...refs.values()]
  const ok = await mapLimit(list, 8, r => r.url.startsWith(thisRelease)
    ? names.has(decodeURIComponent(r.url.slice(thisRelease.length)))
    : checkUrl(r.url, r.size))
  const missing = list.filter((_, i) => !ok[i])
  if (missing.length) {
    throw new Error(`배포 전 점검 실패: 받을 수 없는 파일 ${missing.length}개 → 올리지 않았습니다.\n` +
      missing.slice(0, 10).map(r => `    ${r.what}: ${r.url.split('/').slice(-2).join('/')}`).join('\n'))
  }
}

function nextVersion (v) {
  const parts = String(v).split('.')
  const last = parts.length - 1
  if (!/^\d+$/.test(parts[last])) throw new Error(`이전 버전 ${v} 에서 다음 버전을 정할 수 없습니다. --version 을 적어주세요.`)
  parts[last] = String(Number(parts[last]) + 1)
  return parts.join('.')
}

async function build ({ source, out, version, notes, config: configPath, force, github: githubArg, serverKey = process.env.SERVER_PACK_KEY, ...flags }) {
  const sourceDir = path.resolve(source)
  const outDir = path.resolve(out)
  const userConfig = await readJsonIfExists(configPath ? path.resolve(configPath) : path.join(sourceDir, 'pack.config.json')) || {}
  // exclude / once 는 기본값에 더한다 (기본 목록을 매번 다시 적지 않아도 되게)
  const merged = key => [...DEFAULT_CONFIG[key], ...(userConfig[key] || [])]
  const config = { ...DEFAULT_CONFIG, ...userConfig, exclude: merged('exclude'), once: merged('once'), serverOnly: merged('serverOnly'), serverData: merged('serverData') }
  const repo = githubArg || config.github
  const mode = repo ? 'github' : 'objects'

  const detected = await detectFromCurseForge(sourceDir)
  const minecraft = config.minecraft || detected.minecraft
  const loader = config.loader || detected.loader
  if (!minecraft || !loader) {
    throw new Error('마인크래프트/로더 버전을 알 수 없습니다. pack.config.json 에 "minecraft" 와 "loader" 를 적어주세요.')
  }

  const log = flags.quiet ? () => {} : console.log
  let { previous, previousServer } = mode === 'github' && flags['remote-previous'] !== false
    ? await remotePrevious({ repo, outDir, serverKey, log })
    : { previous: await readJsonIfExists(path.join(outDir, 'manifest.json')), previousServer: await readJsonIfExists(path.join(outDir, 'server-manifest.json')) }
  if (previousServer && (!serverKey || previousServer.keyCheck !== keyCheck(serverKey))) previousServer = null
  if (previous && previous.version === version && !force) {
    // 빌드는 됐지만 업로드가 실패해서 GitHub 에 없는 버전이면 같은 번호로 다시 해도 된다
    const unpublished = mode === 'github' && flags.publish && !(await checkUrl(github.assetUrl(repo, version, 'manifest.json')))
    if (!unpublished) throw new Error(`이미 ${version} 버전이 빌드되어 있습니다. 버전을 올리거나 --force 를 쓰세요.`)
  }

  const walked = (await walk(sourceDir)).filter(p => matchesAny(p, config.include) && !matchesAny(p, config.exclude))
  const serverDataFiles = walked.filter(p => matchesAny(p, config.serverData))
  const included = walked.filter(p => !matchesAny(p, config.serverData))
  const serverOnlyFiles = included.filter(p => matchesAny(p, config.serverOnly))
  const candidates = included.filter(p => !matchesAny(p, config.serverOnly)).sort()
  const cdnMap = flags['no-cdn'] || config.useCurseForgeCdn === false ? new Map() : await readCurseForgeFiles(sourceDir)

  const started = Date.now()
  const lap = label => log(`  · ${label} (${((Date.now() - started) / 1000).toFixed(0)}초)`)
  for (const rel of candidates) if (!isSafeRelPath(rel)) throw new Error(`지원하지 않는 파일 경로: ${rel}`)
  const hashes = await openHashCache(outDir)
  const files = await mapLimit(candidates, 8, async rel => {
    const entry = { path: rel, ...(await hashes.hash(path.join(sourceDir, ...rel.split('/')))) }
    if (matchesAny(rel, config.once)) entry.mode = 'once'
    else if (matchesAny(rel, config.update)) entry.mode = 'update'
    const url = cdnUrlFor(cdnMap, rel, entry.sha1)
    if (url) entry.url = url
    return entry
  })
  lap(`파일 ${files.length}개 확인`)

  // CDN 주소가 실제로 살아 있는지 확인하고, 안 되는 파일은 직접 올리는 쪽으로 돌린다.
  const cdnFailed = []
  if (!flags['no-url-check']) {
    const withUrl = files.filter(f => f.url)
    const ok = await mapLimit(withUrl, 8, f => checkUrl(f.url, f.size))
    withUrl.forEach((f, i) => {
      if (!ok[i]) {
        cdnFailed.push(f.path)
        delete f.url
      }
    })
  }

  if (!flags['no-url-check']) lap('CDN 주소 확인')

  // 커스포지에서 못 받는 모드·리소스팩은 모드린스에서 같은 파일(sha1)을 찾아 본다 (남의 모드를 GitHub 에 다시 올리지 않게)
  let modrinthCount = 0
  if (!flags['no-modrinth'] && config.useModrinth !== false) {
    const lookFor = files.filter(f => !f.url && /^(mods|resourcepacks|shaderpacks)\/[^/]+\.(jar|zip)$/i.test(f.path))
    if (lookFor.length) {
      const found = await modrinth.lookupByHash(lookFor.map(f => f.sha1), { log: console.log })
      const hits = lookFor.filter(f => found.has(f.sha1))
      const ok = flags['no-url-check'] ? hits.map(() => true) : await mapLimit(hits, 8, f => checkUrl(found.get(f.sha1), f.size))
      hits.forEach((f, i) => {
        if (!ok[i]) return
        f.url = found.get(f.sha1)
        modrinthCount++
        const k = cdnFailed.indexOf(f.path)
        if (k >= 0) cdnFailed.splice(k, 1)
      })
    }
  }

  await fsp.mkdir(outDir, { recursive: true })
  const selfHosted = files.filter(f => !f.url)
  const bundles = []
  const newAssets = []
  let releaseDir
  let assets
  let newObjects = 0
  const MB = 1024 * 1024
  const bundleLimit = config.bundleSizeMB ? config.bundleSizeMB * MB : BUNDLE_LIMIT
  if (flags.map && !(mode === 'github' && serverKey)) throw new Error('--map 은 GitHub 배포 + 서버 키가 있을 때만 쓸 수 있습니다')
  if (mode === 'github') {
    assets = await buildGithubAssets({
      repo, version, sourceDir, outDir, previous, previousServer, selfHosted, bundles, newAssets, bundleLimit,
      largeFile: config.largeFileMB ? config.largeFileMB * MB : LARGE_FILE
    })
    releaseDir = assets.releaseDir
    lap(`올릴 파일 준비 (재사용 ${assets.reused()}개)`)
  } else {
    for (const f of selfHosted) {
      const objFile = path.join(outDir, ...objectPath(f.sha1).split('/'))
      if (!fs.existsSync(objFile)) {
        await fsp.mkdir(path.dirname(objFile), { recursive: true })
        await fsp.copyFile(path.join(sourceDir, ...f.path.split('/')), objFile)
        newObjects++
      }
    }
  }

  const history = (!flags['reset-notes'] && previous && Array.isArray(previous.changelog) ? previous.changelog : [])
    .filter(c => c.version !== version)
  const changelog = [
    { version, date: new Date().toISOString().slice(0, 10), notes: (notes || '').trim() },
    ...history
  ].slice(0, config.changelogLimit)

  const base = { formatVersion: FORMAT_VERSION, packName: config.packName, version, minecraft, loader }
  const manifest = {
    ...base,
    ...(config.java ? { java: config.java } : {}),
    ...(config.server ? { server: config.server } : {}),
    ...(config.memory ? { memory: config.memory } : {}),
    strictDirs: config.strictDirs,
    ...(bundles.length ? { bundles } : {}),
    changelog,
    files
  }
  validateManifest(manifest)
  const manifestFile = path.join(outDir, 'manifest.json')
  await fsp.writeFile(manifestFile, JSON.stringify(manifest, null, 2))
  if (releaseDir) {
    // 릴리스에 올릴 파일은 releaseDir 한 곳에 모아 둔다 (수동 업로드 시 폴더 안 파일을 전부 첨부하면 됨)
    await fsp.copyFile(manifestFile, path.join(releaseDir, 'manifest.json'))
    newAssets.push(path.join(releaseDir, 'manifest.json'))
  }
  let serverPackage = null
  if (mode === 'github' && serverKey) {
    serverPackage = await buildServerPackage({
      serverKey, included, clientFiles: files, clientBundles: bundles, sourceDir, outDir, releaseDir,
      addAsset: assets.addAsset, countReused: assets.countReused, thisRelease: assets.thisRelease, hashes,
      bundleLimit, userConfig, base, previousServer, pushMap: !!flags.map, log
    })
    lap('서버 패키지 준비')
    newAssets.push(serverPackage.binFile)
  }
  await hashes.save()
  if (releaseDir && !flags['no-url-check']) {
    await verifyReferences({ manifests: [manifest, serverPackage && serverPackage.manifest].filter(Boolean), thisRelease: assets.thisRelease, newAssets })
    lap('배포 전 점검')
  }

  // 어디가 큰지 보여주기 위한 요약: 폴더별 합계, 가장 큰 파일
  const byDir = {}
  for (const f of files) {
    const dir = f.path.includes('/') ? f.path.split('/')[0] + '/' : f.path
    byDir[dir] = (byDir[dir] || 0) + f.size
  }
  const sizeByDir = Object.entries(byDir).sort((a, b) => b[1] - a[1])
  const largest = [...files].sort((a, b) => b.size - a.size).slice(0, 10)

  return {
    manifest,
    mode,
    sizeByDir,
    largest,
    repo,
    newObjects,
    newAssets,
    releaseDir,
    reused: assets ? assets.reused() : 0,
    serverPackage,
    manifestFile,
    cdnCount: files.length - selfHosted.length - modrinthCount,
    modrinthCount,
    cdnFailed,
    serverOnlyCount: serverOnlyFiles.length,
    serverDataFiles,
    selfHostedBytes: selfHosted.reduce((n, f) => n + f.size, 0),
    totalBytes: files.reduce((n, f) => n + f.size, 0)
  }
}

const mb = n => `${(n / 1024 / 1024).toFixed(1)} MB`

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (!args.version && args.out && !args.help) {
    // 버전을 안 적으면 이전 버전의 마지막 숫자를 +1 (1.0.1 → 1.0.2)
    const previous = await readJsonIfExists(path.join(path.resolve(args.out), 'manifest.json'))
    if (previous) args.version = nextVersion(previous.version)
  }
  if (args.help || !args.source || !args.out || !args.version) {
    console.log(USAGE)
    process.exit(args.help ? 0 : 1)
  }
  const notes = args['notes-file'] ? await fsp.readFile(args['notes-file'], 'utf8') : args.notes
  const saved = []
  for (const name of ['manifest.json', 'server-manifest.json']) {
    const file = path.join(path.resolve(args.out), name)
    saved.push([file, await fsp.readFile(file).catch(() => null)])
  }
  const r = await build({ ...args, notes })
  const { manifest } = r
  console.log(`✔ ${manifest.packName} v${manifest.version} (MC ${manifest.minecraft}, ${manifest.loader.type} ${manifest.loader.version || ''})`)
  console.log(`  파일 ${manifest.files.length}개 (총 ${mb(r.totalBytes)})`)
  console.log(`  - 서버 전용이라 배포에서 뺀 파일: ${r.serverOnlyCount}개 (${[...new Set(DEFAULT_CONFIG.serverOnly)].join(', ')} 등)`)
  if (r.serverDataFiles.length) console.log(`  - 서버 데이터(serverData)라 어디에도 배포 안 함: ${r.serverDataFiles.length}개`)
  console.log(`  - 커스포지 CDN 에서 받음: ${r.cdnCount}개`)
  if (r.modrinthCount) console.log(`  - 모드린스에서 받음: ${r.modrinthCount}개`)
  console.log(`  - 직접 올릴 파일: ${manifest.files.length - r.cdnCount - r.modrinthCount}개 (${mb(r.selfHostedBytes)})`)
  console.log('  폴더별 크기:')
  for (const [dir, size] of r.sizeByDir.slice(0, 8)) console.log(`    ${mb(size).padStart(10)}  ${dir}`)
  console.log('  가장 큰 파일:')
  const source = f => !f.url ? '' : r.repo && f.url.startsWith(github.releaseDownloadPrefix(r.repo)) ? '  (GitHub)' : /modrinth\.com\//.test(f.url) ? '  (모드린스)' : '  (CDN)'
  for (const f of r.largest) console.log(`    ${mb(f.size).padStart(10)}  ${f.path}${source(f)}`)
  const map = r.serverPackage && r.serverPackage.map
  if (map && map.pushed) console.log(`  - 대륙 맵: 싱글 월드에서 바뀐 파일 ${map.changed}개 (${mb(map.uploadBytes)}) → 서버가 덮음, 안 바뀐 파일 ${map.kept}개는 서버 것 유지`)
  else if (map && map.carried) console.log(`  - 대륙 맵: 이번엔 안 올림 (서버 맵 그대로, 지난 항목 ${map.carried}개 이어 감)`)
  if (r.cdnFailed.length) {
    console.log(`  ! CDN 주소 확인 실패로 직접 올리는 파일 ${r.cdnFailed.length}개: ${r.cdnFailed.slice(0, 5).join(', ')}${r.cdnFailed.length > 5 ? ' ...' : ''}`)
  }

  // 맵을 실었으면 "마지막으로 주고받은 상태" 를 기록 (업로드에 실패하면 기록하지 않음)
  const saveMapSync = async () => { if (map && map.pushed) await mapSync.writeSync(path.resolve(args.out), map.sync) }
  if (r.mode === 'objects') {
    console.log(`  → ${path.resolve(args.out)} 폴더를 웹 호스팅에 업로드하세요 (새 파일 ${r.newObjects}개, manifest.json 은 마지막에).`)
    return
  }
  const uploadBytes = (await Promise.all(r.newAssets.map(f => fsp.stat(f).then(s => s.size)))).reduce((a, b) => a + b, 0)
  console.log(`  GitHub 릴리스에 새로 올릴 파일: ${r.newAssets.length}개 (${mb(uploadBytes)}), 이전 릴리스 재사용: ${r.reused}개`)
  if (!args.publish) {
    console.log(`  → GitHub 에서 ${r.repo} 저장소에 태그 ${github.releaseTag(manifest.version)} 로 새 릴리스를 만들고`)
    console.log(`    ${r.releaseDir} 폴더 안의 파일을 전부 첨부하세요. (--publish 를 주면 자동)`)
    await saveMapSync()
  } else {
    try {
      await github.publishRelease({
        repo: r.repo,
        token: process.env.GITHUB_TOKEN,
        version: manifest.version,
        notes,
        files: r.newAssets,
        log: console.log
      })
    } catch (e) {
      // 올리지 못했으면 로컬 기록도 이전(실제로 배포된) 상태로 돌려 둔다
      for (const [file, content] of saved) {
        if (content === null) await fsp.rm(file, { force: true })
        else await fsp.writeFile(file, content)
      }
      throw e
    }
    await saveMapSync()
    console.log(`  ✔ GitHub 릴리스 ${github.releaseTag(manifest.version)} 게시 완료. 이제 런처에 업데이트가 뜹니다.`)
  }
  console.log('  ⚠ 이전 릴리스는 지우지 마세요. 바뀌지 않은 파일은 예전 릴리스에서 받습니다.')
  console.log(`  런처 설정(manifestUrl): ${github.manifestUrl(r.repo)}`)
}

if (require.main === module) {
  main().catch(e => {
    console.error(`✘ ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`)
    // 2 = GitHub 가 토큰을 거부함 (patch.ps1 은 이때만 저장된 토큰을 지운다)
    process.exit(e.status === 401 || e.status === 403 ? 2 : 1)
  })
}

module.exports = { build, detectFromCurseForge, nextVersion, parseArgs, readJsonIfExists, sha1File, walk, DEFAULT_CONFIG }
