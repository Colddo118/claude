'use strict'

// 바닐라 설치 → 자바 준비 → 모드로더 설치 → 라이브러리/에셋 확인 → 게임 실행.
// 설치와 실행 인자 구성은 @xmcl/installer, @xmcl/core 가 한다. 공식 런처와 같은 방식으로
// 버전 JSON 의 jvm 인자(모듈 경로, ${library_directory} 등)를 해석하므로 NeoForge 도 그대로 실행된다.

const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { compareVersions } = require('../common/manifest')

function xmcl () {
  return { core: require('@xmcl/core'), installer: require('@xmcl/installer') }
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

// xmcl 작업(Task)을 실행하면서 전체 진행률을 onProgress 로 흘려보낸다.
function runTask (task, onProgress) {
  return task.startAndWait({
    onUpdate () {
      if (onProgress && task.total > 0) onProgress({ current: task.progress, total: task.total })
    }
  })
}

// 파일 수천 개를 받다 보면 몇 개는 일시적으로 실패한다. 받은 건 남아 있으니 몇 번 다시 시도하면 대개 끝난다.
async function withRetry (fn, times = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i >= times) throw friendlyError(e)
    }
  }
}

// xmcl 은 여러 파일 실패를 AggregateError(메시지 없음)로 던진다 → 사람이 읽을 수 있게
function friendlyError (e) {
  if (!e || !Array.isArray(e.errors)) return e
  let first = e
  while (first && Array.isArray(first.errors) && first.errors.length) first = first.errors[0]
  const detail = first && (first.message || first.code || String(first))
  return new Error(`게임 파일 ${e.errors.length}개를 받지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.${detail ? ` (${detail})` : ''}`)
}

// ---------------------------------------------------------------- Java

