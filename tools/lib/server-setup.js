'use strict'

// 빈 서버 폴더를 "켜지는 서버" 로 만드는 준비 작업: 자바, 모드로더(NeoForge/Forge) 서버 설치, EULA, 메모리.

const fs = require('node:fs')
const fsp = fs.promises
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { compareVersions } = require('../../launcher/src/common/manifest')
const { ensureJava } = require('../../launcher/src/main/game')

function requiredJava (manifest) {
  if (manifest.java) return Number(manifest.java)
  if (compareVersions(manifest.minecraft, '1.20.5') >= 0) return 21
  if (compareVersions(manifest.minecraft, '1.17') >= 0) return 17
  return 8
}

// PATH 의 java 버전 (없으면 0)
function systemJavaMajor () {
  const r = spawnSync('java', ['-version'], { encoding: 'utf8', windowsHide: true })
  const m = /version "(\d+)(?:\.(\d+))?/.exec(`${r.stderr || ''}${r.stdout || ''}`)
  if (!m) return 0
  return m[1] === '1' ? Number(m[2]) : Number(m[1])
}

// 쓸 자바를 정한다. 시스템 자바가 충분하면 그대로, 아니면 서버 폴더의 runtime 에 받아서 쓴다.
async function prepareJava (serverDir, major, log) {
  const sys = systemJavaMajor()
  if (sys >= major) return { javaPath: 'java', binDir: null }
  log(`자바 ${major} 이 없어서 서버 폴더에 받습니다${sys ? ` (지금 자바: ${sys})` : ''}...`)
  const javaPath = await ensureJava(major, path.join(serverDir, 'runtime'), log, { consoleExe: true })
  return { javaPath, binDir: path.dirname(javaPath) }
}

function loaderInstalled (serverDir, loader) {
  try {
    if (loader.type === 'neoforge') return fs.existsSync(path.join(serverDir, 'libraries', 'net', 'neoforged', 'neoforge', loader.version))
    if (loader.type === 'forge') {
      return fs.readdirSync(path.join(serverDir, 'libraries', 'net', 'minecraftforge', 'forge')).some(n => n.endsWith(`-${loader.version}`))
    }
    return true
  } catch {
    return false
  }
}

function installerInfo (manifest) {
  const { type, version } = manifest.loader
  if (type === 'neoforge') {
    return {
      url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`,
      flags: [['--install-server'], ['--installServer']]
    }
  }
  if (type === 'forge') {
    const id = `${manifest.minecraft}-${version}`
    return {
      url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${id}/forge-${id}-installer.jar`,
      flags: [['--installServer'], ['--install-server']]
    }
  }
  return null
}

function runInherit (cmd, args, cwd) {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { cwd, stdio: 'inherit' })
    p.on('error', () => resolve(-1))
    p.on('close', code => resolve(code))
  })
}

// 모드로더 서버 설치 (공식 설치 파일을 받아 서버 모드로 실행). run 은 테스트에서 바꿔 끼울 수 있게.
async function installLoader ({ serverDir, manifest, javaPath, log, run = runInherit, download = downloadTo }) {
  const info = installerInfo(manifest)
  if (!info) throw new Error(`${manifest.loader.type} 서버는 자동 설치를 지원하지 않습니다. 직접 설치해 주세요.`)
  const jar = path.join(serverDir, '.installer', path.basename(new URL(info.url).pathname))
  log(`${manifest.loader.type} ${manifest.loader.version} 서버 설치 파일 받는 중...`)
  await download(info.url, jar)
  for (const flags of info.flags) {
    log(`${manifest.loader.type} 서버 설치 중 (처음엔 몇 분 걸려요)...`)
    const code = await run(javaPath, ['-jar', jar, ...flags, serverDir], serverDir)
    if (code === 0 && loaderInstalled(serverDir, manifest.loader)) {
      await fsp.rm(path.dirname(jar), { recursive: true, force: true })
      return
    }
  }
  throw new Error(`${manifest.loader.type} 서버 설치에 실패했습니다. 위 출력을 확인하세요.`)
}

async function downloadTo (url, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`${url} → HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest + '.part'))
  await fsp.rename(dest + '.part', dest)
}

function eulaAccepted (serverDir) {
  try {
    return /^\s*eula\s*=\s*true\s*$/m.test(fs.readFileSync(path.join(serverDir, 'eula.txt'), 'utf8'))
  } catch {
    return false
  }
}

async function acceptEula (serverDir) {
  await fsp.writeFile(path.join(serverDir, 'eula.txt'),
    `# Minecraft EULA (https://aka.ms/MinecraftEULA) - accepted via server-update.js\neula=true\n`)
}

// user_jvm_args.txt 에 -Xmx 가 없으면 PC 메모리의 절반(4~12GB)으로 넣는다. 넣은 값을 돌려준다 (이미 있으면 null).
async function ensureMemory (serverDir, totalMB = os.totalmem() / 1024 / 1024) {
  const file = path.join(serverDir, 'user_jvm_args.txt')
  let text = ''
  try { text = await fsp.readFile(file, 'utf8') } catch {}
  if (/^\s*-Xmx/m.test(text)) return null
  const gb = Math.max(4, Math.min(12, Math.floor(totalMB / 1024 / 2)))
  await fsp.writeFile(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}-Xmx${gb}G\n`)
  return `${gb}G`
}

module.exports = { requiredJava, systemJavaMajor, prepareJava, loaderInstalled, installerInfo, installLoader, eulaAccepted, acceptEula, ensureMemory }
