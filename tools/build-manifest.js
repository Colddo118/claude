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
const { groupFiles } = require('./lib/grouping')
const { SERVER_DIRS, clientOnlyPatterns } = require('./lib/server-files')
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

const FLAG_OPTIONS = ['force', 'help', 'publish', 'no-cdn', 'no-url-check']
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
  --no-url-check  CDN 주소 확인(HEAD 요청)을 건너뛴다
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

async function readJsonIfExists (file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
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
  const addAsset = async (key, name, size, produce) => {
    // 이전 릴리스에 같은 파일이 실제로 올라가 있을 때만 재사용한다.
    // (같은 버전을 --force 로 다시 빌드했거나, 빌드만 하고 업로드는 안 한 버전이면 다시 올린다)
    const prev = known.get(key)
    if (prev && !prev.startsWith(thisRelease) && await checkUrl(prev, size)) {
      reused++
      return prev
    }
    const dest = path.join(releaseDir, name)
    if (!newAssets.includes(dest)) {
      await produce(dest)
      newAssets.push(dest)
    }
    const url = github.assetUrl(repo, version, name)
    known.set(key, url)
    return url
  }

  for (const f of selfHosted.filter(f => f.size >= largeFile)) {
    f.url = await addAsset(`f:${f.sha1}`, `f-${f.sha1}`, f.size, dest => fsp.copyFile(path.join(sourceDir, ...f.path.split('/')), dest))
  }

  const tmp = path.join(releaseDir, '.building.zip')
  for (const g of groupFiles(selfHosted.filter(f => f.size < largeFile), bundleLimit)) {
    await writeZip(tmp, g.files.map(f => ({ name: f.path, file: path.join(sourceDir, ...f.path.split('/')) })))
    const sha1 = await sha1File(tmp)
    const size = (await fsp.stat(tmp)).size
    const url = await addAsset(`b:${sha1}`, `b-${sha1}.zip`, size, dest => fsp.rename(tmp, dest))
    await fsp.rm(tmp, { force: true })
    bundles.push({ id: g.id, url, sha1, size })
    for (const f of g.files) f.bundle = g.id
  }
  return { releaseDir, addAsset, reused: () => reused }
}

/**
 * 서버 패키지: 서버 컴의 서버시작.bat 이 받아가는 목록 (server-manifest.bin, 전체 암호화).
 * - 친구들과 같은 파일(모드, 설정 등)은 같은 주소·묶음을 그대로 쓴다
 * - 서버 전용 파일(서버 스크립트·데이터)은 암호화 묶음(s-<sha1>.bin)으로 올린다
 * - 클라이언트 전용 모드는 뺀다
 */
