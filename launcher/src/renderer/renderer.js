'use strict'

const api = window.launcher
const $ = id => document.getElementById(id)

const ui = {
  status: $('status-text'),
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

function formatBytes (n) {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function setStatus (text, { error = false } = {}) {
  ui.status.textContent = text
  ui.status.classList.toggle('error', error)
}

function setProgress (current, total) {
  const pct = total > 0 ? Math.min(100, (current / total) * 100) : 0
  ui.bar.style.width = `${pct}%`
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
  ui.accountName.textContent = account ? account.name : '로그인 안 됨'
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
  if (pack.needsUpdate) {
    b.textContent = pack.firstInstall ? '설치 후 시작' : '업데이트 후 시작'
    b.classList.add('update')
  } else {
    b.textContent = '게임 시작'
  }
}

function renderPack () {
  if (!pack) return
  const loader = pack.loader.type === 'vanilla' ? '' : ` · ${pack.loader.type} ${pack.loader.version}`
  ui.packMeta.textContent = `${pack.packName || ''} · Minecraft ${pack.minecraft}${loader}`
  ui.version.textContent = pack.installedVersion
    ? `설치된 버전 v${pack.installedVersion} · 최신 v${pack.remoteVersion}`
    : `최신 v${pack.remoteVersion} (미설치)`
  ui.badge.classList.toggle('hidden', !(pack.needsUpdate && !pack.firstInstall && pack.versionChanged))
  renderChangelog(pack.changelog)

  if (!pack.needsUpdate) {
    setStatus('최신 버전입니다. 바로 접속할 수 있어요.')
  } else if (pack.firstInstall) {
    setStatus(`처음 설치: 파일 ${pack.downloadCount}개 (${formatBytes(pack.downloadBytes)})`)
  } else if (pack.versionChanged) {
    setStatus(`업데이트 있음: v${pack.installedVersion} → v${pack.remoteVersion} · 파일 ${pack.downloadCount}개 (${formatBytes(pack.downloadBytes)})`)
  } else {
    setStatus(`손상되거나 바뀐 파일 ${pack.downloadCount + pack.removalCount + pack.strayCount}개를 복구해야 합니다.`)
  }
  setProgress(0, 1)
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
}

// ---------------------------------------------------------------- actions

async function login () {
  return run(async () => {
    setStatus('마이크로소프트 로그인 창에서 로그인해 주세요...')
    account = await api.login()
    renderAccount()
    setStatus(`${account.name} 님으로 로그인했습니다.`)
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
    setStatus('게임 실행 중... 즐거운 시간 되세요!')
    setProgress(1, 1)
  })
}

api.onProgress(p => {
  if (p.phase === 'download') {
    const pct = p.total ? Math.floor((p.current / p.total) * 100) : 0
    setStatus(`다운로드 중 ${p.files}/${p.fileTotal} · ${formatBytes(p.current)} / ${formatBytes(p.total)} (${pct}%)`)
    setProgress(p.current, p.total)
  } else if (p.phase === 'verify') {
    setStatus(`파일 확인 중 ${p.current}/${p.total}`)
    setProgress(p.current, p.total)
  } else if (p.text) {
    setStatus(p.text)
    if (p.total) setProgress(p.current, p.total)
  }
})

api.onGameExit(({ code, crashed }) => {
  gameRunning = false
  renderPlay()
  if (crashed) {
    setStatus(`게임이 비정상 종료되었습니다 (코드 ${code}). 설정 → 로그 폴더 열기에서 latest.log 를 확인하세요.`, { error: true })
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
$('open-logs-btn').addEventListener('click', () => api.open('logs'))
$('repair-btn').addEventListener('click', async () => {
  dialog.close()
  await run(async () => {
    pack = await api.repairPack()
    renderPack()
    setStatus('모든 파일을 검사하고 복구했습니다.')
  })
})

// ---------------------------------------------------------------- boot

ui.play.addEventListener('click', play)
ui.loginBtn.addEventListener('click', login)
ui.logoutBtn.addEventListener('click', async () => {
  account = await api.logout()
  renderAccount()
  setStatus('로그아웃했습니다.')
})
$('link-discord').addEventListener('click', () => api.open('discord'))
$('link-website').addEventListener('click', () => api.open('website'))

async function boot () {
  info = await api.init()
  document.title = info.appName
  $('app-name').textContent = info.appName
  $('link-discord').classList.toggle('hidden', !info.links.discord)
  $('link-website').classList.toggle('hidden', !info.links.website)
  account = info.account
  renderAccount()
  await check()
  // 런처를 켜 둔 채로 있어도 새 버전이 올라오면 알 수 있게 10분마다 확인
  setInterval(() => { if (!busy && !gameRunning) check() }, 10 * 60 * 1000)
}

boot()
