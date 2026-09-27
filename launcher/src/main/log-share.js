'use strict'

// 게임이 튕겼을 때 로그를 mclo.gs(마인크래프트 로그 공유 사이트)에 올리고 링크를 돌려준다.
// 친구는 그 링크만 관리자에게 보내면 된다. 비밀 키가 필요 없다.
// 올리기 전에 윈도우 사용자 이름(경로 속)과 로그인 토큰처럼 보이는 값은 가린다.

const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const os = require('node:os')

const API = 'https://api.mclo.gs/1/log'
const MAX_LINES = 20000 // mclo.gs 한도(25,000줄)보다 조금 적게

async function readText (file) {
  try { return await fsp.readFile(file, 'utf8') } catch { return null }
}

// 가장 최근 크래시 리포트 (since 이후에 생긴 것만)
async function latestCrashReport (instanceDir, since = 0) {
  const dir = path.join(instanceDir, 'crash-reports')
  let best = null
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    if (!name.endsWith('.txt')) continue
    const st = await fsp.stat(path.join(dir, name)).catch(() => null)
    if (st && st.mtimeMs >= since && (!best || st.mtimeMs > best.mtimeMs)) best = { name, mtimeMs: st.mtimeMs }
  }
  return best ? { name: best.name, text: await readText(path.join(dir, best.name)) } : null
}

function sanitize (text, { home = os.homedir(), user = os.userInfo().username } = {}) {
  let out = text
  if (home) out = out.split(home).join('%USERPROFILE%').split(home.replace(/\\/g, '/')).join('%USERPROFILE%')
  if (user && user.length > 2) out = out.replace(new RegExp(`([\\\\/])${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\\\/])`, 'gi'), '$1<user>$2')
  out = out.replace(/(--accessToken[ =])\S+/g, '$1<hidden>')
  out = out.replace(/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/g, '<token>') // JWT 모양
  return out
}

function tail (text, lines) {
  const all = text.split(/\r?\n/)
  return all.length <= lines ? text : `... (앞부분 ${all.length - lines}줄 생략)\n` + all.slice(-lines).join('\n')
}

/**
 * 공유할 로그 한 덩어리를 만든다: 요약 → 크래시 리포트 → 게임 로그(뒷부분)
 */
async function buildReport ({ instanceDir, launcherLog, info, since }) {
  const crash = await latestCrashReport(instanceDir, since)
  const gameLog = await readText(path.join(instanceDir, 'logs', 'latest.log')) || await readText(launcherLog) || ''
  const head = [
    `# ${info.appName} 로그`,
    `런처 v${info.launcherVersion} · 모드팩 v${info.packVersion || '?'} · ${os.type()} ${os.release()} · 메모리 설정 ${info.memoryMB || '?'}MB`,
    `시각 ${new Date().toISOString()}`,
    ''
  ].join('\n')
  const parts = [head]
  let budget = MAX_LINES - 10
  if (crash && crash.text) {
    parts.push(`===== 크래시 리포트: ${crash.name} =====`, crash.text.split(/\r?\n/).slice(0, 4000).join('\n'), '')
    budget -= Math.min(4000, crash.text.split(/\r?\n/).length) + 2
  }
  parts.push('===== 게임 로그 (latest.log) =====', tail(gameLog, Math.max(1000, budget)))
  return { text: sanitize(parts.join('\n')), crashReport: crash ? crash.name : null }
}

async function uploadReport (text, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ content: text }).toString(),
    signal: AbortSignal.timeout(30000)
  })
  const json = await res.json().catch(() => null)
  if (!res.ok || !json || !json.success) throw new Error(`로그를 올리지 못했습니다${json && json.error ? `: ${json.error}` : ` (HTTP ${res.status})`}`)
  return json.url
}

module.exports = { buildReport, uploadReport, sanitize, latestCrashReport, MAX_LINES }
