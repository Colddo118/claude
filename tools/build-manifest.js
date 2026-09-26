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
const { writeZip } = require('./lib/zip')
const { readCurseForgeFiles, cdnUrlFor, checkUrl } = require('./lib/curseforge')
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
  // 처음 설치할 때만 넣고 이후엔 사용자가 바꾼 값을 유지할 파일들
  once: [
    'options.txt', 'servers.dat',
    // 셰이더/그래픽, JEI 정렬·즐겨찾기, 미니맵 표시 같은 개인 취향 설정 (관리자가 게임하며 바꾼 값이 친구들 설정을 덮지 않게)
    'config/iris.properties', 'config/oculus.properties',
    'config/sodium-options.json', 'config/embeddium-options.json',
    'config/jei', 'config/ftbchunks-client.snbt'
  ],
  // 모드가 실행 중에 스스로 고쳐 쓰는 설정 파일들: 관리자가 바꿨을 때만 덮어쓴다
  update: ['config'],
  // 이 폴더 안에서 매니페스트에 없는 파일은 백업 폴더로 치운다 (서버와 모드 불일치 방지)
  strictDirs: ['mods'],
  changelogLimit: 30
}

function parseArgs (argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`알 수 없는 인자: ${a}`)
    const key = a.slice(2)
    if (['force', 'help', 'publish', 'no-cdn', 'no-url-check'].includes(key)) {
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
  --version       새 모드팩 버전 (예: 1.3.0)
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

async function build ({ source, out, version, notes, config: configPath, force, github: githubArg, ...flags }) {
  const sourceDir = path.resolve(source)
  const outDir = path.resolve(out)
  const userConfig = await readJsonIfExists(configPath ? path.resolve(configPath) : path.join(sourceDir, 'pack.config.json')) || {}
  // exclude / once 는 기본값에 더한다 (기본 목록을 매번 다시 적지 않아도 되게)
  const merged = key => [...DEFAULT_CONFIG[key], ...(userConfig[key] || [])]
  const config = { ...DEFAULT_CONFIG, ...userConfig, exclude: merged('exclude'), once: merged('once') }
  const repo = githubArg || config.github
  // bundleUrl: GitHub 이외의 곳에 zip 을 올릴 때 쓰는 주소 틀 (예: https://example.com/pack-{version}.zip)
  const bundleUrl = repo ? github.bundleUrl(repo, version) : config.bundleUrl && config.bundleUrl.replace(/\{version\}/g, version)
  const mode = bundleUrl ? 'bundle' : 'objects'

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

  const candidates = (await walk(sourceDir))
    .filter(p => matchesAny(p, config.include) && !matchesAny(p, config.exclude))
    .sort()
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
  let bundle
  let bundleFile
  let newObjects = 0
  if (mode === 'bundle') {
    bundleFile = path.join(outDir, repo ? github.bundleName(version) : `pack-${version}.zip`)
    await writeZip(bundleFile, selfHosted.map(f => ({ name: f.path, file: path.join(sourceDir, ...f.path.split('/')) })))
    bundle = { url: bundleUrl, sha1: await sha1File(bundleFile), size: (await fsp.stat(bundleFile)).size }
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

  const manifest = {
    formatVersion: FORMAT_VERSION,
    packName: config.packName,
    version,
    minecraft,
    loader,
    ...(config.java ? { java: config.java } : {}),
    ...(config.server ? { server: config.server } : {}),
    ...(config.memory ? { memory: config.memory } : {}),
    strictDirs: config.strictDirs,
    ...(bundle ? { bundle } : {}),
    changelog,
    files
  }
  validateManifest(manifest)
  const manifestFile = path.join(outDir, 'manifest.json')
  await fsp.writeFile(manifestFile, JSON.stringify(manifest, null, 2))

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
    bundleFile,
    manifestFile,
    cdnCount: files.length - selfHosted.length,
    cdnFailed,
    selfHostedBytes: selfHosted.reduce((n, f) => n + f.size, 0),
    totalBytes: files.reduce((n, f) => n + f.size, 0)
  }
}

const mb = n => `${(n / 1024 / 1024).toFixed(1)} MB`

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.source || !args.out || !args.version) {
    console.log(USAGE)
    process.exit(args.help ? 0 : 1)
  }
  const notes = args['notes-file'] ? await fsp.readFile(args['notes-file'], 'utf8') : args.notes
  const r = await build({ ...args, notes })
  const { manifest } = r
  console.log(`✔ ${manifest.packName} v${manifest.version} (MC ${manifest.minecraft}, ${manifest.loader.type} ${manifest.loader.version || ''})`)
  console.log(`  파일 ${manifest.files.length}개 (총 ${mb(r.totalBytes)})`)
  console.log(`  - 커스포지 CDN 에서 받음: ${r.cdnCount}개`)
  console.log(`  - 직접 올릴 파일: ${manifest.files.length - r.cdnCount}개 (${mb(r.selfHostedBytes)})`)
  console.log('  폴더별 크기:')
  for (const [dir, size] of r.sizeByDir.slice(0, 8)) console.log(`    ${mb(size).padStart(10)}  ${dir}`)
  console.log('  가장 큰 파일:')
  for (const f of r.largest) console.log(`    ${mb(f.size).padStart(10)}  ${f.path}${f.url ? '  (CDN)' : ''}`)
  if (r.cdnFailed.length) {
    console.log(`  ! CDN 주소 확인 실패로 직접 올리는 파일 ${r.cdnFailed.length}개: ${r.cdnFailed.slice(0, 5).join(', ')}${r.cdnFailed.length > 5 ? ' ...' : ''}`)
  }

  if (r.mode === 'objects') {
    console.log(`  → ${path.resolve(args.out)} 폴더를 웹 호스팅에 업로드하세요 (새 파일 ${r.newObjects}개, manifest.json 은 마지막에).`)
    return
  }
  if (!r.repo) {
    console.log(`  → ${path.basename(r.bundleFile)} 를 ${manifest.bundle.url} 에, 그다음 manifest.json 을 올리세요.`)
    return
  }
  if (!args.publish) {
    console.log(`  → GitHub 에서 ${r.repo} 저장소에 태그 ${github.releaseTag(manifest.version)} 로 새 릴리스를 만들고`)
    console.log(`    ${path.basename(r.bundleFile)} 와 manifest.json 두 파일을 첨부하세요. (--publish 를 주면 자동)`)
  } else {
    await github.publishRelease({
      repo: r.repo,
      token: process.env.GITHUB_TOKEN,
      version: manifest.version,
      notes,
      files: [r.bundleFile, r.manifestFile]
    })
    console.log(`  ✔ GitHub 릴리스 ${github.releaseTag(manifest.version)} 게시 완료. 이제 런처에 업데이트가 뜹니다.`)
  }
  console.log(`  런처 설정(manifestUrl): ${github.manifestUrl(r.repo)}`)
}

if (require.main === module) {
  main().catch(e => {
    console.error(`✘ ${e.message}`)
    process.exit(1)
  })
}

module.exports = { build, detectFromCurseForge, DEFAULT_CONFIG }
