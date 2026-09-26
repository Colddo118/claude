'use strict'

const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const { app, BrowserWindow, ipcMain, shell } = require('electron')
const config = require('../../launcher.config.json')
const updater = require('./updater')
const { compareVersions } = require('../common/manifest')
const game = require('./game')
const { AccountStore, loginInteractive, getLaunchAuthorization } = require('./auth')

const manifestUrl = process.env.MODPACK_MANIFEST_URL || config.manifestUrl

const base = path.join(app.getPath('appData'), config.dataFolderName)
const dirs = {
  base,
  instance: path.join(base, 'instance'),
  minecraft: path.join(base, 'minecraft'),
  runtime: path.join(base, 'runtime'),
  cache: path.join(base, 'cache'),
  logs: path.join(base, 'logs')
}
const files = {
  state: path.join(base, 'state.json'),
  settings: path.join(base, 'settings.json'),
  account: path.join(base, 'account.json'),
  loginDiagnostic: path.join(base, 'logs', 'login.json')
}

const accounts = new AccountStore(files.account)
let win = null
let busy = false
let gameProcess = null
let lastManifest = null

// ---------------------------------------------------------------- settings

function defaultMemoryMB (manifest) {
  const total = game.totalMemoryMB()
  const wanted = (manifest && manifest.memory && manifest.memory.recommendedMB) || 4096
  // OS 몫으로 최소 2GB 는 남긴다.
  return Math.max(1024, Math.min(wanted, total - 2048))
}

async function loadSettings () {
  let saved = {}
  try {
    saved = JSON.parse(await fsp.readFile(files.settings, 'utf8'))
  } catch {}
  return {
    memoryMB: saved.memoryMB || defaultMemoryMB(lastManifest),
    jvmArgs: saved.jvmArgs || '',
    autoConnect: saved.autoConnect !== false,
    hideOnLaunch: saved.hideOnLaunch !== false,
    javaPath: saved.javaPath || ''
  }
}

async function saveSettings (s) {
  const current = await loadSettings()
  const next = {
    ...current,
    memoryMB: Math.max(1024, Math.min(Number(s.memoryMB) || current.memoryMB, game.totalMemoryMB())),
    jvmArgs: typeof s.jvmArgs === 'string' ? s.jvmArgs : current.jvmArgs,
    autoConnect: typeof s.autoConnect === 'boolean' ? s.autoConnect : current.autoConnect,
    hideOnLaunch: typeof s.hideOnLaunch === 'boolean' ? s.hideOnLaunch : current.hideOnLaunch,
    javaPath: typeof s.javaPath === 'string' ? s.javaPath.trim() : current.javaPath
  }
  await fsp.mkdir(base, { recursive: true })
  await fsp.writeFile(files.settings, JSON.stringify(next, null, 2))
  return next
}

// ---------------------------------------------------------------- helpers

