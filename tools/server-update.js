#!/usr/bin/env node
'use strict'

// 서버 컴용: GitHub 최신 릴리스의 서버 패키지(server-manifest.bin)를 받아 서버 폴더에 적용한다.
// 서버 폴더에 server-update.json 이 있어야 한다: { "repo": "아이디/modpack", "key": "...", "start": "run.bat" }
//
//   node server-update.js            업데이트만
//   node server-update.js --start    업데이트 후 서버 실행 (서버시작.bat 이 이걸 부름)
//
// - 모드는 관리자 인스턴스와 똑같이 맞추고, 설정/KubeJS 는 관리자가 바꿨을 때만 덮어쓴다
//   (서버가 실행 중에 기록하는 데이터 보존)
// - 월드, server.properties 등 목록에 없는 파일은 건드리지 않는다
// - 바뀌거나 지워지는 파일은 .update-backup/<시각>/ 에 먼저 복사해 둔다

const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const { spawn } = require('node:child_process')
const updater = require('../launcher/src/main/updater')
const secret = require('../launcher/src/common/secret')
const { validateManifest, matchesAny } = require('../launcher/src/common/manifest')
const github = require('./lib/github')

const CONFIG_FILE = 'server-update.json'
const STATE_FILE = '.server-update-state.json'

async function fetchServerManifest (repo, key) {
  const url = new URL(github.manifestUrl(repo).replace(/manifest\.json$/, 'server-manifest.bin'))
  url.searchParams.set('_', Date.now().toString())
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`서버 패키지를 받지 못했습니다 (HTTP ${res.status}). 관리자가 서버 키를 넣고 배포했는지 확인하세요.`)
  const manifest = JSON.parse(secret.decrypt(Buffer.from(await res.arrayBuffer()), key).toString('utf8'))
  return { manifest: validateManifest(manifest), url: url.toString() }
}

function listJars (serverDir) {
  try {
    return fs.readdirSync(path.join(serverDir, 'mods'), { withFileTypes: true }).filter(e => e.isFile()).map(e => `mods/${e.name}`)
  } catch {
    return []
  }
}

function loaderInstalled (serverDir, loader) {
  if (loader.type === 'neoforge') return fs.existsSync(path.join(serverDir, 'libraries', 'net', 'neoforged', 'neoforge', loader.version))
  if (loader.type === 'forge') return fs.readdirSync(path.join(serverDir, 'libraries', 'net', 'minecraftforge', 'forge'), { withFileTypes: true }).some(e => e.name.endsWith(`-${loader.version}`))
  return true
}

async function updateServer ({ serverDir, repo, key, log = () => {} }) {
  const { manifest, url } = await fetchServerManifest(repo, key)
  const stateFile = path.join(serverDir, STATE_FILE)
  const state = await updater.loadState(stateFile)
  const plan = await updater.planUpdate({ manifest, instanceDir: serverDir, state })

  // 서버에 있으면 안 되는 클라이언트 전용 모드 (추적 여부와 무관하게 치움)
  const clientOnly = manifest.clientOnly || []
  const listed = new Set(manifest.files.map(f => f.path.toLowerCase()))
  const clientOnlyJars = listJars(serverDir).filter(p => !listed.has(p.toLowerCase()) && matchesAny(p.toLowerCase(), clientOnly))
  plan.removals.push(...clientOnlyJars.filter(p => !plan.removals.includes(p)))

  const report = {
    fromVersion: state.installedVersion,
    toVersion: manifest.version,
    downloads: plan.downloads.map(f => f.path),
    removals: plan.removals,
    loader: manifest.loader,
    loaderMissing: false,
    backupDir: null
  }

  if (plan.needsUpdate || plan.removals.length) {
    report.backupDir = path.join(serverDir, '.update-backup', new Date().toISOString().replace(/[:.]/g, '-'))
    let lastPct = -1
    await updater.applyUpdate({
      manifest,
      manifestUrl: url,
      instanceDir: serverDir,
      stateFile,
      state,
      plan,
      decrypt: buf => secret.decrypt(buf, key),
      backupDir: report.backupDir,
      onProgress: p => {
        if (p.phase !== 'download' || !p.total) return
        const pct = Math.floor((p.current / p.total) * 10) * 10
        if (pct !== lastPct) { lastPct = pct; log(`  받는 중 ${pct}%`) }
      }
    })
    if (!fs.existsSync(report.backupDir)) report.backupDir = null
  }
  try {
    report.loaderMissing = !loaderInstalled(serverDir, manifest.loader)
  } catch {
    report.loaderMissing = true
  }
  return report
}

function startServer (serverDir, command) {
  return new Promise(resolve => {
    const p = spawn(command, { cwd: serverDir, stdio: 'inherit', shell: true })
    p.on('close', code => resolve(code))
  })
}

async function main () {
  const serverDir = process.cwd()
  const configPath = path.join(serverDir, CONFIG_FILE)
  if (!fs.existsSync(configPath)) throw new Error(`${CONFIG_FILE} 이 없습니다. 관리자에게 받은 서버 키트 파일을 서버 폴더에 넣으세요.`)
  const cfg = JSON.parse(await fsp.readFile(configPath, 'utf8'))
  const start = process.argv.includes('--start')

  console.log('서버 패치 확인 중...')
  let updateFailed = false
  try {
    const r = await updateServer({ serverDir, repo: cfg.repo, key: cfg.key, log: console.log })
    if (!r.downloads.length && !r.removals.length) {
      console.log(`✔ 최신 버전입니다 (v${r.toVersion})`)
    } else {
      console.log(`✔ 패치 적용: v${r.fromVersion || '(처음)'} → v${r.toVersion}  (받은 파일 ${r.downloads.length}개, 지운 파일 ${r.removals.length}개)`)
      for (const p of r.removals) console.log(`  - ${p}`)
      if (r.backupDir) console.log(`  이전 파일 백업: ${r.backupDir}`)
    }
    if (r.loaderMissing) {
      console.log('')
      console.log(`⚠ 이 서버에 ${r.loader.type} ${r.loader.version} 이 설치되어 있지 않습니다.`)
      console.log('  관리자가 모드로더 버전을 올린 것 같습니다. 서버용 설치 파일로 새 버전을 설치한 뒤 켜 주세요.')
      if (start) updateFailed = true
    }
  } catch (e) {
    console.error(`✘ 패치 실패: ${e.message}`)
    updateFailed = true
  }

  if (!start) return process.exit(updateFailed ? 1 : 0)
  if (updateFailed) {
    const answer = await new Promise(resolve => {
      process.stdout.write('\n그래도 서버를 켤까요? (y/n) ')
      process.stdin.once('data', d => resolve(String(d).trim().toLowerCase()))
    })
    if (!['y', 'yes', 'ㅛ'].includes(answer)) return process.exit(1)
  }
  console.log(`\n서버 시작: ${cfg.start || 'run.bat'}\n`)
  process.exit(await startServer(serverDir, cfg.start || 'run.bat'))
}

if (require.main === module) {
  main().catch(e => {
    console.error(`✘ ${e.message}`)
    process.exit(1)
  })
}

module.exports = { updateServer, main }
