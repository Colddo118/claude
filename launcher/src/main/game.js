'use strict'

// 자바 준비 → 모드로더 준비 → 게임 실행.
// 실제 바닐라/라이브러리/에셋 다운로드와 실행 인자 구성은 minecraft-launcher-core(MCLC)가 한다.

const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { compareVersions } = require('../common/manifest')

const MOJANG_VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'

async function fetchJson (url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return res.json()
}

async function downloadTo (url, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`${url} → HTTP ${res.status}`)
  const tmp = dest + '.part'
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp))
  await fsp.rename(tmp, dest)
}

function exists (p) {
  return fs.existsSync(p)
}

// ---------------------------------------------------------------- Java

// 모장 버전 JSON 의 javaVersion.majorVersion 을 그대로 따른다 (없으면 옛 버전 → 8).
async function requiredJavaMajor (manifest, cacheDir) {
  if (manifest.java) return Number(manifest.java)
  const cacheFile = path.join(cacheDir, `java-major-${manifest.minecraft}.txt`)
  try {
    return Number(await fsp.readFile(cacheFile, 'utf8'))
  } catch {}
  const list = await fetchJson(MOJANG_VERSION_MANIFEST)
  const entry = list.versions.find(v => v.id === manifest.minecraft)
  if (!entry) throw new Error(`마인크래프트 ${manifest.minecraft} 버전을 찾을 수 없습니다`)
  const version = await fetchJson(entry.url)
  let major = (version.javaVersion && version.javaVersion.majorVersion) || 8
  if (major === 16) major = 17 // 1.17 은 17 로 잘 돈다 (Temurin 16 JRE 배포 없음)
  await fsp.mkdir(cacheDir, { recursive: true })
  await fsp.writeFile(cacheFile, String(major))
  return major
}

function findJavaExecutable (dir) {
  const exe = process.platform === 'win32' ? 'javaw.exe' : 'java'
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    const candidate = path.join(cur, 'bin', exe)
    if (exists(candidate)) return candidate
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      if (ent.isDirectory()) stack.push(path.join(cur, ent.name))
    }
  }
  return null
}

function run (cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' })
    p.on('error', reject)
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} 종료 코드 ${code}`)))
  })
}

async function extractArchive (archive, destDir) {
  await fsp.mkdir(destDir, { recursive: true })
  if (archive.endsWith('.zip')) {
    const extract = require('extract-zip')
    await extract(archive, { dir: path.resolve(destDir) })
  } else {
    await run('tar', ['-xzf', archive, '-C', destDir])
  }
}

// Eclipse Temurin(Adoptium) JRE 를 런처 폴더 안에 받아 둔다. 사용자 PC 에 자바가 없어도 된다.
async function ensureJava (major, runtimeDir, onStatus) {
  const target = path.join(runtimeDir, `java-${major}`)
  if (exists(target)) {
    const found = findJavaExecutable(target)
    if (found) return found
  }
  const osName = { win32: 'windows', darwin: 'mac', linux: 'linux' }[process.platform]
  const arch = { x64: 'x64', arm64: 'aarch64' }[process.arch]
  if (!osName || !arch) throw new Error(`지원하지 않는 플랫폼입니다: ${process.platform}/${process.arch}`)

  onStatus && onStatus(`Java ${major} 다운로드 중...`)
  const ext = osName === 'windows' ? 'zip' : 'tar.gz'
  const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/${osName}/${arch}/jre/hotspot/normal/eclipse?project=jdk`
  const archive = path.join(runtimeDir, `java-${major}.${ext}`)
  await downloadTo(url, archive)

  onStatus && onStatus(`Java ${major} 설치 중...`)
  const staging = path.join(runtimeDir, `java-${major}.staging`)
  await fsp.rm(staging, { recursive: true, force: true })
  await extractArchive(archive, staging)
  await fsp.rm(target, { recursive: true, force: true })
  await fsp.rename(staging, target)
  await fsp.rm(archive, { force: true })

  const found = findJavaExecutable(target)
  if (!found) throw new Error('자바 설치 후 실행 파일을 찾지 못했습니다')
  if (process.platform !== 'win32') await fsp.chmod(found, 0o755)
  return found
}

// ---------------------------------------------------------------- Mod loader