// consoleExe: 서버처럼 콘솔 창에서 돌릴 때는 javaw.exe 대신 java.exe
function findJavaExecutable (dir, consoleExe = false) {
  const exe = process.platform === 'win32' ? (consoleExe ? 'java.exe' : 'javaw.exe') : 'java'
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

// 윈도우 10+ 에 기본 포함된 bsdtar(System32\tar.exe)는 zip 도 풀 수 있다.
// PATH 에 Git 의 GNU tar 가 먼저 잡히면 zip 을 못 푸므로 경로를 직접 지정한다.
async function extractArchive (archive, destDir) {
  await fsp.mkdir(destDir, { recursive: true })
  const tar = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
  await run(tar, ['-xf', archive, '-C', destDir])
}

// Eclipse Temurin(Adoptium) JRE 를 런처 폴더 안에 받아 둔다. 사용자 PC 에 자바가 없어도 된다.
async function ensureJava (major, runtimeDir, onStatus, { consoleExe = false } = {}) {
  const target = path.join(runtimeDir, `java-${major}`)
  if (exists(target)) {
    const found = findJavaExecutable(target, consoleExe)
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

  const found = findJavaExecutable(target, consoleExe)
  if (!found) throw new Error('자바 설치 후 실행 파일을 찾지 못했습니다')
  if (process.platform !== 'win32') await fsp.chmod(found, 0o755)
  return found
}

// 모장 버전 JSON 의 javaVersion.majorVersion 을 따른다 (1.21.1 → 21). 매니페스트의 java 가 있으면 우선.
function requiredJavaMajor (manifest, vanillaJson) {
  if (manifest.java) return Number(manifest.java)
  const major = (vanillaJson.javaVersion && vanillaJson.javaVersion.majorVersion) || 8
  return major === 16 ? 17 : major // Temurin 16 JRE 배포가 없음, 1.17 은 17 로 잘 돈다
}

// ---------------------------------------------------------------- Minecraft + loader

async function ensureVanilla (mc, minecraftVersion, onStatus, onProgress) {
  const jsonPath = mc.getVersionJson(minecraftVersion)
  if (!exists(jsonPath) || !exists(mc.getVersionJar(minecraftVersion))) {
    const { installer } = xmcl()
    onStatus && onStatus(`마인크래프트 ${minecraftVersion} 설치 중...`)
    let list
    try {
      list = await installer.getVersionList()
    } catch (e) {
      throw new Error(`모장 서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요. (${e.message})`)
    }
    const meta = list.versions.find(v => v.id === minecraftVersion)
    if (!meta) throw new Error(`마인크래프트 ${minecraftVersion} 버전을 찾을 수 없습니다`)
    await withRetry(() => runTask(installer.installTask(meta, mc), onProgress))
  }
  return JSON.parse(await fsp.readFile(jsonPath, 'utf8'))
}

function loaderKey ({ minecraft, loader }) {
  return `${loader.type}-${minecraft}-${loader.version || ''}`
}

async function readLoaderIndex (mc) {
  try {
    return JSON.parse(await fsp.readFile(mc.getPath('launcher-loaders.json'), 'utf8'))
  } catch {
    return {}
  }
}

async function writeLoaderIndex (mc, index) {
  await fsp.writeFile(mc.getPath('launcher-loaders.json'), JSON.stringify(index, null, 2))
}

// 모드로더를 설치하고 실행할 버전 id 를 돌려준다. 한 번 설치하면 기록해 두고 건너뛴다.
async function ensureLoader (manifest, mc, javaPath, { onStatus, onProgress, force = false } = {}) {
  const { type, version } = manifest.loader
  const mcVersion = manifest.minecraft
  if (type === 'vanilla') return mcVersion

  const key = loaderKey(manifest)
  const index = await readLoaderIndex(mc)
  if (!force && index[key] && exists(mc.getVersionJson(index[key]))) return index[key]

  const { installer } = xmcl()
  onStatus && onStatus(`${type} ${version} 설치 중... (처음 한 번은 몇 분 걸릴 수 있어요)`)
  let versionId
  if (type === 'neoforge') {
    // 1.20.1 NeoForge 는 net.neoforged:forge 로 배포되었다.
    const project = mcVersion === '1.20.1' ? 'forge' : 'neoforge'
    const artifact = project === 'forge' ? `${mcVersion}-${version}` : version
    versionId = await runTask(installer.installNeoForgedTask(project, artifact, mc, { java: javaPath }), onProgress)
  } else if (type === 'forge') {
    versionId = await runTask(installer.installForgeTask({ mcversion: mcVersion, version }, mc, { java: javaPath }), onProgress)
  } else if (type === 'fabric') {
    versionId = await installer.installFabric({ minecraftVersion: mcVersion, version, minecraft: mc })
  } else if (type === 'quilt') {
    versionId = await installer.installQuiltVersion({ minecraftVersion: mcVersion, version, minecraft: mc })
  } else {
    throw new Error(`지원하지 않는 로더: ${type}`)
  }

  index[key] = versionId
  await writeLoaderIndex(mc, index)
  return versionId
}

// ---------------------------------------------------------------- Launch

function serverArgs (manifest) {
  const s = manifest.server
  if (!s || !s.address) return {}
  // 포트를 적지 않았으면 주소만 넘긴다. 포트를 붙이면 마인크래프트가 SRV 레코드(도메인에 연결된 포트)를 확인하지 않는다.
  const port = Number(s.port) || undefined
  // 1.20 부터는 --server 대신 Quick Play 를 써야 바로 접속된다.
  if (compareVersions(manifest.minecraft, '1.20') >= 0) {
    return { quickPlayMultiplayer: port ? `${s.address}:${port}` : s.address }
  }
  return { server: port ? { ip: s.address, port } : { ip: s.address } }
}

function jvmArgs (settings) {
  const user = (settings.jvmArgs || '').split(/\s+/).filter(Boolean)
  if (!user.length) return undefined // xmcl 기본 G1GC 튜닝 인자 사용
  const { core } = xmcl()
  return [...core.DEFAULT_EXTRA_JVM_ARGS.filter(a => !a.startsWith('-Xmx')), ...user]
}

/**
 * 게임을 실행하고 child process 를 돌려준다.
 * authorization: { accessToken, profile: { id, name }, xuid }
 */
async function launchGame ({ manifest, dirs, authorization, settings, launcher, onStatus, onProgress }) {
  const { core, installer } = xmcl()
  const mc = core.MinecraftFolder.from(dirs.minecraft)
  const progress = label => p => onProgress && onProgress({ ...p, text: label })

  const vanillaJson = await ensureVanilla(mc, manifest.minecraft, onStatus, progress('마인크래프트 설치 중'))
  const javaPath = settings.javaPath || await ensureJava(requiredJavaMajor(manifest, vanillaJson), dirs.runtime, onStatus)

  let versionId = await ensureLoader(manifest, mc, javaPath, { onStatus, onProgress: progress(`${manifest.loader.type} 설치 중`) })

  // 라이브러리/에셋이 빠졌거나 깨졌으면 받는다. 로더 파일이 망가져 있으면 로더를 한 번 다시 설치한다.
  onStatus && onStatus('게임 파일 확인 중...')
  const checkDeps = () => withRetry(async () => runTask(installer.installDependenciesTask(await core.Version.parse(mc, versionId)), progress('게임 파일 받는 중')))
  try {
    await checkDeps()
  } catch (e) {
    if (manifest.loader.type === 'vanilla') throw e
    versionId = await ensureLoader(manifest, mc, javaPath, { onStatus, onProgress: progress('로더 재설치 중'), force: true })
    await checkDeps()
  }

  onStatus && onStatus('게임 시작 중...')
  return core.launch(buildLaunchOptions({ manifest, dirs, authorization, settings, launcher, javaPath, versionId }))
}

function buildLaunchOptions ({ manifest, dirs, authorization, settings, launcher, javaPath, versionId }) {
  const maxMB = settings.memoryMB
  return {
    gamePath: dirs.instance,
    resourcePath: dirs.minecraft,
    javaPath,
    version: versionId,
    gameProfile: { id: authorization.profile.id, name: authorization.profile.name },
    accessToken: authorization.accessToken,
    userType: 'msa',
    properties: {},
    launcherName: launcher.name,
    launcherBrand: launcher.version,
    maxMemory: maxMB,
    minMemory: Math.min(1024, maxMB),
    extraJVMArgs: jvmArgs(settings),
    // 1.19+ 게임 인자의 --xuid / --clientId 값. 객체형 feature 값은 인자 치환에 쓰인다.
    features: { launcher_ids: { auth_xuid: authorization.xuid || '0', clientid: crypto.randomUUID() } },
    ...(settings.autoConnect !== false ? serverArgs(manifest) : {}),
    extraExecOption: { detached: false }
  }
}

function totalMemoryMB () {
  return Math.floor(os.totalmem() / 1024 / 1024)
}

module.exports = { friendlyError, withRetry, launchGame, buildLaunchOptions, ensureJava, ensureLoader, requiredJavaMajor, totalMemoryMB, serverArgs, jvmArgs }