async function buildServerPackage ({ serverKey, included, clientFiles, clientBundles, sourceDir, outDir, releaseDir, addAsset, bundleLimit, userConfig, base }) {
  const clientOnly = clientOnlyPatterns(userConfig)
  const byPath = new Map(clientFiles.map(f => [f.path, f]))
  const files = []
  const secretFiles = []
  for (const rel of included) {
    if (!matchesAny(rel, SERVER_DIRS) || matchesAny(rel.toLowerCase(), clientOnly)) continue
    const shared = byPath.get(rel)
    const entry = shared
      ? { path: rel, sha1: shared.sha1, size: shared.size, ...(shared.url ? { url: shared.url } : {}), ...(shared.bundle ? { bundle: shared.bundle } : {}) }
      : { path: rel, sha1: await sha1File(path.join(sourceDir, ...rel.split('/'))), size: (await fsp.stat(path.join(sourceDir, ...rel.split('/')))).size }
    // 모드는 항상 똑같이, 나머지는 관리자가 바꿨을 때만 (서버가 실행 중에 쓰는 데이터 보존)
    if (!rel.startsWith('mods/')) entry.mode = 'update'
    if (!shared) secretFiles.push(entry)
    files.push(entry)
  }

  const bundles = clientBundles.filter(b => files.some(f => f.bundle === b.id))
  const tmp = path.join(releaseDir, '.building-server.zip')
  for (const g of groupFiles(secretFiles, bundleLimit)) {
    await writeZip(tmp, g.files.map(f => ({ name: f.path, file: path.join(sourceDir, ...f.path.split('/')) })))
    const sealed = secret.encrypt(await fsp.readFile(tmp), serverKey)
    await fsp.rm(tmp, { force: true })
    const sha1 = require('node:crypto').createHash('sha1').update(sealed).digest('hex')
    const url = await addAsset(`s:${sha1}`, `s-${sha1}.bin`, sealed.length, dest => fsp.writeFile(dest, sealed))
    const id = `server:${g.id}`
    bundles.push({ id, url, sha1, size: sealed.length, enc: true })
    for (const f of g.files) f.bundle = id
  }

  const serverManifest = { ...base, strictDirs: [], clientOnly, bundles, files }
  validateManifest(serverManifest)
  // 다음 빌드에서 재사용 판단용 (로컬에만 보관, 업로드는 암호화본만)
  await fsp.writeFile(path.join(outDir, 'server-manifest.json'), JSON.stringify(serverManifest, null, 2))
  const binFile = path.join(releaseDir, 'server-manifest.bin')
  await fsp.writeFile(binFile, secret.encrypt(Buffer.from(JSON.stringify(serverManifest)), serverKey))
  return { binFile, fileCount: files.length, secretCount: secretFiles.length }
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

  const previous = await readJsonIfExists(path.join(outDir, 'manifest.json'))
  if (previous && previous.version === version && !force) {
    throw new Error(`이미 ${version} 버전이 빌드되어 있습니다. 버전을 올리거나 --force 를 쓰세요.`)
  }

  const walked = (await walk(sourceDir)).filter(p => matchesAny(p, config.include) && !matchesAny(p, config.exclude))
  const serverDataFiles = walked.filter(p => matchesAny(p, config.serverData))
  const included = walked.filter(p => !matchesAny(p, config.serverData))
  const serverOnlyFiles = included.filter(p => matchesAny(p, config.serverOnly))
  const candidates = included.filter(p => !matchesAny(p, config.serverOnly)).sort()
  const cdnMap = flags['no-cdn'] || config.useCurseForgeCdn === false ? new Map() : await readCurseForgeFiles(sourceDir)

  const files = []
  for (const rel of candidates) {
    if (!isSafeRelPath(rel)) throw new Error(`지원하지 않는 파일 경로: ${rel}`)
    const abs = path.join(sourceDir, ...rel.split('/'))
    const entry = { path: rel, sha1: await sha1File(abs), size: (await fsp.stat(abs)).size }
    if (matchesAny(rel, config.once)) entry.mode = 'once'
    else if (matchesAny(rel, config.update)) entry.mode = 'update'
    const url = cdnUrlFor(cdnMap, rel)
    if (url) entry.url = url
    files.push(entry)
  }

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

  await fsp.mkdir(outDir, { recursive: true })
  const selfHosted = files.filter(f => !f.url)
  const bundles = []
  const newAssets = []
  let releaseDir
  let assets
  let newObjects = 0
  const MB = 1024 * 1024
  const bundleLimit = config.bundleSizeMB ? config.bundleSizeMB * MB : BUNDLE_LIMIT
  if (mode === 'github') {
    assets = await buildGithubAssets({
      repo, version, sourceDir, outDir, previous, selfHosted, bundles, newAssets, bundleLimit,
      previousServer: await readJsonIfExists(path.join(outDir, 'server-manifest.json')),
      largeFile: config.largeFileMB ? config.largeFileMB * MB : LARGE_FILE
    })
    releaseDir = assets.releaseDir
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

  const history = (previous && Array.isArray(previous.changelog) ? previous.changelog : [])
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
      addAsset: assets.addAsset, bundleLimit, userConfig, base
    })
    newAssets.push(serverPackage.binFile)
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
    cdnCount: files.length - selfHosted.length,
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
  const r = await build({ ...args, notes })
  const { manifest } = r
  console.log(`✔ ${manifest.packName} v${manifest.version} (MC ${manifest.minecraft}, ${manifest.loader.type} ${manifest.loader.version || ''})`)
  console.log(`  파일 ${manifest.files.length}개 (총 ${mb(r.totalBytes)})`)
  console.log(`  - 서버 전용이라 배포에서 뺀 파일: ${r.serverOnlyCount}개 (${[...new Set(DEFAULT_CONFIG.serverOnly)].join(', ')} 등)`)
  if (r.serverDataFiles.length) console.log(`  - 서버 데이터(serverData)라 어디에도 배포 안 함: ${r.serverDataFiles.length}개`)
  console.log(`  - 커스포지 CDN 에서 받음: ${r.cdnCount}개`)
  console.log(`  - 직접 올릴 파일: ${manifest.files.length - r.cdnCount}개 (${mb(r.selfHostedBytes)})`)
  console.log('  폴더별 크기:')
  for (const [dir, size] of r.sizeByDir.slice(0, 8)) console.log(`    ${mb(size).padStart(10)}  ${dir}`)
  console.log('  가장 큰 파일:')
  const source = f => !f.url ? '' : r.repo && f.url.startsWith(github.releaseDownloadPrefix(r.repo)) ? '  (GitHub)' : '  (CDN)'
  for (const f of r.largest) console.log(`    ${mb(f.size).padStart(10)}  ${f.path}${source(f)}`)
  if (r.cdnFailed.length) {
    console.log(`  ! CDN 주소 확인 실패로 직접 올리는 파일 ${r.cdnFailed.length}개: ${r.cdnFailed.slice(0, 5).join(', ')}${r.cdnFailed.length > 5 ? ' ...' : ''}`)
  }

  if (r.mode === 'objects') {
    console.log(`  → ${path.resolve(args.out)} 폴더를 웹 호스팅에 업로드하세요 (새 파일 ${r.newObjects}개, manifest.json 은 마지막에).`)
    return
  }
  const uploadBytes = (await Promise.all(r.newAssets.map(f => fsp.stat(f).then(s => s.size)))).reduce((a, b) => a + b, 0)
  console.log(`  GitHub 릴리스에 새로 올릴 파일: ${r.newAssets.length}개 (${mb(uploadBytes)}), 이전 릴리스 재사용: ${r.reused}개`)
  if (!args.publish) {
    console.log(`  → GitHub 에서 ${r.repo} 저장소에 태그 ${github.releaseTag(manifest.version)} 로 새 릴리스를 만들고`)
    console.log(`    ${r.releaseDir} 폴더 안의 파일을 전부 첨부하세요. (--publish 를 주면 자동)`)
  } else {
    await github.publishRelease({
      repo: r.repo,
      token: process.env.GITHUB_TOKEN,
      version: manifest.version,
      notes,
      files: r.newAssets
    })
    console.log(`  ✔ GitHub 릴리스 ${github.releaseTag(manifest.version)} 게시 완료. 이제 런처에 업데이트가 뜹니다.`)
  }
  console.log('  ⚠ 이전 릴리스는 지우지 마세요. 바뀌지 않은 파일은 예전 릴리스에서 받습니다.')
  console.log(`  런처 설정(manifestUrl): ${github.manifestUrl(r.repo)}`)
}

if (require.main === module) {
  main().catch(e => {
    console.error(`✘ ${e.message}`)
    process.exit(1)
  })
}

module.exports = { build, detectFromCurseForge, nextVersion, parseArgs, readJsonIfExists, sha1File, walk, DEFAULT_CONFIG }
