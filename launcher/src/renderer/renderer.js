'use strict'

const api = window.launcher
const $ = id => document.getElementById(id)

const ui = {
  status: $('status-text'),
  detail: $('status-detail'),
  pct: $('progress-pct'),
  server: $('server-text'),
  accountSub: $('account-sub'),
  bar: $('progress-bar'),
  version: $('version-text'),
  play: $('play-btn'),
  changelog: $('changelog'),
  badge: $('update-badge'),
  packMeta: $('pack-meta'),
  accountName: $('account-name'),
  loginBtn: $('login-btn'),
  logoutBtn: $('logout-btn')
}

let info = null
let pack = null
let account = null
let busy = false
let gameRunning = false

// ---------------------------------------------------------------- formatting

// 숫자와 단위 사이는 줄바꿈 안 되는 공백 (588.4 / MB 처럼 갈라지지 않게)
function formatBytes (n) {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}\u00a0KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}\u00a0MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}\u00a0GB`
}
const count = n => Number(n).toLocaleString('ko-KR')
// "238 / 588 MB" 처럼 단위를 한 번만 (보조 줄이 한 줄에 들어가게)
function formatPair (current, total) {
  const [div, unit] = total >= 1024 ** 3 ? [1024 ** 3, 'GB'] : total >= 1024 ** 2 ? [1024 ** 2, 'MB'] : [1024, 'KB']
  const f = n => { const v = n / div; return v >= 100 ? v.toFixed(0) : v.toFixed(1) }
  return `${f(current)} / ${f(total)}\u00a0${unit}`
}

const LOADER_NAMES = { neoforge: 'NeoForge', forge: 'Forge', fabric: 'Fabric', quilt: 'Quilt' }

// text = 굵은 한 줄, detail = 그 아래 흐린 보조 줄
function setStatus (text, { error = false, detail = '' } = {}) {
  ui.status.textContent = text
  ui.status.classList.toggle('error', error)
  ui.detail.textContent = error ? '' : detail
}

// showPct: 실제로 진행 중일 때만 칸 이름 옆에 % 표시
function setProgress (current, total, showPct = false) {
  const pct = total > 0 ? Math.min(100, (current / total) * 100) : 0
  ui.bar.style.width = `${pct}%`
  ui.pct.textContent = showPct ? `${Math.floor(pct)}%` : ''
}

// 패치노트는 간단한 마크다운(#, -, 빈 줄)만 지원하고, 항상 textContent 로 넣는다.
function renderNotes (text) {
  const frag = document.createDocumentFragment()
  let list = null
  for (const raw of (text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) { list = null; continue }
    const bullet = line.match(/^[-*]\s+(.*)$/)
    if (bullet) {
      if (!list) { list = document.createElement('ul'); frag.appendChild(list) }
      const li = document.createElement('li')
      li.textContent = bullet[1]
      list.appendChild(li)
      continue
    }
    list = null
    const heading = line.match(/^#{1,6}\s+(.*)$/)
    const el = document.createElement(heading ? 'h3' : 'p')
    el.textContent = heading ? heading[1] : line
    frag.appendChild(el)
  }
  return frag
}

function renderChangelog (entries) {
  ui.changelog.replaceChildren()
  if (!entries.length) {
    const p = document.createElement('p')
    p.className = 'muted'
    p.textContent = '아직 패치노트가 없습니다.'
    ui.changelog.appendChild(p)
    return
  }
  for (const c of entries) {
    const div = document.createElement('div')
    div.className = 'entry' + (c.isNew ? ' new' : '')
    const head = document.createElement('div')
    head.className = 'entry-head'
    const ver = document.createElement('span')
    ver.className = 'ver'
    ver.textContent = `v${c.version}`
    const date = document.createElement('span')
    date.className = 'muted small'
    date.textContent = c.date || ''
    head.append(ver, date)
    if (c.isNew) {
      const badge = document.createElement('span')
      badge.className = 'badge'
      badge.textContent = 'NEW'
      head.appendChild(badge)
    }
    div.append(head, renderNotes(c.notes || '(내용 없음)'))
    ui.changelog.appendChild(div)
  }
}

// ---------------------------------------------------------------- state → UI

function renderAccount () {
  renderPlay()
  ui.accountName.textContent = account ? account.name : '로그인 안 됨'
  ui.accountSub.textContent = account ? '마이크로소프트 계정' : '로그인이 필요해요'
  $('account').classList.toggle('signed-out', !account)
  ui.loginBtn.classList.toggle('hidden', !!account)
  ui.logoutBtn.classList.toggle('hidden', !account)
}

function renderPlay () {
  const b = ui.play
  b.classList.remove('update')
  if (gameRunning) {
    b.textContent = '실행 중'
    b.disabled = true
    return
  }
  b.disabled = busy || !pack
  if (!pack) {
    b.textContent = busy ? '확인 중...' : '다시 시도'
    b.disabled = busy
    return
  }
  if (!account) {
    b.textContent = '로그인하고 시작'
    if (pack.needsUpdate) b.classList.add('update')
  } else if (pack.needsUpdate) {
    b.textContent = pack.firstInstall ? '설치하고 시작' : '업데이트하고 시작'
    b.classList.add('update')
  } else {
    b.textContent = '게임 시작'
  }
}

function renderPack () {
  if (!pack) return
  const loader = pack.loader.type === 'vanilla' ? '' : ` · ${LOADER_NAMES[pack.loader.type] || pack.loader.type} ${pack.loader.version}`
  // 팩 이름이 런처 이름과 같으면 제목과 겹치므로 뺀다
  const name = pack.packName && pack.packName !== info.appName ? `${pack.packName} · ` : ''
  ui.packMeta.textContent = `${name}Minecraft ${pack.minecraft}${loader}`
  const updating = pack.needsUpdate && pack.versionChanged
  ui.version.textContent = !pack.installedVersion
    ? `미설치 → v${pack.remoteVersion}`
    : updating ? `v${pack.installedVersion} → v${pack.remoteVersion}` : `v${pack.installedVersion} (최신)`
  $('facts').classList.remove('hidden')
  $('server-row').classList.toggle('hidden', !pack.server)
  ui.server.textContent = pack.server || ''
  // "새 업데이트" 표시는 상태 줄과 패치노트의 NEW 로 충분해서 따로 띄우지 않는다
  renderChangelog(pack.changelog)
  refreshServer()

  const size = formatBytes(pack.downloadBytes)
  if (!pack.needsUpdate) {
    setStatus('준비 완료', { detail: `v${pack.installedVersion}` })
  } else if (pack.firstInstall) {
    setStatus('처음 설치', { detail: `v${pack.remoteVersion} · ${size}` })
  } else if (pack.versionChanged) {
    setStatus(`새 버전 v${pack.remoteVersion}`, { detail: size })
  } else {
    setStatus('파일 복구 필요', { detail: `${count(pack.downloadCount + pack.removalCount + pack.strayCount)}개` })
  }
  // 최신이면 막대를 꽉 채워 "준비 완료" 로 보이게
  setProgress(pack.needsUpdate ? 0 : 1, 1)
}

async function run (task) {
  busy = true
  renderPlay()
  try {
    return await task()
  } catch (e) {
    setStatus(cleanError(e), { error: true })
    setProgress(0, 1)
    return undefined
  } finally {
    busy = false
    renderPlay()
  }
}

// ipcRenderer.invoke 오류는 "Error invoking remote method 'x': Error: 메시지" 형태라 앞부분을 떼어낸다.
function cleanError (e) {
  return String(e && e.message ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

async function check () {
  setStatus('업데이트 확인 중...')
  await run(async () => {
    pack = null
    const result = await api.checkPack()
    pack = result
    if (result.settings) info.settings = result.settings
    renderPack()
  })
  if (!pack) {
    ui.packMeta.textContent = '서버에 연결하지 못했어요'
    if (!ui.changelog.querySelector('.entry')) {
      const p = document.createElement('p')
      p.className = 'muted'
      p.textContent = '패치노트를 불러오지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.'
      ui.changelog.replaceChildren(p)
    }
  }
}

// 서버 켜짐/꺼짐 · 접속 인원
let serverTimer = null
async function refreshServer () {
  if (!pack || !pack.server) return
  const el = $('server-state')
  const s = await api.serverStatus().catch(() => null)
  if (!s) return
  el.classList.toggle('on', s.online)
  el.classList.toggle('off', !s.online)
  el.textContent = s.online ? `켜짐 · ${count(s.players.online)}/${count(s.players.max)}명` : '꺼짐'
  el.title = s.online ? [s.motd, s.version, `${s.latencyMs}ms`].filter(Boolean).join(' · ') : `연결 안 됨 (${s.error || ''})`
  clearTimeout(serverTimer)
  serverTimer = setTimeout(refreshServer, 30 * 1000) // 30초마다 다시 확인
}

// 로그를 mclo.gs 에 올리고 링크를 클립보드에 복사 (튕겼을 때 관리자에게 보내기용)
async function shareLog () {
  const btn = $('share-log-btn')
  btn.disabled = true
  setStatus('로그 올리는 중...')
  try {
    const r = await api.shareLog()
    setStatus('로그 링크를 복사했어요', { detail: `관리자에게 붙여넣어 보내 주세요 · ${r.url}` })
    btn.classList.add('hidden')
  } catch (e) {
    setStatus(cleanError(e), { error: true })
  } finally {
    btn.disabled = false
  }
}

// 공지: 닫으면 같은 공지는 다시 안 뜸 (새 공지는 다시 뜸)
let notice = null
function dismissedNotice () {
  try { return localStorage.getItem('notice-dismissed') } catch { return null }
}
async function refreshNotice () {
  notice = await api.getNotice().catch(() => null)
  const box = $('notice')
  const show = notice && notice.id !== dismissedNotice()
  box.classList.toggle('hidden', !show)
  box.classList.toggle('warn', !!(show && notice.level === 'warn'))
  if (show) $('notice-text').textContent = notice.text
}

// ---------------------------------------------------------------- actions

async function login () {
  return run(async () => {
    setStatus('마이크로소프트 로그인 창에서 로그인해 주세요...')
    account = await api.login()
    renderAccount()
    setStatus(`${account.name} 님, 반가워요`)
    return account
  })
}

async function play () {
  if (!pack) return check()
  if (!account && !(await login())) return
  await run(async () => {
    await api.launch()
    gameRunning = true
    pack = { ...pack, needsUpdate: false, firstInstall: false, installedVersion: pack.remoteVersion, changelog: pack.changelog.map(c => ({ ...c, isNew: false })) }
    renderPack()
    setStatus('게임 실행 중')
    setProgress(1, 1)
  })
}

api.onProgress(p => {
  if (p.phase === 'download') {
    setStatus('모드팩 받는 중', { detail: formatPair(p.current, p.total) })
    setProgress(p.current, p.total, true)
  } else if (p.phase === 'verify') {
    setStatus('파일 확인 중')
    setProgress(p.current, p.total, true)
  } else if (p.text) {
    // 게임 설치 단계는 "마인크래프트 설치 중 45%" 처럼 온다 → 글자와 % 를 나눠서 표시
    const m = p.text.match(/^(.*?)\s*(\d+)%$/)
    setStatus(m ? m[1] : p.text)
    if (p.total) setProgress(p.current, p.total, true)
    else setProgress(0, 1)
  }
})

api.onGameExit(({ code, crashed }) => {
  gameRunning = false
  renderPlay()
  if (crashed) {
    setStatus(`게임이 비정상 종료되었습니다 (코드 ${code}). 아래 버튼으로 로그 링크를 만들어 관리자에게 보내 주세요.`, { error: true })
    setProgress(0, 1)
    $('share-log-btn').classList.remove('hidden')
  } else {
    check()
  }
})

api.onAccount(a => {
  account = a
  renderAccount()
})

// ---------------------------------------------------------------- settings dialog

const dialog = $('settings')
const memInput = $('mem-input')
const memValue = $('mem-value')

function showMem () {
  memValue.textContent = `${(Number(memInput.value) / 1024).toFixed(1)} GB`
}

$('settings-btn').addEventListener('click', () => {
  const s = info.settings
  memInput.max = String(info.totalMemoryMB)
  memInput.value = String(s.memoryMB)
  $('mem-total').textContent = `${(info.totalMemoryMB / 1024).toFixed(1)} GB`
  $('autoconnect-input').checked = s.autoConnect
  $('hide-input').checked = s.hideOnLaunch
  $('jvm-input').value = s.jvmArgs
  showMem()
  dialog.showModal()
})
memInput.addEventListener('input', showMem)

dialog.addEventListener('close', async () => {
  if (dialog.returnValue !== 'save') return
  info.settings = await api.saveSettings({
    memoryMB: Number(memInput.value),
    autoConnect: $('autoconnect-input').checked,
    hideOnLaunch: $('hide-input').checked,
    jvmArgs: $('jvm-input').value
  })
  setStatus('설정을 저장했습니다.')
})

$('open-folder-btn').addEventListener('click', () => api.open('instance'))
$('share-log-btn').addEventListener('click', shareLog)
$('notice-close').addEventListener('click', () => {
  try { if (notice) localStorage.setItem('notice-dismissed', notice.id) } catch {}
  $('notice').classList.add('hidden')
})
$('share-log-settings-btn').addEventListener('click', () => { dialog.close(); shareLog() })
$('open-logs-btn').addEventListener('click', () => api.open('logs'))
$('repair-btn').addEventListener('click', async () => {
  dialog.close()
  await run(async () => {
    pack = await api.repairPack()
    renderPack()
    setStatus('파일 검사 완료')
  })
})

// ---------------------------------------------------------------- boot

ui.play.addEventListener('click', play)
$('win-min').addEventListener('click', () => api.windowControl('minimize'))
$('win-max').addEventListener('click', () => api.windowControl('maximize'))
$('win-close').addEventListener('click', () => api.windowControl('close'))
api.onWindowState(s => {
  document.body.classList.toggle('maximized', s.maximized)
  $('win-max').title = s.maximized ? '이전 크기로' : '최대화'
})
// 창에서 Enter = 메인 버튼 (설정 창이 열려 있거나 입력 칸에 있을 때는 제외)
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || dialog.open || e.target.closest('input, button, textarea')) return
  if (!ui.play.disabled) ui.play.click()
})
ui.loginBtn.addEventListener('click', login)
ui.logoutBtn.addEventListener('click', async () => {
  account = await api.logout()
  renderAccount()
  setStatus('로그아웃했습니다.')
})
$('link-discord').addEventListener('click', () => api.open('discord'))
$('link-website').addEventListener('click', () => api.open('website'))

// 새 런처가 있으면 받아서 설치하고 이 창은 닫힌다 (설치가 끝나면 새 런처가 다시 켜짐)
async function updateLauncher () {
  const u = await api.checkLauncherUpdate().catch(() => null)
  if (!u || !u.available) return false
  busy = true
  renderPlay()
  setStatus(`런처 업데이트 v${u.version}`, { detail: '런처가 잠깐 꺼졌다가 1분 안팎 뒤 새 버전으로 다시 켜져요.' })
  try {
    await api.installLauncherUpdate(u)
    return true
  } catch (e) {
    busy = false
    setStatus(`런처 업데이트 실패: ${cleanError(e)}`, { error: true })
    return false
  }
}

async function boot () {
  info = await api.init()
  document.title = info.appName
  $('app-name').textContent = info.appName
  $('launcher-version').textContent = info.appVersion ? `런처 v${info.appVersion}` : ''
  $('link-discord').classList.toggle('hidden', !info.links.discord)
  $('link-website').classList.toggle('hidden', !info.links.website)
  account = info.account
  renderAccount()
  if (await updateLauncher()) return
  refreshNotice()
  await check()
  // 런처를 켜 둔 채로 있어도 새 버전이 올라오면 알 수 있게 10분마다 확인
  setInterval(() => { refreshNotice(); if (!busy && !gameRunning) check() }, 10 * 60 * 1000)
}

boot()