// MCLC 에 넘길 { forge } 또는 { custom } 옵션을 만든다.
async function ensureLoader (manifest, rootDir, onStatus) {
  const { type, version } = manifest.loader
  const mc = manifest.minecraft
  const loaderDir = path.join(rootDir, 'loaders')

  if (type === 'vanilla') return {}

  if (type === 'forge' || type === 'neoforge') {
    let url
    let file
    if (type === 'forge') {
      const legacy = compareVersions(mc, '1.13') < 0
      const classifier = legacy ? 'universal' : 'installer'
      const id = `${mc}-${version}`
      file = `forge-${id}-${classifier}.jar`
      url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${id}/${file}`
    } else {
      file = `neoforge-${version}-installer.jar`
      url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/${file}`
    }
    const dest = path.join(loaderDir, file)
    if (!exists(dest)) {
      onStatus && onStatus(`${type} ${version} 다운로드 중...`)
      await downloadTo(url, dest)
    }
    return { forge: dest }
  }

  if (type === 'fabric' || type === 'quilt') {
    const id = `${type}-loader-${version}-${mc}`
    const jsonPath = path.join(rootDir, 'versions', id, `${id}.json`)
    if (!exists(jsonPath)) {
      onStatus && onStatus(`${type} ${version} 설치 중...`)
      const base = type === 'fabric'
        ? 'https://meta.fabricmc.net/v2/versions/loader'
        : 'https://meta.quiltmc.org/v3/versions/loader'
      const profile = await fetchJson(`${base}/${mc}/${version}/profile/json`)
      profile.id = id
      await fsp.mkdir(path.dirname(jsonPath), { recursive: true })
      await fsp.writeFile(jsonPath, JSON.stringify(profile, null, 2))
    }
    return { custom: id }
  }

  throw new Error(`지원하지 않는 로더: ${type}`)
}

// ---------------------------------------------------------------- Launch

let mclcPatched = false
function loadMclc () {
  const mclc = require('minecraft-launcher-core')
  if (!mclcPatched) {
    // MCLC 는 `java -version` 출력을 파싱하는데, 창 없는 javaw.exe 는 출력이 비어 있을 수 있어
    // 그대로 두면 예외가 난다. 자바는 ensureJava 가 이미 확인했으므로 존재 여부만 본다.
    const Handler = require('minecraft-launcher-core/components/handler')
    Handler.prototype.checkJava = function (java) {
      return Promise.resolve(exists(java) ? { run: true } : { run: false, message: `Java 없음: ${java}` })
    }
    mclcPatched = true
  }
  return mclc
}

function serverArgs (manifest) {
  const s = manifest.server
  if (!s || !s.address) return {}
  const identifier = `${s.address}:${s.port || 25565}`
  // 1.20 부터는 --server 대신 Quick Play 를 써야 바로 접속된다 (MCLC 의 legacy 타입이 --server/--port).
  const type = compareVersions(manifest.minecraft, '1.20') >= 0 ? 'multiplayer' : 'legacy'
  return { quickPlay: { type, identifier } }
}

/**
 * 게임을 실행하고 child process 를 돌려준다.
 * events: onStatus(text), onProgress({current,total,type}), onLog(line)
 */
async function launchGame ({ manifest, dirs, authorization, settings, onStatus, onProgress, onLog }) {
  const major = await requiredJavaMajor(manifest, dirs.cache)
  const javaPath = settings.javaPath || await ensureJava(major, dirs.runtime, onStatus)
  const loaderOpts = await ensureLoader(manifest, dirs.minecraft, onStatus)

  const { Client } = loadMclc()
  const client = new Client()
  let lastDebug = ''
  client.on('debug', line => { lastDebug = line; onLog && onLog(line) })
  client.on('data', line => onLog && onLog(line))
  // MCLC progress 이벤트: { type: 'assets' | 'natives' | 'classes' ..., task: 현재, total: 전체 }
  client.on('progress', e => onProgress && onProgress({ type: e.type, current: e.task, total: e.total }))

  const maxMB = settings.memoryMB
  const autoConnect = settings.autoConnect !== false ? serverArgs(manifest) : {}
  const opts = {
    root: dirs.minecraft,
    authorization,
    version: {
      number: manifest.minecraft,
      type: 'release',
      ...(loaderOpts.custom ? { custom: loaderOpts.custom } : {})
    },
    ...(loaderOpts.forge ? { forge: loaderOpts.forge } : {}),
    memory: { max: `${maxMB}M`, min: `${Math.min(1024, maxMB)}M` },
    javaPath,
    customArgs: (settings.jvmArgs || '').split(/\s+/).filter(Boolean),
    ...autoConnect,
    overrides: {
      gameDirectory: dirs.instance,
      detached: false,
      maxSockets: 16
    }
  }

  onStatus && onStatus('마인크래프트 파일 확인 중...')
  const child = await client.launch(opts)
  if (!child) {
    throw new Error(`게임을 시작하지 못했습니다. ${lastDebug.replace('[MCLC]: ', '')}`)
  }
  return { child, client }
}

function totalMemoryMB () {
  return Math.floor(os.totalmem() / 1024 / 1024)
}

module.exports = { launchGame, ensureJava, ensureLoader, requiredJavaMajor, totalMemoryMB, serverArgs }
