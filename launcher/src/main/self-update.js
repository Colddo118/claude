'use strict'

// 런처 자동 업데이트.
// launcher.bat 이 GitHub 의 launcher 릴리스에 launcher.json({ version }) 과 작은 설치 파일(KubejsRPG-Setup.exe)을 올린다.
// 런처는 켜질 때 launcher.json 을 보고 자기보다 새 버전이면 설치 파일을 받아 조용히 실행하고 꺼진다.
// 설치 파일이 새 런처 본체를 받아 덮어쓰고(/S --updated), 끝나면 새 런처를 다시 켠다(--force-run).

const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const { spawn } = require('node:child_process')
const { compareVersions } = require('../common/manifest')

// 같은 버전으로 계속 실패해서 켤 때마다 설치만 반복하는 일이 없게, 한 번 시도한 버전은 한동안 다시 안 함
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000

async function readJson (file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')) } catch { return null }
}

/**
 * @returns {Promise<{available: boolean, version?: string, setupUrl?: string, reason?: string}>}
 */
async function checkForUpdate ({ infoUrl, currentVersion, stateFile, now = Date.now(), fetchImpl = fetch }) {
  if (!infoUrl) return { available: false, reason: 'no-url' }
  const url = new URL(infoUrl)
  url.searchParams.set('_', String(now)) // GitHub 캐시 피하기
  const res = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) })
  if (!res.ok) return { available: false, reason: `HTTP ${res.status}` }
  const info = await res.json()
  if (!info || !info.version || compareVersions(info.version, currentVersion) <= 0) return { available: false, version: info && info.version }
  const setupUrl = new URL(info.setup || 'KubejsRPG-Setup.exe', infoUrl).toString()
  const state = stateFile ? await readJson(stateFile) : null
  if (state && state.version === info.version && now - state.at < RETRY_AFTER_MS) {
    return { available: false, version: info.version, reason: 'recently-tried' }
  }
  return { available: true, version: info.version, setupUrl }
}

// 설치 파일을 받아 조용히 실행한다. 호출한 쪽은 곧바로 앱을 종료해야 한다.
async function startUpdate ({ setupUrl, version, tmpDir, stateFile, now = Date.now(), fetchImpl = fetch, spawnImpl = spawn }) {
  await fsp.mkdir(tmpDir, { recursive: true })
  const file = path.join(tmpDir, `KubejsRPG-Setup-${version}.exe`)
  const res = await fetchImpl(setupUrl, { signal: AbortSignal.timeout(60000) })
  if (!res.ok) throw new Error(`런처 설치 파일을 받지 못했습니다 (HTTP ${res.status})`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 1024 || buf[0] !== 0x4d || buf[1] !== 0x5a) throw new Error('받은 런처 설치 파일이 올바르지 않습니다') // "MZ" = exe
  await fsp.writeFile(file, buf)
  if (stateFile) await fsp.writeFile(stateFile, JSON.stringify({ version, at: now }))
  const child = spawnImpl(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' })
  child.unref()
  return file
}

// launcher.config.json 에 launcherUpdateUrl 이 없으면 매니페스트 주소(GitHub 릴리스)에서 추측
function infoUrlFrom (config) {
  if (config.launcherUpdateUrl) return config.launcherUpdateUrl
  const m = String(config.manifestUrl || '').match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/releases\//)
  return m ? `${m[1]}/releases/download/launcher/launcher.json` : null
}

module.exports = { checkForUpdate, startUpdate, infoUrlFrom, RETRY_AFTER_MS }