function send (channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function progress (p) {
  send('progress', p)
}

async function exclusive (fn) {
  if (busy) throw new Error('이미 작업 중입니다.')
  if (gameProcess) throw new Error('게임이 실행 중입니다. 게임을 끈 뒤 다시 시도하세요.')
  busy = true
  try {
    return await fn()
  } finally {
    busy = false
  }
}

function summarize (manifest, state, plan) {
  return {
    packName: manifest.packName,
    server: manifest.server && manifest.server.address ? manifest.server.address + (manifest.server.port ? `:${manifest.server.port}` : '') : null,
    minecraft: manifest.minecraft,
    loader: manifest.loader,
    remoteVersion: manifest.version,
    installedVersion: state.installedVersion,
    changelog: (manifest.changelog || []).map(c => ({
      ...c,
      isNew: !!state.installedVersion && compareVersions(c.version, state.installedVersion) > 0
    })),
    needsUpdate: plan.needsUpdate,
    firstInstall: !state.installedVersion,
    versionChanged: plan.versionChanged,
    downloadCount: plan.downloads.length,
    downloadBytes: plan.downloadBytes,
    removalCount: plan.removals.length,
    strayCount: plan.strays.length
  }
}

async function computePlan ({ repair = false } = {}) {
  const manifest = await updater.fetchManifest(manifestUrl)
  lastManifest = manifest
  const state = await updater.loadState(files.state)
  // 복구 모드: 저장된 해시 캐시를 무시하고 모든 파일을 실제로 다시 해시한다.
  const planState = repair ? { ...state, files: Object.fromEntries(Object.keys(state.files).map(k => [k, {}])) } : state
  const plan = await updater.planUpdate({
    manifest,
    instanceDir: dirs.instance,
    state: planState,
    onProgress: p => progress({ ...p, text: '파일 확인 중...' })
  })
  return { manifest, state, plan }
}

async function installUpdate ({ repair = false } = {}) {
  const { manifest, state, plan } = await computePlan({ repair })
  if (plan.needsUpdate) {
    await fsp.mkdir(dirs.instance, { recursive: true })
    await updater.applyUpdate({
      manifest,
      manifestUrl,
      instanceDir: dirs.instance,
      stateFile: files.state,
      state,
      plan,
      onProgress: progress
    })
  }
  const newState = await updater.loadState(files.state)
  return summarize(manifest, newState, { ...plan, downloads: [], downloadBytes: 0, removals: [], strays: [], versionChanged: false, needsUpdate: false })
}

// ---------------------------------------------------------------- IPC

ipcMain.handle('launcher:init', async () => ({
  appName: config.appName,
  appVersion: app.getVersion(),
  account: await accounts.profile(),
  settings: await loadSettings(),
  totalMemoryMB: game.totalMemoryMB(),
  links: { discord: config.discordUrl || '', website: config.websiteUrl || '' }
}))

ipcMain.handle('pack:check', async () => {
  const { manifest, state, plan } = await computePlan()
  return { ...summarize(manifest, state, plan), settings: await loadSettings() }
})

ipcMain.handle('pack:update', () => exclusive(() => installUpdate()))
ipcMain.handle('pack:repair', () => exclusive(() => installUpdate({ repair: true })))

ipcMain.handle('account:login', async () => {
  const profile = await loginInteractive(accounts, files.loginDiagnostic)
  return profile
})

ipcMain.handle('account:logout', async () => {
  await accounts.clear()
  return null
})

ipcMain.handle('settings:save', (_e, s) => saveSettings(s))

ipcMain.handle('shell:open', (_e, what) => {
  const targets = {
    instance: dirs.instance,
    logs: dirs.logs,
    discord: config.discordUrl,
    website: config.websiteUrl
  }
  const target = targets[what]
  if (!target) return
  if (/^https?:\/\//.test(target)) return shell.openExternal(target)
  fs.mkdirSync(target, { recursive: true })
  return shell.openPath(target)
})

ipcMain.handle('game:launch', () => exclusive(async () => {
  // 1) 모드팩 최신화 (원클릭: 업데이트가 있으면 여기서 같이 받는다)
  await installUpdate()
  const manifest = lastManifest

  // 2) 로그인 확인
  progress({ phase: 'launch', text: '계정 확인 중...' })
  let authorization
  try {
    authorization = await getLaunchAuthorization(accounts, files.loginDiagnostic)
  } catch (e) {
    if (e.needsLogin) await accounts.clear()
    send('account', null)
    throw e
  }
  if (!authorization) {
    send('account', null)
    throw new Error('먼저 마이크로소프트 계정으로 로그인해 주세요.')
  }

  // 3) 자바/로더/바닐라 준비 후 실행
  const settings = await loadSettings()
  const child = await game.launchGame({
    manifest,
    dirs,
    authorization,
    settings,
    launcher: { name: config.appName, version: app.getVersion() },
    onStatus: text => progress({ phase: 'launch', text }),
    onProgress: e => progress({
      phase: 'launch',
      text: `${e.text} ${Math.floor((e.current / e.total) * 100)}%`,
      current: e.current,
      total: e.total
    })
  })
  await fsp.mkdir(dirs.logs, { recursive: true })
  const log = fs.createWriteStream(path.join(dirs.logs, 'latest.log'))
  child.stdout && child.stdout.pipe(log, { end: false })
  child.stderr && child.stderr.pipe(log, { end: false })

  gameProcess = child
  progress({ phase: 'running', text: '게임 실행 중' })
  if (settings.hideOnLaunch && win) win.hide()
  child.on('error', e => log.write(`[launcher] 게임 프로세스 오류: ${e.message}\n`))
  child.on('close', code => {
    gameProcess = null
    log.end()
    if (!win || win.isDestroyed()) return app.quit()
    win.show()
    win.focus()
    send('game:exit', { code, crashed: code !== 0 })
  })
  return { started: true }
}))

// ---------------------------------------------------------------- window

function createWindow () {
  win = new BrowserWindow({
    width: 1200,
    height: 740,
    minWidth: 1000,
    minHeight: 640,
    title: config.appName,
    backgroundColor: '#11131a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
  app.whenReady().then(createWindow)
  app.on('window-all-closed', () => {
    if (!gameProcess) app.quit()
  })
}
