#!/usr/bin/env node
'use strict'

// 관리자용: 커스포지 인스턴스 폴더(또는 아무 모드팩 폴더)를 읽어서
// 런처가 받아갈 manifest.json + objects/ 를 만든다.
//
//   node tools/build-manifest.js --source "C:/Users/me/curseforge/minecraft/Instances/MyPack" \
//        --out ./pack-dist --version 1.3.0 --notes-file ./notes.md
//
// 결과 폴더(--out)를 통째로 웹 호스팅(Cloudflare R2, 자체 웹서버 등)에 올리면 된다.
// objects/ 는 내용 해시로 이름이 붙으므로 바뀐 파일만 새로 올라간다.

const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const crypto = require('node:crypto')
const { pipeline } = require('node:stream/promises')
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
  exclude: ['**/*.disabled', '**/.DS_Store', '**/Thumbs.db', 'config/**/*.bak'],
  // 처음 설치할 때만 넣고 이후엔 사용자가 바꾼 값을 유지할 파일들
  once: ['options.txt', 'servers.dat'],
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
    if (key === 'force' || key === 'help') {
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
       [--notes "패치노트" | --notes-file <파일>] [--config <pack.config.json>] [--force]

  --source      커스포지 인스턴스 폴더 (mods, config 등이 있는 곳)
  --out         결과물 폴더. 기존 manifest.json 이 있으면 패치노트 이력을 이어 붙인다
  --version     새 모드팩 버전 (예: 1.3.0)
  --config      설정 파일. 생략하면 <source>/pack.config.json 을 찾는다
  --force       같은 버전으로 다시 빌드 허용`

// 커스포지 인스턴스의 minecraftinstance.json 에서 MC/로더 버전을 읽는다.
async function detectFromCurseForge (sourceDir) {
  let info
  try {
    info = JSON.parse(await fsp.readFile(path.join(sourceDir, 'minecraftinstance.json'), 'utf8'))
  } catch {
    return {}
  }
  const minecraft = info.gameVersion || (info.baseModLoader && info.baseModLoader.minecraftVersion)
  const name = info.baseModLoader && info.baseModLoader.name // 예: forge-47.2.0, neoforge-21.1.77, fabric-0.15.11-1.20.1
  if (!minecraft) return {}
  if (!name) return { minecraft, loader: { type: 'vanilla' } }
  const dash = name.indexOf('-')
  const type = name.slice(0, dash).toLowerCase()
  let version = name.slice(dash + 1)
  if ((type === 'fabric' || type === 'quilt') && version.endsWith(`-${minecraft}`)) {
    version = version.slice(0, -(minecraft.length + 1))
  }
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

async function build ({ source, out, version, notes, config: configPath, force }) {
  const sourceDir = path.resolve(source)
  const outDir = path.resolve(out)
  const userConfig = await readJsonIfExists(configPath ? path.resolve(configPath) : path.join(sourceDir, 'pack.config.json')) || {}
  const config = { ...DEFAULT_CONFIG, ...userConfig }

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

  const files = []
  let newObjects = 0
  for (const rel of candidates) {
    if (!isSafeRelPath(rel)) throw new Error(`지원하지 않는 파일 경로: ${rel}`)
    const abs = path.join(sourceDir, ...rel.split('/'))
    const sha1 = await sha1File(abs)
    const { size } = await fsp.stat(abs)
    const entry = { path: rel, sha1, size }
    if (matchesAny(rel, config.once)) entry.mode = 'once'
    files.push(entry)

    const objFile = path.join(outDir, ...objectPath(sha1).split('/'))
    if (!fs.existsSync(objFile)) {
      await fsp.mkdir(path.dirname(objFile), { recursive: true })
      await fsp.copyFile(abs, objFile)
      newObjects++
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
    changelog,
    files
  }
  validateManifest(manifest)

  await fsp.mkdir(outDir, { recursive: true })
  await fsp.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return {
    manifest,
    newObjects,
    totalBytes: files.reduce((n, f) => n + f.size, 0)
  }
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.source || !args.out || !args.version) {
    console.log(USAGE)
    process.exit(args.help ? 0 : 1)
  }
  const notes = args['notes-file'] ? await fsp.readFile(args['notes-file'], 'utf8') : args.notes
  const { manifest, newObjects, totalBytes } = await build({ ...args, notes })
  console.log(`✔ ${manifest.packName} v${manifest.version} (MC ${manifest.minecraft}, ${manifest.loader.type} ${manifest.loader.version || ''})`)
  console.log(`  파일 ${manifest.files.length}개, 총 ${(totalBytes / 1024 / 1024).toFixed(1)} MB, 새로 올릴 파일 ${newObjects}개`)
  console.log(`  → ${path.resolve(args.out)} 폴더를 웹 호스팅에 업로드하세요.`)
}

if (require.main === module) {
  main().catch(e => {
    console.error(`✘ ${e.message}`)
    process.exit(1)
  })
}

module.exports = { build, detectFromCurseForge, DEFAULT_CONFIG }
